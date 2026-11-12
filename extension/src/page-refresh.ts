/** Production visited-page algorithm; all synthetic facilities are injected. */
import { detectMoodleAccess, type MoodleAccessInput } from './moodle-access';
import { parseMoodleAssignment, parseObservedMoodleAssignment } from './moodle-assignments';
import { collectMoodleCalendar, collectObservedMoodleCalendar } from './moodle-calendar';
import { collectMoodleMaterials, collectObservedMoodleMaterials } from './moodle-materials';
import { parseMoodleQuizPage, type QuizReason } from './moodle-quizzes';
import { parseMoodleSubmissionStatus, type SubmissionStatusInput } from './moodle-submission-status';
import type { CollectionRepository } from './collection-repository';
import { CollectionTransportError } from './collection-repository';
import { validSchema, normalized } from '../../shared/src/bridge';
import type { CollectorResult, CollectionContext, PageRefreshReceipt, RawAssignmentObservation, RawQuizObservation, SubmissionSourceRecord } from '../../frontend/src/domain/types';

export type Collector = 'assignment'|'calendar'|'material'|'quiz'|'submission';
export interface PageSource { url:string;documentKey:object|string;input?:MoodleAccessInput;sourceCourseId?:string }
export interface CollectorAdapter {availability:'available'|'unavailable';evidenceMode:'synthetic'|'verified';collect:(input:MoodleAccessInput,selection:readonly string[],observedAt:string,hints?:{title?:string})=>Promise<CollectorResult>|CollectorResult}
export type CollectorRegistry=Record<Collector,CollectorAdapter>;
const unavailable:CollectorAdapter={availability:'unavailable',evidenceMode:'synthetic',collect:()=>({kind:'unavailable',reasons:['collector_unavailable']})};
/** Real pure parsers, with invented structures; never advertised as verified. */
export function syntheticFixtureRegistry():CollectorRegistry {
  return {
    assignment:{availability:'available',evidenceMode:'synthetic',collect:(input,_selection,time)=>{
      const r=parseMoodleAssignment(input,time);
      return r.status==='error'?{kind:'failed',reasons:[r.reason]}:{kind:'assignment',observations:[r.observation],reviews:[],diagnostics:[],pages:[],coverage:'complete',scope:'visited_activity_only'};
    }},
    calendar:{availability:'available',evidenceMode:'synthetic',collect:(input,selection,time)=>{
      const r=collectMoodleCalendar([input],selection,time);
      return {kind:'calendar',observations:r.observations,reviews:r.review.map(v=>({kind:'calendar',...v})),diagnostics:[...r.diagnostics,...r.exclusions],pages:r.pages.map(({access:_access,...page})=>page),coverage:r.coverage,scope:r.scope};
    }},
    material:{availability:'available',evidenceMode:'synthetic',collect:(input,selection,time)=>{
      const r=collectMoodleMaterials([input],selection,time);
      return {kind:'material',observations:r.observations,reviews:r.review.map(({candidate,reason})=>({kind:'material',reasons:[reason],...(candidate?{candidate}:{})})),diagnostics:[...r.diagnostics,...r.exclusions],pages:r.pages.map(({access:_access,...page})=>page),coverage:r.coverage,scope:r.scope};
    }},quiz:unavailable,submission:unavailable,
  };
}
/** Ordinary runtime has no verified collectors or trustworthy HTTP envelope. */
export const disabledRegistry=():CollectorRegistry=>({assignment:unavailable,calendar:unavailable,material:unavailable,quiz:unavailable,submission:unavailable});

type FailureReason=Extract<CollectorResult,{kind:'failed'}>['reasons'][number];
const quizFailure=(reason:QuizReason):FailureReason=>
  reason==='identity_mismatch'||reason==='unsafe_url'||reason==='invalid_date'||reason==='duplicate_date'||reason==='invalid_observed_at'?reason
  :['signed_out','denied','missing_source','network_failure','transient_response','invalid_envelope','untrusted_origin','unsupported_response'].includes(reason)?'access_error'
  :'unsupported_structure';
