/** Bounded synthetic scan traversal. Ordinary runtime never installs a page source. */
import {detectMoodleAccess, type MoodleAccessInput} from './moodle-access';
import {pageRoute, syntheticFixtureRegistry, type Collector} from './page-refresh';
import {scanRetryDecision} from './scan-retry';

type Reason = 'undiscovered'|'unsupported_page'|'collector_unavailable'|'access_error'|'signed_out'|'forbidden'|'request_failed'|'limit_reached'|'invalid_context';
type Scope = 'visited_activity_only'|'supplied_pages_only'|'supplied_ranges_only'|'unknown';
type Page = {pageType:string;scope:Scope;outcome:'ok'|'partial'|'failed'|'unavailable'|'forbidden'|'signed_out'|'undiscovered';coverage:'complete'|'partial'|'none';reasons:Reason[];observedAt?:string;pageUrl?:string;collector?:Collector;result?:unknown};
export interface SyntheticResponse {input:MoodleAccessInput;links:string[];sourceCourseId:string;retryAfter?:string;bytes:number}
/** Resolve only after actual request termination; rejected/lost acknowledgement must not release. */
export interface SyntheticRequest {completion:Promise<SyntheticResponse>; termination:Promise<boolean>; abort:()=>void}
export interface SyntheticSource {start:(url:string)=>SyntheticRequest}
export interface RequestAuthority {acquire:(now:number)=>Promise<string|null>;releaseAfterTermination:(token:string,notBefore:number)=>Promise<boolean>}
export interface ScanOptions {
  source:SyntheticSource; authority:RequestAuthority; sourceCourseId:string;
  valid:()=>Promise<boolean>; now:()=>number; wait:(ms:number)=>Promise<void>;
  signal?:AbortSignal;
  maxPages?:number; maxDepth?:number; maxBytes?:number;
}
export async function scanSyntheticCourse(options:ScanOptions):Promise<{outcome:'completed'|'failed';pages:Page[];incompleteReasons:Reason[];errorCode?:'signed_out'|'request_failed'|'invalid_context'}> {
  const reasons=new Set<Reason>(), pages:Page[]=[], seen=new Set<string>();
  const pending=[{url:`https://moodle.sdu.edu.kz/course/view.php?id=${options.sourceCourseId}`,depth:0}];
  const maxPages=Math.min(options.maxPages??100,100), maxDepth=Math.min(options.maxDepth??4,8), maxBytes=Math.min(options.maxBytes??1048576,1048576);
  const registry=syntheticFixtureRegistry();
  const add=(page:Page)=>{pages.push(page);page.reasons.forEach(r=>reasons.add(r));};
  const failure=(pageType:string,reason:Reason,outcome:Page['outcome'],url?:string)=>add({pageType,scope:'unknown',outcome,coverage:'none',reasons:[reason],observedAt:new Date(options.now()).toISOString(),...(url?{pageUrl:url}:{})});
  const check=async()=>{try{return !options.signal?.aborted && await options.valid();}catch{return false;}};
  let stopped: 'signed_out'|'request_failed'|'invalid_context'|undefined;
  while(pending.length && pages.length<maxPages && !stopped) {
    const next=pending.shift()!;if(seen.has(next.url))continue;seen.add(next.url);
    const route=pageRoute(next.url);
    if(!route||next.url.includes('#')){failure('unsupported','unsupported_page','unavailable');continue;}
    if(!await check()){stopped='invalid_context';break;}
    const pageType=route.kind==='assign'?'assignment':route.kind==='resource'||route.kind==='url'||route.kind==='folder'?'material':route.kind;
    let response:SyntheticResponse|undefined;
    for(let attempt=1;attempt<=3;attempt++) {
      let token:string|null=null;
      while(!token && await check()){token=await options.authority.acquire(options.now());if(!token)await options.wait(100);}
      if(!token){stopped='invalid_context';break;}
      if(!await check()) { await options.authority.releaseAfterTermination(token,0);stopped='invalid_context';break; }
      let request:SyntheticRequest;
      try {request=options.source.start(next.url);}catch{stopped='request_failed';break;}
      // Capture after start: delaying between the SQLite reservation and the
      // actual request must never shorten spacing to the following request.
      const startedAt=options.now();
      if(!Number.isSafeInteger(startedAt)||startedAt<0||!Number.isSafeInteger(startedAt+1000)){request.abort();stopped='request_failed';break;}
      const abort=()=>request.abort();
      options.signal?.addEventListener('abort',abort,{once:true});
      const monitor=setInterval(()=>{void check().then(valid=>{if(!valid)request.abort();});},1000);
      let value:SyntheticResponse|undefined;
      try {value=await request.completion;}catch{}
      clearInterval(monitor);options.signal?.removeEventListener('abort',abort);
      const alive=await check();if(!alive)request.abort();
      let acknowledged=false;try {acknowledged=await request.termination;}catch{}
      if(!acknowledged){stopped='request_failed';break;}
      const access=value&&detectMoodleAccess(value.input);
      const retry=!!value && !!access?.retryable && (value.input.networkFailure || value.input.httpStatus===408 || value.input.httpStatus===425 || value.input.httpStatus===429 || value.input.httpStatus>=500);
      const decision=retry?scanRetryDecision(options.now(),attempt,value?.retryAfter):undefined;
      const deadline=Math.max(startedAt+1000,decision?.kind==='retry'?decision.notBefore:0);
      if(!await options.authority.releaseAfterTermination(token,deadline)){stopped='request_failed';break;}
      if(!alive){stopped='invalid_context';break;}
      if(!value){stopped='request_failed';break;}
      if(retry){if(decision?.kind!=='retry'){failure(pageType,'request_failed','failed',next.url);break;}await options.wait(Math.max(0,deadline-options.now()));continue;}
      response=value;break;
    }
    if(stopped||!response)continue;
    const access=detectMoodleAccess(response.input);
    if(access.status==='signed_out'){failure(pageType,'signed_out','signed_out',next.url);stopped='signed_out';break;}
    if(response.input.requestedUrl!==next.url || response.input.finalUrl!==next.url || response.sourceCourseId!==options.sourceCourseId || response.bytes<0 || response.bytes>maxBytes){failure(pageType,'access_error','failed',next.url);continue;}
    if(access.status==='forbidden'){failure(pageType,'forbidden','forbidden',next.url);continue;}
    if(access.status!=='accessible'){failure(pageType,'access_error','failed',next.url);continue;}
    const collectors:Collector[]=route.kind==='assign'?['assignment','submission']:route.kind==='quiz'?['quiz']:route.kind==='calendar'?['calendar']:['material'];
    const observedAt=new Date(options.now()).toISOString();
    for(const collector of collectors){
      if(pages.length>=maxPages){reasons.add('limit_reached');break;}
      const adapter=registry[collector];const pageType=collector==='material'&&route.kind==='course'?'course':collector;
      if(adapter.availability==='unavailable'){add({pageType,scope:'unknown',outcome:'unavailable',coverage:'none',reasons:['collector_unavailable'],observedAt,pageUrl:next.url});continue;}
      const collected=await adapter.collect(response.input,[options.sourceCourseId],observedAt);
      if(collected.kind!==collector){failure(pageType,'request_failed','failed',next.url);continue;}
      // An empty listing alone is not proof that the whole section was seen.
      const result=(collected.kind==='calendar'||collected.kind==='material') && collected.observations.length===0
        ? {...collected,coverage:'partial' as const}:collected;
      const incomplete=result.coverage!=='complete';
      add({pageType,scope:result.scope, outcome:incomplete?'partial':'ok',coverage:result.coverage,reasons:incomplete?['undiscovered']:[],observedAt,pageUrl:next.url,collector,result});
    }
    for(const link of response.links){
      if(!pageRoute(link)||link.includes('#')){
        if(pages.length<maxPages)add({pageType:'unsupported',scope:'unknown',outcome:'unavailable',coverage:'none',reasons:['unsupported_page','collector_unavailable'],observedAt});
        else reasons.add('limit_reached');
        continue;
      }
      if(!seen.has(link)){if(next.depth>=maxDepth)reasons.add('limit_reached');else pending.push({url:link,depth:next.depth+1});}
    }
  }
  if(pending.length||pages.length>=maxPages)reasons.add('limit_reached');
  // Discovery cannot prove absent categories, and unavailable #14/#16 stay explicit.
  for(const kind of ['assignment','calendar','material','quiz','submission']) {
    if(pages.length>=100){reasons.add('limit_reached');break;}
    if(!pages.some(p=>p.pageType===kind))add({pageType:kind,scope:'unknown',outcome:'undiscovered',coverage:'none',reasons:['undiscovered']});
  }
  if(stopped){reasons.add(stopped);return {outcome:'failed',pages,incompleteReasons:[...reasons],errorCode:stopped};}
  return {outcome:'completed',pages,incompleteReasons:[...reasons]};
}
