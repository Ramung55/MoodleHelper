// Synthetic browser/runtime/envelope shims; production coordinator + worker + real HTTP/SQLite.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { beforeAll,afterAll,beforeEach,describe,it,expect,vi } from 'vitest';
import { createPageRefresh, syntheticFixtureRegistry, installPageRefresh, type PageSource, type CollectorRegistry } from '../../../extension/src/page-refresh';
import { createCollectionWorker, runtimeCollectionRepository, type CollectionRepository, collectionSender } from '../../../extension/src/collection-repository';
import type { Runtime, Sender } from '../../../extension/src/dashboard-bridge';
import type { CollectorResult, Snapshot } from '@/domain/types';
import { makeBackup,previewRestore } from '@/domain/backup';
import { emptySnapshot } from '@/services/demo-adapter';
import { assignment,assignmentInput,dateNode } from './moodle-assignments-fixtures';
import { calendarInput,calendarPage,calendarEvent,calendarDate } from './moodle-calendar-fixtures';
import { account,origin,login } from './moodle-access-fixtures';
const time='2026-10-27T12:30:00.12+05:00';
let server:ChildProcess,base:string,temporary:string,seed:Snapshot;
const root=path.resolve(import.meta.dirname,'../../..');
let database:string;
async function start() {
  const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));base=`http://127.0.0.1:${port}`;
  const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  server=spawn(python,['-m','uvicorn','tests.collection_network_app:app','--host','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,MOODLE_HELPER_COLLECTION_TEST_DATABASE:database},windowsHide:true,stdio:'pipe'});
  let log='';server.stderr?.on('data',v=>log+=String(v));server.on('error',e=>log+=String(e));
  const until=Date.now()+20000;while(Date.now()<until){try{if((await fetch(base+'/docs')).ok)return;}catch{}if(server.exitCode!==null)break;await new Promise(r=>setTimeout(r,50));}throw Error(log);
}
async function stop(){if(server&&server.exitCode===null)await new Promise<void>(resolve=>{server.once('exit',()=>resolve());server.kill();});}
async function json(url:string,method='GET',body?:unknown){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}
beforeAll(async()=>{temporary=await mkdtemp(path.join(tmpdir(),'moodle-page-refresh-'));database=path.join(temporary,'synthetic-collection.sqlite3');await start();seed=await json('/api/snapshot');seed.courses[0]!.discovery={sourceCourseId:'101',sourceUrl:origin+'/course/view.php?id=101',title:{kind:'known',value:'Synthetic course'},termIndicators:{kind:'unknown'},currentTermStatus:'unknown'};seed.settings.trackedCourseIds=[seed.courses[0]!.id];},25000);
afterAll(async()=>{await stop();if(temporary)await rm(temporary,{recursive:true,force:true});});
beforeEach(async()=>{await json('/api/snapshot','PUT',seed);});
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(check:()=>boolean){const limit=Date.now()+5000;while(!check()&&Date.now()<limit)await tick();expect(check()).toBe(true);}
function bridge(source:()=>PageSource,options:{grant?:()=>Promise<boolean>;fetcher?:typeof fetch}={}) {
  const calls:{url:string;init?:RequestInit}[]=[];
  const fetcher:typeof fetch=async (url,init)=>{calls.push({url:String(url),init});return fetch(String(url).replace('http://127.0.0.1:8000',base),init);};
  const worker=createCollectionWorker({runtimeId:'synthetic-extension',grant:options.grant??(async()=>true),fetcher:options.fetcher??fetcher});
  const sender=():Sender=>({id:'synthetic-extension',frameId:0,documentId:'synthetic-document',url:source().url,origin,tab:{id:7,url:source().url}});
  const runtime={id:'synthetic-extension',onMessage:{addListener(){}},sendMessage:(message:unknown,reply:(r:unknown)=>void)=>{void worker(message,sender()).then(reply);}} as Runtime;
  return {repository:runtimeCollectionRepository(runtime),calls,worker,sender};
}
function fixture(input=assignmentInput()):PageSource{return {url:input.finalUrl,documentKey:input.document,input};}
function setup(initial=fixture(),registry=syntheticFixtureRegistry(),overrides:Parameters<typeof bridge>[1]={}) {
  let source=initial;const b=bridge(()=>source,overrides);const coordinator=createPageRefresh({source:()=>source,repository:b.repository,registry,clock:()=>time});
  return {coordinator,...b,set:(next:PageSource)=>{source=next;coordinator.notify();},get source(){return source;}};
}
const materialInput=(html:string,path='/course/view.php?id=101')=>({document:new DOMParser().parseFromString(html,'text/html'),requestedUrl:origin+path,finalUrl:origin+path,httpStatus:200,networkFailure:false});
const course=(body='')=>`${account}<main data-region="course-content"><h1>Synthetic course</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><section data-region="course-section"><h2>Week 1</h2>${body||'<p data-region="materials-empty">No materials</p>'}</section></main>`;

describe('#18 real pipeline AC1/AC2/AC5',()=>{
  it.each(['/course/view.php?id=101','/mod/resource/view.php?id=402','/mod/url/view.php?id=403','/mod/folder/view.php?id=404'])('persists the real material collector safe internal destination %s through worker/HTTP/SQLite',async(destination)=>{
    const html=course(`<article data-region="material" data-module-type="url" data-course-module-id="301"><a data-role="material-link" href="/mod/url/view.php?id=301">Synthetic internal link</a><a data-role="destination" href="${destination}">Open</a></article>`);
    const registry=syntheticFixtureRegistry();registry.material.collect=vi.fn(registry.material.collect);const f=setup(fixture(materialInput(html)),registry);f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===1||f.coordinator.state.status==='failed');
    expect(f.coordinator.state.status).toBe('saved');expect(registry.material.collect).toHaveBeenCalledTimes(1);
    const saved:Snapshot=await json('/api/snapshot');expect(saved.collection!.records).toHaveLength(1);const observation=saved.collection!.records[0]!.observations[0];expect(observation).toMatchObject({sourceUrl:origin+'/mod/url/view.php?id=301',destinationUrl:origin+destination,references:[{destinationUrl:origin+destination}]});expect(saved.collection!.refreshes).toHaveLength(1);f.coordinator.stop();
  });
  it('legacy demo deletion also removes the additive source layer',()=>{
    const base={...seed,collection:{records:[],reviews:[],refreshes:[]}};expect(emptySnapshot(base)).not.toHaveProperty('collection');expect(base).toHaveProperty('collection');
  });
  it('dispatches real assignment DOM once per visit, retains complete dates, updates identity and survives backup/restart/deletion',async()=>{
    const registry=syntheticFixtureRegistry();registry.assignment.collect=vi.fn(registry.assignment.collect);
    const f=setup(fixture(assignmentInput(assignment(dateNode()+dateNode('due','2026-10-29','individual','data-extension-evidence="Synthetic extension"')))),registry);
    f.coordinator.notify();f.coordinator.notify();f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===2);
    expect(registry.assignment.collect).toHaveBeenCalledTimes(1);
    let saved:Snapshot=await json('/api/snapshot');expect(saved.collection!.records).toHaveLength(1);
    const evidence=saved.collection!.records[0]!.observations[0] as any;expect(evidence.individualExtensions[0].evidence).toBe('Synthetic extension');expect(evidence.effectiveDates.due.value).toEqual({kind:'date',date:'2026-10-29'});
    for(const key of ['overlays','assessments','materials','sync'] as const)expect(saved[key]).toEqual(seed[key]);
    f.set(fixture(assignmentInput(assignment().replace('Fictional   assignment','Changed synthetic assignment'))));await until(()=>f.coordinator.state.receipts.length===4);
    saved=await json('/api/snapshot');expect(saved.collection!.records).toHaveLength(1);expect(saved.collection!.records[0]!.observations).toHaveLength(2);
    const backup=previewRestore(JSON.stringify(makeBackup(saved)),seed);expect(backup.ok).toBe(true);if(!backup.ok)throw Error('backup');expect(backup.backup.data).toEqual(saved);
    f.coordinator.stop();await stop();await start();expect(await json('/api/snapshot')).toEqual(saved);
    await json('/api/local-data','DELETE');expect((await json('/api/snapshot')).collection).toBeUndefined();
    expect(await json('/api/snapshot','PUT',backup.backup.data)).toEqual(saved);
    expect(f.calls.every(c=>c.url.startsWith('http://127.0.0.1:8000/api/collection')&&c.init?.credentials==='omit'&&c.init.redirect==='error')).toBe(true);
  });
  it('dispatches real calendar ranges, recurrence, date precision and unresolved reviews without course guessing',async()=>{
    const input=calendarInput(calendarPage(calendarEvent({recurrence:['601','701'],dates:calendarDate('date','2026-10-29','')})+calendarEvent({id:'502',course:null})));
    const f=setup(fixture(input));f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===1);
    const saved:Snapshot=await json('/api/snapshot');const layer=saved.collection!;expect(layer.records).toHaveLength(1);expect(layer.reviews).toHaveLength(1);
    expect(layer.records[0]!.observations[0]).toMatchObject({sourceEventId:'501',sourceOccurrenceId:'701',sourceSeriesId:'601',date:{value:{kind:'date',date:'2026-10-29'}}});
    expect(layer.refreshes[0]).toMatchObject({scope:'supplied_ranges_only',coverage:'partial',pages:[{range:{start:'2026-10-01',end:'2026-10-31'}}]});
    expect(layer.reviews[0]!.candidate).not.toHaveProperty('sourceCourseId');expect(saved.sync).toEqual(seed.sync);f.coordinator.stop();
  });
  it('dispatches real materials including unknown metadata and exact folder listing proof',async()=>{
    const input=materialInput(`${account}<main data-region="activity" data-module-type="folder" data-course-module-id="301"><h1>Synthetic folder</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><span data-role="material-section">Week 2</span><ul data-region="folder-contents"><li data-region="folder-entry" data-entry-kind="file" data-file-id="401"><a data-role="entry-link" href="/pluginfile.php/701/mod_folder/content/2/slides.pptx">Slides</a></li></ul></main>`,'/mod/folder/view.php?id=301');
    const f=setup(fixture(input));f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===1);
    const saved:Snapshot=await json('/api/snapshot');expect(saved.collection!.records).toHaveLength(2);
    const root=saved.collection!.records.find(r=>(r.observations[0] as any).kind==='folder')!.observations[0] as any;
    const child=saved.collection!.records.find(r=>(r.observations[0] as any).kind==='file')!.observations[0] as any;
    expect(root.listingScope).toBe('supplied_listing_only');expect(root.references[0].listingChildResourceKeys).toEqual([child.resourceKey]);expect(root).not.toHaveProperty('listingChildResourceKeys');expect(child.fileType).toEqual({kind:'unknown'});expect(child.parentResourceKey).toBe(root.resourceKey);expect(saved.collection!.refreshes[0]!.scope).toBe('supplied_pages_only');f.coordinator.stop();
  });
  it('executes typed synthetic quiz and submission mocks while real adapters remain unavailable',async()=>{
    const registry=syntheticFixtureRegistry();expect(registry.quiz.availability).toBe('unavailable');expect(registry.submission.availability).toBe('unavailable');
    registry.submission={availability:'available',evidenceMode:'synthetic',collect:(_i,_s,t)=>({kind:'submission',observations:[{sourceCourseId:'101',sourceActivityId:'202',sourceCourseModuleId:'303',sourceUrl:origin+'/mod/assign/view.php?id=303',observation:{status:'submitted',observedAt:t,evidence:'Synthetic classified attempt'}}],reviews:[],diagnostics:[],pages:[],coverage:'complete',scope:'visited_activity_only'})};
    const f=setup(fixture(),registry);f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===2);
    expect((await json('/api/snapshot')).collection.records.map((r:any)=>r.kind)).toEqual(['assignment','submission']);
    registry.quiz={availability:'available',evidenceMode:'synthetic',collect:(_i,_s,t)=>({kind:'quiz',observations:[{sourceCourseId:'101',sourceActivityId:'505',sourceCourseModuleId:'404',sourceUrl:origin+'/mod/quiz/view.php?id=404',title:'Synthetic quiz',observedAt:t,attemptInformation:{kind:'unknown'}}],reviews:[],diagnostics:[],pages:[],coverage:'complete',scope:'visited_activity_only'})};
    const input=materialInput(`${account}<main data-region="activity"><h1>Synthetic quiz</h1><a href="/mod/quiz/view.php?id=404">Quiz</a><a data-role="course-link" href="/course/view.php?id=101">Course</a></main>`,'/mod/quiz/view.php?id=404');f.set(fixture(input));await until(()=>f.coordinator.state.receipts.length===3);
    const saved:Snapshot=await json('/api/snapshot');expect(saved.collection!.records.map(r=>r.kind)).toEqual(['assignment','submission','quiz']);expect(saved.collection!.refreshes.every(r=>r.evidenceMode==='synthetic')).toBe(true);f.coordinator.stop();
  });
  it('persists fixed collector failure and unavailable receipts while retaining earlier facts',async()=>{
    const f=setup();f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===2);
    const registry=syntheticFixtureRegistry();registry.assignment.collect=()=>{throw Error('password-private-exception-sentinel');};
    const other=setup(fixture(),registry);other.coordinator.notify();await until(()=>other.coordinator.state.receipts.length===2);
    const saved=await json('/api/snapshot');expect(saved.collection.records).toHaveLength(1);expect(saved.collection.refreshes.at(-2)).toMatchObject({outcome:'failed',reasons:['collector_failed']});expect(JSON.stringify(saved)).not.toContain('private-exception-sentinel');other.coordinator.stop();f.coordinator.stop();
  });
});

