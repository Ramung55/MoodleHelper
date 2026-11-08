/** #38 reminder wakeup mirror. The backend (SQLite) owns the plan, generation and
 * delivery-request ledger. Alarms carry only these two fixed opaque names; no
 * student titles or content are stored in the worker or in chrome.storage.
 * #39: OS notifications are an optional channel after the backend has already
 * persisted the dashboard Alert. Each pending delivery is reserved atomically in
 * the backend before chrome.notifications.create; a lost response after the
 * reservation is an unknown outcome and is never re-created (at-most-once, so a
 * crash between reserve and create can miss one OS notification by design). */
import { BACKEND } from './dashboard-bridge';
import { APPROVED_ORIGINS } from '../../shared/src/bridge';

export const REMINDER_DUE_ALARM = 'moodle-helper-reminder-due';
export const REMINDER_MAINTENANCE_ALARM = 'moodle-helper-reminder-maintenance';
const MIN_DELAY_MS = 60_000; // Chrome 106 alarm floor (1 minute); no newer 30s behavior assumed.

type PlanItem = { id:string; status:'scheduled'|'due'|'requested'|'unscheduled'; dueAt?:string };
type Pending = { deliveryKey:string; notificationId:string };
type Plan = { datasetId:string; generation:string; serverTime:string; items:PlanItem[]; nextWakeAt?:string; pendingDeliveries?:Pending[] };
type Receipt = { state:string; reserved:boolean; notificationId:string; title?:string; message?:string };
export type DeliveryRequest = { requestId:string; kind:'deadline'|'busy_week'|'catch_up'; total:number };
export type DeliveryResult = 'unavailable'|'denied'|'requested';
type Dispatch = { generation:string; replayed:boolean; requests:DeliveryRequest[]; nextWakeAt?:string; pendingDeliveries?:Pending[] };
export type ReminderAlarms = {
  create:(name:string,info:{when?:number;delayInMinutes?:number;periodInMinutes?:number})=>void;
  clear:(name:string)=>void;
};
export type ReminderState = { status:'ready'|'reconnect'|'unavailable'; nextWakeAt?:string; delivery?:DeliveryResult; lastRequests:string[]; epoch?:number; restoredAt?:number };

/** Callback-compatible port (Chrome 106; no Promise-only API assumed). */
export type NotificationPort = {
  permissionLevel():Promise<'granted'|'denied'>;
  create(id:string, options:{type:'basic';iconUrl:string;title:string;message:string}):Promise<'created'|'error'>;
  clear(id:string):void;
};
export const NOTIFICATION_ICON = 'icon-128.png';
const NOTIFICATION_ID = /^mhn-[0-9a-f]{32}$/;
const DASHBOARD = APPROVED_ORIGINS[0];

/** Closed route mapping (same as the dashboard resolver); never a URL from a payload. */
export function dashboardUrl(target?:{destination?:string;assessmentId?:string}) {
  if (target?.destination==='assessment' && typeof target.assessmentId==='string' && target.assessmentId)
    return `${DASHBOARD}/deadlines?id=${encodeURIComponent(target.assessmentId)}`;
  if (target?.destination==='week') return `${DASHBOARD}/planner`;
  return `${DASHBOARD}/alerts`;
}

