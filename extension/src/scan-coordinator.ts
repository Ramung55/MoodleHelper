/**
 * Bounded course scan traversal (#20). The one traversal for both the injected
 * synthetic harness and the installed live scan: the page source, request
 * authority and collector registry are parameters.
 */
import {detectMoodleAccess, type MoodleAccessInput, type MoodleAccessResult} from './moodle-access';
import {MOODLE_USER_ID} from './moodle-page-analysis';
import {pageRoute, syntheticFixtureRegistry, type Collector, type CollectorRegistry} from './page-refresh';
import {retryAfterDeadline, scanRetryDecision} from './scan-retry';
import type {CollectorResult} from '../../frontend/src/domain/types';

type Reason = 'undiscovered'|'unsupported_page'|'collector_unavailable'|'access_error'|'signed_out'|'forbidden'|'request_failed'|'limit_reached'|'invalid_context';
type Scope = 'visited_activity_only'|'supplied_pages_only'|'supplied_ranges_only'|'unknown';
type Page = {pageType:string;scope:Scope;outcome:'ok'|'partial'|'failed'|'unavailable'|'forbidden'|'signed_out'|'undiscovered';coverage:'complete'|'partial'|'none';reasons:Reason[];observedAt?:string;pageUrl?:string;collector?:Collector;result?:unknown};
/** Envelope of one request. A live response carries no Document: it was analyzed offscreen. */
export type ScanEnvelope = Omit<MoodleAccessInput,'document'> & {readonly document?:Document};
export interface ScanResponse {
  input:ScanEnvelope; links:string[]; sourceCourseId:string; retryAfter?:string; bytes:number;
  /** Precomputed access classification (live); otherwise derived from input.document. */
  access?:MoodleAccessResult;
  /** Precomputed collector results (live, offscreen); otherwise collected in-process. */
  collected?:Partial<Record<Collector,CollectorResult>>;
  /** Quiz card titles by course-module id, from a course page. */
  titles?:Record<string,string>;
  /** Time of this request, when the source recorded it. */
  observedAt?:string;
  /** #93: the signed-in Moodle user id shown in this response's text, when it shows one. */
  moodleUserId?:string;
}
export type SyntheticResponse = ScanResponse;
/** Resolve only after actual request termination; rejected/lost acknowledgement must not release. */
export interface ScanRequest {completion:Promise<ScanResponse>; termination:Promise<boolean>; abort:()=>void}
export type SyntheticRequest = ScanRequest;
export interface StartContext {sourceCourseId:string; collectors:Collector[]; title?:string}
export interface ScanSource {start:(url:string,context?:StartContext)=>ScanRequest}
export type SyntheticSource = ScanSource;
export interface RequestAuthority {acquire:(now:number,requestKey?:string)=>Promise<string|{token:string;failures:number}|null>;releaseAfterTermination:(token:string,notBefore:number,requestKey?:string,retryFailure?:boolean)=>Promise<boolean>}
export interface ScanOptions {
  source:ScanSource; authority:RequestAuthority; sourceCourseId:string;
  valid:()=>Promise<boolean>; now:()=>number; wait:(ms:number)=>Promise<void>;
  signal?:AbortSignal;
  retryScope?:string;
  maxPages?:number; maxDepth?:number; maxBytes?:number;
  /**
   * Collector registry. When supplied (the installed live scan), a discovered route
   * is requested only if the registry has an available collector for it; otherwise
   * it is recorded as collector_unavailable without a request. The course page is
   * always requested, for discovery. Without it (synthetic harness default) the
   * synthetic fixture registry is used and every supported route is requested.
   */
  registry?:CollectorRegistry;
}
/** Longest wait for the request authority before a page fails as request_failed. */
export const ACQUIRE_LIMIT_MS=10*60*1000;
/** #83: the one observed calendar page, requested once per course job when its collector is available. */
const UPCOMING_CALENDAR='https://moodle.sdu.edu.kz/calendar/view.php?view=upcoming';
/** Material module pages (file and link targets) are never requested by the live scan: material is read from the course page. */
const materialModule=(kind:string)=>kind==='resource'||kind==='url'||kind==='folder';
const collectorsFor=(kind:string):Collector[]=>kind==='assign'?['assignment','submission']:kind==='quiz'?['quiz']:kind==='calendar'?['calendar']:['material'];
const pageTypeFor=(kind:string)=>kind==='assign'?'assignment':kind==='resource'||kind==='url'||kind==='folder'?'material':kind;

