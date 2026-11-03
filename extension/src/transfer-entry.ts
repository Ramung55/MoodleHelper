/** Packaged visible transfer page bootstrap (#41). Transfer ID comes only from this page's own hash. */
import { BACKEND } from "./dashboard-bridge";
import { leaseRequester, runTransfer, type DownloadsApi, type LeaseClientPort, type View } from "./material-transfer";
import { TRANSFER_LEASE_PORT } from "./moodle-request-authority";

declare const chrome: { downloads: { download(o: object, cb: (id: number) => void): void; cancel(id: number, cb: () => void): void; search(q: object, cb: (items: any[]) => void): void; onChanged: DownloadsApi["onChanged"] }; runtime: { lastError?: unknown; connect(info: { name: string }): LeaseClientPort } };

const PHASE: Record<View["phase"], string> = { starting: "Starting", queued: "Queued", validating: "Validating", saving: "Saving", complete: "Downloaded", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", unrecorded: "Outcome not yet recorded" };
function render(v: View) {
  document.getElementById("phase")!.textContent = PHASE[v.phase];
  document.getElementById("message")!.textContent = v.message;
  const bar = document.getElementById("progress") as HTMLProgressElement;
  bar.hidden = !(v.phase === "validating" || v.phase === "saving");
  if (v.total) { bar.max = v.total; bar.value = v.bytes ?? 0; } else bar.removeAttribute("value"); // unknown length: indeterminate
  document.getElementById("detail")!.textContent = [v.bytes !== undefined ? `${v.bytes} bytes read` : "", v.filename ? `Saving as ${v.filename}` : ""].filter(Boolean).join(" · ");
}
const call = <T>(f: (cb: (v: T) => void) => void) => new Promise<T>((ok, no) => f((v) => (chrome.runtime.lastError ? no(chrome.runtime.lastError) : ok(v))));
const downloads: DownloadsApi = {
  download: (o) => call<number>((cb) => chrome.downloads.download(o, cb)),
  cancel: (id) => call<void>((cb) => chrome.downloads.cancel(id, cb)),
  search: (q) => call<any[]>((cb) => chrome.downloads.search(q, cb)),
  onChanged: chrome.downloads.onChanged,
};
let binding: string | undefined;
async function backend(path: string, method = "GET", body?: unknown, keepalive = false) {
  // While the tab is closing, the last known binding is reused so the outcome goes out as one
  // keepalive request; a refused reply drops it and the next try rereads the context.
  const known = keepalive ? binding : undefined;
  binding = known ?? String((await (await fetch(BACKEND + "/api/bridge-context", { credentials: "omit", redirect: "error" })).json()).binding);
  const r = await fetch(BACKEND + path, { method, credentials: "omit", redirect: "error", keepalive,
    headers: { Accept: "application/json", "X-Moodle-Helper-Bridge-Binding": binding, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) { if (known) binding = undefined; throw new Error("backend " + r.status); }
  return r.json();
}
const id = location.hash.slice(1);
const closed = new AbortController();
window.addEventListener("pagehide", () => closed.abort(), { once: true });
if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) render({ phase: "failed", message: "No transfer was selected. Start a download from the dashboard." });
else void runTransfer(id, {
  api: {
    descriptor: (t) => backend(`/api/material-downloads/${t}/descriptor`, "POST"),
    read: (t) => backend(`/api/material-downloads/${t}`),
    report: (t, b) => backend(`/api/material-downloads/${t}/status`, "POST", b, closed.signal.aborted),
  },
  fetcher: (u, i) => fetch(u, i), downloads,
  // #20 authority lease over a port to this extension's worker; closing the tab drops the port and releases it.
  lease: leaseRequester(() => chrome.runtime.connect({ name: TRANSFER_LEASE_PORT })),
  parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
  blobs: { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
  render, closed: closed.signal,
});
