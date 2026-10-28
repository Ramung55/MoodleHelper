/** Browser-origin storage for locally validated documents. No file enters an adapter. */
export type LocalAssociation = {
  datasetId: string; courseId: string; digest: string; name: string; size: number;
  source: string; createdAt: string;
};

const DB_NAME = "moodle-helper-local-documents";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("Browser storage is unavailable.")); return; }
    const open = indexedDB.open(DB_NAME, 2);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains("blobs")) open.result.createObjectStore("blobs", { keyPath: ["datasetId", "digest"] });
      if (!open.result.objectStoreNames.contains("associations")) open.result.createObjectStore("associations", { keyPath: ["datasetId", "courseId", "digest"] });
      if (!open.result.objectStoreNames.contains("jobs")) open.result.createObjectStore("jobs", { keyPath: ["datasetId", "owner", "id"] });
    };
    open.onerror = () => reject(new Error("Could not open browser storage."));
    open.onblocked = () => reject(new Error("Browser storage is blocked by another tab."));
    open.onsuccess = () => resolve(open.result);
  });
}

export type LocalJob = { datasetId: string; owner: string; id: string; name: string; courseId: string; state: "queued" | "parsing" | "failed" | "cancelled"; message: string };

/** Tab-owned job markers contain metadata only, so a reload can request reselection. */
export async function updateLocalJob(job: LocalJob): Promise<void> {
  if (await currentDataset() !== job.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("jobs", "readwrite");
      tx.objectStore("jobs").put(job);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("Could not save local import status. Check browser storage."));
    });
  } finally { db.close(); }
}

export async function recoverLocalJobs(datasetId: string, owner: string): Promise<LocalJob[]> {
  if (await currentDataset() !== datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  const db = await database();
  try {
    const jobs = await new Promise<LocalJob[]>((resolve, reject) => {
      const tx = db.transaction("jobs", "readwrite"), store = tx.objectStore("jobs");
      const request = store.getAll(IDBKeyRange.bound([datasetId, owner], [datasetId, owner, []]));
      let rows: LocalJob[] = [];
      request.onsuccess = () => {
        rows = request.result.map((job: LocalJob) => job.state === "queued" || job.state === "parsing" ? { ...job, state: "failed", message: "Interrupted. Reselect the file to retry." } : job);
        rows.forEach((job) => store.put(job));
      };
      tx.oncomplete = () => resolve(rows);
      tx.onabort = () => reject(new Error("Could not recover local import status."));
    });
    if (await currentDataset() !== datasetId) throw new Error("The dataset changed. Reconnect and retry.");
    return jobs;
  } finally { db.close(); }
}

export async function currentDataset(): Promise<string> {
  const response = await fetch("/api/local-context", { method: "GET", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" } });
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

/** Atomic blob and association insertion. Caller must perform validation first. */
export async function saveLocalDocument(association: LocalAssociation, file: Blob, confirmedCourses: string[], signal: AbortSignal, job?: LocalJob): Promise<"stored" | "duplicate" | "confirmation-required"> {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const db = await database();
  try {
    if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reconnect and retry.");
    return await new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
      const tx = db.transaction(["blobs", "associations", "jobs"], "readwrite");
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
        const existing = (lookup.result as LocalAssociation[]).filter((row) => row.digest === association.digest);
        if (existing.some((row) => row.courseId === association.courseId)) { result = "duplicate"; clearCompletedJob(); return; }
        if (existing.some((row) => !confirmedCourses.includes(row.courseId))) { result = "confirmation-required"; return; }
        const blobs = tx.objectStore("blobs");
        const blobLookup = blobs.get([association.datasetId, association.digest]);
        blobLookup.onsuccess = () => {
          if (!blobLookup.result) blobs.add({ datasetId: association.datasetId, digest: association.digest, file });
          rows.add(association);
          clearCompletedJob();
        };
      };
      tx.oncomplete = () => { signal.removeEventListener("abort", abort); resolve(result); };
      tx.onabort = () => { signal.removeEventListener("abort", abort); reject(signal.aborted ? new DOMException("Cancelled", "AbortError") : new Error("Could not save locally. Check browser storage and retry.")); };
      tx.onerror = () => { /* onabort reports the failure */ };
    });
  } finally { db.close(); }
}