/**
 * #20 adapter from the #14 quiz parser (verified SDU variant) to the existing
 * QuizRefreshResult wire shape. Only a complete quiz view page yields an
 * observation. The quiz instance id is not observable on the verified variant, so
 * the course-module id, which identifies the same quiz one-to-one, is used as the
 * wire `sourceActivityId`. The view-page title element was not recorded by #3, so
 * the title comes from the quiz card `.instancename` on the course page that
 * discovered the quiz (`hints.title`); without it the result fails with
 * missing_metadata instead of inventing a title.
 */
export function quizRefreshResult(input:MoodleAccessInput,observedAt:string,hints:{title?:string}={}):CollectorResult {
  const parsed=parseMoodleQuizPage(input,observedAt);
  if(parsed.page!=='quiz_view'||parsed.status!=='complete'||parsed.observations.length!==1)
    return {kind:'failed',reasons:[parsed.status==='complete'?'unsupported_page':quizFailure(parsed.diagnostics[0]?.reason??'malformed_structure')]};
  const o=parsed.observations[0]!;
  const title=(hints.title??'').replace(/\s+/gu,' ').trim();
  if(!title||title.length>256||/[<>\x00-\x1f]/.test(title))return {kind:'failed',reasons:['missing_metadata']};
  const date=(d:typeof o.opening)=>d?{value:d.value,rawText:d.rawText,location:d.location}:undefined;
  const fields=['state','allowed','used','remaining','other'] as const;
  let attemptInformation:RawQuizObservation['attemptInformation']={kind:'unknown'};
  if(o.attemptInformation.kind==='known'){
    const facts=[...new Map(o.attemptInformation.facts.map(({field,rawText,location})=>[JSON.stringify([field,rawText,location]),{field,rawText,location}])).values()];
    attemptInformation={kind:'known',facts,unknownFields:fields.filter(f=>!facts.some(x=>x.field===f)).sort()};
  }
  const opening=date(o.opening),closing=date(o.closing);
  const observation:RawQuizObservation={sourceCourseId:o.sourceCourseId,sourceActivityId:o.sourceCourseModuleId,sourceCourseModuleId:o.sourceCourseModuleId,
    sourceUrl:o.sourceUrl,title,observedAt:o.observedAt,...(opening?{opening}:{}),...(closing?{closing}:{}),attemptInformation};
  return {kind:'quiz',observations:[observation],reviews:[],diagnostics:[],pages:[],coverage:'complete',scope:'visited_activity_only'};
}
const cleanTitle=(value:string|undefined)=>{
  const title=(value??'').replace(/\s+/gu,' ').trim();
  return !title||title.length>256||/[<>\x00-\x1f]/.test(title)?undefined:title;
};
/**
 * #83 adapter from the observed assignment parser to the AssignmentRefreshResult wire
 * shape. As for quizzes, the assignment instance id is not observable, so the cmid is
 * the wire `sourceActivityId`, and the title comes from the course-page card
 * (`hints.title`); without it the result fails with missing_metadata. Only base opening
 * and due dates are observed: no extensions, effective dates equal the base dates.
 */
