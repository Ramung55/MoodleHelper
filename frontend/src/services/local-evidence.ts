import { currentDataset, database } from "./local-documents";
import { captureLocalFence, guardTransaction, StaleLocalWrite } from "./local-erase";
import type { AssessmentMention } from "@/domain/assessment-mentions";
import type { SyllabusDateProposal } from "@/domain/syllabus-dates";
import type { AssessmentType, DateValue, LocalEvidenceMode, LocalEvidenceRef, LocalReviewReceipt, LocalSyllabusProposal, LocalSyllabusRoute } from "@/domain/types";

/** #32 append-only review audit. Original proposal/source text is never rewritten by these entries. */
export type LocalReviewAuditEntry = {
  kind: "review-requested" | "review-committed" | "review-unknown" | "review-failed"; at: string;
  decisionId: string; decision: "confirm" | "correct" | "reject";
  candidateId: string; documentId: string;
  /** Browser original-evidence hash; absent for an audit-only (unavailable original) entry. */
  originalFingerprint?: string;
  /** Server metadata routing fingerprint; deliberately different from originalFingerprint. */
  routingFingerprint: string;
  evidenceMode: LocalEvidenceMode; acknowledgedStoredOnly: boolean;
  proposedValues: { title: string; type: AssessmentType; date: DateValue };
  correctedValues?: { title: string; type: AssessmentType; date: DateValue };
  backendReceipt?: LocalReviewReceipt; message?: string;
};
export type LocalEvidenceRecord = LocalEvidenceRef & {
  fingerprint: string; format: "pdf" | "docx";
  original: { mention: AssessmentMention; dates: SyllabusDateProposal[]; week: DateValue };
  proposal: LocalSyllabusProposal;
  state: "pending" | "routed"; receipt?: LocalSyllabusRoute;
  audit: ({ kind: "retained" | "routed"; at: string } | LocalReviewAuditEntry)[];
};
/** PM-approved audit-only shape at the registered key: never an original, never routable or confirmable. */
export type LocalAuditOnlyRecord = LocalEvidenceRef & {
  originalState: "unavailable"; candidateId: string; documentId: string; routingFingerprint: string;
  audit: LocalReviewAuditEntry[];
  /** Preserved, uninterpreted prior corrupt/mismatched row (never shown or logged). */
  quarantined?: unknown;
};
export const MAX_REVIEW_AUDIT = 64;
const isAuditOnly = (value: unknown): value is LocalAuditOnlyRecord => !!value && typeof value === "object" && (value as LocalAuditOnlyRecord).originalState === "unavailable" && Array.isArray((value as LocalAuditOnlyRecord).audit);
const isOriginal = (value: unknown): value is LocalEvidenceRecord => {
  const row = value as LocalEvidenceRecord | undefined;
  return !!row && typeof row === "object" && !isAuditOnly(row) && typeof row.fingerprint === "string" && !!row.original && typeof row.original.mention?.excerpt === "string" && Array.isArray(row.original.dates) && !!row.proposal && Array.isArray(row.audit);
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
  const fence = await captureLocalFence(scope.datasetId);
  await check(scope.datasetId, signal); const db = await database();
  let collision = false;
  try {
    const saved = await new Promise<LocalEvidenceRecord[]>((resolve, reject) => {
      const tx = db.transaction(["evidence", "lifecycle"], "readwrite"), store = tx.objectStore("evidence"), result: LocalEvidenceRecord[] = [];
      const stale = guardTransaction(tx, fence);
      const abort = () => { try { tx.abort(); } catch { /* complete */ } }; signal.addEventListener("abort", abort, { once: true });
      for (const [index, record] of records.entries()) {
        const request = store.get(key(record));
        request.onsuccess = () => {
          if (stale()) return;
          const previous = request.result as LocalEvidenceRecord | undefined;
          // An audit-only/corrupt row needs explicit recovery; never overwrite it silently.
          if (previous && (!isOriginal(previous) || previous.fingerprint !== record.fingerprint)) { collision = true; tx.abort(); return; }
          result[index] = previous ?? record;
          if (!previous) store.add(record);
        };
      }
      tx.oncomplete = () => { signal.removeEventListener("abort", abort); resolve(result); };
      tx.onabort = () => { signal.removeEventListener("abort", abort); reject(signal.aborted ? new DOMException("Routing cancelled", "AbortError") : stale() ? new StaleLocalWrite() : new Error(collision ? "Original local evidence changed under an immutable identity. Extract/review its revision explicitly." : "Original evidence could not be retained. Check browser storage/quota; nothing was submitted.")); };
      tx.onerror = () => {};
    });
    await check(scope.datasetId, signal); return saved;
  } finally { db.close(); }
}
export type LocalEvidenceRead = { record?: LocalEvidenceRecord; sourceAvailable: boolean; auditOnly?: LocalAuditOnlyRecord; corrupt?: boolean };
export async function readLocalEvidence(ref: LocalEvidenceRef, signal?: AbortSignal): Promise<LocalEvidenceRead> {
  await check(ref.datasetId, signal); const db = await database();
  try {
    const result = await new Promise<LocalEvidenceRead>((resolve, reject) => {
      const tx = db.transaction(["evidence", "associations", "blobs"], "readonly");
      const evidence = tx.objectStore("evidence").get(key(ref));
      const association = tx.objectStore("associations").get([ref.datasetId, ref.courseId, ref.digest]);
      const blob = tx.objectStore("blobs").get([ref.datasetId, ref.digest]);
      tx.oncomplete = () => {
        const row: unknown = evidence.result, sourceAvailable = !!association.result && blob.result?.file instanceof Blob;
        if (isAuditOnly(row)) resolve({ sourceAvailable, auditOnly: row });
        else if (row === undefined) resolve({ sourceAvailable });
        else if (isOriginal(row)) resolve({ record: row, sourceAvailable });
        else resolve({ sourceAvailable, corrupt: true });
      };
      tx.onabort = () => reject(new Error("Could not read stored local evidence."));
    });
    await check(ref.datasetId, signal); return result;
  } finally { db.close(); }
}
/** Mutable receipt/audit only; original title/date/text/geometry is never overwritten. */
export async function markLocalRoutes(records: LocalEvidenceRecord[], routes: LocalSyllabusRoute[], signal: AbortSignal): Promise<void> {
  if (!records.length) return;
  const fence = await captureLocalFence(records[0].datasetId);
  await check(records[0].datasetId, signal); const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["evidence", "lifecycle"], "readwrite"), store = tx.objectStore("evidence");
      guardTransaction(tx, fence);
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

