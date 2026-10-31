/** Disposable MV3 mock queue. SQLite owns all durable state; execution can repeat. */
import { BACKEND } from './dashboard-bridge';
import {createSyntheticScanWorker} from './synthetic-scan-worker';
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

type QueueChrome = { alarms:{create:(name:string,info:{delayInMinutes:number;periodInMinutes:number})=>void;clear:(name:string)=>void;onAlarm:{addListener:(cb:(alarm:{name:string})=>void)=>void}};runtime:{onStartup:{addListener:(cb:()=>void)=>void};onInstalled:{addListener:(cb:()=>void)=>void}} };
type SyntheticOptions=Omit<Parameters<typeof createSyntheticScanWorker>[0], 'base'|'fetcher'|'schedule'>;
export function installQueueWorker(chrome:QueueChrome, options:Partial<Omit<Parameters<typeof createQueueService>[0], 'schedule'>> & {syntheticScan?:SyntheticOptions}={}) {
  // One periodic alarm discovers runs created directly through the local API.
  // Register it and all listeners before any asynchronous worker activity.
  chrome.alarms.create(ALARM_NAME,{delayInMinutes:1,periodInMinutes:1});
  const {syntheticScan,...queueOptions}=options;
  const service=createQueueService({...queueOptions,schedule:()=>{}});
  // Only the in-process synthetic harness can supply this dependency. The
  // installed extension supplies none and has no message/configuration switch.
  const scan=syntheticScan ? createSyntheticScanWorker({...syntheticScan,base:queueOptions.base??BACKEND,fetcher:queueOptions.fetcher??fetch,schedule:()=>{}}) : undefined;
  const wake=async()=>{await Promise.all([service.wake(),scan?.wake()]);};
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM_NAME) void wake();});
  chrome.runtime.onStartup.addListener(()=>{void wake();});
  chrome.runtime.onInstalled.addListener(()=>{void wake();});
  void wake();
  return {...service,wake,dispose(){service.dispose();scan?.dispose();}};
}
