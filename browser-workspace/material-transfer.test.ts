import { acquire, dispositionName, looksLikeHtml, runTransfer, sanitizeFilename, type Descriptor, type DownloadDelta, type Transfer } from "../extension/src/material-transfer";
import { openTransferPage } from "../extension/src/dashboard-bridge";

// Authorized synthetic fixture transport only: injected in-process, never a page/query toggle.
const URL_OK = "https://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/lecture-1.pdf";
const desc = (over: Partial<Descriptor> = {}): Descriptor => ({ transferId: "t1", generation: 1, attemptId: "a1", materialId: "m-pdf", url: URL_OK, format: "pdf", suggestedName: "Lecture 1", maxBytes: 1024, timeoutMs: 1000, ...over });
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n%%EOF");
const LOGIN = new TextEncoder().encode("<!doctype html><html><form id=login>Log in</form></html>");
function res(body: Uint8Array | null, init: { status?: number; type?: string; headers?: Record<string, string>; url?: string; redirected?: boolean } = {}) {
  const r = new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "application/pdf", ...(init.headers ?? {}) } });
  Object.defineProperty(r, "url", { value: init.url ?? URL_OK });
  if (init.redirected) Object.defineProperty(r, "redirected", { value: true });
  return r;
}
const run = (r: Response | (() => Promise<Response>), d = desc(), signal = new AbortController().signal) =>
  acquire(d, { fetcher: typeof r === "function" ? r : async () => r, signal });

