import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createQueueService } from '../extension/src/queue';

// Production queue service, real HTTP and file SQLite. Executor and clock are test doubles; no live Chrome or Moodle.
const root=path.resolve(import.meta.dirname,'..'), base='http://127.0.0.1:18765';
const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
let dir:string, child:ChildProcess;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function stop(){if(child&&child.exitCode===null)await new Promise<void>(r=>{child.once('exit',()=>r());child.kill();});}
async function server(concurrency=1){
 child=spawn(python,['-m','uvicorn','tests.queue_network_app:app','--host','127.0.0.1','--port','18765'],{cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,MOODLE_HELPER_DATASET:'demo',MOODLE_HELPER_DATABASE_URL:`sqlite:///${path.join(dir,'queue.db').replaceAll('\\','/')}`,QUEUE_TEST_CLOCK:path.join(dir,'clock'),MOODLE_HELPER_QUEUE_CONCURRENCY:String(concurrency)}});
 let logs='';child.stderr?.on('data',d=>logs+=d);child.on('error',e=>logs+=e.message);
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/bridge-context')).ok)return;}catch{}await pause(50);}throw Error(logs);
}
async function read(id:string){return (await fetch(base+'/api/queue/runs/'+id)).json();}
async function waitFor(fn:()=>boolean){for(let i=0;i<200;i++){if(fn())return;await pause(10);}throw Error('Timed out waiting for worker');}
beforeAll(async()=>{dir=await mkdtemp(path.join(tmpdir(),'queue-network-'));await writeFile(path.join(dir,'clock'),'1000');await server();});
afterAll(async()=>{await stop();await rm(dir,{recursive:true,force:true});});

it('recreates production service after interruption before commit and backend restart',async()=>{
 const blocked=gate(), entered=gate(), calls:string[]=[];
 const one=createQueueService({base,slots:1,schedule:()=>{},executor:async job=>{calls.push(job.id);if(calls.length===2){entered.release();await blocked.promise;}}});
 const run=await one.start('network-before',['c-csc','c-math']);
 await entered.promise;
 const partial=await read(run.id);expect(partial.progress.completed).toBe(1);expect(partial.progress.running).toBe(1);
 one.dispose();blocked.release();await stop();await writeFile(path.join(dir,'clock'),'1061');await server();
 const resumed:string[]=[];
 const two=createQueueService({base,slots:1,schedule:()=>{},executor:async job=>{resumed.push(job.id);}});
 await two.wake();const done=await read(run.id);expect(done.status).toBe('completed');expect(done.progress.completed).toBe(2);
 expect(resumed).toEqual([calls[1]]);expect(new Set(done.jobs.map((j:any)=>j.result.id)).size).toBe(2);two.dispose();
});

it('does not execute a result again after commit when the response is lost',async()=>{
 const committed=gate(), release=gate(), calls:string[]=[];
 const fetcher:typeof fetch=async (url,init)=>{const response=await fetch(url,init);if(String(url).endsWith('/api/queue/finish')){committed.release();await release.promise;}return response;};
 const one=createQueueService({base,slots:1,schedule:()=>{},fetcher,executor:async job=>{calls.push(job.id);}});
 const run=await one.start('network-after',['c-phy']);await committed.promise;
 expect((await read(run.id)).status).toBe('completed');one.dispose();release.release();await pause(50);
 const next:string[]=[];const two=createQueueService({base,slots:1,schedule:()=>{},executor:async j=>{next.push(j.id);}});await two.wake();
 expect(next).toEqual([]);expect((await read(run.id)).progress.completed).toBe(1);two.dispose();
});

it('enforces global concurrency while a failed executor does not stop other jobs',async()=>{
 await stop();await server(2);let active=0,max=0;const gate1=gate();let entered=0;
 const executor=async (job:{id:string;courseId:string})=>{active++;max=Math.max(max,active);entered++;if(entered<=2)await gate1.promise;active--;if(job.courseId==='c-csc')throw Error('private failure');};
 const one=createQueueService({base,slots:4,schedule:()=>{},executor});
 const run=await one.start('network-concurrency',['c-csc','c-math','c-phy']);await waitFor(()=>entered===2);expect(max).toBe(2);gate1.release();
 await waitFor(()=>active===0&&entered===3);await waitFor(()=>!active);await pause(100);
 const done=await read(run.id);expect(done.status).toBe('failed');expect(done.progress.failed).toBe(1);expect(done.progress.completed).toBe(2);expect(max).toBe(2);expect(JSON.stringify(done)).not.toContain('private failure');one.dispose();
});

it('installed MV3 listener discovers direct HTTP starts after idle and after worker recreation',async()=>{
 const {installQueueWorker,ALARM_NAME}=await import('../extension/src/queue');
 function chromeShim(){
   const alarmCallbacks:((a:{name:string})=>void)[]=[],startup:(()=>void)[]=[],installed:(()=>void)[]=[],created:any[]=[];
   return {created,alarmCallbacks,startup,installed,api:{alarms:{create:(name:string,info:any)=>created.push({name,info}),clear:()=>{},onAlarm:{addListener:(f:any)=>alarmCallbacks.push(f)}},runtime:{onStartup:{addListener:(f:any)=>startup.push(f)},onInstalled:{addListener:(f:any)=>installed.push(f)}}}};
 }
 const shim=chromeShim();const calls:string[]=[];
 const first=installQueueWorker(shim.api,{base,slots:1,executor:async j=>{calls.push(j.id);}});
 expect(shim.created).toEqual([{name:ALARM_NAME,info:{delayInMinutes:1,periodInMinutes:1}}]);
 expect(shim.alarmCallbacks).toHaveLength(1);expect(shim.startup).toHaveLength(1);expect(shim.installed).toHaveLength(1);
 await first.wake();
 const binding=(await (await fetch(base+'/api/bridge-context')).json()).binding;
 const response=await fetch(base+'/api/queue/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding},body:JSON.stringify({idempotencyKey:'direct-idle',courseIds:['c-csc']})});
 const run=await response.json();expect((await read(run.id)).status).toBe('pending');
 shim.alarmCallbacks[0]({name:ALARM_NAME});
 for(let i=0;i<100&&(await read(run.id)).status!=='completed';i++)await pause(20);
 expect((await read(run.id)).status).toBe('completed');expect(calls).toHaveLength(1);first.dispose();
 const next=chromeShim();const second=installQueueWorker(next.api,{base,slots:1});
 expect(next.created).toEqual([{name:ALARM_NAME,info:{delayInMinutes:1,periodInMinutes:1}}]);next.startup[0]();await second.wake();second.dispose();
});
