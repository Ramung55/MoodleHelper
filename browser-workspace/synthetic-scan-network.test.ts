// @vitest-environment jsdom
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {installSyntheticScanWorker} from '../extension/src/synthetic-scan-worker';
import {assignment} from '../frontend/src/test/moodle-assignments-fixtures';

const root=path.resolve(import.meta.dirname,'..');
const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
let server:ChildProcess,dir:string,base:string;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
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
    const authority=()=>({acquire:(n:number)=>call('acquire',file,marker,String(n)),releaseAfterTermination:(token:string,n:number)=>call('release',file,marker,token,String(n))});
    const account='<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav>';
    const html=`${account}<main data-region="course-content"><h1>Course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><section data-region="course-section"><h2>Week 1</h2><p data-region="materials-empty">No materials</p></section></main>`;
    let active=0;const trace:{type:string;at:number}[]=[];
    const source={start(url:string){active++;expect(active).toBe(1);trace.push({type:'start',at:Date.now()});
      const completion=new Promise<any>(resolve=>setTimeout(()=>{active--;trace.push({type:'end',at:Date.now()});resolve({input:{document:new DOMParser().parseFromString(html,'text/html'),requestedUrl:url,finalUrl:url,httpStatus:200,networkFailure:false},links:[],sourceCourseId:'101',bytes:1000});},100));
      return {completion,termination:completion.then(()=>true),abort(){}};}};
    const runs=[];
    for(const endpoint of [base,secondBase]) {
      const binding=(await (await fetch(endpoint+'/api/bridge-context')).json()).binding;
      const response=await fetch(endpoint+'/api/scan/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding},body:JSON.stringify({idempotencyKey:'two-databases'})});
      expect(response.status).toBe(200);runs.push(await response.json());
      workers.push(installSyntheticScanWorker(()=>{}, {base:endpoint,fetcher:fetch,source,authority:authority(),now:Date.now,wait:pause,schedule:()=>{}}));
    }
    await Promise.all(workers.map(worker=>(worker as ReturnType<typeof installSyntheticScanWorker>).wake()));
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
  const course='https://moodle.sdu.edu.kz/course/view.php?id=101', activity='https://moodle.sdu.edu.kz/mod/assign/view.php?id=303';
  const account='<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav>';
  const html=`${account}<main data-region="course-content"><h1>Course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><section data-region="course-section"><h2>Week 1</h2><p data-region="materials-empty">No materials</p></section></main>`;
  let now=Date.parse('2026-10-27T12:30:00Z'),owner=false,last=0,deadline=0;
  const authority={async acquire(at:number){if(owner||at<Math.max(last+1000,deadline))return null;owner=true;last=at;return 'test';},async releaseAfterTermination(_:string,n:number){deadline=Math.max(deadline,n);owner=false;return true;}};
  const source={start(url:string){const document=new DOMParser().parseFromString(url===course?html:assignment(),'text/html');
    return {completion:Promise.resolve({input:{document,requestedUrl:url,finalUrl:url,httpStatus:200,networkFailure:false},links:url===course?[activity]:[],sourceCourseId:'101',bytes:1000}),termination:Promise.resolve(true),abort(){}};}};
  let wake:()=>void=()=>{};
  const worker=installSyntheticScanWorker(fn=>wake=fn,{base,fetcher:fetch,source,authority,now:()=>now,wait:async ms=>{now+=ms;},schedule:()=>{}});
  const binding=(await (await fetch(base+'/api/bridge-context')).json()).binding;
  const start=await fetch(base+'/api/scan/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding},body:JSON.stringify({idempotencyKey:'synthetic-http'})});
  expect(start.status).toBe(200);const run=await start.json();wake();await worker.wake();
  const done=await (await fetch(base+'/api/scan/runs/'+run.id)).json();
  expect(done.status).toBe('completed');
  const evidence=await (await fetch(base+'/api/scan/jobs/'+done.jobs[0].id+'/pages')).json();
  expect(evidence.pages.some((p:any)=>p.collector==='assignment')).toBe(true);
  expect(evidence.pages.some((p:any)=>p.pageType==='submission'&&p.outcome==='unavailable')).toBe(true);
  const saved=await (await fetch(base+'/api/snapshot')).json();
  expect(saved.collection.records.some((r:any)=>r.kind==='assignment'&&r.observations[0].sourceActivityId==='202')).toBe(true);
  worker.dispose();
},30000);
