// @vitest-environment jsdom
/**
 * #41 repo checks for the pilot download path (owner decision 2026-11-02): the transfer
 * page's file GET under a #20 request-authority lease, the followed redirect and the
 * final-URL checks. Moodle is an injected fetch answering with the observed fixtures
 * (tests/fixtures/moodle/observed); the backend gate is an in-process stand-in with
 * the same reserve/release rules as backend/scan_gate.py; time is an injected clock.
 * No real Moodle site, Chrome or account is used.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUSY_TEXT, LEASE_LOST_TEXT, LEASE_WAIT_MS, REASON_TEXT, REQUEST_LIMIT_MS, acquire, leaseRequester, runTransfer,
  type Descriptor, type DownloadDelta, type LeaseClientPort, type LeaseRequester, type Transfer,
} from "../extension/src/material-transfer";
import { LEASE_REQUEST_LIMIT_MS, TRANSFER_LEASE_PORT, createMoodleRequestAuthority, createTransferLeaseHost, type LeasePort, type LeaseSender } from "../extension/src/moodle-request-authority";
import { openTransferPage, transferTabFor } from "../extension/src/dashboard-bridge";

const root = path.resolve(import.meta.dirname, "..");
const observed = (name: string) => readFileSync(path.join(root, "tests/fixtures/moodle/observed", name), "utf8");
const LOGIN_PAGE = observed("login-page.html");
const LOGIN_REDIRECT = JSON.parse(observed("login-redirect-resource.json"));
const RESOURCE_REDIRECT = JSON.parse(observed("resource-redirect.json"));
const ORIGIN = "https://moodle.sdu.edu.kz";
const VIEW = ORIGIN + LOGIN_REDIRECT.request.path; // /mod/resource/view.php?id=990104
const FILE = ORIGIN + RESOURCE_REDIRECT.redirect.locationPath;
const EXT = "chrome-extension://transfer-test/";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n%%EOF");
const pause = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const desc = (over: Partial<Descriptor> = {}): Descriptor => ({ transferId: "tx-1", generation: 1, attemptId: "a1", materialId: "r-pdf", url: VIEW, format: "pdf", suggestedName: "Lecture 1", maxBytes: 1 << 20, timeoutMs: 60_000, ...over });
const parseHtml = (html: string) => new DOMParser().parseFromString(html, "text/html");

type Ev = { event: string; at?: number; detail?: unknown };
/** Moodle answer with a settable final URL; the body stream reports when it has been read to the end. */
function reply(body: Uint8Array | string, init: { status?: number; type?: string | null; url?: string; headers?: Record<string, string> } = {}, log?: Ev[]) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { if (!sent) { sent = true; c.enqueue(bytes); } else { log?.push({ event: "body-read" }); c.close(); } } });
  const type = init.type === undefined ? "application/pdf" : init.type;
  const r = new Response(stream, { status: init.status ?? 200, headers: { ...(type ? { "content-type": type } : {}), ...(init.headers ?? {}) } });
  Object.defineProperty(r, "url", { value: init.url ?? FILE });
  if ((init.url ?? FILE) !== VIEW) Object.defineProperty(r, "redirected", { value: true });
  return r;
}
const grant: LeaseRequester = async () => ({ ok: true, lease: { lost: new AbortController().signal, settle: () => {} } });
const get = (r: () => Response, d = desc()) => acquire(d, { fetcher: async () => r(), signal: new AbortController().signal, lease: grant, parseHtml });

/** In-process stand-in for /api/scan/gate/* with backend/scan_gate.py's rules: one owner, starts >= 1 s apart, not_before never shortened. */
function gate(clock: { now: number }, log: Ev[]) {
  let owner: string | null = null, lastStart = -1e12, notBefore = 0, n = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/bridge-context")) return json({ binding: "b" });
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/api/scan/gate/acquire")) {
      if (owner !== null || body.nowMs < Math.max(notBefore, lastStart + 1000)) return json({ state: "busy" });
      owner = "t" + ++n; lastStart = body.nowMs; log.push({ event: "acquire", at: clock.now });
      return json({ state: "reserved", token: owner });
    }
    if (url.endsWith("/api/scan/gate/release")) {
      if (body.token !== owner) return json({ released: false });
      owner = null; notBefore = Math.max(notBefore, body.notBeforeMs); log.push({ event: "release", at: clock.now, detail: body.notBeforeMs });
      return json({ released: true });
    }
    throw Error("unexpected " + url);
  }) as typeof fetch;
  return { fetcher, held: () => owner !== null, notBefore: () => notBefore };
}

