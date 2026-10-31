/**
 * Explicit single-file material transfer (#41), run only in the packaged visible
 * transfer page. Fetches the exact backend-registered SDU pluginfile URL with the
 * browser's own session (no cookie access, no custom auth headers, redirect:error),
 * validates a bounded PDF in memory and hands Chrome the exact validated local Blob.
 * Chrome's download ID is never treated as completion.
 */
export const SDU_ORIGIN = "https://moodle.sdu.edu.kz";
const PLUGINFILE = /^https:\/\/moodle\.sdu\.edu\.kz\/pluginfile\.php\/[1-9][0-9]*\/mod_resource\/content\/[1-9][0-9]*\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-F]{2})+(?:\?forcedownload=1)?$/;

export type Reason = "sign_in_required" | "forbidden" | "not_found" | "network" | "unsupported_type" | "too_large" | "timeout" | "cancelled_by_user" | "page_closed" | "download_interrupted" | "outcome_unknown";
export type State = "queued" | "validating" | "saving" | "complete" | "failed" | "cancelled" | "interrupted";
export type Descriptor = { transferId: string; generation: number; attemptId: string; materialId: string; url: string; format: "pdf"; suggestedName?: string; maxBytes: number; timeoutMs: number };
export type Transfer = { transferId: string; generation: number; materialId: string; state: State; reason?: Reason; downloadId?: number; cancelRequested: boolean };
export type Acquired = { ok: true; blob: Blob; filename: string; size: number } | { ok: false; reason: Reason };

export const REASON_TEXT: Record<Reason, string> = {
  sign_in_required: "Moodle returned a login page instead of the file. Sign in to Moodle in Chrome, then retry. Nothing was saved.",
  forbidden: "Moodle refused access to this file. Nothing was saved.",
  not_found: "Moodle no longer has this file. Nothing was saved.",
  network: "Moodle could not be reached or redirected the request (often an expired login). Sign in to Moodle in Chrome, then retry. Nothing was saved.",
  unsupported_type: "Moodle did not return a valid PDF. Nothing was saved; open the file in Moodle instead.",
  too_large: "The file is larger than the 20 MiB download limit. Nothing was saved.",
  timeout: "The download took longer than 60 seconds. Nothing was saved.",
  cancelled_by_user: "Download cancelled.",
  page_closed: "The transfer page was closed before the download finished. Retry to download again.",
  download_interrupted: "Chrome interrupted the download. The file may be incomplete; retry to download again.",
  outcome_unknown: "The download outcome is unknown. Check Chrome's downloads list, or retry.",
};

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** Safe base name ending in .pdf; never a path, traversal, control/format char or device name. */
export function sanitizeFilename(candidate: string | undefined, materialId: string): string {
  const fallback = `moodle-material-${materialId.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "file"}.pdf`;
  if (typeof candidate !== "string") return fallback;
  let name = candidate.toWellFormed ? candidate.toWellFormed() : candidate.replace(/[\uD800-\uDFFF]/g, "�");
  name = name.normalize("NFC").replace(/�/g, "");
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"|?*~]/gu, "").replace(/\s+/g, " ").trim();
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  name = name.replace(/\.pdf$/i, "").replace(/[.\s]+$/, "");
  const stem = name.split(".")[0] ?? "";
  if (!name || RESERVED.test(stem.trim()) || /^\.+$/.test(name)) return fallback;
  name = Array.from(name).slice(0, 120).join("").trim().replace(/[.\s]+$/, "");
  return name ? `${name}.pdf` : fallback;
}

/** Bounded Content-Disposition filename (RFC 6266 filename* preferred); undefined when absent or malformed. */
export function dispositionName(header: string | null): string | undefined {
  if (!header || header.length > 1024) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* malformed */ } }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return plain ? (plain[1] ?? plain[2])!.trim() : undefined;
}