describe("#41 bounded acquisition", () => {
  it("accepts a valid PDF with exact read-only browser-session request", async () => {
    let init: RequestInit | undefined;
    const got = await acquire(desc(), { fetcher: async (_u, i) => { init = i; return res(PDF); }, signal: new AbortController().signal });
    expect(got).toMatchObject({ ok: true, filename: "Lecture 1.pdf", size: PDF.length });
    expect(init).toMatchObject({ method: "GET", credentials: "include", redirect: "error" });
    expect(init!.headers).toBeUndefined();
  });
  it("login HTML with 200 and PDF disguise yields sign-in guidance, never a file", async () => {
    expect(await run(res(LOGIN, { type: "text/html" }))).toEqual({ ok: false, reason: "sign_in_required" });
    expect(await run(res(LOGIN, { headers: { "content-disposition": 'attachment; filename="lecture.pdf"' } }))).toEqual({ ok: false, reason: "sign_in_required" });
    expect(await run(res(PDF, { redirected: true }))).toEqual({ ok: false, reason: "sign_in_required" });
    expect(await run(res(PDF, { status: 401 }))).toEqual({ ok: false, reason: "sign_in_required" });
  });
  it("redirect refusal and network errors are reported without claiming a destination", async () => {
    expect(await run(() => Promise.reject(new TypeError("Failed to fetch")))).toEqual({ ok: false, reason: "network" });
  });
  it("distinguishes forbidden, not found and MIME/signature mismatch", async () => {
    expect(await run(res(PDF, { status: 403 }))).toEqual({ ok: false, reason: "forbidden" });
    expect(await run(res(PDF, { status: 404 }))).toEqual({ ok: false, reason: "not_found" });
    expect(await run(res(PDF, { type: "application/octet-stream" }))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(await run(res(new TextEncoder().encode("PK\u0003\u0004zip")))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(await run(res(new Uint8Array()))).toEqual({ ok: false, reason: "unsupported_type" });
  });
  it("refuses non-exact destinations before any fetch", async () => {
    let called = false;
    for (const url of ["https://evil.example/pluginfile.php/1/mod_resource/content/1/a.pdf", URL_OK + "?token=1", "http://moodle.sdu.edu.kz/pluginfile.php/1/mod_resource/content/1/a.pdf"]) {
      expect(await acquire(desc({ url }), { fetcher: async () => { called = true; return res(PDF); }, signal: new AbortController().signal })).toEqual({ ok: false, reason: "unsupported_type" });
    }
    expect(called).toBe(false);
  });
  it("enforces declared and streamed size bounds", async () => {
    expect(await run(res(PDF, { headers: { "content-length": "4096" } }))).toEqual({ ok: false, reason: "too_large" });
    const big = new Uint8Array(2048); big.set(PDF);
    expect(await run(res(big, { headers: { "content-length": "10" } }))).toEqual({ ok: false, reason: "too_large" });
    expect(await run(res(big))).toEqual({ ok: false, reason: "too_large" });
  });
  it("times out and cancels without partial success", async () => {
    const hang = (_u: string, i: RequestInit) => new Promise<Response>((_ok, no) => i.signal!.addEventListener("abort", () => no(new DOMException("abort", "AbortError"))));
    expect(await acquire(desc({ timeoutMs: 20 }), { fetcher: hang, signal: new AbortController().signal })).toEqual({ ok: false, reason: "timeout" });
    const c = new AbortController();
    const p = acquire(desc(), { fetcher: hang, signal: c.signal }); c.abort();
    expect(await p).toEqual({ ok: false, reason: "cancelled_by_user" });
  });
  it("uses a safe Content-Disposition name including Russian", async () => {
    const got = await run(res(PDF, { headers: { "content-disposition": "attachment; filename*=UTF-8''%D0%9B%D0%B5%D0%BA%D1%86%D0%B8%D1%8F%201.pdf" } }));
    expect(got).toMatchObject({ ok: true, filename: "Лекция 1.pdf" });
  });
});

describe("#41 safe filenames", () => {
  it.each([
    [undefined, "moodle-material-m-pdf.pdf"], ["", "moodle-material-m-pdf.pdf"], ["   ", "moodle-material-m-pdf.pdf"],
    ["../../etc/passwd", "passwd.pdf"], ["C:\\Windows\\evil.exe", "evil.exe.pdf"], ["CON", "moodle-material-m-pdf.pdf"], ["lpt1.pdf", "moodle-material-m-pdf.pdf"],
    ["..", "moodle-material-m-pdf.pdf"], [".hidden.pdf", "hidden.pdf"], ["a\u0000b\u202Ec.pdf", "abc.pdf"], ["Лекция 1", "Лекция 1.pdf"],
    ["report.PDF", "report.pdf"], ["x".repeat(400), "x".repeat(120) + ".pdf"], ["bad\uD800name", "badname.pdf"], ['a<b>:"|?*.pdf', "ab.pdf"],
  ])("%j -> %j", (input, out) => expect(sanitizeFilename(input as string | undefined, "m-pdf")).toBe(out));
  it("parses bounded dispositions only", () => {
    expect(dispositionName('attachment; filename="a.pdf"')).toBe("a.pdf");
    expect(dispositionName("x".repeat(2000))).toBeUndefined();
    expect(looksLikeHtml(PDF)).toBe(false);
    expect(looksLikeHtml(new TextEncoder().encode("\uFEFF  <html>"))).toBe(true);
  });
});

function harness(opts: { body?: Uint8Array; type?: string; cancelAt?: "validating" | "saving"; chrome?: "complete" | "interrupted" | "user_cancel" | "none" | "already"; backendDown?: boolean } = {}) {
  const reports: any[] = [];
  let transfer: Transfer = { transferId: "t1", generation: 1, materialId: "m-pdf", state: "queued", cancelRequested: false };
  const listeners = new Set<(d: DownloadDelta) => void>();
  const created: string[] = [], revoked: string[] = [], downloaded: any[] = [], cancelled: number[] = [];
  let failReports = false;
  const emit = (d: DownloadDelta) => listeners.forEach((f) => f(d));
  const api = {
    descriptor: async () => desc(),
    read: async () => transfer,
    report: async (_id: string, b: any) => {
      if (failReports && ["complete", "failed", "cancelled", "interrupted"].includes(b.state)) throw new Error("down");
      reports.push(b);
      transfer = { ...transfer, state: b.state, generation: transfer.generation + 1, cancelRequested: transfer.cancelRequested || (opts.cancelAt === b.state) };
      if (b.state === "saving" && opts.backendDown) failReports = true;
      if (b.state === "saving" && opts.chrome === "complete") setTimeout(() => emit({ id: 9, state: { current: "complete" } }), 5);
      if (b.state === "saving" && opts.chrome === "interrupted") setTimeout(() => emit({ id: 9, state: { current: "interrupted" }, error: { current: "NETWORK_FAILED" } }), 5);
      if (b.state === "saving" && opts.chrome === "user_cancel") setTimeout(() => { emit({ id: 8, state: { current: "complete" } }); emit({ id: 9, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } }); }, 5);
      return transfer;
    },
  };
  const downloads = {
    download: async (o: any) => { downloaded.push(o); return 9; },
    cancel: async (id: number) => { cancelled.push(id); setTimeout(() => emit({ id, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } }), 1); },
    search: async ({ id }: { id: number }) => (opts.chrome === "already" ? [{ id, state: "complete" }] : []),
    onChanged: { addListener: (f: any) => listeners.add(f), removeListener: (f: any) => listeners.delete(f) },
  };
  const closed = new AbortController();
  const views: any[] = [];
  const go = () => runTransfer("t1", {
    api, downloads, fetcher: async () => res(opts.body ?? PDF, { type: opts.type ?? "application/pdf" }),
    blobs: { create: () => { created.push("blob:1"); return "blob:1"; }, revoke: (u) => revoked.push(u) },
    render: (v) => views.push(v), pollMs: 2, closed: closed.signal,
  });
  return { go, reports, created, revoked, downloaded, cancelled, views, closed };
}