/** chrome.runtime.connect port pair: disconnect() fires onDisconnect only on the other end, as in Chrome. */
function ports(sender: LeaseSender) {
  const toPage = { msg: [] as ((m: any) => void)[], disc: [] as (() => void)[] };
  const toWorker = { msg: [] as ((m: any) => void)[], disc: [] as (() => void)[] };
  let open = true;
  const sent: any[] = [];
  const page: LeaseClientPort = {
    postMessage: (m) => { if (!open) throw Error("closed"); sent.push(structuredClone(m)); const c = structuredClone(m); queueMicrotask(() => toWorker.msg.forEach((f) => f(c))); },
    disconnect: () => { if (open) { open = false; queueMicrotask(() => toWorker.disc.forEach((f) => f())); } },
    onMessage: { addListener: (f) => toPage.msg.push(f) }, onDisconnect: { addListener: (f) => toPage.disc.push(f) },
  };
  const worker: LeasePort = {
    name: TRANSFER_LEASE_PORT, sender,
    postMessage: (m) => { if (open) { const c = structuredClone(m); queueMicrotask(() => toPage.msg.forEach((f) => f(c))); } },
    disconnect: () => { if (open) { open = false; queueMicrotask(() => toPage.disc.forEach((f) => f())); } },
    onMessage: { addListener: (f) => toWorker.msg.push(f) }, onDisconnect: { addListener: (f) => toWorker.disc.push(f) },
  };
  return { page, worker, sent, isOpen: () => open };
}

/** The worker's lease host on the real #20 authority, with an injected clock and gate. */
function worker(opts: { tab?: number; transferId?: string } = {}) {
  const clock = { now: Date.parse("2028-03-05T10:00:00Z") };
  const log: Ev[] = [];
  const g = gate(clock, log);
  const authority = createMoodleRequestAuthority({ base: "http://gate", fetcher: g.fetcher, instance: "worker-1" });
  const tabs = new Map<string, number>([[opts.transferId ?? "tx-1", opts.tab ?? 7]]);
  const host = createTransferLeaseHost({ authority, now: () => clock.now, wait: async (ms) => { clock.now += ms; await pause(); },
    extensionId: "transfer-test", transferPageUrl: EXT + "transfer.html", tabFor: (id) => tabs.get(id) });
  const pageSender = (transferId = "tx-1", tab = 7): LeaseSender => ({ id: "transfer-test", url: EXT + "transfer.html#" + transferId, frameId: 0, tab: { id: tab } });
  let last: ReturnType<typeof ports> | undefined;
  const connect = (sender = pageSender()) => () => { last = ports(sender); host.onConnect(last.worker); return last.page; };
  return { clock, log, gate: g, authority, host, connect, pageSender, port: () => last! };
}