const ascii = (bytes: Uint8Array, n: number) => Array.from(bytes.subarray(0, n), (b) => String.fromCharCode(b)).join("");
/** Login/HTML bodies are rejected regardless of status, name or declared type. */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[start]!)) start++;
  const head = ascii(bytes.subarray(start), 512).toLowerCase();
  return head.startsWith("<") || (!head.startsWith("%pdf-") && /<html|<!doctype|<form|login/.test(head));
}
export const isPdf = (bytes: Uint8Array) => ascii(bytes, 5) === "%PDF-";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
/** Bounded read-only acquisition; nothing is returned unless every check passed. */
export async function acquire(d: Descriptor, deps: { fetcher: Fetcher; signal: AbortSignal; onProgress?: (bytes: number, total: number | null) => void }): Promise<Acquired> {
  if (d.format !== "pdf" || !PLUGINFILE.test(d.url) || new URL(d.url).origin !== SDU_ORIGIN) return { ok: false, reason: "unsupported_type" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, d.timeoutMs);
  const relay = () => controller.abort();
  if (deps.signal.aborted) controller.abort();
  deps.signal.addEventListener("abort", relay);
  const why = (): Reason => (deps.signal.aborted ? "cancelled_by_user" : timedOut ? "timeout" : "network");
  try {
    let response: Response;
    try {
      // Browser session only: no custom headers, no cookies API, no redirect following.
      response = await deps.fetcher(d.url, { method: "GET", credentials: "include", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
    } catch {
      return { ok: false, reason: why() };
    }
    if (response.redirected || response.type === "opaqueredirect" || (response.url && response.url !== d.url)) return fail(response, "sign_in_required");
    if (response.status === 401) return fail(response, "sign_in_required");
    if (response.status === 403) return fail(response, "forbidden");
    if (response.status === 404 || response.status === 410) return fail(response, "not_found");
    if (response.status < 200 || response.status > 299) return fail(response, "network");
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type === "text/html" || type === "application/xhtml+xml" || type.startsWith("text/")) return fail(response, "sign_in_required");
    if (type !== "application/pdf") return fail(response, "unsupported_type");
    const declared = response.headers.get("content-length");
    const total = declared && /^\d{1,12}$/.test(declared) ? Number(declared) : null;
    if (total !== null && total > d.maxBytes) return fail(response, "too_large");
    if (!response.body) return { ok: false, reason: "unsupported_type" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > d.maxBytes) { await reader.cancel().catch(() => {}); return { ok: false, reason: "too_large" }; }
        chunks.push(value);
        deps.onProgress?.(size, total);
      }
    } catch {
      return { ok: false, reason: why() };
    }
    if (controller.signal.aborted) return { ok: false, reason: why() };
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    if (size === 0) return { ok: false, reason: "unsupported_type" };
    if (looksLikeHtml(bytes)) return { ok: false, reason: "sign_in_required" };
    if (!isPdf(bytes)) return { ok: false, reason: "unsupported_type" };
    const filename = sanitizeFilename(dispositionName(response.headers.get("content-disposition")) ?? d.suggestedName, d.materialId);
    return { ok: true, blob: new Blob([bytes], { type: "application/pdf" }), filename, size };
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener("abort", relay);
  }
}
function fail(response: Response, reason: Reason): Acquired {
  void response.body?.cancel().catch(() => {});
  return { ok: false, reason };
}

export type TransferApi = {
  descriptor(id: string): Promise<Descriptor>;
  read(id: string): Promise<Transfer>;
  report(id: string, body: Record<string, unknown>): Promise<Transfer>;
};
export type DownloadDelta = { id: number; state?: { current?: string }; error?: { current?: string } };
export type DownloadsApi = {
  download(options: { url: string; filename: string; conflictAction: "uniquify"; saveAs: boolean }): Promise<number>;
  cancel(id: number): Promise<void>;
  search(query: { id: number }): Promise<{ id: number; state: string; error?: string }[]>;
  onChanged: { addListener(f: (d: DownloadDelta) => void): void; removeListener(f: (d: DownloadDelta) => void): void };
};
export type View = { phase: State | "starting" | "unrecorded"; message: string; bytes?: number; total?: number | null; filename?: string; downloadId?: number };
export type PageDeps = {
  api: TransferApi; fetcher: Fetcher; downloads: DownloadsApi;
  blobs: { create(b: Blob): string; revoke(u: string): void };
  render(v: View): void; pollMs?: number; closed: AbortSignal;
};

