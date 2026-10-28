import { afterEach, expect, it, vi } from "vitest";
import { acquireLocalJobLease, recoverLocalJobs, type LocalJob } from "@/services/local-documents";
const datasetId = "12345678-1234-4123-8123-123456789abc";
afterEach(() => vi.unstubAllGlobals());
it("recovers abandoned jobs while leaving a live tab's locked job untouched", async () => {
  const active = new Set<string>();
  let beforeAcquire: ((name: string) => void) | undefined;
  vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
    if (active.has(name)) return callback(null);
    beforeAcquire?.(name);
    active.add(name); try { await callback({ name }); } finally { active.delete(name); }
  } } });
  let currentId = datasetId;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({datasetId:currentId}),{status:200})));
  vi.stubGlobal("IDBKeyRange", { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) });
  const make = (id: string): LocalJob => ({datasetId,owner:"old-session",id,name:`${id}.pdf`,courseId:"course",state:"parsing",message:"running",leaseVersion:1});
  const records = new Map<string, LocalJob>([["live",make("live")],["abandoned",make("abandoned")]]);
  const db = { close: () => {}, transaction: () => {
    const tx: {oncomplete?:()=>void;onabort?:()=>void;objectStore:()=>unknown} = {objectStore:()=>({
      getAll: () => { const request: {result?:LocalJob[]} = {}; queueMicrotask(() => { request.result=[...records.values()].map(v=>({...v})); tx.oncomplete?.(); }); return request; },
      get: (key: string[]) => { const request: {result?:LocalJob;onsuccess?:()=>void} = {}; queueMicrotask(() => { const row=records.get(key[2]!); request.result=row && {...row}; request.onsuccess?.(); tx.oncomplete?.(); }); return request; },
      put: (row: LocalJob) => { records.set(row.id,{...row}); },
    })}; return tx;
  } };
  vi.stubGlobal("indexedDB", {open:()=>{const request: {result?:unknown;onsuccess?:()=>void}={}; queueMicrotask(()=>{request.result=db;request.onsuccess?.();});return request;}});
  const release = await acquireLocalJobLease(records.get("live")!);
  const recovered = await recoverLocalJobs(datasetId,"new-session");
  expect(recovered.find(x=>x.id==="abandoned")?.state).toBe("failed");
  expect(records.get("live")?.state).toBe("parsing");
  release(); await vi.waitFor(()=>expect(active.size).toBe(0));
  await recoverLocalJobs(datasetId,"another-session");
  expect(records.get("live")?.state).toBe("failed");
  records.set("finished",make("finished"));
  beforeAcquire = (name) => { if (name.endsWith(':finished')) records.delete('finished'); };
  await recoverLocalJobs(datasetId,"another-session");
  expect(records.has('finished')).toBe(false); // Completion during recovery is never resurrected.
  records.set("changed",make("changed"));
  beforeAcquire = (name) => { if (name.endsWith(':changed')) currentId='87654321-4321-4321-8321-cba987654321'; };
  await expect(recoverLocalJobs(datasetId,"another-session")).rejects.toThrow(/dataset changed/i);
  expect(records.get('changed')?.state).toBe('parsing');
  currentId=datasetId; beforeAcquire=undefined;
  const legacy = make('legacy'); delete legacy.leaseVersion; records.set('legacy',legacy);
  const result=await recoverLocalJobs(datasetId,'another-session');
  expect(result.find(row=>row.id==='legacy')?.message).toMatch(/cannot be confirmed/);
  expect(records.get('legacy')?.state).toBe('parsing');
});

