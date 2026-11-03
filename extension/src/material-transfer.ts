/**
 * Explicit single-file material transfer (#41), run only in the packaged visible
 * transfer page after one explicit click. The page fetches the exact
 * backend-registered SDU destination (an exact pluginfile URL, or a resource's
 * exact /mod/resource/view.php?id=<cmid> link) with the browser's own session: GET
 * only, no cookie access, no custom headers, no sesskey. The fetch starts only
 * while the page holds a lease from the #20 request authority (a
 * chrome.runtime.connect port to the worker), so it never overlaps a scan or a
 * course discovery. Redirects are followed and the final URL is checked first:
 * origin exactly https://moodle.sdu.edu.kz, then #20's observed access check
 * (final path, status, <body> id) for sign-in; a resource page is `not_a_file`.
 * A bounded PDF (application/pdf and %PDF-), or (#85) a bounded DOCX or PPTX (its
 * OOXML content type, or application/octet-stream, plus a local ZIP central-directory
 * check) is validated in memory, the validated type must equal the descriptor's
 * `format`, and Chrome is handed the exact validated local Blob. Chrome's download ID
 * is never treated as completion.
 */
import { detectObservedMoodleAccess } from "./moodle-access";

export const SDU_ORIGIN = "https://moodle.sdu.edu.kz";
const PLUGINFILE = /^https:\/\/moodle\.sdu\.edu\.kz\/pluginfile\.php\/[1-9][0-9]*\/mod_resource\/content\/[1-9][0-9]*\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-F]{2})+(?:\?forcedownload=1)?$/;
const RESOURCE_VIEW = /^https:\/\/moodle\.sdu\.edu\.kz\/mod\/resource\/view\.php\?id=[1-9][0-9]{0,18}$/;
/** #20's per-request limit and the lease wait; the descriptor's timeoutMs (60 s) bounds both together. */
export const REQUEST_LIMIT_MS = 30_000;
export const LEASE_WAIT_MS = 30_000;
const HTML_PREFIX_BYTES = 256 * 1024;

export type Reason = "sign_in_required" | "forbidden" | "not_found" | "network" | "unsupported_type" | "too_large" | "timeout" | "cancelled_by_user" | "page_closed" | "download_interrupted" | "outcome_unknown" | "not_a_file";
export type State = "queued" | "validating" | "saving" | "complete" | "failed" | "cancelled" | "interrupted";
/** #85 (owner decision 2026-11-03): PDF, DOCX and PPTX only; EPUB and folder entries are declined. */
export type Format = "pdf" | "docx" | "pptx";
export const MIME: Record<Format, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const FORMATS: readonly Format[] = ["pdf", "docx", "pptx"];
export type Descriptor = { transferId: string; generation: number; attemptId: string; materialId: string; url: string; format: Format; suggestedName?: string; maxBytes: number; timeoutMs: number };
/** Optional detail of a failed `network` outcome: `busy` is a 429/503 on the file fetch (#41). */
export type NetworkDetail = "busy";
export type Transfer = { transferId: string; generation: number; materialId: string; state: State; reason?: Reason; networkDetail?: NetworkDetail; downloadId?: number; cancelRequested: boolean };
/** `busy` marks a 429/503 (reason network); `leaseLost` marks a worker restart (reason download_interrupted). */
export type Acquired = { ok: true; blob: Blob; filename: string; size: number } | { ok: false; reason: Reason; busy?: true; leaseLost?: true };

export const BUSY_TEXT = "Moodle is busy. Try again later. Nothing was saved.";
export const LEASE_LOST_TEXT = "The extension restarted while reading the file. Nothing was saved. Retry to download again.";
export const REASON_TEXT: Record<Reason, string> = {
  sign_in_required: "Moodle returned a login page instead of the file. Sign in to SDU Moodle in Chrome, then retry. Nothing was saved.",
  forbidden: "Moodle refused access to this file. Nothing was saved.",
  not_found: "Moodle no longer has this file. Nothing was saved.",
  network: "Moodle could not be reached, or sent the request to another site. Nothing was saved.",
  unsupported_type: "Moodle did not return a valid PDF, DOCX or PPTX file of the listed type. Nothing was saved.",
  too_large: "The file is larger than the 20 MiB download limit. Nothing was saved.",
  timeout: "Moodle did not answer in time. Nothing was saved. Try again later.",
  cancelled_by_user: "Download cancelled.",
  page_closed: "The transfer page was closed before the download finished. Retry to download again.",
  download_interrupted: "Chrome interrupted the download. The file may be incomplete; retry to download again.",
  outcome_unknown: "The download outcome is unknown. Check Chrome's downloads list, or retry.",
  not_a_file: "This resource opens as a Moodle page, not a file. Open it in Moodle.",
};

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/**
 * Safe base name ending in the validated type's extension (#85: never one from the title
 * or header); never a path, traversal, control/format char or device name.
 */
