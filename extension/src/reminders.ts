/** #38 reminder wakeup mirror. The backend (SQLite) owns the plan, generation and
 * delivery-request ledger. Alarms carry only these two fixed opaque names; no
 * student titles or content are stored in the worker or in chrome.storage.
 * Showing OS notifications is #39: requests go to an injected delivery adapter
 * whose default reports "unavailable" without sending anything. */
import { BACKEND } from './dashboard-bridge';

export const REMINDER_DUE_ALARM = 'moodle-helper-reminder-due';
export const REMINDER_MAINTENANCE_ALARM = 'moodle-helper-reminder-maintenance';
const MIN_DELAY_MS = 60_000; // Chrome 106 alarm floor (1 minute); no newer 30s behavior assumed.

type PlanItem = { id:string; status:'scheduled'|'due'|'requested'|'unscheduled'; dueAt?:string };
type Plan = { datasetId:string; generation:string; serverTime:string; items:PlanItem[]; nextWakeAt?:string };
export type DeliveryRequest = { requestId:string; kind:'deadline'|'busy_week'|'catch_up'; total:number };
export type DeliveryResult = 'unavailable'|'denied'|'requested';
type Dispatch = { generation:string; replayed:boolean; requests:DeliveryRequest[]; nextWakeAt?:string };
export type ReminderAlarms = {
  create:(name:string,info:{when?:number;delayInMinutes?:number;periodInMinutes?:number})=>void;
  clear:(name:string)=>void;
};
export type ReminderState = { status:'ready'|'reconnect'|'unavailable'; nextWakeAt?:string; delivery?:DeliveryResult; lastRequests:string[] };

export function createReminderWorker(options:{alarms:ReminderAlarms; fetcher?:typeof fetch; base?:string; now?:()=>number;
  deliver?:(requests:DeliveryRequest[])=>Promise<DeliveryResult>}) {
  const fetcher=options.fetcher??fetch, base=options.base??BACKEND, now=options.now??Date.now;
  const deliver=options.deliver??(async()=> 'unavailable' as const);
  const state:ReminderState={status:'unavailable',lastRequests:[]};
  let current:Promise<ReminderState>|undefined;
  class Stale extends Error {}
  async function request(path:string, binding?:string, body?:unknown) {
    const r=await fetcher(base+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',
      headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':binding!})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if (r.status===409) throw new Stale();
    if (!r.ok) throw new Error('reminders unavailable');
    return await r.json();
  }
  function mirror(nextWakeAt?:string) {
    // Replace the single due wakeup; never one alarm per item.
    options.alarms.clear(REMINDER_DUE_ALARM);
    if (!nextWakeAt) return;
    const at=Date.parse(nextWakeAt);
    if (Number.isFinite(at)) options.alarms.create(REMINDER_DUE_ALARM,{when:Math.max(at,now()+MIN_DELAY_MS)});
  }
  async function run():Promise<ReminderState> {
    try {
      const {binding}=await request('/api/bridge-context') as {binding:string};
      const {datasetId}=await request('/api/local-context') as {datasetId:string};
      let plan=await request('/api/reminders/reconcile',binding,{datasetId}) as Plan;
      if (plan.items.some(i=>i.status==='due')) {
        // Deterministic key: same plan generation + same outstanding wake boundary
        // replays the stored receipt instead of creating new requests.
        const boundary=plan.items.filter(i=>i.status==='due').map(i=>i.id).sort().join('.');
        const idempotencyKey='rd-'+plan.generation.slice(2,42)+'-'+(await digest(boundary));
        const result=await request('/api/reminders/dispatch',binding,{datasetId,expectedGeneration:plan.generation,idempotencyKey}) as Dispatch;
        state.lastRequests=result.requests.map(r=>r.requestId);
        if (result.requests.length) state.delivery=await deliver(result.requests);
        plan={...plan,nextWakeAt:result.nextWakeAt};
      }
      mirror(plan.nextWakeAt);
      state.status='ready'; state.nextWakeAt=plan.nextWakeAt;
    } catch (error) {
      // Backend down or context changed: drop the unsafe old mirror; never
      // send previous-dataset work to a new context. Maintenance retries.
      options.alarms.clear(REMINDER_DUE_ALARM);
      state.status=error instanceof Stale ? 'reconnect' : 'unavailable'; state.nextWakeAt=undefined;
    }
    return {...state};
  }
  return {
    wake() { current??=run().finally(()=>{current=undefined;}); return current; },
    state:()=>({...state}),
  };
}

async function digest(text:string) {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  return Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
}

type ReminderChrome = { alarms:ReminderAlarms & {onAlarm:{addListener:(cb:(alarm:{name:string})=>void)=>void}};
  runtime:{onStartup:{addListener:(cb:()=>void)=>void};onInstalled:{addListener:(cb:()=>void)=>void}} };
export function installReminderWorker(chrome:ReminderChrome, options:Omit<Parameters<typeof createReminderWorker>[0],'alarms'>={}) {
  // Listeners are registered synchronously before any asynchronous work.
  const worker=createReminderWorker({...options,alarms:chrome.alarms});
  chrome.alarms.create(REMINDER_MAINTENANCE_ALARM,{delayInMinutes:1,periodInMinutes:1});
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===REMINDER_DUE_ALARM||alarm.name===REMINDER_MAINTENANCE_ALARM) void worker.wake();});
  chrome.runtime.onStartup.addListener(()=>{void worker.wake();});
  chrome.runtime.onInstalled.addListener(()=>{void worker.wake();});
  void worker.wake();
  return worker;
}
