// @vitest-environment jsdom
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {installExtension} from '../extension/src/index';
import {assignment} from '../frontend/src/test/moodle-assignments-fixtures';
import {calendarPage} from '../frontend/src/test/moodle-calendar-fixtures';

const root=path.resolve(import.meta.dirname,'..');
const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
let server:ChildProcess,dir:string,base:string;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function installed(options:any) {
  const alarms:((alarm:{name:string})=>void)[]=[], startup:(()=>void)[]=[];
  const chrome:any={runtime:{id:'synthetic-test',onMessage:{addListener:()=>{}},onStartup:{addListener:(callback:any)=>startup.push(callback)},onInstalled:{addListener:()=>{}}},
    alarms:{create:()=>{},clear:()=>{},onAlarm:{addListener:(callback:any)=>alarms.push(callback)}},permissions:{contains:(_:any,cb:any)=>cb(true)}};
  const {base,fetcher,...syntheticScan}=options;
  const worker=installExtension(chrome,{base,fetcher,syntheticScan});
  return {...worker, trigger:()=>alarms[0]!({name:'moodle-helper-mock-queue'}),triggerStartup:()=>startup[0]!()};
}
beforeAll(async()=>{
  dir=await mkdtemp(path.join(tmpdir(),'moodle-scan-'));
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  base=`http://127.0.0.1:${port}`;
  server=spawn(python,['-m','uvicorn','tests.collection_network_app:app','--host','127.0.0.1','--port',String(port)],
    {cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,MOODLE_HELPER_COLLECTION_TEST_DATABASE:path.join(dir,'synthetic-collection.sqlite3')}});
  let log='';server.stderr?.on('data',d=>log+=d);server.on('error',e=>log+=e.message);
  for(let i=0;i<200;i++){try{if((await fetch(base+'/api/bridge-context')).ok)return;}catch{}if(server.exitCode!==null)break;await pause(50);}throw Error(log);
},30000);

it('shares one SQLite request authority across workers using different data databases',async()=>{
  const secondDir=path.join(dir,'second');await mkdir(secondDir);
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const secondBase=`http://127.0.0.1:${port}`;
  const second=spawn(python,['-m','uvicorn','tests.collection_network_app:app','--host','127.0.0.1','--port',String(port)],
    {cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,MOODLE_HELPER_COLLECTION_TEST_DATABASE:path.join(secondDir,'synthetic-collection.sqlite3')}});
  const workers:{dispose:()=>void}[]=[];
  try {
    let ready=false;for(let i=0;i<200;i++){try{if((await fetch(secondBase+'/api/bridge-context')).ok){ready=true;break;}}catch{}await pause(50);}expect(ready).toBe(true);
    for(const endpoint of [base,secondBase]) {
      const snapshot=await (await fetch(endpoint+'/api/snapshot')).json();
      snapshot.courses[0].discovery={sourceCourseId:'101',sourceUrl:'https://moodle.sdu.edu.kz/course/view.php?id=101',title:{kind:'known',value:'Synthetic course'},termIndicators:{kind:'unknown'},currentTermStatus:'unknown'};
      snapshot.settings.trackedCourseIds=[snapshot.courses[0].id];
      expect((await fetch(endpoint+'/api/snapshot',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)})).ok).toBe(true);
    }
    const call=async(...args:string[])=>JSON.parse((await promisify(execFile)(python,['-m','tests.synthetic_authority_cli',...args],{cwd:root,windowsHide:true})).stdout);
    const file=path.join(dir,'shared-authority.sqlite3'),marker=await call('provision',file);
    const authority=()=>({acquire:(n:number,key?:string)=>call('acquire',file,marker,String(n),...(key?[key]:[])),releaseAfterTermination:(token:string,n:number,key?:string,failed?:boolean)=>call('release',file,marker,token,String(n),...(key?[key,failed===undefined?'none':String(failed)]:[]))});
    const account='<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav>';
    const html=`${account}<main data-region="course-content"><h1>Course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><section data-region="course-section"><h2>Week 1</h2><p data-region="materials-empty">No materials</p></section></main>`;
    let active=0, releaseFirst!:()=>void, firstStarted!:()=>void;
    const unblock=new Promise<void>(r=>releaseFirst=r), entered=new Promise<void>(r=>firstStarted=r);
    const trace:{type:string;at:number}[]=[];
    const source={start(url:string){active++;expect(active).toBe(1);trace.push({type:'start',at:Date.now()});
      const first=trace.length===1;if(first)firstStarted();
      const completion=(first?unblock:pause(100)).then(()=>{active--;trace.push({type:'end',at:Date.now()});return {input:{document:new DOMParser().parseFromString(html,'text/html'),requestedUrl:url,finalUrl:url,httpStatus:200,networkFailure:false},links:[],sourceCourseId:'101',bytes:1000};});
      return {completion,termination:completion.then(()=>true),abort(){}};}};
    const runs=[];
    for(const endpoint of [base,secondBase]) {
      const binding=(await (await fetch(endpoint+'/api/bridge-context')).json()).binding;
      const response=await fetch(endpoint+'/api/scan/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding},body:JSON.stringify({idempotencyKey:'two-databases'})});
      expect(response.status).toBe(200);runs.push(await response.json());
      workers.push(installed({base:endpoint,fetcher:fetch,source,authority:authority(),now:Date.now,wait:pause}));
    }
    const working=Promise.all(workers.map(worker=>(worker as ReturnType<typeof installed>).wake()));
    await entered;await pause(1300);
    expect(trace.map(x=>x.type)).toEqual(['start']);expect(active).toBe(1);
    releaseFirst();await working;
    for(let i=0;i<2;i++)expect((await (await fetch([base,secondBase][i]+'/api/scan/runs/'+runs[i].id)).json()).status).toBe('completed');
    expect(trace.map(x=>x.type)).toEqual(['start','end','start','end']);
    expect(trace[2]!.at-trace[0]!.at).toBeGreaterThanOrEqual(1000);
  } finally {
    workers.forEach(w=>w.dispose());
    if(second.exitCode===null)await new Promise<void>(r=>{second.once('exit',()=>r());second.kill();});
  }
},30000);
afterAll(async()=>{if(server&&server.exitCode===null)await new Promise<void>(r=>{server.once('exit',()=>r());server.kill();});await rm(dir,{recursive:true,force:true});});

