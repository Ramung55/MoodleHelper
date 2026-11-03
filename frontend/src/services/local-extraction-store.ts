/**
 * #44 row 10: an imported document's local extraction results survive a reload.
 * Stored in the same browser IndexedDB as the document itself (store "extractions"),
 * keyed by dataset, course, the document's SHA-256 and the extraction settings.
 * Nothing here is sent anywhere; erase clears it with the document (CONTENT_STORES),
 * and backups exclude it like the document bytes.
 */
import type { LocalExtraction as Extraction } from "@/domain/local-extraction";
import { MENTION_DETECTOR_VERSION, type AssessmentMention } from "@/domain/assessment-mentions";
import type { ParsedAssessmentMention } from "@/domain/syllabus-dates";
import { LOCAL_PIPELINE_VERSION } from "@/domain/local-routing";
import type { FrozenPreview, ValidatedAi } from "./ai-fallback";
import type { LocalEvidenceRecord } from "./local-evidence";
import { currentDataset, database, type LocalAssociation } from "./local-documents";
import { captureLocalFence, guardTransaction, StaleLocalWrite, type LocalFence } from "./local-erase";

export const EXTRACTION_STORE = "extractions";
/** The extraction settings part of the key: a new detector or pipeline never restores an older record. */
export const EXTRACTION_SETTINGS = `extraction-store-1|${MENTION_DETECTOR_VERSION}|${LOCAL_PIPELINE_VERSION}`;

export type StoredDateContext = { dateOrder: string; sourceTimezone: string; semesterStart: string; semesterEnd: string };
/** Validated AI proposals only: never a preview to resend, never a pending request, always unconfirmed. */
export type StoredAiProposals = {
  requestId: string; payloadDigest: string; provider: string; datasetId: string;
  association: FrozenPreview["association"];
  records: LocalEvidenceRecord[]; rejected: ValidatedAi["rejected"];
};
export type StoredExtraction = {
  datasetId: string; courseId: string; digest: string; settings: string; savedAt: string;
  result: Exclude<Extraction, { format: "ocr" }>;
  mentions?: AssessmentMention[] | undefined;
  parsedDates?: ParsedAssessmentMention[] | undefined;
  context?: StoredDateContext | undefined;
  ai?: StoredAiProposals | undefined;
};
export type ExtractionLoad =
  | { kind: "restored"; record: StoredExtraction; fence: LocalFence }
  | { kind: "none"; fence: LocalFence }
  | { kind: "unavailable" };

const key = (a: Pick<LocalAssociation, "datasetId" | "courseId" | "digest">) => [a.datasetId, a.courseId, a.digest, EXTRACTION_SETTINGS];

export function storedAiFrom(preview: FrozenPreview, result: ValidatedAi): StoredAiProposals {
  return { requestId: preview.requestId, payloadDigest: preview.payloadDigest, provider: preview.policy.provider, datasetId: preview.datasetId,
    association: { ...preview.association }, records: structuredClone(result.records), rejected: structuredClone(result.rejected) };
}

const same = (value: { datasetId?: unknown; courseId?: unknown; digest?: unknown } | undefined, a: LocalAssociation) =>
  !!value && value.datasetId === a.datasetId && value.courseId === a.courseId && value.digest === a.digest;

