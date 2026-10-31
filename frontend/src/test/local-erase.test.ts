import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginErase, captureLocalFence, clearLocalDataset, finishDashboardCleanup, onLocalInvalidation, registerLocalWork, resumeEraseCleanup, StaleLocalWrite } from "@/services/local-erase";
import { saveLocalDocument } from "@/services/local-documents";
import type { MoodleHelperAdapter } from "@/services/adapter";

const A = "12345678-1234-4123-8123-123456789abc", B = "87654321-4321-4321-8321-cba987654321";
const keyPaths: Record<string, string[] | string> = { blobs: ["datasetId", "digest"], associations: ["datasetId", "courseId", "digest"], jobs: ["datasetId", "owner", "id"], evidence: ["datasetId", "courseId", "digest", "mentionId", "pipelineVersion"], lifecycle: "datasetId" };
type Row = Record<string, unknown>;
let stores: Record<string, Map<string, Row>>;
let failNextClear = false;

/** Minimal ordered IndexedDB fake: requests settle in issue order, tx completes after them. */
function fakeIndexedDb() {
  const keyOf = (name: string, row: Row) => { const path = keyPaths[name]!; return JSON.stringify(Array.isArray(path) ? path.map((p) => row[p]) : row[path]); };
  const inRange = (key: string, range: any) => typeof range === "object" && range?.lower ? JSON.parse(key)[0] === range.lower[0] : key === JSON.stringify(range);
  const db = {
    objectStoreNames: { contains: () => true }, close: () => {},
    transaction(names: string[] | string, mode: string) {
      const snapshot = Object.fromEntries(Object.entries(stores).map(([k, v]) => [k, new Map(v)]));
      const queue: (() => void)[] = []; let aborted = false;
      const tx: any = { oncomplete: null, onabort: null, onerror: null, abort() { aborted = true; } };
      const request = (fn: () => unknown) => { const r: any = {}; queue.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
      tx.objectStore = (name: string) => ({
        get: (key: unknown) => request(() => stores[name]!.get(JSON.stringify(key))),
        count: (range: unknown) => request(() => [...stores[name]!.keys()].filter((k) => inRange(k, range)).length),
        getAll: (range: unknown) => request(() => [...stores[name]!.entries()].filter(([k]) => inRange(k, range)).map(([, v]) => v)),
        put: (row: Row) => request(() => { stores[name]!.set(keyOf(name, row), row); }),
        add: (row: Row) => request(() => { stores[name]!.set(keyOf(name, row), row); }),
        delete: (range: unknown) => request(() => { if (failNextClear && name === "evidence") { failNextClear = false; tx.abort(); } for (const k of [...stores[name]!.keys()]) if (inRange(k, range)) stores[name]!.delete(k); }),
        openCursor: () => request(() => null),
      });
      void (mode && names);
      setTimeout(() => {
        while (queue.length && !aborted) queue.shift()!();
        if (aborted) { for (const k of Object.keys(stores)) stores[k] = snapshot[k]!; tx.onabort?.(); } else tx.oncomplete?.();
      });
      return tx;
    },
  };
  return { open: () => { const r: any = { result: db }; setTimeout(() => r.onsuccess()); return r; } };
}

beforeEach(() => {
  stores = Object.fromEntries(Object.keys(keyPaths).map((k) => [k, new Map()]));
  for (const id of [A, B]) {
    stores.blobs!.set(JSON.stringify([id, "d1"]), { datasetId: id, digest: "d1", file: new Blob(["x"]) });
    stores.associations!.set(JSON.stringify([id, "c", "d1"]), { datasetId: id, courseId: "c", digest: "d1" });
    stores.jobs!.set(JSON.stringify([id, "o", "j"]), { datasetId: id, owner: "o", id: "j" });
    stores.evidence!.set(JSON.stringify([id, "c", "d1", "m", 1]), { datasetId: id });
  }
  vi.stubGlobal("indexedDB", fakeIndexedDb());
  vi.stubGlobal("IDBKeyRange", { bound: (lower: unknown[], upper: unknown[]) => ({ lower, upper }) });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ datasetId: A }), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

const count = (id: string) => ["blobs", "associations", "jobs", "evidence"].reduce((n, s) => n + [...stores[s]!.values()].filter((r) => r.datasetId === id).length, 0);

describe("#56 browser-local erase", () => {
  it("clears only this dataset's key ranges and keeps a minimal tombstone", async () => {
    await clearLocalDataset({ datasetId: A, epoch: 2, eraseId: "e".repeat(32) });
    expect(count(A)).toBe(0);
    expect(count(B)).toBe(4);
    expect([...stores.lifecycle!.values()]).toEqual([{ datasetId: A, epoch: 2, eraseId: "e".repeat(32) }]);
  });

  it("never lowers a newer tombstone and rolls back on a failed transaction", async () => {
    await clearLocalDataset({ datasetId: A, epoch: 5, eraseId: "a".repeat(32) });
    await clearLocalDataset({ datasetId: A, epoch: 3, eraseId: "b".repeat(32) });
    expect(stores.lifecycle!.get(JSON.stringify(A))).toMatchObject({ epoch: 5 });
    failNextClear = true;
    await expect(clearLocalDataset({ datasetId: B, epoch: 1, eraseId: "c".repeat(32) })).rejects.toThrow(/Retry cleanup/);
    expect(count(B)).toBe(4);
  });

  it("rejects a document commit whose fence was captured before the erase (no resurrection)", async () => {
    const fence = await captureLocalFence(A);
    await clearLocalDataset({ datasetId: A, epoch: 1, eraseId: "e".repeat(32) });
    const association = { datasetId: A, courseId: "c2", digest: "d2", name: "n.pdf", size: 1, source: "s", createdAt: "now" };
    await expect(saveLocalDocument(association, new Blob(["y"]), [], new AbortController().signal, undefined, fence)).rejects.toBeInstanceOf(StaleLocalWrite);
    expect(count(A)).toBe(0);
    // Fresh work after reload is new data, not resurrection.
    expect(await saveLocalDocument(association, new Blob(["y"]), [], new AbortController().signal)).toBe("stored");
  });

  it("aborts registered local work and notifies listeners when erase begins", () => {
    const controller = new AbortController(); registerLocalWork(controller);
    const listener = vi.fn(); const off = onLocalInvalidation(listener);
    beginErase();
    expect(controller.signal.aborted).toBe(true); expect(listener).toHaveBeenCalled(); off();
  });

  it("acknowledges complete or failed truthfully and resumes an interrupted cleanup", async () => {
    const cleanup = (dashboard: string) => ({ backend: "complete" as const, dashboard: dashboard as "complete", extension: "pending" as const });
    const acknowledgeErase = vi.fn(async (_id: string, _c: string, state: string) => ({ eraseId: "e".repeat(32), datasetId: A, epoch: 1, current: true, cleanup: cleanup(state) }));
    const adapter = { acknowledgeErase, dataContext: vi.fn(async () => ({ datasetId: A, epoch: 1, revision: 2, lifecycle: "cleanup_pending" as const, erasure: { eraseId: "e".repeat(32), cleanup: cleanup("pending") } })) } as unknown as MoodleHelperAdapter;
    const resumed = await resumeEraseCleanup(adapter);
    expect(acknowledgeErase).toHaveBeenCalledWith("e".repeat(32), "dashboard", "complete");
    expect(resumed?.cleanup.dashboard).toBe("complete"); expect(count(A)).toBe(0); expect(count(B)).toBe(4);
    failNextClear = true;
    const failed = await finishDashboardCleanup(adapter, { eraseId: "e".repeat(32), datasetId: B, epoch: 1 });
    expect(acknowledgeErase).toHaveBeenLastCalledWith("e".repeat(32), "dashboard", "failed");
    expect(failed.error).toMatch(/Retry cleanup/); expect(count(B)).toBe(4);
  });
});