describe("#41 final-URL classification with observed fixtures (AC1, AC3)", () => {
  it("the observed view.php -> pluginfile.php redirect with application/pdf and %PDF- is a file, named only via the sanitizer", async () => {
    const got = await get(() => reply(PDF, { url: FILE, headers: { "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent("../Лекция 1.pdf") } }));
    expect(got).toMatchObject({ ok: true, filename: "Лекция 1.pdf", size: PDF.length });
    const fallback = await get(() => reply(PDF, { url: FILE, headers: { "content-disposition": RESOURCE_REDIRECT.final.contentDisposition } }), desc({ suggestedName: "" }));
    expect(fallback).toMatchObject({ ok: true, filename: "moodle-material-r-pdf.pdf" }); // never fixture-document.pdf from the URL path
  });
  it("the observed login redirect (final /login/index.php, 200 text/html, body#page-login-index lang-ru) is sign_in_required", async () => {
    expect(LOGIN_PAGE).toMatch(/<body[^>]*id="page-login-index"[^>]*lang-ru/);
    const r = () => reply(LOGIN_PAGE, { url: ORIGIN + LOGIN_REDIRECT.response.finalPath, status: LOGIN_REDIRECT.response.status, type: LOGIN_REDIRECT.response.contentType });
    expect(await get(r)).toEqual({ ok: false, reason: "sign_in_required" });
  });
  it("a pluginfile URL whose body is the login page, and HTTP 401, are sign_in_required (body id, not text)", async () => {
    expect(await get(() => reply(LOGIN_PAGE, { url: FILE, type: "text/html; charset=utf-8" }))).toEqual({ ok: false, reason: "sign_in_required" });
    // The same login body served on a resource page is still sign-in (body id), never not_a_file.
    expect(await get(() => reply(LOGIN_PAGE, { url: VIEW, type: "text/html" }))).toEqual({ ok: false, reason: "sign_in_required" });
    expect(await get(() => reply("", { url: FILE, status: 401, type: "text/html" }))).toEqual({ ok: false, reason: "sign_in_required" });
  });
  it("a resource that stays an HTML view.php page is not_a_file", async () => {
    const page = '<!doctype html><html><body id="page-mod-resource-view" class="lang-ru cmid-990104 course-9001"><main><h1>Страница</h1></main></body></html>';
    expect(await get(() => reply(page, { url: VIEW, type: "text/html; charset=utf-8" }))).toEqual({ ok: false, reason: "not_a_file" });
    expect(REASON_TEXT.not_a_file).toBe("This resource opens as a Moodle page, not a file. Open it in Moodle.");
  });
  it("other outcomes stay distinct and nothing is returned to save", async () => {
    expect(await get(() => reply(PDF, { status: 403 }))).toEqual({ ok: false, reason: "forbidden" });
    expect(await get(() => reply(PDF, { status: 404 }))).toEqual({ ok: false, reason: "not_found" });
    expect(await acquire(desc(), { fetcher: () => Promise.reject(new TypeError("Failed to fetch")), signal: new AbortController().signal, lease: grant })).toEqual({ ok: false, reason: "network" });
    expect(await get(() => reply(PDF, { type: "application/epub+zip" }))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(await get(() => reply(PDF, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))).toEqual({ ok: false, reason: "unsupported_type" });
    expect(await get(() => reply("PK\u0003\u0004 not a pdf"))).toEqual({ ok: false, reason: "unsupported_type" });
  });
  it("a redirect that ends off https://moodle.sdu.edu.kz is refused before its body is read", async () => {
    for (const url of ["https://evil.example/pluginfile.php/1/mod_resource/content/1/a.pdf", "http://moodle.sdu.edu.kz/pluginfile.php/1/mod_resource/content/1/a.pdf", "https://moodle.sdu.edu.kz:8443/pluginfile.php/1/mod_resource/content/1/a.pdf"]) {
      const log: Ev[] = [];
      expect(await get(() => reply(PDF, { url }, log))).toEqual({ ok: false, reason: "network" });
      expect(log).toEqual([]); // the body was never read to the end
    }
  });
  it("429 and 503 end network with the busy text and are fetched exactly once", async () => {
    for (const status of [429, 503]) {
      let calls = 0;
      const got = await acquire(desc(), { fetcher: async () => { calls++; return reply("", { status, type: "text/html" }); }, signal: new AbortController().signal, lease: grant });
      expect(got).toEqual({ ok: false, reason: "network", busy: true });
      expect(calls).toBe(1);
    }
    expect(BUSY_TEXT).toBe("Moodle is busy. Try again later. Nothing was saved.");
  });
  it("the old combined redirect text is gone; sign-in text names SDU Moodle", () => {
    expect(Object.values(REASON_TEXT).join(" ")).not.toMatch(/unreachable or redirected|redirected the request|often an expired login/);
    expect(REASON_TEXT.sign_in_required).toBe("Moodle returned a login page instead of the file. Sign in to SDU Moodle in Chrome, then retry. Nothing was saved.");
  });
  it("uses #20's 30 s request limit and 30 s lease wait inside the 60 s total", () => {
    expect([REQUEST_LIMIT_MS, LEASE_WAIT_MS, LEASE_REQUEST_LIMIT_MS]).toEqual([30_000, 30_000, 30_000]);
  });
});

/** One transfer page run against fakes; the lease comes from the given requester. */
function page(lease: LeaseRequester, fetcher: (url: string, init: RequestInit) => Promise<Response>, log: Ev[], over: { chrome?: "complete" | "none" } = {}) {
  const reports: any[] = [];
  let transfer: Transfer = { transferId: "tx-1", generation: 1, materialId: "r-pdf", state: "queued", cancelRequested: false };
  const listeners = new Set<(d: DownloadDelta) => void>();
  const downloads: any[] = [];
  const closed = new AbortController();
  const views: any[] = [];
  const go = () => runTransfer("tx-1", {
    api: {
      descriptor: async () => desc(),
      read: async () => transfer,
      report: async (_id, b: any) => {
        reports.push(b); log.push({ event: "state:" + b.state });
        transfer = { ...transfer, state: b.state, generation: transfer.generation + 1 };
        if (b.state === "saving" && over.chrome !== "none") setTimeout(() => { log.push({ event: "onChanged:complete" }); listeners.forEach((f) => f({ id: 9, state: { current: "complete" } })); }, 5);
        return transfer;
      },
    },
    downloads: {
      download: async (o: any) => { downloads.push(o); log.push({ event: "download" }); return 9; },
      cancel: async () => {}, search: async () => [],
      onChanged: { addListener: (f: any) => listeners.add(f), removeListener: (f: any) => listeners.delete(f) },
    },
    lease, fetcher, parseHtml,
    blobs: { create: () => "blob:transfer-test/1", revoke: () => {} },
    render: (v) => views.push(v), pollMs: 5, closed: closed.signal,
  });
  return { go, reports, downloads, views, closed };
}

describe("#41 transfer trace through the #20 authority (AC1)", () => {
  it("one click: tab open, one lease acquire, one GET, redirect to a PDF, release after the body, one download, complete only from onChanged", async () => {
    const tabs: any[] = [];
    const chromeApi = { runtime: { getURL: (p: string) => EXT + p }, tabs: { create: (o: any, cb?: (t: { id: number }) => void) => { tabs.push(o); w.log.push({ event: "tab-open" }); cb?.({ id: 7 }); } } };
    const w = worker();
    expect(openTransferPage(chromeApi, "startMaterialDownload", { supported: true, message: "", transfer: { transferId: "tx-trace", state: "queued" } })).toBe(true);
    expect(tabs).toEqual([{ url: EXT + "transfer.html#tx-trace", active: true }]);
    expect(transferTabFor("tx-trace")).toBe(7);
    const inits: RequestInit[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      inits.push(init); w.log.push({ event: "GET", detail: url });
      return reply(PDF, { url: FILE, headers: { "content-disposition": 'inline; filename="Lecture 1.pdf"', "content-length": String(PDF.length) } }, w.log);
    };
    const p = page(leaseRequester(w.connect()), fetcher, w.log);
    const v = await p.go();
    await pause(5);
    const events = w.log.map((e) => e.event);
    expect(events.filter((e) => ["tab-open", "acquire", "GET", "body-read", "download"].includes(e))).toEqual(["tab-open", "acquire", "GET", "body-read", "download"]);
    expect(events.indexOf("release")).toBeGreaterThan(events.indexOf("body-read"));
    expect(events.filter((e) => e === "acquire")).toHaveLength(1);
    expect(events.filter((e) => e === "release")).toHaveLength(1);
    expect(w.port().sent.map((m) => m.type)).toEqual(["acquire", "settled"]);
    expect(inits).toEqual([expect.objectContaining({ method: "GET", credentials: "include", redirect: "follow", cache: "no-store", referrerPolicy: "no-referrer" })]);
    expect(inits[0]!.headers).toBeUndefined();
    expect(w.log.find((e) => e.event === "GET")!.detail).toBe(VIEW);
    expect(p.downloads).toEqual([{ url: "blob:transfer-test/1", filename: "Lecture 1.pdf", conflictAction: "uniquify", saveAs: false }]);
    expect(p.reports.map((r) => r.state)).toEqual(["validating", "saving", "complete"]);
    expect(events.indexOf("state:complete")).toBeGreaterThan(events.indexOf("onChanged:complete"));
    expect(v.phase).toBe("complete");
    expect(w.gate.held()).toBe(false);
  });
});

describe("#41 lease rules (AC1)", () => {
  it("a lease request from any page other than the transfer tab opened for that transferId is refused, with no Moodle request", async () => {
    const senders: LeaseSender[] = [
      { id: "transfer-test", url: EXT + "transfer.html#tx-1", frameId: 0, tab: { id: 8 } }, // another tab
      { id: "transfer-test", url: EXT + "transfer.html#tx-2", frameId: 0, tab: { id: 7 } }, // another transfer
      { id: "transfer-test", url: EXT + "popup.html", frameId: 0, tab: { id: 7 } },
      { id: "other-extension", url: EXT + "transfer.html#tx-1", frameId: 0, tab: { id: 7 } },
      { id: "transfer-test", url: "https://moodle.sdu.edu.kz/transfer.html#tx-1", frameId: 0, tab: { id: 7 } },
      { id: "transfer-test", url: EXT + "transfer.html#tx-1", frameId: 1, tab: { id: 7 } },
      { id: "transfer-test", url: EXT + "transfer.html#tx-1", frameId: 0 },
    ];
    for (const sender of senders) {
      const w = worker();
      let calls = 0;
      const got = await acquire(desc(), { fetcher: async () => { calls++; return reply(PDF); }, signal: new AbortController().signal, lease: leaseRequester(w.connect(sender)) });
      expect(got).toEqual({ ok: false, reason: "download_interrupted", leaseLost: true });
      expect(calls).toBe(0);
      expect(w.log).toEqual([]);
    }
  });
  it("waits for its turn; with no lease within 30 s it ends failed/timeout with no Moodle request", async () => {
    const w = worker();
    expect(await w.authority.acquire(w.clock.now)).toEqual(expect.any(String)); // a scan request holds the authority
    const started = w.clock.now;
    let calls = 0;
    const log: Ev[] = [];
    const p = page(leaseRequester(w.connect()), async () => { calls++; return reply(PDF); }, log);
    const v = await p.go();
    expect(calls).toBe(0);
    expect(p.reports.at(-1)).toMatchObject({ state: "failed", reason: "timeout" });
    expect(w.clock.now - started).toBeGreaterThanOrEqual(30_000);
    expect(w.clock.now - started).toBeLessThan(31_000);
    expect(p.downloads).toEqual([]);
    expect(v.phase).toBe("failed");
  });
  it("a fetch that does not finish is aborted at the request limit, ends failed/timeout, and the lease is released only after the abort settled", async () => {
    const w = worker();
    const order: string[] = [];
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_ok, no) => init.signal!.addEventListener("abort", () => { order.push("aborted"); no(new DOMException("Aborted", "AbortError")); }));
    // The page limit is min(30 s, descriptor budget); a 40 ms budget exercises the same abort path quickly.
    const got = await acquire(desc({ timeoutMs: 40 }), { fetcher: hang, signal: new AbortController().signal, lease: leaseRequester(w.connect()) });
    await pause(5);
    expect(got).toEqual({ ok: false, reason: "timeout" });
    expect(order).toEqual(["aborted"]);
    expect(w.port().sent.map((m) => m.type)).toEqual(["acquire", "settled"]);
    expect(w.log.map((e) => e.event)).toEqual(["acquire", "release"]);
    expect(w.gate.held()).toBe(false);
  });
  it("429/503 are not retried; the authority's retry wait applies to the next Moodle request of any kind", async () => {
    for (const [status, retryAfter, wait] of [[503, undefined, 2000], [429, "7", 7000]] as const) {
      const w = worker();
      let calls = 0;
      const log: Ev[] = [];
      const p = page(leaseRequester(w.connect()), async () => { calls++; return reply("", { status, type: "text/html", ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}) }); }, log);
      const v = await p.go();
      await pause(5);
      expect(calls).toBe(1);
      expect(p.reports.at(-1)).toMatchObject({ state: "failed", reason: "network" });
      expect(v.message).toBe(BUSY_TEXT);
      const release = w.log.find((e) => e.event === "release")!;
      expect(release.detail as number).toBeGreaterThanOrEqual(release.at! + wait);
      // The next request (a scan, say) is refused by the gate until that wait has passed.
      expect(await w.authority.acquire(w.clock.now + wait - 1)).toBeNull();
      expect(await w.authority.acquire(w.clock.now + wait)).toEqual(expect.any(String));
    }
  });
  it("a worker restart (lease port disconnects) aborts the fetch: interrupted, nothing saved", async () => {
    const w = worker();
    let aborted = false;
    const fetcher = (_u: string, init: RequestInit) => new Promise<Response>((_ok, no) => {
      init.signal!.addEventListener("abort", () => { aborted = true; no(new DOMException("Aborted", "AbortError")); });
      setTimeout(() => w.port().worker.disconnect(), 5); // the worker goes away mid-fetch
    });
    const p = page(leaseRequester(w.connect()), fetcher, []);
    const v = await p.go();
    expect(aborted).toBe(true);
    expect(p.reports.at(-1)).toMatchObject({ state: "interrupted", reason: "download_interrupted" });
    expect(v.message).toBe(LEASE_LOST_TEXT);
    expect(p.downloads).toEqual([]);
  });
  it("closing the transfer tab releases the lease", async () => {
    const w = worker();
    const requester = leaseRequester(w.connect());
    const got = await requester("tx-1", new AbortController().signal);
    expect(got.ok).toBe(true);
    expect(w.gate.held()).toBe(true);
    w.port().page.disconnect(); // the tab closes: Chrome drops the page's port
    await pause(5);
    expect(w.gate.held()).toBe(false);
    expect(w.log.map((e) => e.event)).toEqual(["acquire", "release"]);
  });
});
