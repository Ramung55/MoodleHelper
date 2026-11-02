/**
 * #20 live Moodle request authority. One in-memory single-flight owner per
 * service worker: every Moodle fetch of the extension is started only while it
 * holds this authority, so at most one request is in flight across all tabs,
 * windows, alarms and bridge wakes. Durable pacing (last start, retry
 * not-before and per-request failure counts, never shortened) lives in the
 * backend's scan_request_gate row behind /api/scan/gate/*.
 *
 * Release happens only after the caller observed the fetch settle. If the backend
 * release cannot be confirmed, the in-memory owner stays held (fail closed); a
 * restarted worker (new instance id) may reclaim the backend gate only once the
 * previous request's start plus the 30 s request limit has passed.
 */
import type {RequestAuthority} from './scan-coordinator';

export function createMoodleRequestAuthority(options:{base:string;fetcher?:typeof fetch;instance:string;timeoutMs?:number}):RequestAuthority & {held:()=>boolean} {
  const fetcher:typeof fetch=(input,init)=>(options.fetcher??globalThis.fetch)(input,init);
  let owner:string|null=null, pending=false, binding:string|undefined;
  async function call(path:string,body:unknown,retry=true):Promise<any> {
    if(binding===undefined){
      const context=await (await fetcher(options.base+'/api/bridge-context',{credentials:'omit',redirect:'error',cache:'no-store'})).json();
      if(typeof context?.binding!=='string')throw Error('Invalid binding');
      binding=context.binding;
    }
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),options.timeoutMs??10_000);
    try {
      const response=await fetcher(options.base+path,{method:'POST',credentials:'omit',redirect:'error',signal:controller.signal,
        headers:{Accept:'application/json','Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding!},body:JSON.stringify(body)});
      if(response.status===409&&retry){binding=undefined;return call(path,body,false);}
      if(!response.ok)throw Error('Gate unavailable');
      return await response.json();
    } finally {clearTimeout(timer);}
  }
  return {
    held:()=>owner!==null||pending,
    async acquire(now,requestKey) {
      if(owner!==null||pending)return null;
      pending=true;
      try {
        const reply=await call('/api/scan/gate/acquire',{nowMs:now,instance:options.instance,...(requestKey!==undefined?{requestKey}:{})});
        if(reply?.state==='reserved'&&typeof reply.token==='string'){
          owner=reply.token;
          return requestKey!==undefined?{token:reply.token,failures:Number.isInteger(reply.failures)?reply.failures:0}:reply.token;
        }
        return reply?.state==='exhausted'?'exhausted':null;
      } catch {return null;}
      finally {pending=false;}
    },
    async releaseAfterTermination(token,notBefore,requestKey,retryFailure) {
      if(owner===null||owner!==token)return false;
      for(let attempt=0;attempt<3;attempt++){
        try {
          const reply=await call('/api/scan/gate/release',{token,notBeforeMs:Math.max(0,Math.trunc(notBefore)),
            ...(requestKey!==undefined?{requestKey}:{}),...(requestKey!==undefined&&retryFailure!==undefined?{retryFailure}:{})});
          // The fetch already settled, so the in-memory owner ends either way.
          owner=null;
          return reply?.released===true;
        } catch {/* retry, then stay held */}
      }
      return false;
    },
  };
}
