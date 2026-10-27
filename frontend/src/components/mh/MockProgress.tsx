import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BridgeClient } from '@/services/extension-adapter';
import type { Snapshot } from '@/domain/types';
import { createMockProgress, type ProgressState } from '../../../../shared/src/mock-progress';

export function MockProgress({snapshot}:{snapshot:Snapshot}) {
  const [state,setState]=useState<ProgressState>({unavailable:false,busy:false,uncertain:false});
  const [controller,setController]=useState<ReturnType<typeof createMockProgress>>();
  useEffect(()=>{
    const client=new BridgeClient();
    const c=createMockProgress({connect:()=>client.connect(),current:()=>client.currentMockRun(),start:k=>client.startMockRun(k),cancel:id=>client.cancelMockRun(id),dispose:()=>client.dispose()},setState,window.sessionStorage);
    setController(c); return ()=>c.dispose();
  },[]);
  const run=state.current?.run;
  const active=run && ['pending','running'].includes(run.status);
  const selectedSources=new Set(snapshot.courses.filter(c=>snapshot.settings.trackedCourseIds.includes(c.id)).map(c=>c.discovery?.sourceCourseId).filter(Boolean));
  const receipt=snapshot.collection?.refreshes.filter(r=>r.sourceCourseIds.some(id=>selectedSources.has(id))).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
  return <section className="mt-8 rounded-lg border bg-card p-5" aria-label="Mock scan progress">
    <h2 className="text-xl font-semibold">Mock scan progress</h2>
    <p className="text-sm text-muted-foreground">Demonstration only: this does not contact Moodle or refresh saved data.</p>
    <p>No successful full sync yet. No authoritative full-scan evidence is available.</p>
    <p>{receipt ? `Latest page refresh: ${receipt.observedAt} · ${receipt.scope} · ${receipt.outcome} · ${receipt.evidenceMode} evidence` : 'No individual-page refresh recorded.'}</p>
    {snapshot.sync.filter(x=>x.lastSuccessAt).map(x=><p key={x.courseId} className="text-sm">Saved course timestamp (sample/demo values are fictional): {x.courseId} · {x.lastSuccessAt}</p>)}
    {!state.current?.courseIds.length && !state.unavailable && <p>Select courses in <Link to="/settings" className="underline">Settings</Link> to start a mock run.</p>}
    {state.unavailable && <p role="alert">Progress is unavailable or the outcome is unknown. Saved data remains visible. Reconnect and read back before retrying. <button className="underline" onClick={()=>void controller?.reconnect()}>Reconnect</button></p>}
    {state.uncertain && <p>An earlier request may have completed. Reconnect and read back; an explicit retry uses the same unresolved key.</p>}
    {run && !state.unavailable && <div>
      <p>Mock run: {run.status} · {run.progress.completed}/{run.progress.total} completed</p>
      <ul>{run.jobs.map(j=><li key={j.id}>{snapshot.courses.find(c=>c.id===j.courseId)?.name ?? j.courseId}: {j.state}</li>)}</ul>
    </div>}
    {state.current?.lastFailedRun && <p>Last failed mock attempt started: {new Date(state.current.lastFailedRun.createdAt*1000).toLocaleString()}</p>}
    <div className="mt-2 flex gap-3">
      <button className="rounded border px-3 py-1" disabled={state.busy||state.unavailable||!state.current?.courseIds.length||!!active} onClick={()=>void controller?.start()}>{run&&!active?'Retry mock run':'Start mock run'}</button>
      <button className="rounded border px-3 py-1" disabled={state.busy||state.unavailable||!active} onClick={()=>void controller?.cancel()}>Cancel mock run</button>
    </div>
    <details className="mt-3 text-sm"><summary>Mock examples</summary>
      <p>Example — Partial: some courses completed, others remain incomplete. Retry the mock run.</p>
      <p>Example — Failed: a mock job failed. Retry the mock run.</p>
      <p>Example — Cancelled: the mock run was cancelled. Start another mock run.</p>
      <button className="underline" disabled={state.busy||state.unavailable||!state.current?.courseIds.length||!!active} onClick={()=>void controller?.start()}>Retry a mock run</button>
      <p>Example — Signed out: <a className="underline" href="https://moodle.sdu.edu.kz/login/index.php">Sign in to SDU Moodle</a>, then retry when live scanning is available. This example does not describe your current session.</p>
    </details>
  </section>;
}
