/** Browser-origin storage for locally validated documents. No file enters an adapter. */
export type LocalAssociation = {
  datasetId: string; courseId: string; digest: string; name: string; size: number;
  source: string; createdAt: string;
};

const DB_NAME = "moodle-helper-local-documents";
import { captureLocalFence, guardTransaction, StaleLocalWrite, type LocalFence } from "./local-erase";

export function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("Browser storage is unavailable.")); return; }
    const open = indexedDB.open(DB_NAME, 4);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains("blobs")) open.result.createObjectStore("blobs", { keyPath: ["datasetId", "digest"] });
      if (!open.result.objectStoreNames.contains("associations")) open.result.createObjectStore("associations", { keyPath: ["datasetId", "courseId", "digest"] });
      if (!open.result.objectStoreNames.contains("jobs")) open.result.createObjectStore("jobs", { keyPath: ["datasetId", "owner", "id"] });
      // #56 minimal per-dataset erase tombstone {datasetId, epoch, eraseId}; no student content.
      if (!open.result.objectStoreNames.contains("lifecycle")) open.result.createObjectStore("lifecycle", { keyPath: "datasetId" });
      if (!open.result.objectStoreNames.contains("evidence")) open.result.createObjectStore("evidence", { keyPath: ["datasetId", "courseId", "digest", "mentionId", "pipelineVersion"] });
    };
    open.onerror = () => reject(new Error("Could not open browser storage."));
    open.onblocked = () => reject(new Error("Browser storage is blocked by another tab."));
    open.onsuccess = () => resolve(open.result);
  });
}

export type LocalJob = { datasetId: string; owner: string; id: string; name: string; courseId: string; state: "queued" | "parsing" | "failed" | "cancelled"; message: string; leaseVersion?: 1 };

const lockName = (job: LocalJob) => `moodle-helper-import:${job.datasetId}:${job.id}`;

/** The lock is released automatically if the tab or browser process dies. */
export async function acquireLocalJobLease(job: LocalJob): Promise<() => void> {
  if (!navigator.locks) throw new Error("This browser cannot safely recover interrupted imports. Use a browser with Web Locks support.");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let ready!: (release: () => void) => void, reject!: (error: Error) => void;
  const acquired = new Promise<() => void>((resolve, rejectPromise) => { ready = resolve; reject = rejectPromise; });
  void navigator.locks.request(lockName(job), { ifAvailable: true }, async (lock) => {
    if (!lock) { reject(new Error("This local import is already active.")); return; }
    ready(release); await held;
  }).catch(() => reject(new Error("Could not secure the local import. Retry.")));
  return acquired;
}

/** Tab-owned job markers contain metadata only, so a reload can request reselection. */
export async function updateLocalJob(job: LocalJob, fence?: LocalFence): Promise<void> {
  const guard = fence ?? await captureLocalFence(job.datasetId);
  if (await currentDataset() !== job.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["jobs", "lifecycle"], "readwrite");
      const stale = guardTransaction(tx, guard);
      const lookup = tx.objectStore("jobs").count([job.datasetId, job.owner, job.id]);
      lookup.onsuccess = () => { if (!stale()) tx.objectStore("jobs").put(job); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale() ? new StaleLocalWrite() : new Error("Could not save local import status. Check browser storage."));
    });
  } finally { db.close(); }
}

export async function recoverLocalJobs(datasetId: string, _owner: string): Promise<LocalJob[]> {
  if (await currentDataset() !== datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  if (!navigator.locks) throw new Error("This browser cannot safely recover interrupted imports. Use a browser with Web Locks support.");
  const db = await database();
  try {
    const jobs = await new Promise<LocalJob[]>((resolve, reject) => {
      const tx = db.transaction("jobs", "readonly"), store = tx.objectStore("jobs");
      const request = store.getAll(IDBKeyRange.bound([datasetId], [datasetId, []]));
      tx.oncomplete = () => resolve(request.result as LocalJob[]);
      tx.onabort = () => reject(new Error("Could not recover local import status."));
    });
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      if (job.state !== "queued" && job.state !== "parsing") continue;
      if (job.leaseVersion !== 1) {
        jobs[i] = { ...job, message: "Older import status cannot be confirmed. If no other tab is working on it, reselect the file." };
        continue;
      }
      await navigator.locks.request(lockName(job), { ifAvailable: true }, async (lock) => {
        if (!lock) return; // Another live tab owns this attempt.
        if (await currentDataset() !== datasetId) throw new Error("The dataset changed. Reconnect and retry.");
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("jobs", "readwrite"), store = tx.objectStore("jobs");
          const request = store.get([job.datasetId, job.owner, job.id]);
          request.onsuccess = () => {
            const current = request.result as LocalJob | undefined;
            if (current?.leaseVersion === 1 && (current.state === "queued" || current.state === "parsing")) {
              jobs[i] = { ...current, state: "failed", message: "Interrupted. Reselect the file to retry." };
              store.put(jobs[i]);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(new Error("Could not recover local import status."));
        });
      });
    }
    if (await currentDataset() !== datasetId) throw new Error("The dataset changed. Reconnect and retry.");
    return jobs;
  } finally { db.close(); }
}