export function assignmentRefreshResult(input:MoodleAccessInput,observedAt:string,hints:{title?:string;sourceCourseId?:string}={}):CollectorResult {
  const parsed=parseObservedMoodleAssignment(input,observedAt,hints.sourceCourseId??'');
  if(parsed.status==='error')return {kind:'failed',reasons:[parsed.reason]};
  const title=cleanTitle(hints.title);
  if(!title)return {kind:'failed',reasons:['missing_metadata']};
  const o=parsed.observation;
  const baseDates:RawAssignmentObservation['baseDates']={};
  for(const field of ['opening','due'] as const){const d=o[field];if(d)baseDates[field]={value:d.value,rawText:d.rawText,location:d.location};}
  const observation:RawAssignmentObservation={sourceCourseId:o.sourceCourseId,sourceActivityId:o.sourceCourseModuleId,sourceCourseModuleId:o.sourceCourseModuleId,
    sourceUrl:o.sourceUrl,title,observedAt:o.observedAt,baseDates,individualExtensions:[],effectiveDates:structuredClone(baseDates)};
  return {kind:'assignment',observations:[observation],reviews:[],diagnostics:[],pages:[],coverage:'complete',scope:'visited_activity_only'};
}
/** #83 adapter from the observed upcoming-calendar collector to the CalendarRefreshResult wire shape. */
export function calendarRefreshResult(input:MoodleAccessInput,selection:readonly string[],observedAt:string):CollectorResult {
  const r=collectObservedMoodleCalendar(input,selection,observedAt);
  if(r.pages[0]?.access.status!=='accessible')return {kind:'failed',reasons:['access_error']};
  return {kind:'calendar',observations:r.observations,reviews:r.review.map(v=>({kind:'calendar' as const,...v})),diagnostics:[...r.diagnostics,...r.exclusions],
    pages:r.pages.map(({access:_access,...page})=>page),coverage:r.coverage,scope:r.scope};
}
/** #83 adapter from the observed course-page material collector to the MaterialRefreshResult wire shape. */
export function materialRefreshResult(input:MoodleAccessInput,selection:readonly string[],observedAt:string):CollectorResult {
  const r=collectObservedMoodleMaterials(input,selection,observedAt);
  if(r.status==='error')return {kind:'failed',reasons:[r.reason]};
  return {kind:'material',observations:r.observations,reviews:[],diagnostics:r.diagnostics,
    pages:[{pageIndex:0,coverage:r.coverage,candidateCount:r.candidateCount,paginationPending:false}],coverage:r.coverage,scope:'supplied_pages_only'};
}
/**
 * #81 adapter from the #16 submission status mapper to the existing
 * SubmissionRefreshResult wire shape. The SDU assignment view page shows only
 * `course-<id>` and `cmid-<id>`, never the assignment instance id that retention
 * keys on, so `hints.sourceActivityId` must come from a recorded source (a stored
 * assignment or calendar observation for the same course and cmid). Unlike the
 * quiz adapter, the cmid is never copied into `sourceActivityId`: without a
 * decimal hint the result fails with missing_identity and nothing is stored.
 * An inaccessible page maps to `unknown` (never `not_submitted`). The mapper's
 * `access`, `evidenceBasis` and `unknownReason` are not stored.
 */
export function submissionRefreshResult(input:SubmissionStatusInput,observedAt:string,hints:{sourceActivityId?:string}={}):CollectorResult {
  const parsed=parseMoodleSubmissionStatus(input,observedAt);
  if(parsed.status==='error')return {kind:'failed',reasons:[parsed.error]};
  const activity=hints.sourceActivityId;
  if(activity!==undefined&&(typeof activity!=='string'||!/^[1-9][0-9]*$/.test(activity)))return {kind:'failed',reasons:['missing_identity']};
  const o=parsed.observation;
  const observation:SubmissionSourceRecord={sourceCourseId:o.sourceCourseId,...(activity!==undefined?{sourceActivityId:activity}:{}),sourceCourseModuleId:o.sourceCourseModuleId,sourceUrl:o.sourceUrl,
    observation:{status:o.state,...(o.state!=='unknown'&&o.wording!==undefined?{evidence:o.wording}:{}),observedAt:o.observedAt,actionRequired:o.actionRequired}};
  return {kind:'submission',observations:[observation],reviews:[],diagnostics:[],pages:[],coverage:'complete',scope:'visited_activity_only'};
}
/**
 * #20 live registry: the collectors that match the observed SDU pages, each switched on
 * with its passing observed-fixture tests: #14 quiz; #83 assignment (assignment view
 * page), calendar (upcoming view) and material (course page). Submission stays
 * unavailable until #16 is wired.
 */
