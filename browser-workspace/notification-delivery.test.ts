import { it, expect } from 'vitest';
import { createReminderWorker, installReminderWorker, chromeNotificationPort, dashboardUrl, NOTIFICATION_ICON, type NotificationPort } from '../extension/src/reminders';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const NID='mhn-'+'a'.repeat(32);

/** Fake #39 backend: one pending delivery whose state machine mirrors the real ledger. */
function backend(opts:{target?:unknown;lose?:'issued'}={}) {
  const log:{url:string;body?:any}[]=[];let state='pending',holder:string|undefined;let lost=false;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;log.push({url,body});
    if(url.endsWith('/bridge-context')) return json({binding:'b'});
    if(url.endsWith('/local-context')) return json({datasetId:'ds'});
    if(url.endsWith('/reconcile')) return json({datasetId:'ds',generation:'g-1',serverTime:'x',items:[],
      pendingDeliveries:state==='pending'?[{deliveryKey:'change:c1',notificationId:NID}]:[]});
    if(url.endsWith('/notification-target')) return opts.target===undefined?json({message:'x'},409):json(opts.target);
    if(url.endsWith('/delivery-status')){
      expect(Object.keys(body).sort()).toEqual(['attemptId','datasetId','deliveryKey','expectedGeneration','state',...(body.fixedErrorCode?['fixedErrorCode']:[])].sort());
      if(body.state==='issued'||body.state==='denied'){
        if(state!=='pending') return json({deliveryKey:body.deliveryKey,notificationId:NID,state,reserved:false});
        state=body.state;holder=body.attemptId;
        if(opts.lose===body.state&&!lost){lost=true;throw new TypeError('lost response');}
        return json({deliveryKey:body.deliveryKey,notificationId:NID,state,reserved:state==='issued',...(state==='issued'?{title:'Moodle Helper',message:'Title a is due soon'}:{})});
      }
      if(state!=='issued'||holder!==body.attemptId) return json({message:'x'},409);
      state=body.state;return json({deliveryKey:body.deliveryKey,notificationId:NID,state,reserved:false});
    }
    throw Error('unexpected '+url);
  };
  return {fetcher,log,state:()=>state};
}
function port(level:'granted'|'denied',result:'created'|'error'='created') {
  const created:{id:string;options:any}[]=[];let prompts=0;
  const p:NotificationPort={permissionLevel:async()=>{prompts++;return level;},create:async(id,options)=>{created.push({id,options});return result;},clear:()=>{}};
  return {p,created,checks:()=>prompts};
}
const alarms=()=>({create:()=>{},clear:()=>{}});

it('reserves once then creates with the stable id, fixed local icon and backend-derived text',async()=>{
  const b=backend(),n=port('granted');
  const w=createReminderWorker({alarms:alarms(),fetcher:b.fetcher,notifications:n.p});
  expect((await w.wake()).delivery).toBe('requested');
  expect(n.created).toEqual([{id:NID,options:{type:'basic',iconUrl:NOTIFICATION_ICON,title:'Moodle Helper',message:'Title a is due soon'}}]);
  expect(b.state()).toBe('shown');
  await w.wake();await createReminderWorker({alarms:alarms(),fetcher:b.fetcher,notifications:n.p}).wake(); // repeated alarm + restart
  expect(n.created).toHaveLength(1);
});

it('denied capability records denied, never creates and never prompts more than a level read',async()=>{
  const b=backend(),n=port('denied');
  const result=await createReminderWorker({alarms:alarms(),fetcher:b.fetcher,notifications:n.p}).wake();
  expect(result.delivery).toBe('denied');expect(n.created).toEqual([]);expect(b.state()).toBe('denied');expect(n.checks()).toBe(1);
});

it('a definite create error is recorded as fixed create_failed and not retried',async()=>{
  const b=backend(),n=port('granted','error');
  const w=createReminderWorker({alarms:alarms(),fetcher:b.fetcher,notifications:n.p});await w.wake();await w.wake();
  expect(b.state()).toBe('failed');expect(n.created).toHaveLength(1);
  const failed=b.log.find(l=>l.body?.state==='failed');expect(failed?.body.fixedErrorCode).toBe('create_failed');
});

it('lost reservation response is an unknown outcome: no create, and no new reservation on restart',async()=>{
  const b=backend({lose:'issued'}),n=port('granted');
  expect((await createReminderWorker({alarms:alarms(),fetcher:b.fetcher,notifications:n.p}).wake()).status).toBe('unavailable');
  await createReminderWorker({alarms:alarms(),fetcher:b.fetcher,notifications:n.p}).wake();
  expect(n.created).toEqual([]);expect(b.state()).toBe('issued');
});

it('without a notifications port the dashboard history is untouched and nothing is reserved',async()=>{
  const b=backend();expect((await createReminderWorker({alarms:alarms(),fetcher:b.fetcher}).wake()).delivery).toBe('unavailable');
  expect(b.log.some(l=>l.url.endsWith('/delivery-status'))).toBe(false);
});

it('click opens only closed dashboard routes; failures open Alerts',async()=>{
  expect(dashboardUrl({destination:'assessment',assessmentId:'a/b?c'})).toBe('http://127.0.0.1:5173/deadlines?id=a%2Fb%3Fc');
  expect(dashboardUrl({destination:'week'})).toBe('http://127.0.0.1:5173/planner');
  expect(dashboardUrl({destination:'https://evil.example'} as any)).toBe('http://127.0.0.1:5173/alerts');
  const listeners:any={};const opened:string[]=[];const cleared:string[]=[];
  const chrome={alarms:{create:()=>{},clear:()=>{},onAlarm:{addListener:()=>{}}},runtime:{onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}}},
    tabs:{create:({url}:{url:string})=>opened.push(url)},
    notifications:{getPermissionLevel:(cb:any)=>cb('denied'),create:()=>{},clear:(id:string)=>cleared.push(id),onClicked:{addListener:(f:any)=>{listeners.click=f;}}}};
  installReminderWorker(chrome,{fetcher:backend({target:{destination:'assessment',assessmentId:'x1',url:'https://moodle'}}).fetcher});
  listeners.click('foreign-id');listeners.click(NID);await new Promise(r=>setTimeout(r,20));
  expect(opened).toEqual(['http://127.0.0.1:5173/deadlines?id=x1']);expect(cleared).toEqual([NID]);
  installReminderWorker(chrome,{fetcher:backend().fetcher}); // stale dataset -> 409
  listeners.click(NID);await new Promise(r=>setTimeout(r,20));
  expect(opened.at(-1)).toBe('http://127.0.0.1:5173/alerts');
});

it('callback adapter maps lastError to a fixed error without message text',async()=>{
  const runtime:{lastError?:unknown}={};
  const p=chromeNotificationPort({runtime,notifications:{getPermissionLevel:cb=>cb('granted'),create:(_i,_o,cb)=>{runtime.lastError={message:'secret path'};cb('');runtime.lastError=undefined;},clear:()=>{},onClicked:{addListener:()=>{}}}});
  expect(await p.permissionLevel()).toBe('granted');
  expect(await p.create(NID,{type:'basic',iconUrl:NOTIFICATION_ICON,title:'t',message:'m'})).toBe('error');
});
