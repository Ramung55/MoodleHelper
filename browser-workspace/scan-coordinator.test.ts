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