export function liveRegistry():CollectorRegistry {
  return {assignment:{availability:'available',evidenceMode:'verified',collect:(input,selection,time,hints)=>assignmentRefreshResult(input,time,{...hints,sourceCourseId:selection[0]??''})},
    calendar:{availability:'available',evidenceMode:'verified',collect:(input,selection,time)=>calendarRefreshResult(input,selection,time)},
    material:{availability:'available',evidenceMode:'verified',collect:(input,selection,time)=>materialRefreshResult(input,selection,time)},
    // A configured backend namespace is not proof of the active Moodle user.
    // Do not collect personal submission state until that identity is bound.
    submission:{...unavailable,evidenceMode:'verified'},
    quiz:{availability:'available',evidenceMode:'verified',collect:(input,_selection,time,hints)=>quizRefreshResult(input,time,hints)}};
}
export interface RefreshState {status:'idle'|'collecting'|'saved'|'unavailable'|'failed'|'cancelled';visitId?:string;reason?:string;receipts:PageRefreshReceipt[]}
export function pageRoute(url:string):{kind:string;id?:string}|undefined {
  const m=/^https:\/\/moodle\.sdu\.edu\.kz\/(course|mod\/(assign|quiz|resource|url|folder))\/view\.php\?id=([1-9][0-9]*)(?:#[A-Za-z0-9_-]{1,128})?$/.exec(url);
  // Group 3 is required in the regex, so it is defined whenever m is.
  if(m)return {kind:m[2]??'course',id:m[3]!};
  if(/^https:\/\/moodle\.sdu\.edu\.kz\/calendar\/view\.php(?:\?(?:view=(?:month|day|upcoming)(?:&time=[1-9][0-9]*)?|event=[1-9][0-9]*(?:&occurrence=[1-9][0-9]*)?|course=[1-9][0-9]*))?(?:#[A-Za-z0-9_-]{1,128})?$/.test(url))return {kind:'calendar'};
  return undefined;
}
const fingerprint=(c:CollectionContext)=>normalized(c);
const documentIdentity=(page:PageSource)=>normalized([page.sourceCourseId,[...page.input!.document.querySelectorAll('a[data-role="course-link"], [data-assignment-id], [data-course-module-id], [data-quiz-id]')].map(node=>[node.getAttribute('href'),node.getAttribute('data-course-id'),node.getAttribute('data-assignment-id'),node.getAttribute('data-quiz-id'),node.getAttribute('data-course-module-id')])]);
export function createPageRefresh(options:{source:()=>PageSource;repository:CollectionRepository;registry:CollectorRegistry;clock?:()=>string;uuid?:()=>string;onState?:(state:RefreshState)=>void}) {
  let generation=0,stopped=false,last:PageSource|undefined;
  let state:RefreshState={status:'idle',receipts:[]};
  const emit=(value:RefreshState)=>{state=value;options.onState?.(structuredClone(state));};
  const current=(g:number)=>!stopped&&generation===g;
  const now=options.clock??(()=>new Date().toISOString());const uuid=options.uuid??(()=>crypto.randomUUID());
  async function run(page:PageSource,g:number,visitId:string) {
    const visible=(status:RefreshState['status'],reason?:string)=>{if(current(g))emit({status,visitId,...(reason?{reason}:{}),receipts:state.receipts});};
    try {
      const route=pageRoute(page.url);if(!route){visible('unavailable','unsupported_page');return;}
      const context=await options.repository.context();if(!current(g))return;
      if(context.mode==='disabled'){visible('unavailable',context.reason??'collection_disabled');return;}
      if(!page.input){visible('unavailable','envelope_unavailable');return;}
      const input={...page.input,requestedUrl:page.input.requestedUrl.split('#')[0]!,finalUrl:page.input.finalUrl.split('#')[0]!};
      if(input.finalUrl!==page.url.split('#')[0]||input.requestedUrl!==input.finalUrl||detectMoodleAccess(input).status!=='accessible'){visible('unavailable','access_error');return;}
      const ids=context.courses.map(c=>c.sourceCourseId);
      let course=page.sourceCourseId;
      // Association is exact evidence, never the sole tracked course heuristic.
      const links=[...input.document.querySelectorAll('a[data-role="course-link"]')].map(a=>/^(?:https:\/\/moodle\.sdu\.edu\.kz(?::443)?)?\/course\/view\.php\?id=([1-9][0-9]*)$/.exec(a.getAttribute('href')??'')?.[1]).filter((v):v is string=>!!v);
      const unique=[...new Set(links)];
      if(course===undefined&&unique.length===1)course=unique[0];
      if(!course||!ids.includes(course)||(route.kind==='course'&&course!==route.id)||(unique.length>0&&!unique.includes(course))){visible('unavailable','invalid_selection');return;}
      const identity=documentIdentity(page);
      const token=await options.repository.begin({visitId,pageUrl:page.url,selectionRevision:context.selectionRevision},context.binding);if(!current(g))return;
      const collectors:Collector[]=route.kind==='assign'?['assignment','submission']:route.kind==='quiz'?['quiz']:route.kind==='calendar'?['calendar']:['material'];
      const observedAt=now();
      for(const collector of collectors) {
        if(!current(g))return;
        const adapter=options.registry[collector];let result:CollectorResult;
        try {
          if(adapter.availability==='unavailable')result={kind:'unavailable',reasons:['collector_unavailable']};
          else if(adapter.evidenceMode!==context.mode)result={kind:'unavailable',reasons:['invalid_context']};
          else result=await adapter.collect(input,ids,observedAt);
          if(!validSchema('CollectorResult',result))result={kind:'failed',reasons:['malformed_result']};
        }catch{result={kind:'failed',reasons:['collector_failed']};}
        if(!current(g))return;
        const latest=options.source();
        if(latest.url!==page.url||latest.documentKey!==page.documentKey){notify();return;}
        if(!latest.input||detectMoodleAccess(latest.input).status!=='accessible'||documentIdentity(latest)!==identity){generation++;emit({status:'cancelled',visitId,reason:'invalid_identity',receipts:state.receipts});return;}
        const before=await options.repository.context();
        if(!current(g))return;
        if(fingerprint(before)!==fingerprint(context)){generation++;emit({status:'cancelled',visitId,reason:'invalid_context',receipts:state.receipts});return;}
        const saved=await options.repository.refresh({visitToken:token.visitToken,collector,observedAt,result},context.binding);
        if(!current(g))return;
        emit({status:saved.receipt.outcome==='failed'?'failed':saved.receipt.outcome==='unavailable'?'unavailable':'saved',visitId,receipts:[...state.receipts,saved.receipt]});
      }
    }catch(e){visible('failed',e instanceof CollectionTransportError?e.reason:'persistence_failed');}
  }
  function notify():void {
    if(stopped)return;
    const page=options.source();
    if(last&&last.url===page.url&&last.documentKey===page.documentKey)return;
    last=page;const g=++generation;const visitId=uuid();emit({status:'collecting',visitId,receipts:state.receipts});
    void run(page,g,visitId);
  }
  return {notify,invalidate(){generation++;last=undefined;emit({status:'cancelled',receipts:state.receipts});},stop(){stopped=true;generation++;emit({status:'cancelled',receipts:state.receipts});},get state(){return structuredClone(state);}};
}
export function installPageRefresh(win:Window,options:Parameters<typeof createPageRefresh>[0]):()=>void {
  if(win.top!==win||win.location.origin!=='https://moodle.sdu.edu.kz')return ()=>{};
  const coordinator=createPageRefresh(options);
  const listener=()=>coordinator.notify();
  win.addEventListener('popstate',listener);win.addEventListener('hashchange',listener);
  const observer=new MutationObserver(listener);observer.observe(win.document,{subtree:true,childList:true,attributes:true});
  coordinator.notify();
  return ()=>{coordinator.stop();observer.disconnect();win.removeEventListener('popstate',listener);win.removeEventListener('hashchange',listener);};
}
