/** Disposable MV3 mock queue. SQLite owns all durable state; execution can repeat. */
import { BACKEND, transferTabFor } from './dashboard-bridge';
import {createScanWorker, type ScanWorkerOptions} from './synthetic-scan-worker';
import {createMoodlePageSource, createOffscreenClient, type OffscreenChrome} from './moodle-page-source';
import {createPageVisitWorker, installPageVisitWorker} from './page-visit';
import {createMoodleRequestAuthority, createTransferLeaseHost, type LeasePort} from './moodle-request-authority';
import {liveRegistry} from './page-refresh';
import type {AccessChecker, Analyzer} from './moodle-page-analysis';
import {createCourseDiscovery} from './course-discovery';
import {createSignInProbe} from './moodle-sign-in-probe';
type Job = { id:string; courseId:string };
type Claim = { job:Job; token:string; generation:number; expiresAt:number };
type ClaimReply = { unfinished:boolean; claim?:Claim };
type Executor = (job:Job)=>Promise<void>;
export const ALARM_NAME = 'moodle-helper-mock-queue';
export const RENEW_MS = 20_000;
export const mockExecutor:Executor = async (_job) => { /* synthetic only; no Moodle access */ };

export function createQueueService(options:{fetcher?:typeof fetch; executor?:Executor; base?:string; slots?:number; schedule:(needed:boolean)=>void; renewMs?:number}) {
  const fetcher=options.fetcher??fetch, executor=options.executor??mockExecutor, base=options.base??BACKEND;
  const slots=Math.max(1,Math.min(4,options.slots??4));
  let disposed=false, current:Promise<void>|undefined;
  const intervals=new Set<ReturnType<typeof setInterval>>();
  const controllers=new Set<AbortController>();
  async function request(path:string, binding?:string, body?:unknown) {
    const controller=new AbortController(); controllers.add(controller); const timer=setTimeout(()=>controller.abort(),10_000);
    try {
      const r=await fetcher(base+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,
        headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding!})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      if (!r.ok) throw new Error('queue unavailable');
      return await r.json();
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  async function work(binding:string):Promise<boolean> {
    while(!disposed) {
      const response=await request('/api/queue/claim',binding,{}) as ClaimReply;
      if(typeof response.unfinished!=='boolean') throw new Error('invalid response');
      const claim=response.claim;
      if(!claim) return response.unfinished;
      let alive=true, renewing=false;
      const token={jobId:claim.job.id,generation:claim.generation,token:claim.token};
      const timer=setInterval(()=>{
        if(disposed||!alive||renewing) return;
        renewing=true;
        void request('/api/queue/renew',binding,token).catch(()=>{alive=false;}).finally(()=>{renewing=false;});
      },options.renewMs??RENEW_MS);
      intervals.add(timer);
      let outcome:'completed'|'failed'='completed';
      try { await executor(claim.job); } catch { outcome='failed'; }
      clearInterval(timer); intervals.delete(timer);
      if(disposed||!alive) return true;
      await request('/api/queue/finish',binding,{...token,outcome,...(outcome==='failed'?{errorCode:'mock_failure'}:{})});
    }
    return true;
  }
  async function wake() {
    if(disposed) return;
    if(current) return current;
    current=(async()=>{
      try {
        const context=await request('/api/bridge-context');
        if(typeof context.binding!=='string') throw new Error('invalid context');
        const results=await Promise.allSettled(Array.from({length:slots},()=>work(context.binding)));
        if(disposed) return;
        if(results.some(result=>result.status==='rejected')) { options.schedule(true); return; }
        // All local work has settled. A final drain observes the current durable
        // state, including claims held by another worker, without losing a claim.
        const unfinished=await work(context.binding);
        if(!disposed) options.schedule(unfinished);
      } catch { if(!disposed) options.schedule(true); }
    })().finally(()=>{current=undefined;});
    return current;
  }
  async function start(idempotencyKey:string,courseIds:string[]) {
    const context=await request('/api/bridge-context');
    const run=await request('/api/queue/runs',context.binding,{idempotencyKey,courseIds});
    options.schedule(true); void wake(); return run;
  }
  return {wake,start,dispose(){disposed=true; for(const timer of intervals) clearInterval(timer); intervals.clear(); for(const controller of controllers) controller.abort(); controllers.clear();}};
}

type QueueChrome = { alarms:{create:(name:string,info:{delayInMinutes:number;periodInMinutes:number})=>void;clear:(name:string)=>void;onAlarm:{addListener:(cb:(alarm:{name:string})=>void)=>void}};runtime:{onStartup:{addListener:(cb:()=>void)=>void};onInstalled:{addListener:(cb:()=>void)=>void}} } & {runtime:OffscreenChrome['runtime'];offscreen?:OffscreenChrome['offscreen']} &
  {runtime:{id?:string;onConnect?:{addListener:(cb:(port:LeasePort)=>void)=>void};onMessage?:Parameters<typeof installPageVisitWorker>[0]['runtime']['onMessage']}};
type SyntheticOptions=Omit<ScanWorkerOptions, 'base'|'fetcher'|'schedule'>;
/** In-process test seams for the live scan; the installed extension passes none. */
export type LiveScanOptions={moodleFetch?:typeof fetch;now?:()=>number;wait?:(ms:number)=>Promise<void>;instance?:string;analyze?:Analyzer;access?:AccessChecker;requestLimitMs?:number;transferTabFor?:(transferId:string)=>number|undefined};
export function installQueueWorker(chrome:QueueChrome, options:Partial<Omit<Parameters<typeof createQueueService>[0], 'schedule'>> & {syntheticScan?:SyntheticOptions;liveScan?:LiveScanOptions}={}) {
  // One periodic alarm discovers runs created directly through the local API.
  // Register it and all listeners before any asynchronous worker activity.
  chrome.alarms.create(ALARM_NAME,{delayInMinutes:1,periodInMinutes:1});
  const {syntheticScan,liveScan={},...queueOptions}=options;
  const service=createQueueService({...queueOptions,schedule:()=>{}});
  const base=queueOptions.base??BACKEND;
  const fetcher:typeof fetch=(input,init)=>(queueOptions.fetcher??globalThis.fetch)(input,init);
  // The in-process synthetic harness injects its own source and authority. The
  // installed extension always runs the live scan: the live page source, the
  // single-flight request authority and the live registry (#20). Only a run
  // created by Sync all (or the local scan API) gives it any Moodle work.
  const now=liveScan.now??Date.now, wait=liveScan.wait??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  // One request authority per worker: the live scan and course discovery (#82) share it,
  // so their Moodle requests interleave but never overlap. One offscreen client as well.
  const offscreen=createOffscreenClient(chrome);
  const authority=createMoodleRequestAuthority({base,fetcher,instance:liveScan.instance??(globalThis.crypto?.randomUUID?.()??String(Math.random()).slice(2))});
  const scan=syntheticScan ? createScanWorker({...syntheticScan,base,fetcher,schedule:()=>{}})
    : createScanWorker({base,fetcher,schedule:()=>{},now,wait,registry:liveRegistry(),
        source:createMoodlePageSource({...(liveScan.moodleFetch?{fetcher:liveScan.moodleFetch}:{}),...(liveScan.requestLimitMs?{requestLimitMs:liveScan.requestLimitMs}:{}),analyze:liveScan.analyze??offscreen.analyze,now}),
        authority});
  // #82: runs only when the bridge discoverCourses operation (an explicit click) asks.
  const discovery=createCourseDiscovery({base,fetcher,authority,access:liveScan.access??offscreen.access,now,wait,
    ...(liveScan.moodleFetch?{moodleFetch:liveScan.moodleFetch}:{}),...(liveScan.requestLimitMs?{requestLimitMs:liveScan.requestLimitMs}:{})});
  // #46: the onboarding sign-in probe; one GET /my/courses.php through the same authority.
  const signIn=createSignInProbe({base,fetcher,authority,access:liveScan.access??offscreen.access,now,wait,
    ...(liveScan.moodleFetch?{moodleFetch:liveScan.moodleFetch}:{}),...(liveScan.requestLimitMs?{requestLimitMs:liveScan.requestLimitMs}:{})});
  // #41: the transfer page's file fetch takes a lease from the same authority, so a
  // download, a scan and course discovery never overlap their Moodle requests.
  if(chrome.runtime.onConnect&&chrome.runtime.id&&chrome.runtime.getURL){
    const leases=createTransferLeaseHost({authority,now,wait,extensionId:chrome.runtime.id,
      transferPageUrl:chrome.runtime.getURL('transfer.html'),tabFor:liveScan.transferTabFor??transferTabFor});
    chrome.runtime.onConnect.addListener(port=>leases.onConnect(port));
  }
  // #95: a page the student opens is read once through the same authority and page rules.
  let visits:ReturnType<typeof createPageVisitWorker>|undefined;
  if(!syntheticScan&&chrome.runtime.id&&chrome.runtime.onMessage){
    visits=createPageVisitWorker({base,fetcher,authority,now,wait,
      source:createMoodlePageSource({...(liveScan.moodleFetch?{fetcher:liveScan.moodleFetch}:{}),...(liveScan.requestLimitMs?{requestLimitMs:liveScan.requestLimitMs}:{}),analyze:liveScan.analyze??offscreen.analyze,now})});
    installPageVisitWorker(chrome as Parameters<typeof installPageVisitWorker>[0],visits);
  }
  const wake=async()=>{await Promise.all([service.wake(),scan.wake()]);};
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM_NAME) void wake();});
  chrome.runtime.onStartup.addListener(()=>{void wake();});
  chrome.runtime.onInstalled.addListener(()=>{void wake();});
  void wake();
  return {...service,wake,wakeScan:()=>scan.wake(),discoverCourses:()=>discovery.discover(),checkMoodleSignIn:()=>signIn.check(),visits,dispose(){service.dispose();scan.dispose();}};
}