export function createReminderWorker(options:{alarms:ReminderAlarms; fetcher?:typeof fetch; base?:string; now?:()=>number;
  notifications?:NotificationPort; attemptId?:()=>string}) {
  const fetcher=options.fetcher??fetch, base=options.base??BACKEND, now=options.now??Date.now;
  const attemptId=options.attemptId??(()=>'at-'+crypto.randomUUID().replace(/-/g,''));
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
  async function deliver(pending:Pending[], ctx:{binding:string;datasetId:string;generation:string}):Promise<DeliveryResult> {
    const port=options.notifications;
    if (!port) return 'unavailable'; // Dashboard history stays; nothing is sent.
    // Capability is re-read before each scheduled delivery; never a permission prompt.
    let level:'granted'|'denied';
    try { level=await port.permissionLevel(); } catch { return 'unavailable'; }
    for (const item of pending) {
      const body={datasetId:ctx.datasetId,expectedGeneration:ctx.generation,deliveryKey:item.deliveryKey,attemptId:attemptId()};
      if (level!=='granted') { await request('/api/reminders/delivery-status',ctx.binding,{...body,state:'denied'}); continue; }
      const receipt=await request('/api/reminders/delivery-status',ctx.binding,{...body,state:'issued'}) as Receipt;
      if (!receipt.reserved || !receipt.title || !receipt.message || !NOTIFICATION_ID.test(receipt.notificationId)) continue;
      const outcome=await port.create(receipt.notificationId,{type:'basic',iconUrl:NOTIFICATION_ICON,title:receipt.title,message:receipt.message});
      await request('/api/reminders/delivery-status',ctx.binding,
        outcome==='created'?{...body,state:'shown'}:{...body,state:'failed',fixedErrorCode:'create_failed'});
    }
    return level==='granted'?'requested':'denied';
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
      // #55: a changed data-lifecycle epoch means a backup restore replaced the data.
      // Drop the old wakeup mirror before reconciling the rebuilt backend plan.
      let epoch:number|undefined;
      try { const ctx=await request('/api/backups/restore-context') as {datasetId?:string;epoch?:unknown};
        if (ctx.datasetId===datasetId && Number.isInteger(ctx.epoch)) epoch=ctx.epoch as number; } catch { /* older backend: no epoch */ }
      if (epoch!==undefined && state.epoch!==undefined && epoch!==state.epoch) { options.alarms.clear(REMINDER_DUE_ALARM); state.restoredAt=now(); }
      if (epoch!==undefined) state.epoch=epoch;
      // #56: a confirmed erase for the CURRENT epoch: drop only this tool's reminder wakeup
      // and extension-side delivery metadata, then acknowledge (backend stays authority).
      let erasure:{eraseId?:unknown;cleanup?:{extension?:unknown}}|undefined;
      try { const ctx=await request('/api/data-context') as {datasetId?:string;epoch?:unknown;erasure?:typeof erasure};
        if (ctx.datasetId===datasetId && ctx.epoch===epoch) erasure=ctx.erasure; } catch { /* older backend: no erase protocol */ }
      if (erasure && typeof erasure.eraseId==='string' && /^[0-9a-f]{32}$/.test(erasure.eraseId) && erasure.cleanup?.extension!=='complete') {
        options.alarms.clear(REMINDER_DUE_ALARM);
        state.lastRequests=[]; state.delivery=undefined; state.nextWakeAt=undefined;
        await request(`/api/local-data/erasures/${erasure.eraseId}/ack`,binding,{component:'extension',state:'complete'});
      }
      let plan=await request('/api/reminders/reconcile',binding,{datasetId}) as Plan;
      if (plan.items.some(i=>i.status==='due')) {
        // Deterministic key: same plan generation + same outstanding wake boundary
        // replays the stored receipt instead of creating new requests.
        const boundary=plan.items.filter(i=>i.status==='due').map(i=>i.id).sort().join('.');
        const idempotencyKey='rd-'+plan.generation.slice(2,42)+'-'+(await digest(boundary));
        const result=await request('/api/reminders/dispatch',binding,{datasetId,expectedGeneration:plan.generation,idempotencyKey}) as Dispatch;
        state.lastRequests=result.requests.map(r=>r.requestId);
        plan={...plan,nextWakeAt:result.nextWakeAt,pendingDeliveries:result.pendingDeliveries??plan.pendingDeliveries};
      }
      mirror(plan.nextWakeAt);
      // Pending deliveries come from the durable backend history, so a lost dispatch
      // response or a worker restart still reaches delivery (reserved at most once).
      if (plan.pendingDeliveries?.length) state.delivery=await deliver(plan.pendingDeliveries,{binding,datasetId,generation:plan.generation});
      state.status='ready'; state.nextWakeAt=plan.nextWakeAt;
    } catch (error) {
      // Backend down or context changed: drop the unsafe old mirror; never
      // send previous-dataset work to a new context. Maintenance retries.
      options.alarms.clear(REMINDER_DUE_ALARM);
      state.status=error instanceof Stale ? 'reconnect' : 'unavailable'; state.nextWakeAt=undefined;
    }
    return {...state};
  }
  async function target(notificationId:string):Promise<string> {
    // Current process/dataset check; any failure opens generic Alerts with no stale private context.
    try {
      const {binding}=await request('/api/bridge-context') as {binding:string};
      const {datasetId}=await request('/api/local-context') as {datasetId:string};
      return dashboardUrl(await request('/api/reminders/notification-target',binding,{datasetId,notificationId}));
    } catch { return dashboardUrl(); }
  }
  return {
    wake() { current??=run().finally(()=>{current=undefined;}); return current; },
    state:()=>({...state}),
    target,
  };
}

