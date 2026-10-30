/** Packaged visible transfer page bootstrap (#41). Transfer ID comes only from this page's own hash. */
import { BACKEND } from "./dashboard-bridge";
import { runTransfer, type DownloadsApi, type View } from "./material-transfer";

declare const chrome: { downloads: { download(o: object, cb: (id: number) => void): void; cancel(id: number, cb: () => void): void; search(q: object, cb: (items: any[]) => void): void; onChanged: DownloadsApi["onChanged"] }; runtime: { lastError?: unknown } };

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
async function backend(path: string, method = "GET", body?: unknown, keepalive = false) {
  const context = await (await fetch(BACKEND + "/api/bridge-context", { credentials: "omit", redirect: "error" })).json();
  const r = await fetch(BACKEND + path, { method, credentials: "omit", redirect: "error", keepalive,
    headers: { Accept: "application/json", "X-Moodle-Helper-Bridge-Binding": String(context.binding), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new Error("backend " + r.status);
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
  blobs: { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
  render, closed: closed.signal,
});
