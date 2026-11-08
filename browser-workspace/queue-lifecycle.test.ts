import { it, expect } from 'vitest';
import { createQueueService, installQueueWorker, ALARM_NAME } from '../extension/src/queue';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

it('clears the alarm after an empty queue and a fully drained job',async()=>{
 const calls:boolean[]=[];let claimed=false,finished=false;
 const fetcher:typeof fetch=async url=>{
   if(String(url).endsWith('bridge-context'))return json({binding:'binding'});
   if(String(url).endsWith('/claim')){if(!claimed){claimed=true;return json({unfinished:true,claim:{job:{id:'job',courseId:'course'},token:'token',generation:1,expiresAt:60}});}return json({unfinished:!finished});}
   if(String(url).endsWith('/finish')){finished=true;return json({});}throw Error('unexpected');
 };
 const worker=createQueueService({fetcher,slots:1,schedule:v=>calls.push(v)});
 await worker.wake();expect(calls.at(-1)).toBe(false);await worker.wake();expect(calls.at(-1)).toBe(false);worker.dispose();
});

it('clears renewal immediately on disposal while an executor remains unresolved',async()=>{
 const blocked=gate(),entered=gate();let renewals=0, finishes=0;
 const fetcher:typeof fetch=async url=>{
   if(String(url).endsWith('bridge-context'))return json({binding:'binding'});
   if(String(url).endsWith('/claim'))return json({unfinished:true,claim:{job:{id:'job',courseId:'course'},token:'token',generation:1,expiresAt:60}});
   if(String(url).endsWith('/renew')){renewals++;return json({expiresAt:100});}
   if(String(url).endsWith('/finish')){finishes++;return json({});}throw Error('unexpected');
 };
 const worker=createQueueService({fetcher,slots:1,renewMs:10,schedule:()=>{},executor:async()=>{entered.release();await blocked.promise;}});
 void worker.wake();await entered.promise;await pause(25);worker.dispose();const before=renewals;await pause(35);expect(renewals).toBe(before);expect(finishes).toBe(0);blocked.release();await pause(10);expect(finishes).toBe(0);
});

it('does not launch a second wake when a sibling fails while another executor is gated',async()=>{
 const blocked=gate(),entered=gate();let claims=0;
 const fetcher:typeof fetch=async url=>{
   if(String(url).endsWith('bridge-context'))return json({binding:'binding'});
   if(String(url).endsWith('/claim')){claims++;if(claims===1)return json({unfinished:true,claim:{job:{id:'job',courseId:'course'},token:'token',generation:1,expiresAt:60}});if(claims===2)throw Error('offline');return json({unfinished:false});}
   if(String(url).endsWith('/finish'))return json({});throw Error('unexpected');
 };
 const scheduled:boolean[]=[];const worker=createQueueService({fetcher,slots:2,schedule:v=>scheduled.push(v),executor:async()=>{entered.release();await blocked.promise;}});
 const first=worker.wake();await entered.promise;await pause(10);const second=worker.wake();await pause(10);expect(claims).toBe(2);blocked.release();await Promise.all([first,second]);expect(scheduled.at(-1)).toBe(true);worker.dispose();
});
