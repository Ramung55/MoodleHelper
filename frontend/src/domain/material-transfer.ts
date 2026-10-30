/**
 * #41 explicit single-file download status, derived only from backend transfer
 * records. A download ID is never completion; a completed record is history, not
 * a guarantee that the file still exists on disk.
 */
export type TransferState = "queued" | "validating" | "saving" | "complete" | "failed" | "cancelled" | "interrupted";
export type TransferReason = "sign_in_required" | "forbidden" | "not_found" | "network" | "unsupported_type" | "too_large" | "timeout" | "cancelled_by_user" | "page_closed" | "download_interrupted" | "outcome_unknown";
export interface MaterialTransfer {
  transferId: string; generation: number; materialId: string; state: TransferState; reason?: TransferReason;
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

const REASON: Record<TransferReason, string> = {
  sign_in_required: "Moodle returned a login page instead of the file. Sign in to Moodle in Chrome, then retry. Nothing was saved.",
  forbidden: "Moodle refused access to this file. Nothing was saved.",
  not_found: "Moodle no longer has this file. Nothing was saved.",
  network: "Moodle could not be reached or redirected the request (often an expired login). Sign in to Moodle in Chrome, then retry. Nothing was saved.",
  unsupported_type: "Moodle did not return a valid PDF. Nothing was saved.",
  too_large: "The file is larger than the 20 MiB limit. Nothing was saved.",
  timeout: "The download took longer than 60 seconds. Nothing was saved.",
  cancelled_by_user: "Download cancelled. Nothing is available offline.",
  page_closed: "The transfer tab was closed before the download finished. Retry to download again.",
  download_interrupted: "Chrome interrupted the download; the file may be incomplete. Retry to download again.",
  outcome_unknown: "The download outcome is unknown. Check Chrome's downloads list, or retry.",
};
const fmtDate = (iso?: string) => {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "an unknown time";
};

export interface TransferLabel { text: string; tone: "muted" | "warning" | "destructive"; progress?: { value: number; max: number } | "indeterminate"; canCancel: boolean; canRetry: boolean }
export function transferLabel(t: MaterialTransfer): TransferLabel {
  const known = t.totalBytes && t.totalBytes > 0 ? { value: Math.min(t.bytesReceived ?? 0, t.totalBytes), max: t.totalBytes } : "indeterminate" as const;
  switch (t.state) {
    case "queued": return { text: t.cancelRequested ? "Cancelling…" : "Queued — the transfer tab will open", tone: "muted", progress: "indeterminate", canCancel: !t.cancelRequested, canRetry: false };
    case "validating": return { text: t.cancelRequested ? "Cancelling…" : `Validating file from Moodle${t.bytesReceived ? ` (${t.bytesReceived} bytes read)` : ""}`, tone: "muted", progress: known, canCancel: !t.cancelRequested, canRetry: false };
    case "saving": return { text: t.cancelRequested ? "Cancelling…" : "Chrome is saving the file — not finished yet", tone: "muted", progress: "indeterminate", canCancel: !t.cancelRequested, canRetry: false };
    case "complete": return { text: `Download record: saved by Chrome on ${fmtDate(t.completedAt)}. The file may since have been moved or removed.`, tone: "muted", canCancel: false, canRetry: true };
    case "failed": return { text: `Download failed. ${REASON[t.reason ?? "outcome_unknown"]}`, tone: "destructive", canCancel: false, canRetry: true };
    case "cancelled": return { text: REASON[t.reason === "outcome_unknown" ? "outcome_unknown" : "cancelled_by_user"], tone: "warning", canCancel: false, canRetry: true };
    case "interrupted": return { text: `Download interrupted. ${REASON[t.reason ?? "download_interrupted"]}`, tone: "warning", canCancel: false, canRetry: true };
  }
}

/** Only one supported file kind; folders/links/unknown are never offered. */
export const downloadable = (i: { kind: string; type: string; provenance: string }) => i.kind === "file" && i.type === "pdf";
