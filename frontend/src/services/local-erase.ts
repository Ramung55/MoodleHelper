/**
 * #56 browser-side erase coordinator: stop local work, then (only after the backend
 * committed its tombstone) clear THIS dataset's key ranges in the same-origin
 * IndexedDB stores, keep a minimal epoch tombstone that rejects stale commits,
 * notify cooperative tabs and acknowledge the dashboard component.
 * Never deletes the database, other datasets, other origins/profiles or disk files.
 */
import { database } from "./local-documents";
import type { DataContext, EraseCleanup, MoodleHelperAdapter } from "./adapter";

export const CONTENT_STORES = ["blobs", "associations", "jobs", "evidence"] as const;
export const LIFECYCLE_STORE = "lifecycle";
export type LocalTombstone = { datasetId: string; epoch: number; eraseId: string };
export type LocalFence = { datasetId: string; epoch: number; generation: number };

const CHANNEL = "moodle-helper-lifecycle";
let generation = 0;
const work = new Set<AbortController>();
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

function invalidateLocal() {
  generation++;
  for (const controller of work) controller.abort();
  work.clear();
  for (const listener of listeners) listener();
}

function bus(): BroadcastChannel | undefined {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | null;
    if (data && (data.type === "erasing" || data.type === "erased")) invalidateLocal();
  };
  return channel;
}

/** Abortable local render/OCR/import work registers here so erase can stop it. */
export function registerLocalWork(controller: AbortController): () => void {
  bus(); work.add(controller);
  return () => { work.delete(controller); };
}

/** Called when this or another tab erases; stale callbacks must re-load before showing data. */
export function onLocalInvalidation(listener: () => void): () => void {
  bus(); listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function localGeneration() { return generation; }

/** Stop accepting new local actions in this and cooperative tabs. Does not clear anything. */
export function beginErase() {
  invalidateLocal();
  bus()?.postMessage({ type: "erasing" });
}

function readTombstone(db: IDBDatabase, datasetId: string): Promise<LocalTombstone | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LIFECYCLE_STORE, "readonly");
    const request = tx.objectStore(LIFECYCLE_STORE).get(datasetId);
    tx.oncomplete = () => resolve(request.result as LocalTombstone | undefined);
    tx.onabort = () => reject(new Error("Could not read browser storage."));
  });
}

/** Capture at the START of a local operation; its final commit re-checks it in-transaction. */
export async function captureLocalFence(datasetId: string): Promise<LocalFence> {
  const captured = generation;
  const db = await database();
  try { return { datasetId, epoch: (await readTombstone(db, datasetId))?.epoch ?? 0, generation: captured }; }
  finally { db.close(); }
}

/**
 * Queue the tombstone check FIRST inside a content write transaction. Requests run in
 * order, so later handlers see `stale()` before inserting; a stale fence aborts the tx.
 */
export function guardTransaction(tx: IDBTransaction, fence: LocalFence): () => boolean {
  let stale = generation !== fence.generation;
  const request = tx.objectStore(LIFECYCLE_STORE).get(fence.datasetId);
  request.onsuccess = () => {
    if (((request.result as LocalTombstone | undefined)?.epoch ?? 0) !== fence.epoch || generation !== fence.generation) stale = true;
    if (stale) { try { tx.abort(); } catch { /* finished */ } }
  };
  return () => stale || generation !== fence.generation;
}

export class StaleLocalWrite extends Error {
  constructor() { super("Local data was deleted while this action was running. Nothing was saved."); this.name = "StaleLocalWrite"; }
}

/** One readwrite transaction: delete only this dataset's key ranges and write the tombstone. */
export async function clearLocalDataset(tombstone: LocalTombstone): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([...CONTENT_STORES, LIFECYCLE_STORE], "readwrite");
      const range = IDBKeyRange.bound([tombstone.datasetId], [tombstone.datasetId, []]);
      let remaining = 0;
      for (const name of CONTENT_STORES) tx.objectStore(name).delete(range);
      for (const name of CONTENT_STORES) {
        const count = tx.objectStore(name).count(range);
        count.onsuccess = () => { remaining += count.result; };
      }
      const lifecycle = tx.objectStore(LIFECYCLE_STORE), previous = lifecycle.get(tombstone.datasetId);
      previous.onsuccess = () => {
        // Monotonic: never lower an epoch written by a later erase in another tab.
        const old = previous.result as LocalTombstone | undefined;
        if (!old || old.epoch <= tombstone.epoch) lifecycle.put(tombstone);
      };
      tx.oncomplete = () => remaining === 0 ? resolve() : reject(new Error("Browser storage still holds data for this dataset."));
      tx.onabort = () => reject(new Error("Could not clear browser storage for this dataset. Retry cleanup."));
    });
  } finally { db.close(); }
}

export type EraseOutcome = { cleanup: EraseCleanup; error?: string };

/** After the backend tombstone: clear browser stores, broadcast and acknowledge. Retry-safe. */
export async function finishDashboardCleanup(adapter: MoodleHelperAdapter, erasure: { eraseId: string; datasetId: string; epoch: number }): Promise<EraseOutcome> {
  let state: "complete" | "failed" = "complete", error: string | undefined;
  try { await clearLocalDataset({ datasetId: erasure.datasetId, epoch: erasure.epoch, eraseId: erasure.eraseId }); }
  catch (e) { state = "failed"; error = e instanceof Error ? e.message : "Browser cleanup failed."; }
  invalidateLocal();
  bus()?.postMessage({ type: "erased" });
  try {
    const status = await adapter.acknowledgeErase!(erasure.eraseId, "dashboard", state);
    return { cleanup: status.cleanup, ...(error ? { error } : {}) };
  } catch (e) {
    return { cleanup: { backend: "complete", dashboard: state === "complete" ? "pending" : "failed", extension: "pending" }, error: error ?? (e instanceof Error ? e.message : "Could not record browser cleanup. Retry.") };
  }
}

/** On reopen: an interrupted cleanup for the current epoch resumes; never seeds or syncs. */
export async function resumeEraseCleanup(adapter: MoodleHelperAdapter, context?: DataContext): Promise<EraseOutcome | undefined> {
  if (!adapter.dataContext || !adapter.acknowledgeErase) return undefined;
  const current = context ?? await adapter.dataContext();
  if (!current.erasure || current.erasure.cleanup.dashboard === "complete") return current.erasure ? { cleanup: current.erasure.cleanup } : undefined;
  return finishDashboardCleanup(adapter, { eraseId: current.erasure.eraseId, datasetId: current.datasetId, epoch: current.epoch });
}