/** A record is restored only if every part belongs to this exact document (SHA-256), course, dataset and settings. */
export function validStoredExtraction(row: unknown, a: LocalAssociation): row is StoredExtraction {
  const r = row as StoredExtraction | undefined;
  if (!r || typeof r !== "object" || !same(r, a) || r.settings !== EXTRACTION_SETTINGS || !r.result || !same(r.result, a) || r.result.complete !== true) return false;
  const format = /\.docx$/i.test(a.name) ? "docx" : "pdf";
  if (r.result.format !== format || (format === "pdf" ? !Array.isArray((r.result as { pages?: unknown }).pages) : !Array.isArray((r.result as { blocks?: unknown }).blocks))) return false;
  if (r.mentions !== undefined && (!Array.isArray(r.mentions) || !r.mentions.every(m => same(m, a) && m.detectorVersion === MENTION_DETECTOR_VERSION && m.status === "unconfirmed" && typeof m.excerpt === "string"))) return false;
  if (r.parsedDates !== undefined && (!r.mentions || !Array.isArray(r.parsedDates) || !r.parsedDates.every(p => Array.isArray(p.dates) && r.mentions!.some(m => m.id === p.mention?.id)))) return false;
  if (r.ai !== undefined) {
    const ai = r.ai;
    if (!r.parsedDates || ai.datasetId !== a.datasetId || !same(ai.association, a) || !Array.isArray(ai.records) || !Array.isArray(ai.rejected)
      || !ai.records.every(x => same(x, a) && x.pipelineVersion === LOCAL_PIPELINE_VERSION && x.proposal?.facts?.aiProposal === true && typeof x.original?.mention?.excerpt === "string")) return false;
  }
  return true;
}

/**
 * Restore only when the document itself (association and bytes) is still stored and the dataset is current.
 * Browser storage is opened first, so an unavailable store never calls the backend.
 */
export async function loadStoredExtraction(a: LocalAssociation): Promise<ExtractionLoad> {
  try {
    const fence = await captureLocalFence(a.datasetId);
    const db = await database();
    let row: unknown, documentStored = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([EXTRACTION_STORE, "associations", "blobs"], "readonly");
        const record = tx.objectStore(EXTRACTION_STORE).get(key(a));
        const association = tx.objectStore("associations").get([a.datasetId, a.courseId, a.digest]);
        const blob = tx.objectStore("blobs").get([a.datasetId, a.digest]);
        tx.oncomplete = () => { row = record.result; documentStored = !!association.result && blob.result?.file instanceof Blob; resolve(); };
        tx.onabort = () => reject(new Error("Could not read stored extraction results."));
      });
    } finally { db.close(); }
    if (row === undefined) return { kind: "none", fence };
    if (await currentDataset() !== a.datasetId) return { kind: "unavailable" };
    if (!documentStored || !validStoredExtraction(row, a)) return { kind: "none", fence };
    // AI proposals are always unconfirmed on restore; nothing pending is resumed.
    const record: StoredExtraction = { ...row, ...(row.ai ? { ai: { ...row.ai, records: row.ai.records.map(x => ({ ...x, state: "pending" as const })) } } : {}) };
    return { kind: "restored", record, fence };
  } catch { return { kind: "unavailable" }; }
}

/** Writes are fenced by the erase epoch captured at load: a write after erase is refused. */
export async function saveStoredExtraction(record: StoredExtraction, fence: LocalFence): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([EXTRACTION_STORE, "associations", "lifecycle"], "readwrite");
      const stale = guardTransaction(tx, fence);
      const association = tx.objectStore("associations").get([record.datasetId, record.courseId, record.digest]);
      association.onsuccess = () => { if (!stale() && association.result) tx.objectStore(EXTRACTION_STORE).put(record); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale() ? new StaleLocalWrite() : new Error("Could not store extraction results locally."));
      tx.onerror = () => {};
    });
  } finally { db.close(); }
}

export async function deleteStoredExtraction(a: Pick<LocalAssociation, "datasetId" | "courseId" | "digest">, fence: LocalFence): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([EXTRACTION_STORE, "lifecycle"], "readwrite");
      const stale = guardTransaction(tx, fence);
      const existing = tx.objectStore(EXTRACTION_STORE).get(key(a));
      existing.onsuccess = () => { if (!stale() && existing.result !== undefined) tx.objectStore(EXTRACTION_STORE).delete(key(a)); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale() ? new StaleLocalWrite() : new Error("Could not update stored extraction results."));
      tx.onerror = () => {};
    });
  } finally { db.close(); }
}
