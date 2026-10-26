/** Disposable MV3 mock queue. SQLite owns all durable state; execution can repeat. */
import { BACKEND } from './dashboard-bridge';
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
  async function request(path:string, binding?:string, body?:unknown) {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10_000);
    try {
      const r=await fetcher(base+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,
        headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding!})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      if (!r.ok) throw new Error('queue unavailable');
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  async function work(binding:string, status:{unfinished:boolean}) {
    while(!disposed) {
      const response=await request('/api/queue/claim',binding,{}) as ClaimReply;
      if(typeof response.unfinished!=='boolean') throw new Error('invalid response');
      status.unfinished ||= response.unfinished;
      const claim=response.claim;
      if(!claim) return;
      let alive=true, renewing=false;
      const token={jobId:claim.job.id,generation:claim.generation,token:claim.token};
      const timer=setInterval(()=>{
        if(disposed||!alive||renewing) return;
        renewing=true;
        void request('/api/queue/renew',binding,token).catch(()=>{alive=false;}).finally(()=>{renewing=false;});
      },options.renewMs??RENEW_MS);
      let outcome:'completed'|'failed'='completed';
      try { await executor(claim.job); } catch { outcome='failed'; }
      clearInterval(timer);
      if(disposed||!alive) return;
      await request('/api/queue/finish',binding,{...token,outcome,...(outcome==='failed'?{errorCode:'mock_failure'}:{})});
    }
  }
  async function wake() {
    if(disposed) return;
    if(current) return current;
    current=(async()=>{
      try {
        const context=await request('/api/bridge-context');
        if(typeof context.binding!=='string') throw new Error('invalid context');
        const status={unfinished:false};
        await Promise.all(Array.from({length:slots},()=>work(context.binding,status)));
        if(!disposed) options.schedule(status.unfinished);
      } catch { if(!disposed) options.schedule(true); }
    })().finally(()=>{current=undefined;});
    return current;
  }
  async function start(idempotencyKey:string,courseIds:string[]) {
    const context=await request('/api/bridge-context');
    const run=await request('/api/queue/runs',context.binding,{idempotencyKey,courseIds});
    options.schedule(true); void wake(); return run;
  }
  return {wake,start,dispose(){disposed=true;}};
}

type QueueChrome = { alarms:{create:(name:string,info:{delayInMinutes:number})=>void;clear:(name:string)=>void;onAlarm:{addListener:(cb:(alarm:{name:string})=>void)=>void}};runtime:{onStartup:{addListener:(cb:()=>void)=>void};onInstalled:{addListener:(cb:()=>void)=>void}} };
export function installQueueWorker(chrome:QueueChrome) {
  // A bounded one-shot alarm also discovers runs started through the local HTTP API.
  const service=createQueueService({schedule:()=>chrome.alarms.create(ALARM_NAME,{delayInMinutes:1})});
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM_NAME) void service.wake();});
  chrome.runtime.onStartup.addListener(()=>{void service.wake();});
  chrome.runtime.onInstalled.addListener(()=>{void service.wake();});
  void service.wake();
  return service;
}
