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
import {retryAfterDeadline, scanRetryDecision} from './scan-retry';

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

/**
 * #41 transfer-page lease. The packaged transfer page fetches one explicitly clicked
 * file, but only while it holds this lease, which counts as the one in-flight Moodle
 * request of the authority above: the same backend gate acquire and release, the
 * same >= 1 s spacing and the same 30 s request limit. Protocol over a
 * `chrome.runtime.connect({name: TRANSFER_LEASE_PORT})` port:
 *   page -> {type:'acquire', transferId}
 *   worker -> {type:'granted'} | {type:'timeout'} (no lease within 30 s) | {type:'refused'}
 *   page -> {type:'settled', status?, retryAfter?} once its fetch and body have settled
 *   worker -> {type:'released'} and disconnects.
 * The lease is released when the page reports that its fetch settled, or when the
 * port disconnects (tab closed). A worker restart disconnects the port and the page
 * aborts its fetch. Only this extension's transfer.html tab opened for that
 * transferId may hold a lease. A 429/503 is not retried here: the page ends the
 * transfer, and the retry wait (2 s, or a longer Retry-After) still applies to the
 * next Moodle request of any kind.
 */
export const TRANSFER_LEASE_PORT='moodle-transfer-lease';
export const LEASE_WAIT_MS=30_000;
export const LEASE_REQUEST_LIMIT_MS=30_000;
export type LeaseSender={id?:string;url?:string;frameId?:number;tab?:{id?:number}};
export type LeasePort={name:string;sender?:LeaseSender;postMessage(message:unknown):void;disconnect():void;
  onMessage:{addListener(listener:(message:any)=>void):void};onDisconnect:{addListener(listener:()=>void):void}};
export function createTransferLeaseHost(options:{authority:RequestAuthority;now:()=>number;wait:(ms:number)=>Promise<void>;
  extensionId:string;transferPageUrl:string;tabFor:(transferId:string)=>number|undefined;waitMs?:number;requestLimitMs?:number}) {
  const waitLimit=Math.min(options.waitMs??LEASE_WAIT_MS,LEASE_WAIT_MS);
  const requestLimit=Math.min(options.requestLimitMs??LEASE_REQUEST_LIMIT_MS,LEASE_REQUEST_LIMIT_MS);
  function trusted(sender:LeaseSender|undefined,transferId:unknown):transferId is string {
    if(typeof transferId!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(transferId)||!sender)return false;
    const tab=options.tabFor(transferId);
    return sender.id===options.extensionId&&sender.url===options.transferPageUrl+'#'+transferId&&
      (sender.frameId===undefined||sender.frameId===0)&&tab!==undefined&&sender.tab?.id===tab;
  }
  return {
    onConnect(port:LeasePort) {
      if(port.name!==TRANSFER_LEASE_PORT)return;
      let state:'idle'|'waiting'|'held'|'done'='idle', token:string|undefined, startedAt=0, guard:ReturnType<typeof setTimeout>|undefined;
      const post=(message:unknown)=>{try{port.postMessage(message);}catch{/* page gone */}};
      const close=()=>{try{port.disconnect();}catch{/* already closed */}};
      async function release(notBefore:number) {
        if(token===undefined)return;
        const held=token;token=undefined;
        if(guard)clearTimeout(guard);
        await options.authority.releaseAfterTermination(held,notBefore);
      }
      port.onDisconnect.addListener(()=>{
        const wasHeld=state==='held';state='done';
        if(wasHeld)void release(startedAt+1000);
      });
      port.onMessage.addListener(message=>{
        if(message?.type==='acquire'&&state==='idle'){
          if(!trusted(port.sender,message.transferId)){state='done';post({type:'refused'});close();return;}
          state='waiting';
          void (async()=>{
            const since=options.now();
            while(state==='waiting'){
              const reservation=await options.authority.acquire(options.now());
              const got=typeof reservation==='string'?reservation:reservation&&typeof reservation==='object'?reservation.token:undefined;
              if(got!==undefined){
                token=got;
                if(state!=='waiting'){await release(options.now()+1000);return;} // the page left while we waited
                state='held';startedAt=options.now();
                // Backstop only: the page aborts its own fetch at the 30 s limit.
                guard=setTimeout(()=>{if(state==='held'){state='done';close();void release(startedAt+1000);}},requestLimit+5000);
                post({type:'granted'});
                return;
              }
              if(reservation==='exhausted'||!(options.now()-since<waitLimit)){state='done';post({type:'timeout'});close();return;}
              await options.wait(100);
            }
          })();
        } else if(message?.type==='settled'&&state==='held'){
          state='done';
          const failedAt=options.now();
          const status=Number.isInteger(message.status)?message.status:undefined;
          const retryAfter=typeof message.retryAfter==='string'&&message.retryAfter.length<=64?message.retryAfter:undefined;
          let deadline=startedAt+1000;
          if(status===429||status===503){
            const decision=scanRetryDecision(failedAt,1,retryAfter);
            const server=retryAfter!==undefined?retryAfterDeadline(failedAt,retryAfter):undefined;
            deadline=Math.max(deadline,failedAt+2000,decision.kind==='retry'?decision.notBefore:0,
              server!==undefined&&server<=failedAt+86_400_000?server:0);
          }
          void release(deadline).then(()=>{post({type:'released'});close();});
        }
      });
    },
  };
}
