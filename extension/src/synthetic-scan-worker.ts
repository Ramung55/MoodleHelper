/**
 * Scan worker: the claim, renew and finish loop over the backend scan queue (#20).
 * The installed extension runs it with the live page source, request authority
 * and registry; the in-process synthetic harness injects its own source and
 * authority. One scan runs at a time; overlapping wakes share the current one.
 */
import {scanSyntheticCourse, type RequestAuthority, type ScanSource} from './scan-coordinator';
import type {CollectorRegistry} from './page-refresh';

type Claim={job:{id:string};token:string;generation:number;sourceCourseId:string;selectionRevision:string};
export type ScanWorkerOptions={base:string;fetcher:typeof fetch;source:ScanSource;authority:RequestAuthority;registry?:CollectorRegistry;
  now:()=>number;wait:(ms:number)=>Promise<void>;schedule:(needed:boolean)=>void};
export function createScanWorker(options:ScanWorkerOptions) {
  let disposed=false, current:Promise<void>|undefined;
  const controller=new AbortController();
  const fetcher:typeof fetch=(input,init)=>options.fetcher(input,init);
  async function request(path:string,binding?:string,body?:unknown){
    const response=await fetcher(options.base+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,
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
        valid,now:options.now,wait:options.wait,signal:controller.signal,retryScope:claim.job.id,...(options.registry?{registry:options.registry}:{})});
      if(disposed||!alive)return true;
      await request('/api/scan/finish',binding,{...token,selectionRevision:claim.selectionRevision,...result});
    }
    return true;
  }
  let again=false;
  function wake():Promise<void>{
    if(disposed)return Promise.resolve();
    // A wake during a drain (for example a bridge wake right after Sync all) runs
    // one more drain afterwards, so new work is never left for the next alarm.
    if(current){again=true;return current;}
    current=(async()=>{try{const context=await request('/api/bridge-context');
      if(typeof context.binding!=='string')throw Error('Invalid binding');
      const unfinished=await work(context.binding);if(!disposed)options.schedule(unfinished);
    }catch{if(!disposed)options.schedule(true);}})().finally(()=>{current=undefined;if(again&&!disposed){again=false;void wake();}});
    return current;
  }
  async function start(idempotencyKey:string){const context=await request('/api/bridge-context');
    const run=await request('/api/scan/runs',context.binding,{idempotencyKey});options.schedule(true);void wake();return run;}
  return {wake,start,dispose(){disposed=true;controller.abort();}};
}
/** The injected synthetic harness name for the same worker. */
export const createSyntheticScanWorker=createScanWorker;