/** Production transfer state machine for one explicit attempt; idempotent, generation-fenced. */
export async function runTransfer(transferId: string, deps: PageDeps): Promise<View> {
  const { api, downloads } = deps;
  let blobUrl: string | null = null;
  let generation = 0;
  let attemptId = "";
  let downloadId: number | undefined;
  let finished = false;
  const user = new AbortController();
  const stop = () => user.abort();
  deps.closed.addEventListener("abort", stop);
  if (deps.closed.aborted) user.abort();
  const view = (v: View) => { deps.render(v); return v; };
  const report = async (body: Record<string, unknown>) => {
    const t = await api.report(transferId, { generation, attemptId, ...body });
    generation = t.generation;
    return t;
  };
  const end = async (state: State, reason?: Reason): Promise<View> => {
    finished = true;
    const message = state === "complete" ? "Downloaded. This is a download record; the file may later be moved or removed." : REASON_TEXT[reason ?? "outcome_unknown"];
    for (let i = 0; i < 3; i++) {
      try {
        await report({ state, ...(reason ? { reason } : {}), ...(downloadId !== undefined ? { downloadId } : {}) });
        return view({ phase: state, message, ...(downloadId !== undefined ? { downloadId } : {}) });
      } catch { /* retry the same outcome; never restart the download */ }
    }
    return view({ phase: "unrecorded", message: "Download outcome not yet recorded. " + message, ...(downloadId !== undefined ? { downloadId } : {}) });
  };
  const poll = setInterval(() => {
    void api.read(transferId).then((t) => { if (t.cancelRequested) user.abort(); }).catch(() => {});
  }, deps.pollMs ?? 1000);
  try {
    let d: Descriptor;
    try { d = await api.descriptor(transferId); } catch { finished = true; return view({ phase: "failed", message: "This transfer can no longer start (it was cancelled, already started or its material changed). Retry from the dashboard." }); }
    generation = d.generation; attemptId = d.attemptId;
    await report({ state: "validating" });
    view({ phase: "validating", message: "Checking the file from Moodle…" });
    const got = await acquire(d, { fetcher: deps.fetcher, signal: user.signal, onProgress: (bytes, total) => view({ phase: "validating", message: "Reading from Moodle…", bytes, total }) });
    if (!got.ok) return await end(got.reason === "cancelled_by_user" ? (deps.closed.aborted ? "interrupted" : "cancelled") : "failed", deps.closed.aborted ? "page_closed" : got.reason);
    if (user.signal.aborted) return await end(deps.closed.aborted ? "interrupted" : "cancelled", deps.closed.aborted ? "page_closed" : "cancelled_by_user");
    blobUrl = deps.blobs.create(got.blob);
    let resolveTerminal!: (s: { state: "complete" } | { state: "interrupted" | "cancelled"; error?: string }) => void;
    const terminal = new Promise<{ state: "complete" } | { state: "interrupted" | "cancelled"; error?: string }>((r) => { resolveTerminal = r; });
    const listener = (delta: DownloadDelta) => {
      if (downloadId === undefined || delta.id !== downloadId) return; // only our own known download
      if (delta.state?.current === "complete") resolveTerminal({ state: "complete" });
      else if (delta.state?.current === "interrupted") resolveTerminal({ state: delta.error?.current === "USER_CANCELED" ? "cancelled" : "interrupted", error: delta.error?.current });
    };
    downloads.onChanged.addListener(listener);
    try {
      downloadId = await downloads.download({ url: blobUrl, filename: got.filename, conflictAction: "uniquify", saveAs: false });
      await report({ state: "saving", downloadId, bytesReceived: got.size, totalBytes: got.size });
      view({ phase: "saving", message: "Chrome is saving the file…", filename: got.filename, downloadId, bytes: got.size, total: got.size });
      const known = (await downloads.search({ id: downloadId }).catch(() => []))[0];
      if (known?.state === "complete") resolveTerminal({ state: "complete" });
      else if (known?.state === "interrupted") resolveTerminal({ state: known.error === "USER_CANCELED" ? "cancelled" : "interrupted", error: known.error });
      const cancelled = new Promise<"cancel">((r) => user.signal.addEventListener("abort", () => r("cancel"), { once: true }));
      const first = await Promise.race([terminal, cancelled]);
      if (first === "cancel") {
        await downloads.cancel(downloadId).catch(() => {});
        const after = await Promise.race([terminal, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
        if (after?.state === "complete") return await end("complete");
        return await end(deps.closed.aborted ? "interrupted" : "cancelled", after ? (deps.closed.aborted ? "page_closed" : "cancelled_by_user") : "outcome_unknown");
      }
      if (first.state === "complete") return await end("complete");
      return await end(first.state, first.state === "cancelled" ? "cancelled_by_user" : "download_interrupted");
    } finally {
      downloads.onChanged.removeListener(listener);
    }
  } catch {
    return finished ? view({ phase: "unrecorded", message: "Download outcome not yet recorded." }) : await end("failed", "outcome_unknown").catch(() => view({ phase: "unrecorded", message: "Download outcome not yet recorded." }));
  } finally {
    clearInterval(poll);
    deps.closed.removeEventListener("abort", stop);
    if (blobUrl) deps.blobs.revoke(blobUrl); // bytes released on every path
  }
}
