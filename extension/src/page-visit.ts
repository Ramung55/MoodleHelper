/**
 * #95 live update while browsing SDU Moodle (see _docs/page-refresh-contract.md, "#95").
 *
 * The content script only says "this top-frame SDU document finished loading" and,
 * from its `<body>` class, which course it belongs to. The worker trusts the URL only
 * from the browser's sender data. For a supported page of a selected course it makes
 * ONE GET of that same URL through the live scan's page source and request authority
 * (same rules as Sync all: real status, final URL, content type, 1 MiB cap, offscreen
 * analysis with the live registry, #93 `M.cfg` user id). The results go through the
 * existing visit/refresh routes, where the backend saves them only past #93's account
 * check. No other page is requested, nothing is posted to Moodle.
 */
import {BACKEND} from './dashboard-bridge';
import {collectionSender} from './collection-repository';
import {UPCOMING_CALENDAR_URL} from './moodle-calendar';
import {pageRoute, type Collector} from './page-refresh';
import type {RequestAuthority, ScanSource} from './scan-coordinator';
import type {CollectionContext, CollectorResult} from '../../frontend/src/domain/types';
import type {Sender} from './dashboard-bridge';

export const VISIT_SOURCE='moodle-helper-page-visit';
export const VISIT_STATE_SOURCE='moodle-helper-page-visit-state';
export const VISIT_MESSAGES={
  collecting:'Updating deadlines from this page…',
  saved:'Deadlines from this page were saved.',
  not_supported:'This page is not supported for live updates.',
  not_selected:'This course is not selected in Moodle Helper. Nothing was saved.',
  disabled:'Live updates work only with your own dataset. Nothing was saved.',
  signed_out:'Sign in to SDU Moodle to continue.',
  needs_sync:'Run Sync all once to add this activity. Nothing was saved.',
  account_mismatch:'The signed-in Moodle account is not the account of this dataset. Nothing was saved.',
  account_unconfirmed:'The Moodle account could not be confirmed. Nothing was saved.',
  failed:'This page could not be updated. Earlier data was kept.',
} as const;
export type VisitStatus=keyof typeof VISIT_MESSAGES;
export interface VisitState {status:VisitStatus;message:string}
type Kind='course'|'assign'|'quiz'|'calendar';

/** The supported visit routes: exactly the pages the live scan reads (#83/#14). */
export function visitRoute(url:string):{kind:Kind;id?:string}|undefined {
  if(url===UPCOMING_CALENDAR_URL)return {kind:'calendar'};
  const route=pageRoute(url);
  if(!route||url.includes('#')||!['course','assign','quiz'].includes(route.kind))return undefined;
  return {kind:route.kind as Kind,id:route.id!};
}
const COLLECTORS:Record<Kind,Collector[]>={course:['material'],assign:['assignment','submission'],quiz:['quiz'],calendar:['calendar']};
const DECIMAL=/^[1-9][0-9]{0,18}$/;
const ACQUIRE_LIMIT_MS=8_000;
const BACKEND_TIMEOUT_MS=10_000;
const MAX_TABS=64;