export function sanitizeFilename(candidate: string | undefined, materialId: string, ext: Format = "pdf"): string {
  const fallback = `moodle-material-${materialId.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "file"}.${ext}`;
  if (typeof candidate !== "string") return fallback;
  let name = candidate.toWellFormed ? candidate.toWellFormed() : candidate.replace(/[\uD800-\uDFFF]/g, "�");
  name = name.normalize("NFC").replace(/�/g, "");
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"|?*~]/gu, "").replace(/\s+/g, " ").trim();
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  name = name.replace(/\.(?:pdf|docx|pptx)$/i, "").replace(/[.\s]+$/, "");
  const stem = name.split(".")[0] ?? "";
  if (!name || RESERVED.test(stem.trim()) || /^\.+$/.test(name)) return fallback;
  name = Array.from(name).slice(0, 120).join("").trim().replace(/[.\s]+$/, "");
  return name ? `${name}.${ext}` : fallback;
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
export const isPdf = (bytes: Uint8Array) => ascii(bytes, 5) === "%PDF-";

const enc = new TextEncoder();
const CONTENT_TYPES = enc.encode("[Content_Types].xml");
const WORD_MAIN = enc.encode("word/document.xml");
const PPT_MAIN = enc.encode("ppt/presentation.xml");
const EOCD_SIZE = 22;
const CEN_SIZE = 46;
const LOC_SIZE = 30;
const MAX_COMMENT = 0xffff;
const MAX_ENTRIES = 10_000;
const LOC_SIG = 0x04034b50, CEN_SIG = 0x02014b50, EOCD_SIG = 0x06054b50;
const sameBytes = (a: Uint8Array, at: number, len: number, b: Uint8Array) => {
  if (len !== b.length || at < 0 || at + len > a.length) return false;
  for (let i = 0; i < len; i++) if (a[at + i] !== b[i]) return false;
  return true;
};
type Part = { name: Uint8Array; local: number; count: number };

/**
 * #85 local OOXML container check over the whole bounded body: reads ZIP headers only,
 * decompresses nothing, uses no library. Returns the type only when every step holds:
 * a leading local header; an EOCD that ends exactly at the end of the body (searched
 * over the last 22 + 65,535 bytes); single disk, no ZIP64, 1..10,000 entries; a central
 * directory that ends exactly at the EOCD and walks exactly the declared entries inside
 * its bounds; `[Content_Types].xml` exactly once plus exactly one of `word/document.xml`
 * (docx) or `ppt/presentation.xml` (pptx), never both; no encrypted entry; and each
 * required entry's local header (before the central directory) carries the same name.
 * Every read is bounds-checked; malformed input gives null, never a throw.
 */
export function ooxmlType(bytes: Uint8Array): "docx" | "pptx" | null {
  try {
    const len = bytes.length;
    if (len < EOCD_SIZE) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== LOC_SIG) return null;
    let eocd = -1;
    for (let at = len - EOCD_SIZE, low = Math.max(0, len - EOCD_SIZE - MAX_COMMENT); at >= low; at--) {
      if (view.getUint32(at, true) === EOCD_SIG && at + EOCD_SIZE + view.getUint16(at + 20, true) === len) { eocd = at; break; }
    }
    if (eocd < 0) return null;
    const disk = view.getUint16(eocd + 4, true), cdDisk = view.getUint16(eocd + 6, true);
    const onDisk = view.getUint16(eocd + 8, true), total = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true), cdOffset = view.getUint32(eocd + 16, true);
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total) return null; // single disk only
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null; // ZIP64
    if (total < 1 || total > MAX_ENTRIES) return null;
    if (cdOffset + cdSize !== eocd) return null;
    const types: Part = { name: CONTENT_TYPES, local: -1, count: 0 };
    const word: Part = { name: WORD_MAIN, local: -1, count: 0 };
    const ppt: Part = { name: PPT_MAIN, local: -1, count: 0 };
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
      if (p + CEN_SIZE > eocd || view.getUint32(p, true) !== CEN_SIG) return null;
      const flags = view.getUint16(p + 8, true);
      const packed = view.getUint32(p + 20, true), plain = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
      const startDisk = view.getUint16(p + 34, true), local = view.getUint32(p + 42, true);
      const next = p + CEN_SIZE + nameLen + extraLen + commentLen;
      if (next > eocd) return null;
      if (flags & 1) return null; // encrypted entry
      if (startDisk !== 0 || packed === 0xffffffff || plain === 0xffffffff || local === 0xffffffff) return null; // ZIP64 / multi-disk
      for (const part of [types, word, ppt]) {
        if (sameBytes(bytes, p + CEN_SIZE, nameLen, part.name)) { part.count++; part.local = local; }
      }
      p = next;
    }
    if (p !== eocd) return null;
    if (types.count !== 1) return null;
    let kind: "docx" | "pptx";
    if (word.count === 1 && ppt.count === 0) kind = "docx";
    else if (ppt.count === 1 && word.count === 0) kind = "pptx";
    else return null;
    for (const part of [types, kind === "docx" ? word : ppt]) {
      const at = part.local;
      if (at < 0 || at + LOC_SIZE > cdOffset || view.getUint32(at, true) !== LOC_SIG) return null;
      if (view.getUint16(at + 6, true) & 1) return null; // encrypted
      const nameLen = view.getUint16(at + 26, true);
      if (at + LOC_SIZE + nameLen > cdOffset || !sameBytes(bytes, at + LOC_SIZE, nameLen, part.name)) return null;
    }
    return kind;
  } catch {
    return null; // defensive: a malformed body never throws out of the validator
  }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** A held #20 request-authority lease: `lost` aborts on worker restart; `settle` releases it after the fetch settled. */
