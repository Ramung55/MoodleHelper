// @vitest-environment jsdom
import { MIME, REASON_TEXT, acquire, dispositionName, isPdf, ooxmlType, runTransfer, sanitizeFilename, type Descriptor, type DownloadDelta, type LeaseRequester, type Transfer } from "../extension/src/material-transfer";
import { DOCX_MIME, DOCX_NAMES, PPTX_MIME, docx, epub, pptx, zip } from "./ooxml-fixtures";
import { openTransferPage } from "../extension/src/dashboard-bridge";

// Authorized synthetic fixture transport only: injected in-process, never a page/query toggle.
const URL_OK = "https://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/lecture-1.pdf";
const desc = (over: Partial<Descriptor> = {}): Descriptor => ({ transferId: "t1", generation: 1, attemptId: "a1", materialId: "m-pdf", url: URL_OK, format: "pdf", suggestedName: "Lecture 1", maxBytes: 1024, timeoutMs: 1000, ...over });
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n%%EOF");
// The login page is recognised only by #20's <body id="page-login-index">, never by its text.
const LOGIN = new TextEncoder().encode('<!doctype html><html><body id="page-login-index" class="lang-ru"><form id=login>Log in</form></body></html>');
function res(body: Uint8Array | null, init: { status?: number; type?: string; headers?: Record<string, string>; url?: string; redirected?: boolean } = {}) {
  const r = new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "application/pdf", ...(init.headers ?? {}) } });
  Object.defineProperty(r, "url", { value: init.url ?? URL_OK });
  if (init.redirected) Object.defineProperty(r, "redirected", { value: true });
  return r;
}
/** A lease that is always granted at once; the #20 lease protocol itself is checked in material-transfer-lease.test.ts. */
const grant: LeaseRequester = async () => ({ ok: true, lease: { lost: new AbortController().signal, settle: () => {} } });
const run = (r: Response | (() => Promise<Response>), d = desc(), signal = new AbortController().signal) =>
  acquire(d, { fetcher: typeof r === "function" ? r : async () => r, signal, lease: grant });

