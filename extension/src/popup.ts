import { BACKEND } from './dashboard-bridge';
import { validSchema } from '../../shared/src/bridge';
import { createMockProgress, type ProgressState } from '../../shared/src/mock-progress';
import { fullSyncFreshness, type FullSyncAttestation } from '../../shared/src/full-sync';

export function installPopup(doc:Document, fetcher:typeof fetch=fetch, storage:Storage=localStorage, fullSyncAttestation?:FullSyncAttestation) {
  let binding='', snapshot:any;
  const status=doc.getElementById('status')!, freshness=doc.getElementById('freshness')!;
  const start=doc.getElementById('start') as HTMLButtonElement, cancel=doc.getElementById('cancel') as HTMLButtonElement, reconnect=doc.getElementById('reconnect') as HTMLButtonElement;
  const exampleRetry=doc.getElementById('example-retry') as HTMLButtonElement;
  start.disabled=true; cancel.disabled=true; exampleRetry.disabled=true;
  async function request(path:string, schema:string, body?:unknown) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
    try {
      const response=await fetcher(BACKEND+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(binding?{'X-Moodle-Helper-Bridge-Binding':binding}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!response.ok) throw new Error('unavailable');
      const text=await response.text(); if(new TextEncoder().encode(text).length>1024*1024) throw new Error('response too large');
      const value=JSON.parse(text); if(!validSchema(schema,value)) throw new Error('invalid response'); return value;
    } finally {clearTimeout(timer);}
  }
  const render=(state:ProgressState)=>{
    status.replaceChildren();
    const add=(text:string)=>{const p=doc.createElement('p');p.textContent=text;status.append(p);};
    const run=state.current?.run, active=!!run&&['pending','running'].includes(run.status);
    if(state.unavailable) add('Progress unavailable or outcome unknown. Reconnect and read back before retrying. Saved data remains visible.');
    else if(!state.current?.courseIds.length) add('Select courses in dashboard Settings to start.');
    else if(run) {
      add(`Mock run: ${run.status} · ${run.progress.completed}/${run.progress.total} completed`);
      for(const job of run.jobs) add(`${snapshot?.courses.find((c:any)=>c.id===job.courseId)?.name ?? job.courseId}: ${job.state}`);
    }
    if(state.current?.lastFailedRun) add(`Last failed mock attempt started: ${new Date(state.current.lastFailedRun.createdAt*1000).toLocaleString()}`);
    if(state.uncertain) add('A request may have completed. Reconnect and read back; explicit retry uses the same unresolved key.');
    start.disabled=state.busy||state.unavailable||!state.current?.courseIds.length||active;
    exampleRetry.disabled=start.disabled;
    start.textContent=run&&!active?'Retry mock run':'Start mock run'; cancel.disabled=state.busy||state.unavailable||!active;
  };
  const transport={
    async connect(){binding='';const context=await request('/api/bridge-context','BridgeContext');binding=context.binding; snapshot=await request('/api/snapshot','Snapshot');
      freshness.replaceChildren(); const p=doc.createElement('p'); const selectedSources=new Set(snapshot.courses.filter((c:any)=>snapshot.settings.trackedCourseIds.includes(c.id)).map((c:any)=>c.discovery?.sourceCourseId).filter(Boolean)); const receipt=snapshot.collection?.refreshes.filter((r:any)=>r.sourceCourseIds.some((id:string)=>selectedSources.has(id))).sort((a:any,b:any)=>b.observedAt.localeCompare(a.observedAt))[0];
      const fullSync=doc.getElementById('full-sync'); if(fullSync) fullSync.textContent=fullSyncFreshness(snapshot.settings.trackedCourseIds,fullSyncAttestation,snapshot.settings.timezone);
      p.textContent=receipt?`Latest page refresh: ${receipt.observedAt} · ${receipt.scope} · ${receipt.outcome} · ${receipt.evidenceMode} evidence`:'No individual-page refresh recorded.';freshness.append(p);
      for(const course of snapshot.sync.filter((x:any)=>x.lastSuccessAt)){const item=doc.createElement('p');item.textContent=`Saved course timestamp (sample/demo values are fictional): ${course.courseId} · ${course.lastSuccessAt}`;freshness.append(item);}
      const saved=doc.createElement('p'); saved.textContent=`Saved data: ${snapshot.courses.length} courses, ${snapshot.assessments.length} assessments. Previous data remains available in the dashboard.`;freshness.append(saved);
      const list=doc.createElement('ul');
      for(const assessment of snapshot.assessments.slice(0,5)) {const item=doc.createElement('li');item.textContent=assessment.title;list.append(item);}
      freshness.append(list);
    },
    current:()=>request('/api/queue/current','QueueCurrent'),
    start:(key:string)=>request('/api/queue/current','QueueRun',{idempotencyKey:key}),
    cancel:(id:string)=>request(`/api/queue/runs/${encodeURIComponent(id)}/cancel`,'QueueRun',{}),
  };
  const controller=createMockProgress(transport,render,storage);
  start.onclick=()=>void controller.start(); exampleRetry.onclick=()=>void controller.start(); cancel.onclick=()=>void controller.cancel(); reconnect.onclick=()=>void controller.reconnect();
  return controller;
}