describe("#41 transfer state machine", () => {
  it("download ID is not completion; complete only from matching Chrome state", async () => {
    const h = harness({ chrome: "complete" });
    const v = await h.go();
    expect(h.reports.map((r) => r.state)).toEqual(["validating", "saving", "complete"]);
    expect(h.reports[1]).toMatchObject({ downloadId: 9, attemptId: "a1" });
    expect(h.reports[2]).toMatchObject({ state: "complete", downloadId: 9 });
    expect(h.downloaded).toEqual([{ url: "blob:1", filename: "Lecture 1.pdf", conflictAction: "uniquify", saveAs: false }]);
    expect(v.phase).toBe("complete");
    expect(v.message).toContain("download record");
    expect(h.revoked).toEqual(["blob:1"]);
  });
  it("reconciles a download that finished before the listener saw it by its known ID", async () => {
    expect((await harness({ chrome: "already" }).go()).phase).toBe("complete");
  });
  it("login page never reaches Chrome downloads", async () => {
    const h = harness({ body: LOGIN, type: "text/html" });
    const v = await h.go();
    expect(h.downloaded).toEqual([]);
    expect(h.reports.at(-1)).toMatchObject({ state: "failed", reason: "sign_in_required" });
    expect(v.message).toContain("Sign in to Moodle");
  });
  it("Chrome interruption and user cancel are distinct, unrelated IDs ignored", async () => {
    expect((await harness({ chrome: "interrupted" }).go()).phase).toBe("interrupted");
    const h = harness({ chrome: "user_cancel" });
    expect((await h.go()).phase).toBe("cancelled");
    expect(h.reports.at(-1)).toMatchObject({ state: "cancelled", reason: "cancelled_by_user" });
  });
  it("cancel during saving cancels only the owned download ID", async () => {
    const h = harness({ cancelAt: "saving", chrome: "none" });
    const v = await h.go();
    expect(h.cancelled).toEqual([9]);
    expect(v.phase).toBe("cancelled");
    expect(h.revoked).toEqual(["blob:1"]);
  });
  it("page close before dispatch creates no download and reports interrupted", async () => {
    const h = harness({ chrome: "none" });
    h.closed.abort();
    const v = await h.go();
    expect(h.downloaded).toEqual([]);
    expect(v.phase).toBe("interrupted");
    expect(h.reports.at(-1)).toMatchObject({ reason: "page_closed" });
  });
  it("backend loss after Chrome completion says outcome not yet recorded, never restarts", async () => {
    const h = harness({ chrome: "complete", backendDown: true });
    const v = await h.go();
    expect(v.phase).toBe("unrecorded");
    expect(v.message).toContain("not yet recorded");
    expect(h.downloaded).toHaveLength(1);
  });
});

describe("#41 worker opens one visible transfer page per new transfer", () => {
  it("opens once and ignores repeats, unsupported and non-download results", () => {
    const tabs: any[] = [];
    const api = { runtime: { getURL: (p: string) => "chrome-extension://x/" + p }, tabs: { create: (o: any) => tabs.push(o) } };
    const r = { supported: true, message: "", transfer: { transferId: "tx-1", state: "queued" } };
    expect(openTransferPage(api, "startMaterialDownload", r)).toBe(true);
    expect(openTransferPage(api, "startMaterialDownload", r)).toBe(false);
    expect(openTransferPage(api, "startMaterialDownload", { supported: false, message: "" })).toBe(false);
    expect(openTransferPage(api, "load", r)).toBe(false);
    expect(tabs).toEqual([{ url: "chrome-extension://x/transfer.html#tx-1", active: true }]);
  });
});