describe("#41 bounded acquisition", () => {
  it("accepts a valid PDF with exact read-only browser-session request", async () => {
    let init: RequestInit | undefined;
    const got = await acquire(desc(), { fetcher: async (_u, i) => { init = i; return res(PDF); }, signal: new AbortController().signal, lease: grant });
    expect(got).toMatchObject({ ok: true, filename: "Lecture 1.pdf", size: PDF.length });
    expect(init).toMatchObject({ method: "GET", credentials: "include", redirect: "follow", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(init!.headers).toBeUndefined();
  });
  it("login HTML (body#page-login-index) yields sign-in guidance; a PDF-typed non-%PDF- body is unsupported, never a file", async () => {
    expect(await run(res(LOGIN, { type: "text/html" }))).toEqual({ ok: false, reason: "sign_in_required" });
    expect(await run(res(LOGIN, { headers: { "content-disposition": 'attachment; filename="lecture.pdf"' } }))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(await run(res(LOGIN, { type: "text/html", redirected: true, url: "https://moodle.sdu.edu.kz/login/index.php" }))).toEqual({ ok: false, reason: "sign_in_required" });
    expect(await run(res(PDF, { status: 401 }))).toEqual({ ok: false, reason: "sign_in_required" });
  });
  it("network errors are reported as network", async () => {
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
      expect(await acquire(desc({ url }), { fetcher: async () => { called = true; return res(PDF); }, signal: new AbortController().signal, lease: grant })).toEqual({ ok: false, reason: "unsupported_type" });
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
    expect(await acquire(desc({ timeoutMs: 20 }), { fetcher: hang, signal: new AbortController().signal, lease: grant })).toEqual({ ok: false, reason: "timeout" });
    const c = new AbortController();
    const p = acquire(desc(), { fetcher: hang, signal: c.signal, lease: grant }); c.abort();
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
    expect(isPdf(PDF)).toBe(true);
    expect(isPdf(new TextEncoder().encode("﻿  <html>"))).toBe(false);
  });
});

function harness(opts: { body?: Uint8Array; type?: string; cancelAt?: "validating" | "saving"; chrome?: "complete" | "interrupted" | "user_cancel" | "none" | "already"; backendDown?: boolean; descriptor?: Descriptor } = {}) {
  const reports: any[] = [];
  let transfer: Transfer = { transferId: "t1", generation: 1, materialId: "m-pdf", state: "queued", cancelRequested: false };
  const listeners = new Set<(d: DownloadDelta) => void>();
  const created: string[] = [], revoked: string[] = [], downloaded: any[] = [], cancelled: number[] = [], blobTypes: string[] = [];
  let failReports = false;
  const emit = (d: DownloadDelta) => listeners.forEach((f) => f(d));
  const api = {
    descriptor: async () => opts.descriptor ?? desc(),
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
    api, downloads, lease: grant, fetcher: async () => res(opts.body ?? PDF, { type: opts.type ?? "application/pdf" }),
    blobs: { create: (b) => { created.push("blob:1"); blobTypes.push(b.type); return "blob:1"; }, revoke: (u) => revoked.push(u) },
    render: (v) => views.push(v), pollMs: 2, closed: closed.signal,
  });
  return { go, reports, created, revoked, downloaded, cancelled, views, closed, blobTypes };
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
    expect(v.message).toContain("Sign in to SDU Moodle in Chrome");
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

// ---- #85 DOCX and PPTX (owner decision 2026-11-03); ZIP fixtures are synthetic, built in test code ----
const enc = new TextEncoder();
const OFFICE_URL = "https://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/notes.docx";
const ddesc = (format: "docx" | "pptx", over: Partial<Descriptor> = {}) => desc({ format, materialId: "m-" + format, suggestedName: "Week 1", maxBytes: 4096, url: OFFICE_URL, ...over });
const office = (format: "docx" | "pptx", body: Uint8Array, init: Parameters<typeof res>[1] = {}, d = ddesc(format)) =>
  run(res(body, { type: format === "docx" ? DOCX_MIME : PPTX_MIME, url: OFFICE_URL, ...init }), d);
const unsupported = { ok: false, reason: "unsupported_type" };
const cutCentral = () => {
  // Drop the last 20 bytes of the central directory and keep the EOCD as it was.
  const z = docx(), cut = 20, out = new Uint8Array(z.length - cut);
  out.set(z.subarray(0, z.length - 22 - cut));
  out.set(z.subarray(z.length - 22), z.length - 22 - cut);
  return out;
};

describe("#85 OOXML container check (ooxmlType)", () => {
  it("accepts a minimal stored DOCX and PPTX, also with an EOCD comment", () => {
    expect(ooxmlType(docx())).toBe("docx");
    expect(ooxmlType(pptx())).toBe("pptx");
    expect(ooxmlType(docx({ comment: enc.encode("PK\u0005\u0006 inside a comment") }))).toBe("docx");
    // a view into a larger buffer (non-zero byteOffset) is read through its own bounds
    const z = docx(), wrapped = new Uint8Array(z.length + 9);
    wrapped.set(z, 5);
    expect(ooxmlType(wrapped.subarray(5, 5 + z.length))).toBe("docx");
  });
  it.each<[string, () => Uint8Array]>([
    ["an empty body", () => new Uint8Array()],
    ["a PK\\x03\\x04-only body", () => new Uint8Array([0x50, 0x4b, 3, 4])],
    ["21 bytes", () => docx().subarray(0, 21)],
    ["a PDF", () => PDF],
    ["an EPUB (mimetype entry, no [Content_Types].xml)", epub],
    ["a plain ZIP without [Content_Types].xml", () => zip(["readme.txt", "word/document.xml"])],
    ["[Content_Types].xml alone", () => zip(["[Content_Types].xml"])],
    ["[Content_Types].xml twice", () => zip(["[Content_Types].xml", "[Content_Types].xml", "word/document.xml"])],
    ["word/document.xml twice", () => zip(["[Content_Types].xml", "word/document.xml", "word/document.xml"])],
    ["both word/document.xml and ppt/presentation.xml", () => zip([...DOCX_NAMES, "ppt/presentation.xml"])],
    ["a different-case main part", () => zip(["[Content_Types].xml", "Word/document.xml"])],
    ["the EOCD cut off", () => docx().subarray(0, docx().length - 5)],
    ["the central directory cut short", cutCentral],
    ["bytes after the EOCD", () => docx({ trailing: new Uint8Array([0, 0]) })],
    ["prefix bytes before the first local header", () => docx({ prefix: enc.encode("junk") })],
    ["a ZIP64 entry count", () => docx({ eocd: { total: 0xffff, onDisk: 0xffff } })],
    ["a ZIP64 central directory offset", () => docx({ eocd: { cdOffset: 0xffffffff } })],
    ["a multi-disk EOCD", () => docx({ eocd: { disk: 1 } })],
    ["a central directory on another disk", () => docx({ eocd: { cdDisk: 1 } })],
    ["entries-on-disk different from total", () => docx({ eocd: { onDisk: 3 } })],
    ["zero entries", () => docx({ eocd: { total: 0, onDisk: 0 } })],
    ["more than 10,000 entries declared", () => docx({ eocd: { total: 10_001, onDisk: 10_001 } })],
    ["fewer entries declared than present", () => docx({ eocd: { total: 3, onDisk: 3 } })],
    ["more entries declared than present", () => docx({ eocd: { total: 5, onDisk: 5 } })],
    ["a central directory size that does not reach the EOCD", () => { const z = docx(); return docx({ eocd: { cdSize: new DataView(z.buffer).getUint32(z.length - 10, true) - 1 } }); }],
    ["a central offset past the EOCD", () => docx({ eocd: { cdOffset: 0x7fffffff } })],
    ["a required local header offset pointing at junk", () => docx({ junkLocal: ["word/document.xml"] })],
    ["a [Content_Types].xml local header pointing at junk", () => pptx({ junkLocal: ["[Content_Types].xml"] })],
    ["a local name that differs from the central name", () => docx({ renameLocal: { "word/document.xml": "word/document.xmL" } })],
    ["an encrypted required entry", () => docx({ encrypt: ["word/document.xml"] })],
    ["an encrypted other entry", () => pptx({ encrypt: ["ppt/slides/slide1.xml"] })],
  ])("rejects %s", (_name, body) => expect(ooxmlType(body())).toBeNull());
  it("never throws on malformed or random input", () => {
    let seed = 85;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const base = docx();
    for (let i = 0; i < 400; i++) {
      const mutated = base.slice(0, Math.floor(rand() * (base.length + 1)));
      for (let j = 0; j < 4; j++) if (mutated.length) mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
      expect(() => ooxmlType(mutated)).not.toThrow();
      const noise = new Uint8Array(Math.floor(rand() * 300)).map(() => Math.floor(rand() * 256));
      if (noise.length >= 4) noise.set([0x50, 0x4b, 3, 4]);
      expect(() => ooxmlType(noise)).not.toThrow();
      expect(ooxmlType(noise)).toBeNull();
    }
  });
});

describe("#85 DOCX/PPTX acquisition", () => {
  it.each(["docx", "pptx"] as const)("saves a valid %s with its MIME type and the validated extension", async (format) => {
    const got = await office(format, format === "docx" ? docx() : pptx());
    expect(got).toMatchObject({ ok: true, filename: `Week 1.${format}` });
    expect(got.ok && got.blob.type).toBe(MIME[format]);
  });
  it("tolerates application/octet-stream only together with the full container check", async () => {
    expect(await office("docx", docx(), { type: "application/octet-stream" })).toMatchObject({ ok: true, filename: "Week 1.docx" });
    expect(await office("pptx", pptx(), { type: "application/octet-stream; charset=binary" })).toMatchObject({ ok: true, filename: "Week 1.pptx" });
    expect(await office("docx", epub(), { type: "application/octet-stream" })).toEqual(unsupported);
    expect(await office("pptx", PDF, { type: "application/octet-stream" })).toEqual(unsupported);
    expect(await office("docx", zip(["readme.txt"]), { type: "application/octet-stream" })).toEqual(unsupported);
    expect(await run(res(PDF, { type: "application/octet-stream" }))).toEqual(unsupported); // never for a PDF
  });
  it("refuses any other content type", async () => {
    for (const type of ["application/zip", "application/epub+zip", "application/pdf", "", "text/plain", "text/xml", PPTX_MIME]) {
      expect(await office("docx", docx(), { type })).toEqual(unsupported);
    }
    expect(await office("pptx", pptx(), { type: DOCX_MIME })).toEqual(unsupported);
  });
  it("the validated type must equal the listed format: a DOCX for a pptx badge and the reverse are refused, never renamed", async () => {
    expect(await office("pptx", docx())).toEqual(unsupported);
    expect(await office("docx", pptx())).toEqual(unsupported);
    expect(await office("pptx", docx(), { type: "application/octet-stream" })).toEqual(unsupported);
    expect(await office("docx", PDF)).toEqual(unsupported);
    expect(await run(res(docx(), { type: "application/pdf" }))).toEqual(unsupported);
    expect(await run(res(docx(), { type: DOCX_MIME }))).toEqual(unsupported);
  });
  it.each<[string, () => Uint8Array]>([
    ["EPUB", epub], ["plain ZIP", () => zip(["readme.txt"])], ["both parts", () => zip([...DOCX_NAMES, "ppt/presentation.xml"])],
    ["EOCD cut off", () => docx().subarray(0, docx().length - 3)], ["central directory cut short", cutCentral],
    ["prefix bytes", () => docx({ prefix: new Uint8Array([1, 2, 3]) })],
    ["ZIP64", () => docx({ eocd: { total: 0xffff, onDisk: 0xffff } })], ["multi-disk", () => docx({ eocd: { disk: 2 } })],
    ["junk local header", () => docx({ junkLocal: ["word/document.xml"] })], ["PK\\x03\\x04 only", () => new Uint8Array([0x50, 0x4b, 3, 4])],
    ["empty", () => new Uint8Array()],
  ])("a %s body with a DOCX content type is unsupported_type", async (_n, body) => {
    expect(await office("docx", body())).toEqual(unsupported);
  });
  it("an HTML login page labelled as a docx: sign-in on /login/index.php, unsupported_type on pluginfile.php", async () => {
    expect(await office("docx", LOGIN, { url: "https://moodle.sdu.edu.kz/login/index.php", redirected: true })).toEqual({ ok: false, reason: "sign_in_required" });
    expect(await office("docx", LOGIN)).toEqual(unsupported);
    expect(await office("pptx", LOGIN, { type: "text/html" })).toEqual({ ok: false, reason: "sign_in_required" }); // body#page-login-index
    expect(await office("pptx", pptx(), { status: 401 })).toEqual({ ok: false, reason: "sign_in_required" });
  });
  it("enforces declared and streamed bounds", async () => {
    expect(await office("docx", docx(), { headers: { "content-length": "5000" } })).toEqual({ ok: false, reason: "too_large" });
    expect(await office("pptx", pptx({ comment: new Uint8Array(4500) }))).toEqual({ ok: false, reason: "too_large" });
  });
  it("status outcomes match #41", async () => {
    expect(await office("docx", docx(), { status: 403 })).toEqual({ ok: false, reason: "forbidden" });
    expect(await office("docx", docx(), { status: 404 })).toEqual({ ok: false, reason: "not_found" });
    expect(await office("pptx", pptx(), { status: 410 })).toEqual({ ok: false, reason: "not_found" });
    expect(await office("pptx", pptx(), { status: 503, type: "text/html" })).toEqual({ ok: false, reason: "network", busy: true });
  });
  it("names the file from Content-Disposition or the title, always with the validated extension", async () => {
    expect(await office("pptx", pptx(), { headers: { "content-disposition": 'attachment; filename="Slides.PPTX"' } })).toMatchObject({ ok: true, filename: "Slides.pptx" });
    expect(await office("pptx", pptx(), {}, ddesc("pptx", { suggestedName: "Week 1.pdf" }))).toMatchObject({ ok: true, filename: "Week 1.pptx" });
    expect(await office("docx", docx(), { headers: { "content-disposition": 'attachment; filename="../evil.docx.exe"' } })).toMatchObject({ ok: true, filename: "evil.docx.exe.docx" });
    expect(await office("docx", docx(), {}, ddesc("docx", { suggestedName: "" }))).toMatchObject({ ok: true, filename: "moodle-material-m-docx.docx" });
  });
  it("refuses an unknown format (EPUB) before any request", async () => {
    let called = false;
    const got = await acquire({ ...ddesc("docx"), format: "epub" as never }, { fetcher: async () => { called = true; return res(epub()); }, signal: new AbortController().signal, lease: grant });
    expect(got).toEqual(unsupported);
    expect(called).toBe(false);
  });
  it("the unsupported_type text names the allowed types", () => {
    expect(REASON_TEXT.unsupported_type).toBe("Moodle did not return a valid PDF, DOCX or PPTX file of the listed type. Nothing was saved.");
  });
});

describe("#85 safe filenames per extension", () => {
  const cases: [string | undefined, string][] = [
    [undefined, "moodle-material-m-pdf"], ["", "moodle-material-m-pdf"], ["../../etc/passwd", "passwd"], ["C:\\Windows\\evil.exe", "evil.exe"],
    ["CON", "moodle-material-m-pdf"], ["lpt1.pptx", "moodle-material-m-pdf"], ["nul.docx", "moodle-material-m-pdf"], ["..", "moodle-material-m-pdf"],
    [".hidden.docx", "hidden"], ["a\u0000b\u202Ec.pptx", "abc"], ["Лекция 1", "Лекция 1"], ["x".repeat(400), "x".repeat(120)],
    ["bad\uD800name", "badname"], ['a<b>:"|?*.docx', "ab"], ["Week 1.pdf", "Week 1"], ["Week 1.DOCX", "Week 1"], ["Week 1.PpTx", "Week 1"],
    ["deck.pptx.pptx", "deck.pptx"],
  ];
  for (const ext of ["pdf", "docx", "pptx"] as const) {
    it.each(cases)(`%j -> %j.${ext}`, (input, stem) => expect(sanitizeFilename(input, "m-pdf", ext)).toBe(`${stem}.${ext}`));
  }
});

describe("#85 transfer state machine for DOCX and PPTX", () => {
  it.each(["docx", "pptx"] as const)("a %s goes validating -> saving -> complete with the validated name and MIME type", async (format) => {
    const h = harness({ chrome: "complete", descriptor: ddesc(format, { maxBytes: 1 << 20 }), body: format === "docx" ? docx() : pptx(), type: MIME[format] });
    const v = await h.go();
    expect(h.reports.map((r) => r.state)).toEqual(["validating", "saving", "complete"]);
    expect(h.downloaded).toEqual([{ url: "blob:1", filename: `Week 1.${format}`, conflictAction: "uniquify", saveAs: false }]);
    expect(h.blobTypes).toEqual([MIME[format]]);
    expect(v.phase).toBe("complete");
    expect(v.message).toContain("download record");
  });
  it("a DOCX for a pptx badge never reaches Chrome and ends failed/unsupported_type", async () => {
    const h = harness({ chrome: "complete", descriptor: ddesc("pptx", { maxBytes: 1 << 20 }), body: docx(), type: "application/octet-stream" });
    const v = await h.go();
    expect(h.downloaded).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.reports.at(-1)).toMatchObject({ state: "failed", reason: "unsupported_type" });
    expect(v.message).toBe(REASON_TEXT.unsupported_type);
  });
});