export async function currentDataset(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/local-context", { method: "GET", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error("Could not identify the current dataset. Reconnect and retry.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 ||
      !("datasetId" in value) || typeof value.datasetId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.datasetId)) {
    throw new Error("The current dataset identity is invalid. Reconnect and retry.");
  }
  return value.datasetId;
}

export async function listLocalDocuments(datasetId: string): Promise<LocalAssociation[]> {
  if (await currentDataset() !== datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  const db = await database();
  try {
    const result = await new Promise<LocalAssociation[]>((resolve, reject) => {
      const tx = db.transaction("associations", "readonly");
      const request = tx.objectStore("associations").getAll(IDBKeyRange.bound([datasetId], [datasetId, []]));
      request.onsuccess = () => resolve(request.result as LocalAssociation[]);
      request.onerror = () => reject(new Error("Could not read browser storage."));
    });
    if (await currentDataset() !== datasetId) throw new Error("The dataset changed. Reconnect and retry.");
    return result;
  } finally { db.close(); }
}

/** Read bytes only through an existing dataset/course/digest association. */
export async function readLocalDocument(association: LocalAssociation, signal: AbortSignal): Promise<Blob> {
  const check = () => { if (signal.aborted) throw new DOMException("Cancelled", "AbortError"); };
  check();
  if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  check(); const db = await database();
  try {
    const file = await new Promise<Blob>((resolve, reject) => {
      const tx = db.transaction(["associations", "blobs"], "readonly");
      const row = tx.objectStore("associations").get([association.datasetId, association.courseId, association.digest]);
      const blob = tx.objectStore("blobs").get([association.datasetId, association.digest]);
      tx.oncomplete = () => {
        if (!row.result || !(blob.result?.file instanceof Blob)) reject(new Error("The original local document is unavailable. Reselect and import it for this course."));
        else resolve(blob.result.file);
      };
      tx.onabort = () => reject(new Error("Could not read the local document. Check browser storage and retry."));
    });
    check();
    if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
    check(); return file;
  } finally { db.close(); }
}

/** Atomic blob and association insertion. Caller must perform validation first. */
export async function saveLocalDocument(association: LocalAssociation, file: Blob, confirmedCourses: string[], signal: AbortSignal, job?: LocalJob, fence?: LocalFence): Promise<"stored" | "duplicate" | "confirmation-required"> {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const guard = fence ?? await captureLocalFence(association.datasetId);
  if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const db = await database();
  try {
    if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
    return await new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
      const tx = db.transaction(["blobs", "associations", "jobs", "lifecycle"], "readwrite");
      const stale = guardTransaction(tx, guard);
      const abort = () => { try { tx.abort(); } catch { /* already finished */ } };
      signal.addEventListener("abort", abort, { once: true });
      let result: "stored" | "duplicate" | "confirmation-required" = "stored";
      const rows = tx.objectStore("associations");
      const clearCompletedJob = () => {
        if (!job) return;
        const jobs = tx.objectStore("jobs");
        const cursor = jobs.openCursor(IDBKeyRange.bound([job.datasetId, job.owner], [job.datasetId, job.owner, []]));
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const value = entry.value as LocalJob;
          if (value.id === job.id || (value.name === job.name && value.courseId === job.courseId && value.state === "failed")) entry.delete();
          entry.continue();
        };
      };
      const lookup = rows.getAll(IDBKeyRange.bound([association.datasetId], [association.datasetId, []]));
      lookup.onsuccess = () => {
        if (stale()) return;
        const existing = (lookup.result as LocalAssociation[]).filter((row) => row.digest === association.digest);
        if (existing.some((row) => row.courseId === association.courseId)) { result = "duplicate"; clearCompletedJob(); return; }
        if (existing.some((row) => !confirmedCourses.includes(row.courseId))) { result = "confirmation-required"; return; }
        const blobs = tx.objectStore("blobs");
        const blobLookup = blobs.get([association.datasetId, association.digest]);
        blobLookup.onsuccess = () => {
          if (stale()) return;
          if (!blobLookup.result) blobs.add({ datasetId: association.datasetId, digest: association.digest, file });
          rows.add(association);
          clearCompletedJob();
        };
      };
      tx.oncomplete = () => { signal.removeEventListener("abort", abort); resolve(result); };
      tx.onabort = () => { signal.removeEventListener("abort", abort); reject(signal.aborted ? new DOMException("Cancelled", "AbortError") : stale() ? new StaleLocalWrite() : new Error("Could not save locally. Check browser storage and retry.")); };
      tx.onerror = () => { /* onabort reports the failure */ };
    });
  } finally { db.close(); }
}