export async function scanSyntheticCourse(options:ScanOptions):Promise<{outcome:'completed'|'failed';pages:Page[];incompleteReasons:Reason[];errorCode?:'signed_out'|'request_failed'|'invalid_context';moodleUserId?:string}> {
  const reasons=new Set<Reason>(), pages:Page[]=[], seen=new Set<string>(), titles=new Map<string,string>();
  // #93: every id the job's own responses showed; the finish carries one only if they all agree.
  const userIds=new Set<string>();
  const pending=[{url:`https://moodle.sdu.edu.kz/course/view.php?id=${options.sourceCourseId}`,depth:0}];
  const maxPages=Math.min(options.maxPages??100,100), maxDepth=Math.min(options.maxDepth??4,8), maxBytes=Math.min(options.maxBytes??1048576,1048576);
  const strict=options.registry!==undefined;
  const registry=options.registry??syntheticFixtureRegistry();
  const add=(page:Page)=>{pages.push(page);page.reasons.forEach(r=>reasons.add(r));};
  const failure=(pageType:string,reason:Reason,outcome:Page['outcome'],url?:string)=>add({pageType,scope:'unknown',outcome,coverage:'none',reasons:[reason],observedAt:new Date(options.now()).toISOString(),...(url?{pageUrl:url}:{})});
  const check=async()=>{try{return !options.signal?.aborted && await options.valid();}catch{return false;}};
  // Course-card titles back the quiz (#14) and assignment (#83) titles: their view-page title was not recorded.
  const titled=(route:{kind:string;id?:string})=>(route.kind==='quiz'||route.kind==='assign')&&titles.has(route.id!);
  const accessOf=(value:ScanResponse)=>value.access??detectMoodleAccess(value.input as MoodleAccessInput);
  let stopped: 'signed_out'|'request_failed'|'invalid_context'|undefined;
  while(pending.length && pages.length<maxPages && !stopped) {
    const next=pending.shift()!;if(seen.has(next.url))continue;seen.add(next.url);
    const route=pageRoute(next.url);
    if(!route||next.url.includes('#')){failure('unsupported','unsupported_page','unavailable');continue;}
    if(!await check()){stopped='invalid_context';break;}
    const pageType=pageTypeFor(route.kind);
    const available=collectorsFor(route.kind).filter(c=>registry[c].availability==='available');
    let response:ScanResponse|undefined;
    const requestKey=options.retryScope?JSON.stringify([options.retryScope,next.url]):undefined;
    for(let attempt=1;attempt<=3;attempt++) {
      let reservation:string|{token:string;failures:number}|null=null;
      const waitingSince=options.now();
      let starved=false;
      while(!reservation && await check()){
        reservation=await options.authority.acquire(options.now(),requestKey);
        if(reservation)break;
        // Bounded: an authority that never frees (for example one kept occupied
        // after a lost acknowledgement) cannot make this job poll forever.
        if(!(options.now()-waitingSince<ACQUIRE_LIMIT_MS)){starved=true;break;}
        await options.wait(100);
      }
      if(starved){failure(pageType,'request_failed','failed',next.url);stopped='request_failed';break;}
      if(!reservation){stopped='invalid_context';break;}
      if(reservation==='exhausted'){failure(pageType,'request_failed','failed',next.url);break;}
      const token=typeof reservation==='string'?reservation:reservation.token;
      if(typeof reservation!=='string')attempt=reservation.failures+1;
      if(!await check()) { await options.authority.releaseAfterTermination(token,0,requestKey);stopped='invalid_context';break; }
      let request:ScanRequest;
      try {request=options.source.start(next.url,{sourceCourseId:options.sourceCourseId,collectors:available,...(titled(route)?{title:titles.get(route.id!)!}:{})});}
      catch{await options.authority.releaseAfterTermination(token,0,requestKey);stopped='request_failed';break;}
      // Capture after start: delaying between the SQLite reservation and the
      // actual request must never shorten spacing to the following request.
      const startedAt=options.now();
      if(!Number.isSafeInteger(startedAt)||startedAt<0||!Number.isSafeInteger(startedAt+1000)){request.abort();stopped='request_failed';break;}
      const abort=()=>request.abort();
      options.signal?.addEventListener('abort',abort,{once:true});
      const monitor=setInterval(()=>{void check().then(valid=>{if(!valid)request.abort();});},1000);
      let value:ScanResponse|undefined;
      try {value=await request.completion;}catch{}
      clearInterval(monitor);options.signal?.removeEventListener('abort',abort);
      const alive=await check();if(!alive)request.abort();
      let acknowledged=false;try {acknowledged=await request.termination;}catch{}
      if(!acknowledged){stopped='request_failed';break;}
      const access=value&&accessOf(value);
      const retry=!!value && !!access?.retryable && (value.input.networkFailure || value.input.httpStatus===408 || value.input.httpStatus===425 || value.input.httpStatus===429 || value.input.httpStatus>=500);
      const failedAt=options.now();
      const serverDeadline=retry && value?.retryAfter!==undefined?retryAfterDeadline(failedAt,value.retryAfter):0;
      // Malformed or unrepresentable server deadlines cannot be safely cleared.
      if(serverDeadline===undefined){stopped='request_failed';break;}
      const decision=retry?scanRetryDecision(failedAt,attempt,value?.retryAfter):undefined;
      const deadline=Math.max(startedAt+1000,serverDeadline,decision?.kind==='retry'?decision.notBefore:0);
      if(!await options.authority.releaseAfterTermination(token,deadline,requestKey,retry)){stopped='request_failed';break;}
      if(!alive){stopped='invalid_context';break;}
      if(!value){stopped='request_failed';break;}
      if(retry && serverDeadline>failedAt+86400000){failure(pageType,'request_failed','failed',next.url);break;}
      if(retry){if(decision?.kind!=='retry'){failure(pageType,'request_failed','failed',next.url);break;}await options.wait(Math.max(0,deadline-options.now()));continue;}
      response=value;break;
    }
    if(stopped||!response)continue;
    const access=accessOf(response);
    if(access.status==='signed_out'){failure(pageType,'signed_out','signed_out',next.url);stopped='signed_out';break;}
    if(response.input.requestedUrl!==next.url || response.input.finalUrl!==next.url || response.sourceCourseId!==options.sourceCourseId || !Number.isSafeInteger(response.bytes) || response.bytes<0 || response.bytes>maxBytes || !Array.isArray(response.links)){failure(pageType,'access_error','failed',next.url);continue;}
    if(typeof response.moodleUserId==='string'&&MOODLE_USER_ID.test(response.moodleUserId))userIds.add(response.moodleUserId);
    if(access.status==='forbidden'){failure(pageType,'forbidden','forbidden',next.url);continue;}
    if(access.status!=='accessible'){failure(pageType,'access_error','failed',next.url);continue;}
    const observedAt=typeof response.observedAt==='string'?response.observedAt:new Date(options.now()).toISOString();
    if(route.kind==='course')for(const [cmid,title] of Object.entries(response.titles??{}))if(/^[1-9][0-9]*$/.test(cmid)&&typeof title==='string')titles.set(cmid,title);
    for(const collector of collectorsFor(route.kind)){
      if(pages.length>=maxPages){reasons.add('limit_reached');break;}
      const adapter=registry[collector];const pageType=collector==='material'&&route.kind==='course'?'course':collector;
      if(adapter.availability==='unavailable'){add({pageType,scope:'unknown',outcome:'unavailable',coverage:'none',reasons:['collector_unavailable'],observedAt,pageUrl:next.url});continue;}
      let collected:CollectorResult|undefined;
      try {
        collected=response.collected?response.collected[collector]
          :await adapter.collect(response.input as MoodleAccessInput,[options.sourceCourseId],observedAt,titled(route)?{title:titles.get(route.id!)!}:{});
      } catch {collected=undefined;}
      if(!collected||collected.kind!==collector){failure(pageType,'request_failed','failed',next.url);continue;}
      // An empty listing alone is not proof that the whole section was seen.
      const result=(collected.kind==='calendar'||collected.kind==='material') && collected.observations.length===0
        ? {...collected,coverage:'partial' as const}:collected;
      const incomplete=result.coverage!=='complete';
      add({pageType,scope:result.scope, outcome:incomplete?'partial':'ok',coverage:result.coverage,reasons:incomplete?['undiscovered']:[],observedAt,pageUrl:next.url,collector,result});
    }
    if(response.links.length>512)reasons.add('limit_reached');
    for(const link of response.links.slice(0,512)){
      const linked=typeof link==='string'?pageRoute(link):undefined;
      if(typeof link!=='string'||!linked||link.includes('#')){
        if(pages.length<maxPages)add({pageType:'unsupported',scope:'unknown',outcome:'unavailable',coverage:'none',reasons:['unsupported_page','collector_unavailable'],observedAt});
        else reasons.add('limit_reached');
        continue;
      }
      if(seen.has(link) || pending.some(item=>item.url===link))continue;
      if(strict && materialModule(linked.kind)){
        // #83: resource, URL and folder pages are recorded without a request; the course page's material collector lists them.
        seen.add(link);
        if(pages.length<maxPages)add({pageType:'material',scope:'unknown',outcome:'unavailable',coverage:'none',reasons:['unsupported_page','collector_unavailable'],observedAt,pageUrl:link});
        else reasons.add('limit_reached');
        continue;
      }
      if(strict && linked.kind!=='course' && !collectorsFor(linked.kind).some(c=>registry[c].availability==='available')){
        // Discovered, but no collector can use it: recorded without a request.
        seen.add(link);
        for(const collector of collectorsFor(linked.kind)){
          if(pages.length>=maxPages){reasons.add('limit_reached');break;}
          add({pageType:collector==='material'?'material':collector,scope:'unknown',outcome:'unavailable',coverage:'none',reasons:['collector_unavailable'],observedAt,pageUrl:link});
        }
        continue;
      }
      if(next.depth>=maxDepth || pending.length+seen.size>=maxPages)reasons.add('limit_reached');
      else pending.push({url:link,depth:next.depth+1});
    }
    // #83: the upcoming calendar lists every course; each course job requests it once and keeps its own course's events.
    if(strict && route.kind==='course' && registry.calendar.availability==='available' && !seen.has(UPCOMING_CALENDAR) && !pending.some(item=>item.url===UPCOMING_CALENDAR)){
      if(next.depth>=maxDepth || pending.length+seen.size>=maxPages)reasons.add('limit_reached');
      else pending.push({url:UPCOMING_CALENDAR,depth:next.depth+1});
    }
  }
  if(pending.length||pages.length>=maxPages)reasons.add('limit_reached');
  // Discovery cannot prove absent categories, and unavailable collectors stay explicit.
  for(const kind of ['assignment','calendar','material','quiz','submission'] as const) {
    if(pages.length>=100){reasons.add('limit_reached');break;}
    const missing:Reason[]=registry[kind].availability==='unavailable'||(!strict&&(kind==='quiz'||kind==='submission'))?['undiscovered','collector_unavailable']:['undiscovered'];
    if(!pages.some(p=>p.pageType===kind))add({pageType:kind,scope:'unknown',outcome:'undiscovered',coverage:'none',reasons:missing});
  }
  const account=userIds.size===1?{moodleUserId:[...userIds][0]!}:{};
  if(stopped){reasons.add(stopped);return {outcome:'failed',pages,incompleteReasons:[...reasons],errorCode:stopped,...account};}
  return {outcome:'completed',pages,incompleteReasons:[...reasons],...account};
}
/** The same traversal under its general name. */
export const scanCourse = scanSyntheticCourse;