export function createPageVisitWorker(options:{source:ScanSource;authority:RequestAuthority;base?:string;fetcher?:typeof fetch;now?:()=>number;wait?:(ms:number)=>Promise<void>;uuid?:()=>string}) {
  const base=options.base??BACKEND, now=options.now??Date.now;
  const fetcher:typeof fetch=(input,init)=>(options.fetcher??globalThis.fetch)(input,init);
  const wait=options.wait??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const uuid=options.uuid??(()=>crypto.randomUUID());
  const states=new Map<number,{documentKey:string;state:VisitState}>();
  const running=new Map<string,Promise<VisitState>>();
  const set=(tab:number,documentKey:string,status:VisitStatus):VisitState=>{
    const state={status,message:VISIT_MESSAGES[status]};
    // A later document of the same tab owns its state; an older visit never overwrites it.
    if(states.get(tab)?.documentKey!==documentKey&&status!=='collecting'&&states.has(tab))return state;
    states.delete(tab);states.set(tab,{documentKey,state});
    while(states.size>MAX_TABS)states.delete(states.keys().next().value!);
    return state;
  };
  async function backend<T>(path:string,binding?:string,body?:unknown):Promise<{status:number;body?:T}> {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),BACKEND_TIMEOUT_MS);
    try {
      const response=await fetcher(base+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,
        headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding!})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      let parsed:T|undefined;try {parsed=await response.json() as T;}catch {parsed=undefined;}
      return {status:response.status,...(parsed!==undefined?{body:parsed}:{})};
    } finally {clearTimeout(timer);}
  }
  async function fetchPage(url:string,context:{sourceCourseId:string;collectors:Collector[];title?:string;selection?:string[]}) {
    let token:string|undefined;const since=now();
    while(!token){
      const reservation=await options.authority.acquire(now());
      if(typeof reservation==='string')token=reservation;
      else if(reservation&&typeof reservation==='object')token=reservation.token;
      else if(reservation==='exhausted'||now()-since>=ACQUIRE_LIMIT_MS)return undefined;
      else await wait(100);
    }
    const startedAt=now();
    let request:ReturnType<ScanSource['start']>;
    try {request=options.source.start(url,context);}
    catch {await options.authority.releaseAfterTermination(token,0);return undefined;}
    let response:Awaited<typeof request.completion>|undefined;
    try {response=await request.completion;}catch {response=undefined;}
    let settled=false;try {settled=await request.termination;}catch {settled=false;}
    // An unsettled fetch keeps the authority held (fail closed), as in the scan.
    if(!settled)return undefined;
    await options.authority.releaseAfterTermination(token,startedAt+1000);
    return response;
  }
  async function run(url:string,tab:number,documentKey:string,courseHint:unknown):Promise<VisitState> {
    const route=visitRoute(url);
    if(!route)return set(tab,documentKey,'not_supported');
    set(tab,documentKey,'collecting');
    try {
      const got=await backend<CollectionContext>('/api/collection-context');
      const context=got.body;
      if(got.status!==200||!context||context.mode!=='verified')return set(tab,documentKey,'disabled');
      const tracked=context.courses.map(c=>c.sourceCourseId);
      // The course comes from the URL (course page) or the page's own `course-<id>` class;
      // the fetched page must show the same class, or the access check fails it.
      const course=route.kind==='course'?route.id!:route.kind==='calendar'?tracked[0]:typeof courseHint==='string'&&DECIMAL.test(courseHint)?courseHint:undefined;
      if(!course||!tracked.includes(course))return set(tab,documentKey,'not_selected');
      const begun=await backend<{visitToken:string;title?:string}>('/api/collection/visits',context.binding,{documentKey,visitId:uuid(),pageUrl:url,selectionRevision:context.selectionRevision});
      if(begun.status!==200||typeof begun.body?.visitToken!=='string')return set(tab,documentKey,'failed');
      const collectors=COLLECTORS[route.kind];
      const page=await fetchPage(url,{sourceCourseId:course,collectors,...(begun.body.title?{title:begun.body.title}:{}),...(route.kind==='calendar'?{selection:tracked}:{})});
      if(!page)return set(tab,documentKey,'failed');
      if(page.access?.status!=='accessible')return set(tab,documentKey,page.access?.status==='signed_out'?'signed_out':'failed');
      let status:VisitStatus='saved';
      for(const collector of collectors){
        const result:CollectorResult=page.collected?.[collector]??{kind:'unavailable',reasons:['collector_unavailable']};
        const saved=await backend<{message?:string}>('/api/collection/refresh',context.binding,{visitToken:begun.body.visitToken,observedAt:page.observedAt??new Date(now()).toISOString(),collector,result,
          ...(page.moodleUserId?{moodleUserId:page.moodleUserId}:{})});
        if(saved.status===409&&saved.body?.message===VISIT_MESSAGES.account_mismatch)return set(tab,documentKey,'account_mismatch');
        if(saved.status===409&&saved.body?.message===VISIT_MESSAGES.account_unconfirmed)return set(tab,documentKey,'account_unconfirmed');
        if(saved.status!==200)return set(tab,documentKey,'failed');
        if(result.kind==='failed'&&result.reasons.includes('missing_metadata'))status='needs_sync';
        else if(result.kind==='failed'&&status==='saved')status='failed';
      }
      return set(tab,documentKey,status);
    } catch {return set(tab,documentKey,'failed');}
  }
  return {
    /** One visit per browser document: duplicate notifications share the first run. */
    visit(sender:Sender,courseHint?:unknown):Promise<VisitState> {
      const tab=sender.tab!.id!, documentKey=`${tab}:${sender.documentId}`, url=sender.url!;
      const existing=running.get(documentKey);
      if(existing)return existing;
      const work=run(url,tab,documentKey,courseHint);
      running.set(documentKey,work);
      while(running.size>MAX_TABS)running.delete(running.keys().next().value!);
      return work;
    },
    state(tab:number):VisitState|undefined {return states.get(tab)?.state;},
  };
}
type VisitChrome={runtime:{id:string;onMessage:{addListener:(f:(message:any,sender:Sender,reply:(value:unknown)=>void)=>boolean|undefined)=>void}}};
/** Content-script visits from exact SDU top frames; state questions from this extension's popup only. */
export function installPageVisitWorker(chrome:VisitChrome,worker:ReturnType<typeof createPageVisitWorker>) {
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.source===VISIT_SOURCE&&message.version==='1'&&collectionSender(sender,chrome.runtime.id)){
      void worker.visit(sender,message.sourceCourseId).then(state=>reply(state));return true;
    }
    if(message?.source===VISIT_STATE_SOURCE&&sender.id===chrome.runtime.id&&sender.tab===undefined&&Number.isInteger(message.tabId)){
      reply(worker.state(message.tabId)??null);return undefined;
    }
    return undefined;
  });
}