/**
 * Durable pending/outcome review audit. An original record gets the entry appended (originals untouched);
 * a missing/corrupt/mismatched original gets the explicit audit-only wrapper, preserving any raw row.
 * Throws (and the caller sends nothing) on quota/storage/context failure or a changed original fingerprint.
 */
export async function appendLocalReviewAudit(ref: LocalEvidenceRef, entry: LocalReviewAuditEntry, signal?: AbortSignal): Promise<void> {
  const fence = await captureLocalFence(ref.datasetId);
  await check(ref.datasetId, signal); const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["evidence", "lifecycle"], "readwrite"), store = tx.objectStore("evidence");
      const stale = guardTransaction(tx, fence);
      let problem = "Review audit could not be stored locally (storage or quota). Nothing was sent.";
      const request = store.get(key(ref));
      request.onsuccess = () => {
        if (stale()) { problem = new StaleLocalWrite().message; return; }
        const current: unknown = request.result;
        const fail = (message: string) => { problem = message; tx.abort(); };
        const reviews = (rows: unknown[]) => rows.filter(row => String((row as { kind?: string }).kind).startsWith("review-")).length;
        if (isOriginal(current) && entry.evidenceMode !== "unavailable") {
          if (current.fingerprint !== entry.originalFingerprint || current.locationId !== ref.locationId) return fail("Stored original evidence changed. Reload before reviewing; nothing was sent.");
          if (reviews(current.audit) >= MAX_REVIEW_AUDIT) return fail("The local review audit limit was reached. Nothing was sent.");
          store.put({ ...current, audit: [...current.audit, entry] });
        } else if (isAuditOnly(current)) {
          if (current.candidateId !== entry.candidateId || current.documentId !== entry.documentId) return fail("Audit-only evidence belongs to another candidate. Nothing was sent.");
          if (current.audit.length >= MAX_REVIEW_AUDIT) return fail("The local review audit limit was reached. Nothing was sent.");
          store.put({ ...current, audit: [...current.audit, entry] });
        } else {
          if (entry.evidenceMode !== "unavailable") return fail("Original local evidence is unavailable. Only Reject can be recorded.");
          const wrapper: LocalAuditOnlyRecord = { datasetId: ref.datasetId, courseId: ref.courseId, digest: ref.digest, mentionId: ref.mentionId, locationId: ref.locationId, pipelineVersion: ref.pipelineVersion, originalState: "unavailable", candidateId: entry.candidateId, documentId: entry.documentId, routingFingerprint: entry.routingFingerprint, audit: [entry], ...(current === undefined ? {} : { quarantined: current }) };
          store.put(wrapper);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error(problem));
      tx.onerror = () => {};
    });
    await check(ref.datasetId, signal);
  } finally { db.close(); }
}
