/** Production visited-page algorithm; all synthetic facilities are injected. */
import { detectMoodleAccess, type MoodleAccessInput } from './moodle-access';
import { parseMoodleAssignment } from './moodle-assignments';
import { collectMoodleCalendar } from './moodle-calendar';
import { collectMoodleMaterials } from './moodle-materials';
import type { CollectionRepository } from './collection-repository';
import { CollectionTransportError } from './collection-repository';
import { validSchema, normalized } from '../../shared/src/bridge';
import type { CollectorResult, CollectionContext, PageRefreshReceipt } from '../../frontend/src/domain/types';

export type Collector = 'assignment'|'calendar'|'material'|'quiz'|'submission';
export interface PageSource { url:string;documentKey:object|string;input?:MoodleAccessInput;sourceCourseId?:string }
export interface CollectorAdapter {availability:'available'|'unavailable';evidenceMode:'synthetic'|'verified';collect:(input:MoodleAccessInput,selection:readonly string[],observedAt:string)=>Promise<CollectorResult>|CollectorResult}
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
export interface RefreshState {status:'idle'|'collecting'|'saved'|'unavailable'|'failed'|'cancelled';visitId?:string;reason?:string;receipts:PageRefreshReceipt[]}
export function pageRoute(url:string):{kind:string;id?:string}|undefined {
  const m=/^https:\/\/moodle\.sdu\.edu\.kz\/(course|mod\/(assign|quiz|resource|url|folder))\/view\.php\?id=([1-9][0-9]*)(?:#[A-Za-z0-9_-]{1,128})?$/.exec(url);
  if(m)return {kind:m[2]??'course',id:m[3]};
  if(/^https:\/\/moodle\.sdu\.edu\.kz\/calendar\/view\.php(?:\?(?:view=(?:month|day|upcoming)(?:&time=[1-9][0-9]*)?|event=[1-9][0-9]*(?:&occurrence=[1-9][0-9]*)?|course=[1-9][0-9]*))?(?:#[A-Za-z0-9_-]{1,128})?$/.test(url))return {kind:'calendar'};
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
