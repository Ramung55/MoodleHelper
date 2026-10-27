// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {scanSyntheticCourse} from '../extension/src/scan-coordinator';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

it('paces retry attempts and records explicitly incomplete synthetic evidence',async()=>{
  let now=10000, last=-1000, occupied=false, deadline=0, attempts=0;
  const trace:{kind:string;at:number}[]=[];
  const authority={
    async acquire(at:number){if(occupied||at<Math.max(last+1000,deadline))return null;occupied=true;last=at;return 'owner';},
    async releaseAfterTermination(token:string,after:number){expect(token).toBe('owner');expect(occupied).toBe(true);deadline=Math.max(deadline,after);occupied=false;return true;},
  };
  const url='https://moodle.sdu.edu.kz/course/view.php?id=101';
  const document=new DOMParser().parseFromString('<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav><main data-region="course-content"><h1>Course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><section data-region="course-section"><h2>Week 1</h2><p data-region="materials-empty">No materials</p></section></main>','text/html');
  const source={start(requestedUrl:string){
    expect(occupied).toBe(true);trace.push({kind:'start',at:now});attempts++;
    const input={document,requestedUrl,finalUrl:requestedUrl,httpStatus:attempts===1?429:200,networkFailure:false};
    trace.push({kind:'end',at:now});
    return {completion:Promise.resolve({input,links:[],sourceCourseId:'101',retryAfter:attempts===1?'3':undefined,bytes:300}),termination:Promise.resolve(true),abort(){}};
  }};
  const output=await scanSyntheticCourse({source,authority,sourceCourseId:'101',valid:async()=>true,now:()=>now,wait:async ms=>{now+=ms;}});
  expect(output.outcome).toBe('completed');
  expect(trace.filter(e=>e.kind==='start').map(e=>e.at)).toEqual([10000,13000]);
  expect(output.incompleteReasons).toContain('undiscovered');
  expect(output.pages.some(p=>p.pageType==='quiz'&&p.outcome==='undiscovered')).toBe(true);
  expect(output.pages.some(p=>p.pageType==='course'&&p.collector==='material')).toBe(true);
  expect(occupied).toBe(false);
});

it('serializes actual synthetic starts across independent authority processes and retains lost acknowledgements',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'scan-authority-'));
  try {
    const root=path.resolve(import.meta.dirname,'..');
    const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
    const file=path.join(directory,'authority.sqlite3'), run=promisify(execFile);
    const call=async(...args:string[])=>JSON.parse((await run(python,['-m','tests.synthetic_authority_cli',...args],{cwd:root,windowsHide:true})).stdout);
    const marker=await call('provision',file);
    const makeAuthority=()=>({acquire:(now:number)=>call('acquire',file,marker,String(now)),releaseAfterTermination:(token:string,notBefore:number)=>call('release',file,marker,token,String(notBefore))});
    const course='https://moodle.sdu.edu.kz/course/view.php?id=101';
    const document=new DOMParser().parseFromString('<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav><main data-region="course-content"><h1>Course</h1><a href="/course/view.php?id=101">Course</a></main>','text/html');
    const trace:{kind:'start'|'end';at:number}[]=[];let active=0;
    const source={start(url:string){active++;expect(active).toBe(1);trace.push({kind:'start',at:Date.now()});
      const completion=new Promise<any>(resolve=>setTimeout(()=>{trace.push({kind:'end',at:Date.now()});active--;resolve({input:{document,requestedUrl:url,finalUrl:url,httpStatus:200,networkFailure:false},links:[],sourceCourseId:'101',bytes:10});},120));
      return {completion,termination:completion.then(()=>true),abort(){}};}};
    const options={source,sourceCourseId:'101',valid:async()=>true,now:Date.now,wait:(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))};
    await Promise.all([scanSyntheticCourse({...options,authority:makeAuthority()}),scanSyntheticCourse({...options,authority:makeAuthority()})]);
    const starts=trace.filter(e=>e.kind==='start');expect(starts).toHaveLength(2);
    expect(starts[1]!.at-starts[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(trace.map(e=>e.kind)).toEqual(['start','end','start','end']);
    const lost=await call('acquire',file,marker,String(Date.now()+2000));expect(lost).toBeTruthy();
    // A restarted authority process cannot reclaim an owner when its acknowledgement is lost.
    expect(await makeAuthority().acquire(Date.now()+999999)).toBeNull();
    expect(course).toContain('/course/');
  } finally {await rm(directory,{recursive:true,force:true});}
},30000);

it('persists terminal Retry-After and keeps the gate occupied for malformed values',async()=>{
  for(const header of ['60','not-a-date']) {
    let now=10000,occupied=false,deadline=0,last=-1000,attempts=0;
    const authority={async acquire(at:number){if(occupied||at<Math.max(last+1000,deadline))return null;occupied=true;last=at;return 'owner';},
      async releaseAfterTermination(_:string,n:number){occupied=false;deadline=Math.max(deadline,n);return true;}};
    const document=new DOMParser().parseFromString('<main></main>','text/html');
    const source={start(url:string){attempts++;return {completion:Promise.resolve({input:{document,requestedUrl:url,finalUrl:url,httpStatus:503,networkFailure:false},links:[],sourceCourseId:'101',bytes:10,retryAfter:attempts===3?header:undefined}),termination:Promise.resolve(true),abort(){}};}};
    const result=await scanSyntheticCourse({source,authority,sourceCourseId:'101',valid:async()=>true,now:()=>now,wait:async ms=>{now+=ms;}});
    expect(attempts).toBe(3);
    if(header==='60'){expect(occupied).toBe(false);expect(deadline).toBeGreaterThanOrEqual(now+60000);}
    else {expect(occupied).toBe(true);expect(result.errorCode).toBe('request_failed');}
  }
});

