import { it, expect } from 'vitest';
import { createReminderWorker, installReminderWorker, REMINDER_DUE_ALARM, REMINDER_MAINTENANCE_ALARM } from '../extension/src/reminders';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const NOW=Date.parse('2027-02-10T12:00:00Z');

/** Deterministic fake backend: receipts keyed by idempotency key, ledger of requested item ids. */
function backend(items:{id:string;dueAt:string}[], opts:{dataset?:string}={}) {
  const requested=new Set<string>(), receipts=new Map<string,unknown>(), log:{url:string;body?:any;binding?:string|null}[]=[];
  let binding='b1', down=false;
  const plan=()=>{const it=items.map(i=>({...i,status:requested.has(i.id)?'requested':Date.parse(i.dueAt)<=NOW?'due':'scheduled'}));
    const next=it.filter(i=>i.status==='scheduled').map(i=>i.dueAt).sort()[0];
    return {datasetId:opts.dataset??'ds',generation:'g-abc',serverTime:'x',items:it,...(next?{nextWakeAt:next}:{})};};
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input), body=init?.body?JSON.parse(String(init.body)):undefined, header=(init?.headers as any)?.['X-Moodle-Helper-Bridge-Binding']??null;
    log.push({url,body,binding:header});
    if(down) throw new TypeError('offline');
    expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error');
    if(url.endsWith('/api/bridge-context')) return json({version:'1',binding});
    if(url.endsWith('/api/local-context')) return json({datasetId:'ds'});
    if(header!==binding||body?.datasetId!=='ds') return json({message:'Collection context changed. Reconnect.'},409);
    if(url.endsWith('/reconcile')) return json(plan());
    if(url.endsWith('/dispatch')){
      if(receipts.has(body.idempotencyKey)) return json({...(receipts.get(body.idempotencyKey) as object),replayed:true});
      const due=plan().items.filter(i=>i.status==='due');due.forEach(i=>requested.add(i.id));
      const requests=due.length>1?[{requestId:'rq-catch',kind:'catch_up',state:'requested',total:due.length,targets:[]}]:due.map(i=>({requestId:'rq-'+i.id,kind:'deadline',state:'requested',total:1,targets:[]}));
      const p=plan(); const result={datasetId:'ds',generation:'g-abc',serverTime:'x',replayed:false,requests,...(p.nextWakeAt?{nextWakeAt:p.nextWakeAt}:{})};
      receipts.set(body.idempotencyKey,result); return json(result);
    }
    throw Error('unexpected '+url);
  };
  return {fetcher,log,requested,setBinding:(b:string)=>{binding=b;},setDown:(d:boolean)=>{down=d;}};
}
function alarms(){const set=new Map<string,any>();return {set,create:(n:string,i:any)=>{set.set(n,i);},clear:(n:string)=>{set.delete(n);}};}

it('mirrors only one opaque due wakeup with the Chrome 106 one-minute floor',async()=>{
  const b=backend([{id:'a',dueAt:'2027-02-11T00:00:00Z'},{id:'c',dueAt:'2027-02-10T12:00:30Z'}]);const a=alarms();
  const w=createReminderWorker({alarms:a,fetcher:b.fetcher,now:()=>NOW-60_000});
  expect((await w.wake()).status).toBe('ready');
  expect([...a.set.keys()]).toEqual([REMINDER_DUE_ALARM]);
  expect(a.set.get(REMINDER_DUE_ALARM).when).toBe(Date.parse('2027-02-10T12:00:30Z'));
  expect(JSON.stringify([...a.set])).not.toMatch(/Title|assessment/i);
  expect(b.log.some(l=>l.url.endsWith('/dispatch'))).toBe(false);
});

it('missed items after restart become one catch-up request; restart and lost alarms never re-request',async()=>{
  const b=backend([{id:'a',dueAt:'2027-02-09T00:00:00Z'},{id:'c',dueAt:'2027-02-08T00:00:00Z'},{id:'f',dueAt:'2027-03-01T00:00:00Z'}]);
  const delivered:string[][]=[];
  const make=()=>createReminderWorker({alarms:alarms(),fetcher:b.fetcher,now:()=>NOW});
  const first=await make().wake();
  delivered.push(first.lastRequests);
  expect(delivered).toEqual([['rq-catch']]);expect(first.nextWakeAt).toBe('2027-03-01T00:00:00Z');
  const lost=alarms();const second=createReminderWorker({alarms:lost,fetcher:b.fetcher,now:()=>NOW});await second.wake();
  expect(delivered).toHaveLength(1);
  expect(lost.set.has(REMINDER_DUE_ALARM)).toBe(true); // recreated after alarm loss
  expect(b.log.filter(l=>l.url.endsWith('/dispatch'))).toHaveLength(1);
});

it('uncertain dispatch response never creates a new request on the next wake (ledger fences it; #39 reconciles receipt)',async()=>{
  const b=backend([{id:'a',dueAt:'2027-02-10T11:59:00Z'}]);let drop=true;
  const fetcher:typeof fetch=async(u,i)=>{const r=await b.fetcher(u,i);if(String(u).endsWith('/dispatch')&&drop){drop=false;throw new TypeError('lost response');}return r;};
  const delivered:string[]=[];const opts={alarms:alarms(),fetcher,now:()=>NOW};
  expect((await createReminderWorker(opts).wake()).status).toBe('unavailable');
  await createReminderWorker(opts).wake();
  const keys=b.log.filter(l=>l.url.endsWith('/dispatch')).map(l=>l.body.idempotencyKey);
  expect(keys).toHaveLength(1);expect(b.requested).toEqual(new Set(['a']));expect(delivered).toEqual([]);
});

it('stale binding or backend down cancels the unsafe mirror and sends nothing',async()=>{
  const b=backend([{id:'a',dueAt:'2027-02-11T00:00:00Z'}]);const a=alarms();
  const w=createReminderWorker({alarms:a,fetcher:b.fetcher,now:()=>NOW});await w.wake();expect(a.set.has(REMINDER_DUE_ALARM)).toBe(true);
  b.setDown(true);expect((await w.wake()).status).toBe('unavailable');expect(a.set.has(REMINDER_DUE_ALARM)).toBe(false);
  b.setDown(false);const stale:typeof fetch=async(u,i)=>{const r=await b.fetcher(u,i);if(String(u).endsWith('/bridge-context'))b.setBinding('b2');return r;};
  const s=createReminderWorker({alarms:a,fetcher:stale,now:()=>NOW});expect((await s.wake()).status).toBe('reconnect');expect(a.set.size).toBe(0);
});

it('installs listeners synchronously with fixed names and a periodic maintenance wake',async()=>{
  const created=new Map<string,any>(),alarm:any[]=[],life:any[]=[];
  const chrome={alarms:{create:(n:string,i:any)=>created.set(n,i),clear:()=>{},onAlarm:{addListener:(f:any)=>alarm.push(f)}},
    runtime:{onStartup:{addListener:(f:any)=>life.push(f)},onInstalled:{addListener:(f:any)=>life.push(f)}}};
  const b=backend([]);installReminderWorker(chrome,{fetcher:b.fetcher});
  expect(alarm).toHaveLength(1);expect(life).toHaveLength(2);
  expect(created.get(REMINDER_MAINTENANCE_ALARM)).toEqual({delayInMinutes:1,periodInMinutes:1});
  const before=b.log.length;alarm[0]({name:'moodle-helper-mock-queue'});await new Promise(r=>setTimeout(r,10));
  alarm[0]({name:REMINDER_DUE_ALARM});await new Promise(r=>setTimeout(r,10));expect(b.log.length).toBeGreaterThan(before);
});