export type Lease = { lost: AbortSignal; settle(info: { status?: number; retryAfter?: string }): void };
export type LeaseResult = { ok: true; lease: Lease } | { ok: false; reason: "timeout" | "refused" | "lost" | "cancelled" };
export type LeaseRequester = (transferId: string, signal: AbortSignal) => Promise<LeaseResult>;

/** Port shape of chrome.runtime.connect, so the page side is testable against the real worker host. */
export type LeaseClientPort = {
  postMessage(message: unknown): void; disconnect(): void;
  onMessage: { addListener(listener: (message: any) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};
/** Page side of the #20 lease protocol (see createTransferLeaseHost in moodle-request-authority.ts). */
export function leaseRequester(connect: () => LeaseClientPort, options: { waitMs?: number } = {}): LeaseRequester {
  return (transferId, signal) => new Promise<LeaseResult>((resolve) => {
    let port: LeaseClientPort;
    try { port = connect(); } catch { resolve({ ok: false, reason: "lost" }); return; }
    const lost = new AbortController();
    let answered = false, granted = false;
    const answer = (r: LeaseResult) => { if (!answered) { answered = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(r); } };
    const drop = () => { try { port.disconnect(); } catch { /* already closed */ } };
    // The worker answers `timeout` at 30 s; this is only a backstop for a silent worker.
    const timer = setTimeout(() => { if (!granted) { drop(); answer({ ok: false, reason: "timeout" }); } }, Math.min(options.waitMs ?? LEASE_WAIT_MS, LEASE_WAIT_MS) + 2000);
    const onAbort = () => { if (!granted) { drop(); answer({ ok: false, reason: "cancelled" }); } };
    signal.addEventListener("abort", onAbort);
    port.onMessage.addListener((m) => {
      if (m?.type === "granted" && !answered) {
        granted = true;
        answer({ ok: true, lease: { lost: lost.signal, settle: (info) => { try { port.postMessage({ type: "settled", ...info }); } catch { /* worker gone: it released on disconnect */ } } } });
      } else if (m?.type === "timeout") answer({ ok: false, reason: "timeout" });
      else if (m?.type === "refused") answer({ ok: false, reason: "refused" });
    });
    port.onDisconnect.addListener(() => { if (granted) lost.abort(); else answer({ ok: false, reason: "lost" }); });
    if (signal.aborted) { onAbort(); return; }
    try { port.postMessage({ type: "acquire", transferId }); } catch { answer({ ok: false, reason: "lost" }); }
  });
}

type FinalKind = "file" | "page" | "login" | "other";
function finalKind(url: URL): FinalKind {
  if (url.pathname.startsWith("/pluginfile.php/")) return "file";
  if (url.pathname === "/mod/resource/view.php") return "page";
  if (url.pathname === "/login/index.php") return "login";
  return "other";
}
async function readPrefix(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const c of chunks) { const part = c.subarray(0, bytes.length - at); bytes.set(part, at); at += part.byteLength; if (at >= bytes.length) break; }
  return new TextDecoder().decode(bytes);
}
const defaultParse = (html: string): Document | undefined => (typeof DOMParser === "undefined" ? undefined : new DOMParser().parseFromString(html, "text/html"));

export type AcquireDeps = {
  fetcher: Fetcher; signal: AbortSignal; lease: LeaseRequester;
  onProgress?: (bytes: number, total: number | null) => void;
  /** The page's DOMParser; injected in tests. Only the <body> id/classes are read, by #20's access check. */
  parseHtml?: (html: string) => Document | undefined;
};
/** Bounded read-only acquisition under a #20 lease; nothing is returned unless every check passed. */
export async function acquire(d: Descriptor, deps: AcquireDeps): Promise<Acquired> {
  if (!FORMATS.includes(d.format) || !(PLUGINFILE.test(d.url) || RESOURCE_VIEW.test(d.url)) || new URL(d.url).origin !== SDU_ORIGIN) return { ok: false, reason: "unsupported_type" };
  const budget = Math.max(1, d.timeoutMs);
  const granted = await deps.lease(d.transferId, deps.signal);
  if (!granted.ok) {
    if (granted.reason === "cancelled" || deps.signal.aborted) return { ok: false, reason: "cancelled_by_user" };
    if (granted.reason === "timeout") return { ok: false, reason: "timeout" }; // no Moodle request was made
    return { ok: false, reason: "download_interrupted", leaseLost: true };
  }
  const lease = granted.lease;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(REQUEST_LIMIT_MS, budget));
  const relay = () => controller.abort();
  if (deps.signal.aborted || lease.lost.aborted) controller.abort();
  deps.signal.addEventListener("abort", relay);
  lease.lost.addEventListener("abort", relay);
  const why = (): Acquired => (lease.lost.aborted && !deps.signal.aborted ? { ok: false, reason: "download_interrupted", leaseLost: true }
    : { ok: false, reason: deps.signal.aborted ? "cancelled_by_user" : timedOut ? "timeout" : "network" });
  const settled: { status?: number; retryAfter?: string } = {};
  const fail = async (response: Response, reason: Reason, extra: { busy?: true } = {}): Promise<Acquired> => {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason, ...extra };
  };
  try {
    let response: Response;
    if (controller.signal.aborted) return why(); // cancelled or lost while the lease was granted: no request
    try {
      // Browser session only: GET, no custom headers, no cookies API; redirects followed, final URL checked below.
      response = await deps.fetcher(d.url, { method: "GET", credentials: "include", redirect: "follow", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
    } catch {
      return why();
    }
    settled.status = response.status;
    let final: URL;
    try { final = new URL(response.url || d.url); } catch { return await fail(response, "network"); }
    // A redirect off the exact SDU origin is refused before its body is read.
    if (final.origin !== SDU_ORIGIN || final.username || final.password) return await fail(response, "network");
    const kind = finalKind(final);
    const status = response.status;
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const envelope = { requestedUrl: d.url, finalUrl: final.origin + final.pathname, httpStatus: status, networkFailure: false, ...(type ? { contentType: type } : {}) };
    if (status === 401 || kind === "login") {
      // #20's observed access check: final path /login/index.php or HTTP 401 is signed out.
      return await fail(response, detectObservedMoodleAccess(envelope, { kind: "service" }).status === "signed_out" ? "sign_in_required" : "network");
    }
    if (status === 429 || status === 503) {
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) settled.retryAfter = retryAfter.slice(0, 64);
      return await fail(response, "network", { busy: true }); // never retried automatically
    }
    if (status === 403) return await fail(response, "forbidden");
    if (status === 404 || status === 410) return await fail(response, "not_found");
    if (status < 200 || status > 299) return await fail(response, "network");
    if (type === "text/html" || type === "application/xhtml+xml") {
      let text: string;
      try { text = await readPrefix(response, HTML_PREFIX_BYTES); } catch { return why(); }
      let document: Document | undefined;
      try { document = (deps.parseHtml ?? defaultParse)(text); } catch { document = undefined; }
      const access = detectObservedMoodleAccess({ ...envelope, ...(document ? { document } : {}) }, { kind: "service" });
      if (access.status === "signed_out") return { ok: false, reason: "sign_in_required" };
      // A resource that stays on its view.php page (or any other Moodle page) is not a file.
      if (kind !== "file") return { ok: false, reason: "not_a_file" };
      // HTML on pluginfile.php that #20's check did not classify as signed out is not a PDF; never saved.
      return { ok: false, reason: "unsupported_type" };
    }
    if (kind !== "file") return await fail(response, type.startsWith("text/") ? "not_a_file" : "unsupported_type");
    // #85: the content type must be the listed format's exact MIME type; application/octet-stream
    // is tolerated for DOCX/PPTX only, and only together with the full container check below.
    const octet = type === "application/octet-stream" && d.format !== "pdf";
    if (type !== MIME[d.format] && !octet) return await fail(response, "unsupported_type");
    const declared = response.headers.get("content-length");
    const total = declared && /^\d{1,12}$/.test(declared) ? Number(declared) : null;
    if (total !== null && total > d.maxBytes) return await fail(response, "too_large");
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
      await reader.cancel().catch(() => {});
      return why();
    }
    if (controller.signal.aborted) return why();
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    if (size === 0) return { ok: false, reason: "unsupported_type" };
    // Sign-in is classified only by #20's access check above (final URL, status, <body> id),
    // never from body text: any body that fails its type's check is unsupported_type.
    const validated: Format | null = d.format === "pdf" ? (isPdf(bytes) ? "pdf" : null) : ooxmlType(bytes);
    // The validated type must equal the listed format: a DOCX for a pptx badge is refused, never renamed.
    if (validated === null || validated !== d.format) return { ok: false, reason: "unsupported_type" };
    // The name comes from the final response's Content-Disposition or the stored metadata,
    // always through the sanitizer, with the validated type's extension; the final URL path is never used.
    const filename = sanitizeFilename(dispositionName(response.headers.get("content-disposition")) ?? d.suggestedName, d.materialId, validated);
    return { ok: true, blob: new Blob([bytes], { type: MIME[validated] }), filename, size };
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener("abort", relay);
    lease.lost.removeEventListener("abort", relay);
    // The fetch and its body have settled (read, cancelled or aborted): release the lease.
    lease.settle(settled);
  }
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
  /** #20 request-authority lease; the file fetch starts only while it is held. */
  lease: LeaseRequester; parseHtml?: (html: string) => Document | undefined;
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
  // Only the dashboard's explicit Cancel (the backend's cancelRequested) is a user cancel.
  // A closed transfer tab or a Chrome-side stop (even one Chrome labels USER_CANCELED, as it
  // does when the closing page takes its Blob with it) is an interruption, never cancelled_by_user.
  let cancelClicked = false;
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
  const end = async (state: State, reason?: Reason, text?: string, networkDetail?: NetworkDetail): Promise<View> => {
    finished = true;
    const message = text ?? (state === "complete" ? "Downloaded. This is a download record; the file may later be moved or removed." : REASON_TEXT[reason ?? "outcome_unknown"]);
    // The busy detail is sent only with failed/network, so the dashboard can show the same busy text.
    const detail = networkDetail && state === "failed" && reason === "network" ? { networkDetail } : {};
    for (let i = 0; i < 3; i++) {
      try {
        await report({ state, ...(reason ? { reason } : {}), ...detail, ...(downloadId !== undefined ? { downloadId } : {}) });
        return view({ phase: state, message, ...(downloadId !== undefined ? { downloadId } : {}) });
      } catch { /* retry the same outcome; never restart the download */ }
    }
    return view({ phase: "unrecorded", message: "Download outcome not yet recorded. " + message, ...(downloadId !== undefined ? { downloadId } : {}) });
  };
  const poll = setInterval(() => {
    void api.read(transferId).then((t) => { if (t.cancelRequested) { cancelClicked = true; user.abort(); } }).catch(() => {});
  }, deps.pollMs ?? 1000);
  try {
    let d: Descriptor;
    try { d = await api.descriptor(transferId); } catch { finished = true; return view({ phase: "failed", message: "This transfer can no longer start (it was cancelled, already started or its material changed). Retry from the dashboard." }); }
    generation = d.generation; attemptId = d.attemptId;
    await report({ state: "validating" });
    view({ phase: "validating", message: "Checking the file from Moodle…" });
    view({ phase: "validating", message: "Waiting for Moodle to be free…" });
    const got = await acquire(d, { fetcher: deps.fetcher, signal: user.signal, lease: deps.lease,
      ...(deps.parseHtml ? { parseHtml: deps.parseHtml } : {}),
      onProgress: (bytes, total) => view({ phase: "validating", message: "Reading from Moodle…", bytes, total }) });
    if (!got.ok) {
      if (got.reason === "cancelled_by_user" && cancelClicked) return await end("cancelled", "cancelled_by_user");
      if (deps.closed.aborted) return await end(got.reason === "cancelled_by_user" ? "interrupted" : "failed", "page_closed");
      if (got.reason === "cancelled_by_user") return await end("interrupted", "page_closed");
      // Worker restart: the lease port dropped, the fetch was aborted, nothing was saved.
      if (got.leaseLost) return await end("interrupted", "download_interrupted", LEASE_LOST_TEXT);
      // 429/503: reason stays `network`; the record carries networkDetail "busy" for the dashboard.
      if (got.busy) return await end("failed", got.reason, BUSY_TEXT, "busy");
      return await end("failed", got.reason);
    }
    if (user.signal.aborted) return await end(cancelClicked ? "cancelled" : "interrupted", cancelClicked ? "cancelled_by_user" : "page_closed");
    blobUrl = deps.blobs.create(got.blob);
    type Terminal = { state: "complete" } | { state: "interrupted"; error?: string };
    let resolveTerminal!: (s: Terminal) => void;
    const terminal = new Promise<Terminal>((r) => { resolveTerminal = r; });
    const listener = (delta: DownloadDelta) => {
      if (downloadId === undefined || delta.id !== downloadId) return; // only our own known download
      if (delta.state?.current === "complete") resolveTerminal({ state: "complete" });
      else if (delta.state?.current === "interrupted") resolveTerminal({ state: "interrupted", ...(delta.error?.current ? { error: delta.error.current } : {}) });
    };
    // A Chrome-side stop: cancelled only if the dashboard's Cancel was pressed (seen now or by one
    // last read), page_closed if the tab is going away, otherwise download_interrupted.
    const chromeStopped = async (): Promise<View> => {
      if (!cancelClicked && !deps.closed.aborted) {
        const t = await api.read(transferId).catch(() => null);
        if (t?.cancelRequested) cancelClicked = true;
      }
      if (cancelClicked) return await end("cancelled", "cancelled_by_user");
      return await end("interrupted", deps.closed.aborted ? "page_closed" : "download_interrupted");
    };
    downloads.onChanged.addListener(listener);
    try {
      downloadId = await downloads.download({ url: blobUrl, filename: got.filename, conflictAction: "uniquify", saveAs: false });
      await report({ state: "saving", downloadId, bytesReceived: got.size, totalBytes: got.size });
      view({ phase: "saving", message: "Chrome is saving the file…", filename: got.filename, downloadId, bytes: got.size, total: got.size });
      const known = (await downloads.search({ id: downloadId }).catch(() => []))[0];
      if (known?.state === "complete") resolveTerminal({ state: "complete" });
      else if (known?.state === "interrupted") resolveTerminal({ state: "interrupted", ...(known.error ? { error: known.error } : {}) });
      const stopped = new Promise<"stop">((r) => {
        if (user.signal.aborted) r("stop");
        else user.signal.addEventListener("abort", () => r("stop"), { once: true });
      });
      const first = await Promise.race([terminal, stopped]);
      if (first === "stop" && !cancelClicked) {
        // The tab is closing: record the interruption first, while the page can still send it
        // (keepalive), and do not wait on Chrome; the download is stopped without awaiting it.
        void downloads.cancel(downloadId).catch(() => {});
        return await end("interrupted", "page_closed");
      }
      if (first === "stop") {
        await downloads.cancel(downloadId).catch(() => {});
        const after = await Promise.race([terminal, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
        if (after?.state === "complete") return await end("complete");
        return await end("cancelled", after ? "cancelled_by_user" : "outcome_unknown");
      }
      if (first.state === "complete") return await end("complete");
      return await chromeStopped();
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