it('holds the authority after cancellation until a stalled request acknowledges abort',async()=>{
  let owner=false,last=0,starts=0,active=0,ack!:()=>void,entered!:()=>void,aborted!:()=>void;
  const began=new Promise<void>(r=>entered=r),abortSeen=new Promise<void>(r=>aborted=r);
  const authority={async acquire(at:number){if(owner||at<last+1000)return null;owner=true;last=at;return 'owner';},
    async releaseAfterTermination(){expect(active).toBe(0);owner=false;return true;}};
  const document=new DOMParser().parseFromString('<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav><main data-region="course-content"><h1>Course</h1><a href="/course/view.php?id=101">Course</a></main>','text/html');
  const source={start(url:string){starts++;active++;if(starts===1){entered();let reject!:(e:Error)=>void,confirm!:(v:boolean)=>void;
    const completion=new Promise<any>((_,r)=>reject=r),termination=new Promise<boolean>(r=>confirm=r);
    ack=()=>{active--;confirm(true);};return {completion,termination,abort(){reject(Error('stopped'));aborted();}};}
    active--;return {completion:Promise.resolve({input:{document,requestedUrl:url,finalUrl:url,httpStatus:200,networkFailure:false},links:[],sourceCourseId:'101',bytes:10}),termination:Promise.resolve(true),abort(){}};}};
  const signal=new AbortController(), wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
  const common={source,authority,sourceCourseId:'101',valid:async()=>true,now:Date.now,wait};
  const first=scanSyntheticCourse({...common,signal:signal.signal});await began;
  const second=scanSyntheticCourse(common);signal.abort();await abortSeen;await wait(250);
  expect(starts).toBe(1);expect(owner).toBe(true);ack();
  const [cancelled,completed]=await Promise.all([first,second]);
  expect(cancelled.errorCode).toBe('invalid_context');expect(completed.outcome).toBe('completed');expect(starts).toBe(2);
},10000);

it('terminates on login with fixed signed-out evidence',async()=>{
  let now=10000,last=-1000,occupied=false;
  const authority={async acquire(at:number){if(occupied||at<last+1000)return null;occupied=true;last=at;return 'owner';},async releaseAfterTermination(){occupied=false;return true;}};
  const document=new DOMParser().parseFromString('<main><h1>Sign in</h1><form action="/login/index.php"><input name="username" type="text"><input name="password" type="password"></form></main>','text/html');
  const source={start(url:string){return {completion:Promise.resolve({input:{document,requestedUrl:url,finalUrl:'https://moodle.sdu.edu.kz/login/index.php',httpStatus:200,networkFailure:false},links:[],sourceCourseId:'101',bytes:50}),termination:Promise.resolve(true),abort(){}};}};
  const result=await scanSyntheticCourse({source,authority,sourceCourseId:'101',valid:async()=>true,now:()=>now,wait:async ms=>{now+=ms;}});
  expect(result.outcome).toBe('failed');expect(result.errorCode).toBe('signed_out');expect(result.incompleteReasons).toContain('signed_out');
  expect(result.pages.some(p=>p.outcome==='signed_out')).toBe(true);
});

it('records forbidden and unsupported pages, breaks cycles, and bounds discovery',async()=>{
  let now=10000,last=-1000,occupied=false;const calls:string[]=[];
  const authority={async acquire(at:number){if(occupied||at<last+1000)return null;occupied=true;last=at;return 'owner';},async releaseAfterTermination(){occupied=false;return true;}};
  const course='https://moodle.sdu.edu.kz/course/view.php?id=101', quiz='https://moodle.sdu.edu.kz/mod/quiz/view.php?id=404';
  const doc=new DOMParser().parseFromString('<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav><main data-region="course-content"><h1>Course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a></main>','text/html');
  const denied=new DOMParser().parseFromString('<main><h1>Unavailable</h1><div role="alert" data-errorcode="nopermissions">Access denied</div></main>','text/html');
  const source={start(url:string){calls.push(url);return {completion:Promise.resolve({input:{document:url===course?doc:denied,requestedUrl:url,finalUrl:url,httpStatus:url===course?200:403,networkFailure:false},links:url===course?[course,quiz,'https://evil.invalid/private']:[],sourceCourseId:'101',bytes:100}),termination:Promise.resolve(true),abort(){}};}};
  const result=await scanSyntheticCourse({source,authority,sourceCourseId:'101',valid:async()=>true,now:()=>now,wait:async ms=>{now+=ms;}});
  expect(calls).toEqual([course,quiz]);expect(result.pages.some(p=>p.pageType==='quiz'&&p.outcome==='forbidden')).toBe(true);
  expect(result.pages.some(p=>p.pageType==='unsupported'&&p.reasons.includes('unsupported_page'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('evil.invalid');
  const bounded=await scanSyntheticCourse({source,authority,sourceCourseId:'101',valid:async()=>true,now:()=>now,wait:async ms=>{now+=ms;},maxDepth:0});
  expect(bounded.incompleteReasons).toContain('limit_reached');
});