describe('#18 lifecycle AC3/AC4',()=>{
  it('A -> B -> A creates three visits; duplicate notifications once; late A cannot commit',async()=>{
    let resolveA!:(v:CollectorResult)=>void;const registry=syntheticFixtureRegistry();const real=registry.assignment.collect;let count=0;
    registry.assignment.collect=vi.fn((input,selection,t)=>++count===1?new Promise<CollectorResult>(resolve=>{resolveA=resolve;}):real(input,selection,t));
    const a=fixture(),b=fixture(assignmentInput(assignment().replaceAll('303','304'),{requestedUrl:origin+'/mod/assign/view.php?id=304',finalUrl:origin+'/mod/assign/view.php?id=304'}));
    const f=setup(a,registry);f.coordinator.notify();await until(()=>!!resolveA);f.set(b);f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===2);
    resolveA(await real(a.input!,['101'],time));await tick();expect((await json('/api/snapshot')).collection.refreshes).toHaveLength(2);
    f.set(a);await until(()=>f.coordinator.state.receipts.length===4);expect(registry.assignment.collect).toHaveBeenCalledTimes(3);
    const saved=await json('/api/snapshot');expect(new Set(saved.collection.refreshes.map((r:any)=>r.visitId)).size).toBe(2);expect(saved.collection.records).toHaveLength(1);f.coordinator.stop();
  });
  it.each(['stop','selection','mapping','grant','document'])('invalidates unresolved results after %s change',async(change)=>{
    let release!:(v:CollectorResult)=>void;const registry=syntheticFixtureRegistry();const real=registry.assignment.collect;registry.assignment.collect=()=>new Promise(resolve=>{release=resolve;});let granted=true;
    const f=setup(fixture(),registry,{grant:async()=>granted});f.coordinator.notify();await until(()=>!!release);
    if(change==='stop')f.coordinator.stop();
    if(change==='selection')await json('/api/tracked-courses','PUT',[]);
    if(change==='mapping'){const s=await json('/api/snapshot');s.courses[0].discovery.sourceCourseId='102';await json('/api/snapshot','PUT',s);}
    if(change==='grant')granted=false;
    if(change==='document')f.set({...f.source,documentKey:{}});
    release(await real(f.source.input!,['101'],time));await tick();await tick();
    expect((await json('/api/snapshot')).collection).toBeUndefined();f.coordinator.stop();
  });
  it.each(['other_host','unsupported','denied','unselected','unmapped','no_envelope'])('%s never writes or calls a collector',async(kind)=>{
    const registry=syntheticFixtureRegistry();registry.assignment.collect=vi.fn(registry.assignment.collect);let source=fixture();
    if(kind==='other_host')source={...source,url:'https://other.example/mod/assign/view.php?id=303'};
    if(kind==='unsupported')source={...source,url:origin+'/my/'};
    if(kind==='denied')source=fixture(assignmentInput(login));
    if(kind==='no_envelope')source={url:source.url,documentKey:{}};
    if(kind==='unselected')await json('/api/tracked-courses','PUT',[]);
    if(kind==='unmapped')source=fixture(assignmentInput(assignment().replaceAll('101','999')));
    const f=setup(source,registry);f.coordinator.notify();await until(()=>f.coordinator.state.status==='unavailable');expect(registry.assignment.collect).not.toHaveBeenCalled();expect((await json('/api/snapshot')).collection).toBeUndefined();f.coordinator.stop();
  });
  it('initial/popstate/hashchange/DOM URL lifecycle disconnects and stops after disposal',async()=>{
    const doc=document;history.replaceState({},'', '/');
    let page=fixture();const b=bridge(()=>page);const registry=syntheticFixtureRegistry();registry.assignment.collect=vi.fn(registry.assignment.collect);
    // Labeled Window shim supplies an SDU origin, real jsdom event/MutationObserver APIs.
    const shim={top:null,location:{origin},document:doc,addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window)} as unknown as Window;(shim as any).top=shim;
    let receipts=0;const stop=installPageRefresh(shim,{source:()=>page,repository:b.repository,registry,clock:()=>time,onState:s=>{receipts=s.receipts.length;}});
    await until(()=>receipts===2);window.dispatchEvent(new PopStateEvent('popstate'));window.dispatchEvent(new HashChangeEvent('hashchange'));doc.body.append(doc.createElement('span'));await tick();expect(registry.assignment.collect).toHaveBeenCalledTimes(1);
    page={...page,url:page.url+'#second'};window.dispatchEvent(new HashChangeEvent('hashchange'));await until(()=>receipts===4);
    page={...page,url:page.url.replace('#second','#third')};doc.body.append(doc.createElement('span'));await until(()=>receipts===6);
    stop();page={...page,url:page.url.replace('#third','#fourth')};window.dispatchEvent(new PopStateEvent('popstate'));doc.body.append(doc.createElement('span'));await tick();expect(registry.assignment.collect).toHaveBeenCalledTimes(3);
  });
  it('visible persistence failure retains saved data and never reflects caught private text',async()=>{
    const initial=setup();initial.coordinator.notify();await until(()=>initial.coordinator.state.receipts.length===2);const saved=await json('/api/snapshot');
    const source=fixture();const b=bridge(()=>source);const repo:CollectionRepository={...b.repository,refresh:async()=>{throw Error('private-sentinel');}};
    const c=createPageRefresh({source:()=>source,repository:repo,registry:syntheticFixtureRegistry(),clock:()=>time});c.notify();await until(()=>c.state.status==='failed');expect(c.state.reason).toBe('persistence_failed');expect(JSON.stringify(c.state)).not.toContain('private-sentinel');expect(await json('/api/snapshot')).toEqual(saved);c.stop();initial.coordinator.stop();
  });
  it('real SQLite writer lock returns a visible fixed failure through actual HTTP without erasing earlier facts',async()=>{
    const initial=setup();initial.coordinator.notify();await until(()=>initial.coordinator.state.receipts.length===2);const saved=await json('/api/snapshot');initial.coordinator.stop();
    const python=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
    const locker=spawn(python,['-u','-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); print('locked',flush=True); sys.stdin.read(); c.rollback(); c.close()",database],{cwd:root,windowsHide:true,stdio:'pipe'});
    let ready=false;locker.stdout?.on('data',v=>{if(String(v).includes('locked'))ready=true;});await until(()=>ready);
    try {const f=setup();f.coordinator.notify();await until(()=>f.coordinator.state.status==='failed');expect(f.coordinator.state.reason).toBe('backend_unavailable');expect(await json('/api/snapshot')).toEqual(saved);f.coordinator.stop();}
    finally {await new Promise<void>(resolve=>{locker.once('exit',()=>resolve());locker.stdin?.end();});}
  });
  it('process restart during a deferred collector invalidates the old result',async()=>{
    let release!:(v:CollectorResult)=>void;const registry=syntheticFixtureRegistry();const real=registry.assignment.collect;registry.assignment.collect=()=>new Promise(resolve=>{release=resolve;});const f=setup(fixture(),registry);f.coordinator.notify();await until(()=>!!release);
    await stop();await start();release(await real(f.source.input!,['101'],time));await until(()=>f.coordinator.state.status==='cancelled');expect((await json('/api/snapshot')).collection).toBeUndefined();f.coordinator.stop();
  });
  it('in-place document activity identity changes invalidate pending results',async()=>{
    let release!:(v:CollectorResult)=>void;const registry=syntheticFixtureRegistry();const real=registry.assignment.collect;const input=assignmentInput();const parsed=await real(input,['101'],time);registry.assignment.collect=()=>new Promise(resolve=>{release=resolve;});const f=setup(fixture(input),registry);f.coordinator.notify();await until(()=>!!release);
    input.document.querySelector('[data-assignment-id]')!.setAttribute('data-assignment-id','999');release(parsed);await until(()=>f.coordinator.state.status==='cancelled');expect((await json('/api/snapshot')).collection).toBeUndefined();f.coordinator.stop();
  });
  it('unassociated calendar reviews cannot guess the sole tracked course',async()=>{
    const registry=syntheticFixtureRegistry();registry.calendar.collect=vi.fn(registry.calendar.collect);const f=setup(fixture(calendarInput(calendarPage(calendarEvent({course:null})))),registry);f.coordinator.notify();await until(()=>f.coordinator.state.status==='unavailable');expect(registry.calendar.collect).not.toHaveBeenCalled();expect((await json('/api/snapshot')).collection).toBeUndefined();f.coordinator.stop();
  });
  it('delayed begin response from A cannot launch a collector after observed B',async()=>{
    const a=fixture();let source=a;const b=bridge(()=>source);let release!:()=>void;let hold=true;const repo:CollectionRepository={...b.repository,begin:async(...args)=>{const token=await b.repository.begin(...args);if(hold){hold=false;await new Promise<void>(r=>{release=r;});}return token;}};
    const registry=syntheticFixtureRegistry();registry.assignment.collect=vi.fn(registry.assignment.collect);const c=createPageRefresh({source:()=>source,repository:repo,registry,clock:()=>time});c.notify();await until(()=>!!release);
    source=fixture(assignmentInput(assignment().replaceAll('303','304'),{requestedUrl:origin+'/mod/assign/view.php?id=304',finalUrl:origin+'/mod/assign/view.php?id=304'}));c.notify();await until(()=>c.state.receipts.length===2);release();await tick();expect(registry.assignment.collect).toHaveBeenCalledTimes(1);expect((await json('/api/snapshot')).collection.refreshes).toHaveLength(2);c.stop();
  });
  it('retains separate complete empty and changed child listings on folder revisit without unioning proof',async()=>{
    const folder=(children:string,attrs='')=>materialInput(`${account}<main data-region="activity" data-module-type="folder" data-course-module-id="301"><h1>Synthetic folder</h1><a data-role="course-link" href="/course/view.php?id=101">Course</a><span data-role="material-section">Week 2</span><ul data-region="folder-contents" ${attrs}>${children}</ul></main>`,'/mod/folder/view.php?id=301');
    const f=setup(fixture(folder('<span data-role="folder-empty"></span>')));f.coordinator.notify();await until(()=>f.coordinator.state.receipts.length===1);
    f.set(fixture(folder('<li data-region="folder-entry" data-entry-kind="file" data-file-id="401" data-file-type="pdf"><a data-role="entry-link" type="application/pdf" href="/pluginfile.php/701/mod_folder/content/2/lecture.pdf">Lecture</a></li>')));await until(()=>f.coordinator.state.receipts.length===2);
    const records=(await json('/api/snapshot')).collection.records;const root=records.find((r:any)=>r.observations[0].kind==='folder');expect(root.observations).toHaveLength(2);expect(root.observations.map((v:any)=>v.references[0].listingChildResourceKeys)).toEqual([[],[records.find((r:any)=>r.observations[0].kind==='file').observations[0].resourceKey]]);expect(root.observations.every((v:any)=>v.listingCoverage==='complete')).toBe(true);f.coordinator.stop();
  });
});