async function digest(text:string) {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  return Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
}

type ChromeNotifications = {
  getPermissionLevel:(cb:(level:string)=>void)=>void;
  create:(id:string,options:object,cb:(id:string)=>void)=>void;
  clear:(id:string,cb?:(cleared:boolean)=>void)=>void;
  onClicked:{addListener:(cb:(id:string)=>void)=>void};
};
type ReminderChrome = { alarms:ReminderAlarms & {onAlarm:{addListener:(cb:(alarm:{name:string})=>void)=>void}};
  runtime:{onStartup:{addListener:(cb:()=>void)=>void};onInstalled:{addListener:(cb:()=>void)=>void};lastError?:unknown};
  notifications?:ChromeNotifications; tabs?:{create:(props:{url:string})=>void} };

/** A definite create error becomes the fixed 'create_failed' code; no Chrome message text is kept. */
export function chromeNotificationPort(chrome:{runtime:{lastError?:unknown};notifications:ChromeNotifications}):NotificationPort {
  return {
    permissionLevel:()=>new Promise(resolve=>chrome.notifications.getPermissionLevel(level=>resolve(level==='granted'?'granted':'denied'))),
    create:(id,options)=>new Promise(resolve=>{
      try { chrome.notifications.create(id,options,()=>resolve(chrome.runtime.lastError?'error':'created')); }
      catch { resolve('error'); }
    }),
    clear:id=>{ try { chrome.notifications.clear(id,()=>void chrome.runtime.lastError); } catch { /* best effort */ } },
  };
}

export function installReminderWorker(chrome:ReminderChrome, options:Omit<Parameters<typeof createReminderWorker>[0],'alarms'>={}) {
  // Listeners are registered synchronously before any asynchronous work.
  const notifications=chrome.notifications?chromeNotificationPort({runtime:chrome.runtime,notifications:chrome.notifications}):undefined;
  const worker=createReminderWorker({...(notifications?{notifications}:{}),...options,alarms:chrome.alarms});
  chrome.alarms.create(REMINDER_MAINTENANCE_ALARM,{delayInMinutes:1,periodInMinutes:1});
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===REMINDER_DUE_ALARM||alarm.name===REMINDER_MAINTENANCE_ALARM) void worker.wake();});
  chrome.runtime.onStartup.addListener(()=>{void worker.wake();});
  chrome.runtime.onInstalled.addListener(()=>{void worker.wake();});
  chrome.notifications?.onClicked.addListener(id=>{
    if (!NOTIFICATION_ID.test(id)) return; // Only our opaque ids.
    void worker.target(id).then(url=>{ chrome.tabs?.create({url}); notifications?.clear(id); });
  });
  void worker.wake();
  return worker;
}
