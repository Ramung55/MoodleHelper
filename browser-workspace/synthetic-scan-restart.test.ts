// @vitest-environment jsdom
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {installExtension} from '../extension/src/index';

function installed(options:any) {
  const chrome:any={runtime:{id:'synthetic-test',onMessage:{addListener:()=>{}},onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}}},
    alarms:{create:()=>{},clear:()=>{},onAlarm:{addListener:()=>{}}},permissions:{contains:(_:any,cb:any)=>cb(true)}};
  const {base,fetcher,...syntheticScan}=options;
  return installExtension(chrome,{base,fetcher,syntheticScan});
}

it('recovers a pre-commit worker interruption and does not repeat a committed scan after restart',async()=>{
  const root=path.resolve(import.meta.dirname,'..'), dir=await mkdtemp(path.join(tmpdir(),'scan-restart-'));
  const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const base=`http://127.0.0.1:${port}`,clock=path.join(dir,'clock');let server:ChildProcess;
  const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
  const startServer=async()=>{server=spawn(python,['-m','uvicorn','tests.scan_network_app:app','--host','127.0.0.1','--port',String(port)],{cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,SCAN_TEST_DATABASE:path.join(dir,'synthetic-scan.sqlite3'),SCAN_TEST_CLOCK:clock}});
    for(let i=0;i<200;i++){try{if((await fetch(base+'/api/bridge-context')).ok)return;}catch{}await pause(50);}throw Error('Synthetic server unavailable');};
  const stopServer=async()=>{if(server&&server.exitCode===null)await new Promise<void>(r=>{server.once('exit',()=>r());server.kill();});};
  const workers:{dispose:()=>void}[]=[];
  try {
    await writeFile(clock,'1000');await startServer();
    const snapshot=await (await fetch(base+'/api/snapshot')).json();
    snapshot.courses[0].discovery={sourceCourseId:'101',sourceUrl:'https://moodle.sdu.edu.kz/course/view.php?id=101',title:{kind:'known',value:'Synthetic course'},termIndicators:{kind:'unknown'},currentTermStatus:'unknown'};
    snapshot.settings.trackedCourseIds=[snapshot.courses[0].id];
    await fetch(base+'/api/snapshot',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
    let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let active=false,now=10000,last=-1000;
    const authority={async acquire(at:number){if(active||at<last+1000)return null;active=true;last=at;return 'owner';},async releaseAfterTermination(){active=false;return true;}};
    const stalled={start(_url:string){entered();let reject!:(e:Error)=>void,ack!:(v:boolean)=>void;
      const completion=new Promise<any>((_,r)=>reject=r),termination=new Promise<boolean>(r=>ack=r);
      return {completion,termination,abort(){reject(Error('terminated'));ack(true);}};}};
    const first=installed({base,fetcher:fetch,source:stalled,authority,now:()=>now,wait:async (ms:number)=>{now+=ms;}});workers.push(first);
    const binding=(await (await fetch(base+'/api/bridge-context')).json()).binding;
    const run=await (await fetch(base+'/api/scan/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding},body:JSON.stringify({idempotencyKey:'restart'})})).json();
    void first.wake();await started;first.dispose();await first.wake();await stopServer();
    await writeFile(clock,'1061');await startServer();
    let calls=0;const html='<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav><main data-region="course-content"><h1>Course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><section data-region="course-section"><h2>Week</h2><p data-region="materials-empty">None</p></section></main>';
    const source={start(url:string){calls++;return {completion:Promise.resolve({input:{document:new DOMParser().parseFromString(html,'text/html'),requestedUrl:url,finalUrl:url,httpStatus:200,networkFailure:false},links:[],sourceCourseId:'101',bytes:100}),termination:Promise.resolve(true),abort(){}};}};
    const second=installed({base,fetcher:fetch,source,authority,now:()=>now,wait:async (ms:number)=>{now+=ms;}});workers.push(second);
    await second.wake();expect((await (await fetch(base+'/api/scan/runs/'+run.id)).json()).status).toBe('completed');expect(calls).toBe(1);second.dispose();
    await stopServer();await startServer();
    const third=installed({base,fetcher:fetch,source,authority,now:()=>now,wait:async (ms:number)=>{now+=ms;}});workers.push(third);
    await third.wake();expect(calls).toBe(1);
    const done=await (await fetch(base+'/api/scan/runs/'+run.id)).json();
    expect((await (await fetch(base+'/api/scan/jobs/'+done.jobs[0].id+'/pages')).json()).pages.length).toBeGreaterThan(0);
  } finally {workers.forEach(w=>w.dispose());await stopServer();await rm(dir,{recursive:true,force:true});}
},45000);
