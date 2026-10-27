/** Injectable synthetic-only worker. This is never installed by the ordinary extension runtime. */
import {scanSyntheticCourse, type RequestAuthority, type SyntheticSource} from './scan-coordinator';

type Claim={job:{id:string};token:string;generation:number;sourceCourseId:string;selectionRevision:string};
export function createSyntheticScanWorker(options:{base:string;fetcher:typeof fetch;source:SyntheticSource;authority:RequestAuthority;now:()=>number;wait:(ms:number)=>Promise<void>;schedule:(needed:boolean)=>void}) {
  let disposed=false, current:Promise<void>|undefined;
  const controller=new AbortController();
  async function request(path:string,binding?:string,body?:unknown){
    const response=await options.fetcher(options.base+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,
      headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding!})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok)throw Error('Scan unavailable');return response.json();
  }
  async function work(binding:string):Promise<boolean>{
    while(!disposed){
      const reply=await request('/api/scan/claim',binding,{}) as {unfinished:boolean;claim?:Claim};
      if(typeof reply.unfinished!=='boolean')throw Error('Invalid claim');
      if(!reply.claim)return reply.unfinished;
      const claim=reply.claim, token={jobId:claim.job.id,generation:claim.generation,token:claim.token};
      let alive=true;
      const valid=async()=>{if(disposed||!alive)return false;try{await request('/api/scan/renew',binding,token);return true;}catch{alive=false;return false;}};
      const result=await scanSyntheticCourse({source:options.source,authority:options.authority,sourceCourseId:claim.sourceCourseId,
        valid,now:options.now,wait:options.wait,signal:controller.signal,retryScope:claim.job.id});
      if(disposed||!alive)return true;
      await request('/api/scan/finish',binding,{...token,selectionRevision:claim.selectionRevision,...result});
    }
    return true;
  }
  function wake(){
    if(disposed)return Promise.resolve();if(current)return current;
    current=(async()=>{try{const context=await request('/api/bridge-context');
      if(typeof context.binding!=='string')throw Error('Invalid binding');
      const unfinished=await work(context.binding);if(!disposed)options.schedule(unfinished);
    }catch{if(!disposed)options.schedule(true);}})().finally(()=>{current=undefined;});
    return current;
  }
  async function start(idempotencyKey:string){const context=await request('/api/bridge-context');
    const run=await request('/api/scan/runs',context.binding,{idempotencyKey});options.schedule(true);void wake();return run;}
  return {wake,start,dispose(){disposed=true;controller.abort();}};
}

/** Harness installation binds wakeup to its scheduler; no live runtime invokes this. */
export function installSyntheticScanWorker(register:(wake:()=>void)=>void, options:Parameters<typeof createSyntheticScanWorker>[0]) {
  const worker=createSyntheticScanWorker(options);register(()=>{void worker.wake();});return worker;
}
