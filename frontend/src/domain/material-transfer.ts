/**
 * #41 explicit single-file download status, derived only from backend transfer
 * records. A download ID is never completion; a completed record is history, not
 * a guarantee that the file still exists on disk.
 */
export type TransferState = "queued" | "validating" | "saving" | "complete" | "failed" | "cancelled" | "interrupted";
export type TransferReason = "sign_in_required" | "forbidden" | "not_found" | "network" | "unsupported_type" | "too_large" | "timeout" | "cancelled_by_user" | "page_closed" | "download_interrupted" | "outcome_unknown" | "not_a_file";
/** Optional detail of a failed `network` outcome: `busy` is a 429/503 on the file fetch (openapi MaterialTransfer). */
export type TransferNetworkDetail = "busy";
export interface MaterialTransfer {
  transferId: string; generation: number; materialId: string; state: TransferState; reason?: TransferReason;
  networkDetail?: TransferNetworkDetail;
  downloadId?: number; bytesReceived?: number; totalBytes?: number; cancelRequested: boolean;
  createdAt: string; updatedAt: string; completedAt?: string;
}
export interface MaterialDownloadStartResult {
  supported: boolean; message: string;
  reason?: "material_not_found" | "not_a_file" | "unsupported_type" | "unsafe_destination" | "source_unavailable";
  transfer?: MaterialTransfer;
}
export interface MaterialDownloads {
  startMaterialDownload(datasetId: string, materialId: string, idempotencyKey: string): Promise<MaterialDownloadStartResult>;
  listMaterialDownloads(): Promise<{ transfers: MaterialTransfer[] }>;
  materialDownload(transferId: string): Promise<MaterialTransfer>;
  cancelMaterialDownload(transferId: string): Promise<MaterialTransfer>;
}
export const supportsDownloads = (a: unknown): a is MaterialDownloads =>
  !!a && typeof (a as MaterialDownloads).startMaterialDownload === "function" && typeof (a as MaterialDownloads).listMaterialDownloads === "function";

export const ACTIVE: TransferState[] = ["queued", "validating", "saving"];
export const isActive = (t?: MaterialTransfer) => !!t && ACTIVE.includes(t.state);

/** Texts the #41 pilot groomed (2026-11-02). */
export const BUSY_TEXT = "Moodle is busy. Try again later. Nothing was saved.";
export const NETWORK_TEXT = "Moodle could not be reached, or sent the request to another site. Nothing was saved.";
export const NOT_A_FILE_TEXT = "This resource opens as a Moodle page, not a file. Open it in Moodle.";
/** The backend's answer to a repeated click while a transfer of that material is active. */
export const ALREADY_IN_PROGRESS = "This download is already in progress.";
const REASON: Record<TransferReason, string> = {
  sign_in_required: "Moodle returned a login page instead of the file. Sign in to SDU Moodle in Chrome, then retry. Nothing was saved.",
  forbidden: "Moodle refused access to this file. Nothing was saved.",
  not_found: "Moodle no longer has this file. Nothing was saved.",
  // Plain network errors and off-origin redirects. A 429/503 is also `network`, but its record
  // carries networkDetail "busy" and shows BUSY_TEXT instead (see failedText).
  network: NETWORK_TEXT,
  unsupported_type: "Moodle did not return a valid PDF, DOCX or PPTX file of the listed type. Nothing was saved.",
  too_large: "The file is larger than the 20 MiB limit. Nothing was saved.",
  timeout: "Moodle did not answer in time. Nothing was saved. Try again later.",
  cancelled_by_user: "Download cancelled. Nothing is available offline.",
  page_closed: "The transfer tab was closed before the download finished. Retry to download again.",
  download_interrupted: "The download was interrupted before it finished (by Chrome or an extension restart); any partial file is not a download record. Retry to download again.",
  outcome_unknown: "The download outcome is unknown. Check Chrome's downloads list, or retry.",
  not_a_file: NOT_A_FILE_TEXT,
};
const fmtDate = (iso?: string) => {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "an unknown time";
};

/** The failure text for a record: the busy text only when the record says 429/503 (`networkDetail: "busy"`). */
const failedText = (t: MaterialTransfer) =>
  t.reason === "network" && t.networkDetail === "busy" ? BUSY_TEXT : REASON[t.reason ?? "outcome_unknown"];

export interface TransferLabel { text: string; tone: "muted" | "warning" | "destructive"; progress?: { value: number; max: number } | "indeterminate"; canCancel: boolean; canRetry: boolean }
export function transferLabel(t: MaterialTransfer): TransferLabel {
  const known = t.totalBytes && t.totalBytes > 0 ? { value: Math.min(t.bytesReceived ?? 0, t.totalBytes), max: t.totalBytes } : "indeterminate" as const;
  switch (t.state) {
    case "queued": return { text: t.cancelRequested ? "Cancelling…" : "Queued — the transfer tab will open", tone: "muted", progress: "indeterminate", canCancel: !t.cancelRequested, canRetry: false };
    case "validating": return { text: t.cancelRequested ? "Cancelling…" : `Validating file from Moodle${t.bytesReceived ? ` (${t.bytesReceived} bytes read)` : ""}`, tone: "muted", progress: known, canCancel: !t.cancelRequested, canRetry: false };
    case "saving": return { text: t.cancelRequested ? "Cancelling…" : "Chrome is saving the file — not finished yet", tone: "muted", progress: "indeterminate", canCancel: !t.cancelRequested, canRetry: false };
    case "complete": return { text: `Download record: saved by Chrome on ${fmtDate(t.completedAt)}. The file may since have been moved or removed.`, tone: "muted", canCancel: false, canRetry: true };
    case "failed": return { text: `Download failed. ${failedText(t)}`, tone: "destructive", canCancel: false, canRetry: true };
    case "cancelled": return { text: REASON[t.reason === "outcome_unknown" ? "outcome_unknown" : "cancelled_by_user"], tone: "warning", canCancel: false, canRetry: true };
    case "interrupted": return { text: `Download interrupted. ${REASON[t.reason ?? "download_interrupted"]}`, tone: "warning", canCancel: false, canRetry: true };
  }
}

/**
 * #85: PDF, DOCX and PPTX files only. EPUB, unknown types, folders, folder entries (declined by
 * the owner; the backend answers not_a_file) and links are never offered.
 */
const DOWNLOADABLE_TYPES = new Set(["pdf", "docx", "pptx"]);
export const downloadable = (i: { kind: string; type: string; provenance: string; parentResourceKey?: string }) =>
  i.kind === "file" && DOWNLOADABLE_TYPES.has(i.type) && !i.parentResourceKey;
