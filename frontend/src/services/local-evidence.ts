import { currentDataset, database } from "./local-documents";
import type { AssessmentMention } from "@/domain/assessment-mentions";
import type { SyllabusDateProposal } from "@/domain/syllabus-dates";
import type { DateValue, LocalEvidenceRef, LocalSyllabusProposal, LocalSyllabusRoute } from "@/domain/types";

export type LocalEvidenceRecord = LocalEvidenceRef & {
  fingerprint: string; format: "pdf" | "docx";
  original: { mention: AssessmentMention; dates: SyllabusDateProposal[]; week: DateValue };
  proposal: LocalSyllabusProposal;
  state: "pending" | "routed"; receipt?: LocalSyllabusRoute;
  audit: { kind: "retained" | "routed"; at: string }[];
};
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function localHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
const key = (ref: LocalEvidenceRef) => [ref.datasetId, ref.courseId, ref.digest, ref.mentionId, ref.pipelineVersion];
async function check(datasetId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (await currentDataset(signal) !== datasetId) throw new Error("The dataset changed. Reconnect before using local evidence.");
  signal?.throwIfAborted();
}
/** Atomic original+policy retention; never replace immutable originals after correction/replay. */
export async function retainLocalEvidence(records: LocalEvidenceRecord[], signal: AbortSignal): Promise<LocalEvidenceRecord[]> {
  if (!records.length) return [];
  const scope = records[0];
  if (records.length > 1000 || records.some(row => row.datasetId !== scope.datasetId || row.courseId !== scope.courseId || row.digest !== scope.digest)) throw new Error("Local evidence must use one bounded document/course/dataset scope.");
  await check(scope.datasetId, signal); const db = await database();
  let collision = false;
  try {
    const saved = await new Promise<LocalEvidenceRecord[]>((resolve, reject) => {
      const tx = db.transaction("evidence", "readwrite"), store = tx.objectStore("evidence"), result: LocalEvidenceRecord[] = [];
      const abort = () => { try { tx.abort(); } catch { /* complete */ } }; signal.addEventListener("abort", abort, { once: true });
      for (const [index, record] of records.entries()) {
        const request = store.get(key(record));
        request.onsuccess = () => {
          const previous = request.result as LocalEvidenceRecord | undefined;
          if (previous && previous.fingerprint !== record.fingerprint) { collision = true; tx.abort(); return; }
          result[index] = previous ?? record;
          if (!previous) store.add(record);
        };
      }
      tx.oncomplete = () => { signal.removeEventListener("abort", abort); resolve(result); };
      tx.onabort = () => { signal.removeEventListener("abort", abort); reject(signal.aborted ? new DOMException("Routing cancelled", "AbortError") : new Error(collision ? "Original local evidence changed under an immutable identity. Extract/review its revision explicitly." : "Original evidence could not be retained. Check browser storage/quota; nothing was submitted.")); };
      tx.onerror = () => {};
    });
    await check(scope.datasetId, signal); return saved;
  } finally { db.close(); }
}
export async function readLocalEvidence(ref: LocalEvidenceRef, signal?: AbortSignal): Promise<{ record?: LocalEvidenceRecord; sourceAvailable: boolean }> {
  await check(ref.datasetId, signal); const db = await database();
  try {
    const result = await new Promise<{ record?: LocalEvidenceRecord; sourceAvailable: boolean }>((resolve, reject) => {
      const tx = db.transaction(["evidence", "associations", "blobs"], "readonly");
      const evidence = tx.objectStore("evidence").get(key(ref));
      const association = tx.objectStore("associations").get([ref.datasetId, ref.courseId, ref.digest]);
      const blob = tx.objectStore("blobs").get([ref.datasetId, ref.digest]);
      tx.oncomplete = () => resolve({ record: evidence.result, sourceAvailable: !!association.result && blob.result?.file instanceof Blob });
      tx.onabort = () => reject(new Error("Could not read stored local evidence."));
    });
    await check(ref.datasetId, signal); return result;
  } finally { db.close(); }
}
/** Mutable receipt/audit only; original title/date/text/geometry is never overwritten. */
export async function markLocalRoutes(records: LocalEvidenceRecord[], routes: LocalSyllabusRoute[], signal: AbortSignal): Promise<void> {
  if (!records.length) return;
  await check(records[0].datasetId, signal); const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("evidence", "readwrite"), store = tx.objectStore("evidence");
      const abort = () => { try { tx.abort(); } catch {} }; signal.addEventListener("abort", abort, { once: true });
      for (const record of records) {
        const route = routes.find(route => route.mentionId === record.mentionId);
        if (!route) { tx.abort(); break; }
        const request = store.get(key(record));
        request.onsuccess = () => {
          const current = request.result as LocalEvidenceRecord | undefined;
          if (!current || current.fingerprint !== record.fingerprint) { tx.abort(); return; }
          if (current.receipt && (current.receipt.candidateId !== route.candidateId || current.receipt.documentId !== route.documentId)) { tx.abort(); return; }
          store.put({ ...current, state: "routed", receipt: current.receipt ?? route, audit: current.receipt ? current.audit : [...current.audit, { kind: "routed", at: new Date().toISOString() }] });
        };
      }
      tx.oncomplete = () => { signal.removeEventListener("abort", abort); resolve(); };
      tx.onabort = () => { signal.removeEventListener("abort", abort); reject(new Error("Routing outcome is not locally reconciled. Retry the same stored proposal; no new identity was assigned.")); };
    });
    await check(records[0].datasetId, signal);
  } finally { db.close(); }
}