it('wakes the synthetic worker through HTTP and commits actual assignment parser output to SQLite',async()=>{
  const snapshot=await (await fetch(base+'/api/snapshot')).json();
  snapshot.courses[0].discovery={sourceCourseId:'101',sourceUrl:'https://moodle.sdu.edu.kz/course/view.php?id=101',title:{kind:'known',value:'Synthetic course'},termIndicators:{kind:'unknown'},currentTermStatus:'unknown'};
  snapshot.settings.trackedCourseIds=[snapshot.courses[0].id];
  expect((await fetch(base+'/api/snapshot',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)})).ok).toBe(true);
  const course='https://moodle.sdu.edu.kz/course/view.php?id=101', activity='https://moodle.sdu.edu.kz/mod/assign/view.php?id=303', calendar='https://moodle.sdu.edu.kz/calendar/view.php';
  const account='<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav>';
  const html=`${account}<main data-region="course-content"><h1>Course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><section data-region="course-section"><h2>Week 1</h2><article data-region="material" data-module-type="resource" data-course-module-id="201" data-file-type="pdf"><a data-role="material-link" href="/mod/resource/view.php?id=201">Synthetic lecture</a><a data-role="destination" href="/pluginfile.php/700/mod_resource/content/1/lecture.pdf" type="application/pdf">Open</a></article></section></main>`;
  let now=Date.parse('2026-10-27T12:30:00Z'),owner=false,last=0,deadline=0;
  const authority={async acquire(at:number){if(owner||at<Math.max(last+1000,deadline))return null;owner=true;last=at;return 'test';},async releaseAfterTermination(_:string,n:number){deadline=Math.max(deadline,n);owner=false;return true;}};
  const source={start(url:string){const document=new DOMParser().parseFromString(url===course?html:url===calendar?calendarPage():assignment(),'text/html');
    return {completion:Promise.resolve({input:{document,requestedUrl:url,finalUrl:url,httpStatus:200,networkFailure:false},links:url===course?[activity,calendar]:[],sourceCourseId:'101',bytes:1000}),termination:Promise.resolve(true),abort(){}};}};
  const worker=installed({base,fetcher:fetch,source,authority,now:()=>now,wait:async (ms:number)=>{now+=ms;}});
  await worker.wake();
  const binding=(await (await fetch(base+'/api/bridge-context')).json()).binding;
  const start=await fetch(base+'/api/scan/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding},body:JSON.stringify({idempotencyKey:'synthetic-http'})});
  expect(start.status).toBe(200);const run=await start.json();worker.trigger();
  let done:any;
  for(let i=0;i<200;i++){done=await (await fetch(base+'/api/scan/runs/'+run.id)).json();if(done.status==='completed'||done.status==='failed')break;await pause(25);}
  expect(done.status).toBe('completed');
  const evidence=await (await fetch(base+'/api/scan/jobs/'+done.jobs[0].id+'/pages')).json();
  expect(evidence.pages.some((p:any)=>p.collector==='assignment')).toBe(true);
  expect(evidence.pages.some((p:any)=>p.pageType==='submission'&&p.outcome==='unavailable')).toBe(true);
  const saved=await (await fetch(base+'/api/snapshot')).json();
  expect(saved.collection.records.some((r:any)=>r.kind==='assignment'&&r.observations[0].sourceActivityId==='202')).toBe(true);
  expect(saved.collection.records.some((r:any)=>r.kind==='calendar'&&r.observations[0].sourceEventId==='501')).toBe(true);
  expect(saved.collection.records.some((r:any)=>r.kind==='material'&&r.observations[0].sourceCourseModuleId==='201')).toBe(true);
  await worker.wake();
  const next=await (await fetch(base+'/api/scan/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding},body:JSON.stringify({idempotencyKey:'synthetic-startup'})})).json();
  worker.triggerStartup();
  let resumed:any;for(let i=0;i<200;i++){resumed=await (await fetch(base+'/api/scan/runs/'+next.id)).json();if(resumed.status==='completed'||resumed.status==='failed')break;await pause(25);}
  expect(resumed.status).toBe('completed');
  worker.dispose();
},30000);

it('aborts an in-flight synthetic request on cancellation and fences its late result',async()=>{
  const snapshot=await (await fetch(base+'/api/snapshot')).json();
  const before=JSON.stringify(snapshot);
  let entered!:()=>void, aborted!:()=>void;
  const started=new Promise<void>(r=>entered=r), stopped=new Promise<void>(r=>aborted=r);
  let active=false, starts=0, releases=0;
  const authority={async acquire(){if(active)return null;active=true;return 'owner';},async releaseAfterTermination(){active=false;releases++;return true;}};
  const source={start(_url:string){starts++;entered();let reject!:(reason:Error)=>void;
    const completion=new Promise<any>((_,r)=>reject=r);let acknowledge!:(value:boolean)=>void;
    const termination=new Promise<boolean>(r=>acknowledge=r);
    return {completion,termination,abort(){reject(Error('cancelled'));acknowledge(true);aborted();}};}};
  const worker=installed({base,fetcher:fetch,source,authority,now:Date.now,wait:pause});
  const binding=(await (await fetch(base+'/api/bridge-context')).json()).binding;
  const h={'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding};
  const run=await (await fetch(base+'/api/scan/runs',{method:'POST',headers:h,body:JSON.stringify({idempotencyKey:'cancel-inflight'})})).json();
  const work=worker.wake();await started;
  expect((await fetch(base+'/api/scan/runs/'+run.id+'/cancel',{method:'POST',headers:h,body:'{}'})).status).toBe(200);
  await stopped;await work;
  expect((await (await fetch(base+'/api/scan/runs/'+run.id)).json()).status).toBe('cancelled');
  expect(starts).toBe(1);expect(releases).toBe(1);expect(JSON.stringify(await (await fetch(base+'/api/snapshot')).json())).toBe(before);
  worker.dispose();
},30000);

it('aborts on changed selection before any later request or merge',async()=>{
  const snapshot=await (await fetch(base+'/api/snapshot')).json();
  let entered!:()=>void,aborted!:()=>void;
  const started=new Promise<void>(r=>entered=r),stopped=new Promise<void>(r=>aborted=r);
  let starts=0,occupied=false;
  const authority={async acquire(){if(occupied)return null;occupied=true;return 'owner';},async releaseAfterTermination(){occupied=false;return true;}};
  const source={start(_url:string){starts++;entered();let reject!:(reason:Error)=>void;let acknowledge!:(value:boolean)=>void;
    const completion=new Promise<any>((_,r)=>reject=r),termination=new Promise<boolean>(r=>acknowledge=r);
    return {completion,termination,abort(){reject(Error('changed'));acknowledge(true);aborted();}};}};
  const worker=installed({base,fetcher:fetch,source,authority,now:Date.now,wait:pause});
  const binding=(await (await fetch(base+'/api/bridge-context')).json()).binding;
  const h={'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding};
  const run=await (await fetch(base+'/api/scan/runs',{method:'POST',headers:h,body:JSON.stringify({idempotencyKey:'selection-change'})})).json();
  const work=worker.wake();await started;
  expect((await fetch(base+'/api/tracked-courses',{method:'PUT',headers:{'Content-Type':'application/json'},body:'[]'})).status).toBe(200);
  await stopped;await work;
  const after=await (await fetch(base+'/api/snapshot')).json();
  expect(after.settings.trackedCourseIds).toEqual([]);expect(after.collection).toEqual(snapshot.collection);
  expect(starts).toBe(1);expect(occupied).toBe(false);
  expect((await (await fetch(base+'/api/scan/runs/'+run.id)).json()).status).toBe('running');
  worker.dispose();
},30000);
