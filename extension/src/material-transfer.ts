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
 * A bounded PDF (application/pdf and %PDF-) is validated in memory and Chrome is
 * handed the exact validated local Blob. Chrome's download ID is never treated as
 * completion.
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
export type Descriptor = { transferId: string; generation: number; attemptId: string; materialId: string; url: string; format: "pdf"; suggestedName?: string; maxBytes: number; timeoutMs: number };
export type Transfer = { transferId: string; generation: number; materialId: string; state: State; reason?: Reason; downloadId?: number; cancelRequested: boolean };
/** `busy` marks a 429/503 (reason network); `leaseLost` marks a worker restart (reason download_interrupted). */
export type Acquired = { ok: true; blob: Blob; filename: string; size: number } | { ok: false; reason: Reason; busy?: true; leaseLost?: true };

export const BUSY_TEXT = "Moodle is busy. Try again later. Nothing was saved.";
export const LEASE_LOST_TEXT = "The extension restarted while reading the file. Nothing was saved. Retry to download again.";
export const REASON_TEXT: Record<Reason, string> = {
  sign_in_required: "Moodle returned a login page instead of the file. Sign in to SDU Moodle in Chrome, then retry. Nothing was saved.",
  forbidden: "Moodle refused access to this file. Nothing was saved.",
  not_found: "Moodle no longer has this file. Nothing was saved.",
  network: "Moodle could not be reached, or sent the request to another site. Nothing was saved.",
  unsupported_type: "Moodle did not return a valid PDF. Nothing was saved; open the file in Moodle instead.",
  too_large: "The file is larger than the 20 MiB download limit. Nothing was saved.",
  timeout: "Moodle did not answer in time. Nothing was saved. Try again later.",
  cancelled_by_user: "Download cancelled.",
  page_closed: "The transfer page was closed before the download finished. Retry to download again.",
  download_interrupted: "Chrome interrupted the download. The file may be incomplete; retry to download again.",
  outcome_unknown: "The download outcome is unknown. Check Chrome's downloads list, or retry.",
  not_a_file: "This resource opens as a Moodle page, not a file. Open it in Moodle.",
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
  if (d.format !== "pdf" || !(PLUGINFILE.test(d.url) || RESOURCE_VIEW.test(d.url)) || new URL(d.url).origin !== SDU_ORIGIN) return { ok: false, reason: "unsupported_type" };
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
      return { ok: false, reason: "sign_in_required" }; // HTML in place of a file is never saved
    }
    if (kind !== "file") return await fail(response, type.startsWith("text/") ? "not_a_file" : "unsupported_type");
    if (type.startsWith("text/")) return await fail(response, "sign_in_required");
    if (type !== "application/pdf") return await fail(response, "unsupported_type");
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
    if (looksLikeHtml(bytes)) return { ok: false, reason: "sign_in_required" };
    if (!isPdf(bytes)) return { ok: false, reason: "unsupported_type" };
    // The name comes from the final response's Content-Disposition or the stored metadata,
    // always through the sanitizer; the final URL path is never used.
    const filename = sanitizeFilename(dispositionName(response.headers.get("content-disposition")) ?? d.suggestedName, d.materialId);
    return { ok: true, blob: new Blob([bytes], { type: "application/pdf" }), filename, size };
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
  const end = async (state: State, reason?: Reason, text?: string): Promise<View> => {
    finished = true;
    const message = text ?? (state === "complete" ? "Downloaded. This is a download record; the file may later be moved or removed." : REASON_TEXT[reason ?? "outcome_unknown"]);
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
    view({ phase: "validating", message: "Waiting for Moodle to be free…" });
    const got = await acquire(d, { fetcher: deps.fetcher, signal: user.signal, lease: deps.lease,
      ...(deps.parseHtml ? { parseHtml: deps.parseHtml } : {}),
      onProgress: (bytes, total) => view({ phase: "validating", message: "Reading from Moodle…", bytes, total }) });
    if (!got.ok) {
      if (deps.closed.aborted) return await end(got.reason === "cancelled_by_user" ? "interrupted" : "failed", "page_closed");
      if (got.reason === "cancelled_by_user") return await end("cancelled", "cancelled_by_user");
      // Worker restart: the lease port dropped, the fetch was aborted, nothing was saved.
      if (got.leaseLost) return await end("interrupted", "download_interrupted", LEASE_LOST_TEXT);
      return await end("failed", got.reason, got.busy ? BUSY_TEXT : undefined);
    }
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
