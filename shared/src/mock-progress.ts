/** Mock queue presentation state. No operation here accesses Moodle. */
export type MockJob = { id:string; courseId:string; state:'pending'|'running'|'completed'|'failed'|'cancelled' };
export type MockRun = { id:string; idempotencyKey:string; courseIds:string[]; createdAt:number; status:'pending'|'running'|'completed'|'failed'|'cancelled'; cancelled:boolean; jobs:MockJob[]; progress:{total:number; pending:number; running:number; completed:number; failed:number; cancelled:number} };
export type Current = {courseIds:string[]; run?:MockRun; lastFailedRun?:MockRun};
export interface MockTransport { connect():Promise<unknown>; current():Promise<Current>; start(key:string):Promise<MockRun>; cancel(id:string):Promise<MockRun>; dispose?():void }
export type ProgressState = {current?:Current; unavailable:boolean; busy:boolean; uncertain:boolean};

export function createMockProgress(transport:MockTransport, publish:(state:ProgressState)=>void, storage:Storage) {
  let state:ProgressState={unavailable:false,busy:false,uncertain:!!storage.getItem('mock-start-key')};
  let generation=0, readsInFlight=0, disposed=false, timer:ReturnType<typeof setInterval>|undefined;
  const update=(patch:Partial<ProgressState>)=>{state={...state,...patch}; if(!disposed) publish(state);};
  async function read(reconnect=false) {
    const serial=++generation;
    readsInFlight++;
    try {
      if(reconnect) await transport.connect();
      if(disposed || serial!==generation) return false;
      const current=await transport.current();
      if(serial===generation&&!disposed) { update({current,unavailable:false}); return true; }
      return false;
    } catch { if(serial===generation&&!disposed) update({unavailable:true}); return false; }
    finally { readsInFlight--; }
  }
  async function start() {
    if(state.busy||state.unavailable||!state.current?.courseIds.length) return;
    const key=storage.getItem('mock-start-key') || crypto.randomUUID();
    storage.setItem('mock-start-key',key);
    ++generation; update({busy:true});
    try {
      await transport.start(key);
      if(await read()) { storage.removeItem('mock-start-key'); update({uncertain:false}); }
      else update({uncertain:true});
    } catch { update({uncertain:true,unavailable:true}); }
    finally { update({busy:false}); }
  }
  async function cancel() {
    const run=state.current?.run;
    if(state.busy||state.unavailable||!run||!['pending','running'].includes(run.status)) return;
    ++generation; update({busy:true});
    try { await transport.cancel(run.id); await read(); }
    catch { update({unavailable:true,uncertain:true}); }
    finally { update({busy:false}); }
  }
  void read(true);
  // Never supersede a slow successful read with another periodic poll. Explicit
  // mutations and reconnects still fence older responses using generation.
  timer=setInterval(()=>{if(!disposed&&!readsInFlight&&!state.busy&&!state.unavailable && (typeof document==='undefined'||document.visibilityState==='visible')) void read();},3000);
  return {start,cancel,reconnect:()=>read(true),dispose(){disposed=true; ++generation; if(timer) clearInterval(timer); transport.dispose?.();}};
}