describe('internal worker sender/message bounds',()=>{
  it.each([{id:'other'},{frameId:1},{documentId:undefined},{tab:{id:-1}},{url:'http://moodle.sdu.edu.kz/mod/assign/view.php?id=303'},{url:'https://student:password@moodle.sdu.edu.kz/mod/assign/view.php?id=303'},{origin:'https://other.example'},{tab:{id:7,url:'https://other.example/'}}])('rejects sender %j before network',async(change)=>{
    const f=setup();const fetcher=vi.fn();const worker=createCollectionWorker({runtimeId:'synthetic-extension',grant:async()=>true,fetcher});const sender={...f.sender(),...change};expect(collectionSender(sender,'synthetic-extension')).toBe(false);expect(await worker({source:'moodle-helper-collection',version:'1',requestId:'one',operation:'collectionContext',payload:{}},sender)).toBeUndefined();expect(fetcher).not.toHaveBeenCalled();f.coordinator.stop();
  });
  it('rejects dashboard operation, body context switches and payload document key injection',async()=>{
    const f=setup();const context=await f.repository.context();
    for(const payload of [{visitId:'visit',pageUrl:f.source.url,selectionRevision:context.selectionRevision,documentKey:'forged'},{visitId:'visit',pageUrl:f.source.url,selectionRevision:context.selectionRevision,mode:'verified'}]) {
      const r=await f.worker({source:'moodle-helper-collection',version:'1',requestId:crypto.randomUUID(),operation:'beginPageVisit',binding:context.binding,payload},f.sender());expect(r).toMatchObject({ok:false,reason:'invalid_request'});
    }
    const r=await f.worker({source:'moodle-helper-web',version:'1',requestId:'dashboard',operation:'ingestPageRefresh',payload:{}},f.sender());expect(r).toMatchObject({ok:false});expect((await json('/api/snapshot')).collection).toBeUndefined();f.coordinator.stop();
  });
  it('deduplicates identical internal refresh requests, rejects conflicts and uses browser-derived document keys',async()=>{
    const f=setup();const context=await f.repository.context();const begin={source:'moodle-helper-collection',version:'1',requestId:'begin-once',operation:'beginPageVisit',binding:context.binding,payload:{visitId:'worker-visit',pageUrl:f.source.url,selectionRevision:context.selectionRevision}};
    const [a,b]=await Promise.all([f.worker(begin,f.sender()),f.worker(begin,f.sender())]);expect(a).toEqual(b);expect(f.calls.filter(c=>c.url.endsWith('/visits'))).toHaveLength(1);const body=JSON.parse(f.calls.find(c=>c.url.endsWith('/visits'))!.init!.body as string);expect(body.documentKey).toBe('7:synthetic-document');
    const registry=syntheticFixtureRegistry();const result=await registry.assignment.collect(f.source.input!,['101'],time);const refresh={source:'moodle-helper-collection',version:'1',requestId:'refresh-once',operation:'ingestPageRefresh',binding:context.binding,payload:{visitToken:(a as any).result.visitToken,collector:'assignment',observedAt:time,result}};
    const [one,two]=await Promise.all([f.worker(refresh,f.sender()),f.worker(refresh,f.sender())]);expect(one).toEqual(two);expect(f.calls.filter(c=>c.url.endsWith('/refresh'))).toHaveLength(1);
    expect(await f.worker({...refresh,payload:{...refresh.payload,observedAt:'2026-10-28T12:00Z'}},f.sender())).toMatchObject({ok:false,reason:'duplicate_conflict'});expect((await json('/api/snapshot')).collection.refreshes).toHaveLength(1);f.coordinator.stop();
  });
});
