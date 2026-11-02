// @vitest-environment jsdom
/**
 * #41 repo check "one request at a time": a #20 scan (Sync all), a #82 course discovery
 * and one explicit material download run at the same time, through the installed
 * extension entry (installExtension), its bridge and the #20 request authority, against
 * a real loopback backend on the trusted real namespace (verified mode, file SQLite).
 * The transfer page side (runTransfer) takes its lease over a fake
 * chrome.runtime.connect port. Moodle is one injected fetch shared by the worker and the
 * page, so its trace covers every Moodle request; time is an injected clock. The
 * material record and course pages are fixtures; no real Moodle site, Chrome or account
 * is used.
 */
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, readFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, expect, it} from 'vitest';
import {installExtension} from '../extension/src/index';
import {installOffscreen} from '../extension/src/offscreen';
import {ENROLLED_METHOD} from '../extension/src/moodle-page-source';
import {leaseRequester, runTransfer, type DownloadDelta, type LeaseClientPort} from '../extension/src/material-transfer';
import type {LeasePort} from '../extension/src/moodle-request-authority';

const root = path.resolve(import.meta.dirname, '..');
const python = path.join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const fixtures = path.join(root, 'tests/fixtures/moodle');
const ORIGIN = 'https://moodle.sdu.edu.kz';
const SHELL_URL = `${ORIGIN}/my/courses.php`;
const SESSKEY = '0InventedFixtureKey0';
const SERVICE_URL = `${ORIGIN}/lib/ajax/service.php?sesskey=${SESSKEY}&info=${ENROLLED_METHOD}`;
const CMID = '990104';
const VIEW = `${ORIGIN}/mod/resource/view.php?id=${CMID}`;
const FILE = `${ORIGIN}/pluginfile.php/55001/mod_resource/content/1/fixture-document.pdf`;
const EXT_ID = 'transfer-network-test';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let dir: string, shell: string, inprogress: string, coursePage: string;
let child: ChildProcess | undefined, base = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'material-transfer-'));
  shell = await readFile(path.join(fixtures, 'my-courses-shell.html'), 'utf8');
  inprogress = await readFile(path.join(fixtures, 'observed/enrolled-courses-inprogress.json'), 'utf8');
  coursePage = await readFile(path.join(fixtures, 'observed/course-page.html'), 'utf8');
  const db = path.join(dir, 'real', 'live-scan.sqlite3');
  await mkdir(path.dirname(db), {recursive: true});
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as {port: number}).port; await new Promise<void>(r => listener.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(python, ['-m', 'uvicorn', 'tests.live_scan_network_app:app', '--host', '127.0.0.1', '--port', String(port)],
    {cwd: root, windowsHide: true, stdio: 'pipe', env: {...process.env, LIVE_SCAN_TEST_DATABASE: db}});
  let log = ''; child.stderr?.on('data', d => log += d);
  for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/api/bridge-context')).ok) return; } catch {} if (child.exitCode !== null) break; await pause(50); }
  throw Error(log);
}, 60000);
afterAll(async () => {
  const c = child;
  if (c && c.exitCode === null) await new Promise<void>(r => { c.once('exit', () => r()); c.kill(); });
  await rm(dir, {recursive: true, force: true});
});

async function backend(route: string, method = 'GET', body?: unknown) {
  const binding = (await (await fetch(base + '/api/bridge-context')).json()).binding as string;
  const r = await fetch(base + route, {method, headers: {Accept: 'application/json', 'X-Moodle-Helper-Bridge-Binding': binding, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  if (!r.ok) throw Error(`${method} ${route} ${r.status} ${await r.text()}`);
  return r.json();
}

/** A collected SDU PDF resource record (fixture) linked as its exact view.php?id=<cmid>. */
function resourceRecord(courseId: string) {
  const at = '2028-03-01T10:00:00Z';
  return {id: 'r-pdf', courseId, kind: 'material', firstObservedAt: at, lastObservedAt: at, observations: [{
    sourcePageUrl: `${ORIGIN}/course/view.php?id=9001`, sourceUrl: VIEW, destinationUrl: VIEW, observedAt: at, location: 'course.material',
    sourceCourseId: '9001', sourceCourseModuleId: CMID, sourceModuleType: 'resource', resourceKey: JSON.stringify([ORIGIN, '9001', 'resource', 'module', CMID]),
    kind: 'file', title: {kind: 'known', value: 'Lecture 1'}, section: {kind: 'unknown'}, fileType: {kind: 'known', value: 'pdf'},
    mimeType: {kind: 'unknown'}, references: []}]};
}

type Event = {event: 'start' | 'end'; method: string; url: string; at: number};
/** One Moodle fetch for the worker and the page: start/end on the injected clock, and in-flight count. */
function moodle(clock: {now: number}) {
  const trace: Event[] = [];
  let active = 0, maxActive = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    active++; maxActive = Math.max(maxActive, active);
    trace.push({event: 'start', method, url, at: clock.now});
    await pause(2); clock.now += 150;
    let body: string | Uint8Array, contentType = 'text/html; charset=utf-8', finalUrl = url;
    const course = /course\/view\.php\?id=(\d+)$/.exec(url)?.[1];
    if (course) body = coursePage.replaceAll('course-9001', `course-${course}`).replace(/<li class="activity[\s\S]*?<\/li>/g, '');
    else if (method === 'GET' && url === SHELL_URL) body = shell;
    else if (method === 'POST' && url === SERVICE_URL) { body = inprogress; contentType = 'application/json; charset=utf-8'; }
    else if (method === 'GET' && url === VIEW) { body = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n%%EOF'); contentType = 'application/pdf'; finalUrl = FILE; }
    else throw Error('Unexpected Moodle request ' + method + ' ' + url);
    const response = new Response(body, {status: 200, headers: {'content-type': contentType, ...(url === VIEW ? {'content-disposition': 'inline; filename="fixture-document.pdf"'} : {})}});
    Object.defineProperty(response, 'url', {value: finalUrl});
    active--; trace.push({event: 'end', method, url, at: clock.now});
    return response;
  }) as typeof fetch;
  return {fetcher, trace, starts: () => trace.filter(e => e.event === 'start'), maxActive: () => maxActive};
}

/** chrome.runtime.connect port pair: disconnect() fires onDisconnect only on the other end. */
function ports(sender: LeasePort['sender']) {
  const toPage = {msg: [] as ((m: any) => void)[], disc: [] as (() => void)[]};
  const toWorker = {msg: [] as ((m: any) => void)[], disc: [] as (() => void)[]};
  let open = true;
  const page: LeaseClientPort = {
    postMessage: m => { if (!open) throw Error('closed'); const c = structuredClone(m); queueMicrotask(() => toWorker.msg.forEach(f => f(c))); },
    disconnect: () => { if (open) { open = false; queueMicrotask(() => toWorker.disc.forEach(f => f())); } },
    onMessage: {addListener: f => toPage.msg.push(f)}, onDisconnect: {addListener: f => toPage.disc.push(f)}};
  const worker: LeasePort = {name: 'moodle-transfer-lease', ...(sender ? {sender} : {}),
    postMessage: m => { if (open) { const c = structuredClone(m); queueMicrotask(() => toPage.msg.forEach(f => f(c))); } },
    disconnect: () => { if (open) { open = false; queueMicrotask(() => toPage.disc.forEach(f => f())); } },
    onMessage: {addListener: f => toWorker.msg.push(f)}, onDisconnect: {addListener: f => toWorker.disc.push(f)}};
  return {page, worker};
}

it('a download, a #20 scan and a #82 discovery at the same time: at most 1 in-flight Moodle request, starts >= 1000 ms apart', async () => {
  // Fixture setup: two tracked courses, and one collected PDF resource in the real dataset.
  const seeded = await backend('/api/courses/discovery', 'POST', {observations: ['9001', '9002'].map(id => ({sourceCourseId: id, sourceUrl: `${ORIGIN}/course/view.php?id=${id}`,
    title: {kind: 'known', value: `Fictional course ${id}`}, termIndicators: {kind: 'unknown'}}))});
  const ids = seeded.courses.filter((c: any) => c.discovery).map((c: any) => c.id);
  await backend('/api/tracked-courses', 'PUT', ids);
  const ctx = await backend('/api/backups/restore-context');
  const data = await backend('/api/snapshot');
  data.collection = {records: [resourceRecord(ids[0])], reviews: [], refreshes: []};
  await backend('/api/backups/restore', 'POST', {idempotencyKey: 'seed-material-1', expectedDatasetId: ctx.datasetId, expectedEpoch: ctx.epoch, expectedRevision: ctx.revision,
    backup: {app: 'moodle-helper', version: 1, exportedAt: '2028-03-01T10:00:00Z', note: '', datasetId: ctx.datasetId, data}});
  expect((await backend('/api/collection-context')).mode).toBe('verified');
  const datasetId = (await backend('/api/backups/restore-context')).datasetId;

  // The installed extension with fake Chrome events.
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock);
  const messages: any[] = [], offscreen: any[] = [], connects: ((port: LeasePort) => void)[] = [], tabs: any[] = [];
  const runtime: any = {id: EXT_ID, getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}`,
    onMessage: {addListener: (f: any) => messages.push(f)}, onStartup: {addListener: () => {}}, onInstalled: {addListener: () => {}},
    onConnect: {addListener: (f: any) => connects.push(f)},
    sendMessage: (message: unknown, callback: (reply: unknown) => void) => { for (const listener of offscreen) listener(message, {id: EXT_ID}, callback); }};
  const chrome: any = {runtime, alarms: {create: () => {}, clear: () => {}, onAlarm: {addListener: () => {}}},
    tabs: {create: (o: any, cb?: (tab: {id: number}) => void) => { tabs.push(o); cb?.({id: 41}); }},
    permissions: {contains: (_: unknown, cb: (allowed: boolean) => void) => cb(true)},
    offscreen: {createDocument: async () => { installOffscreen({id: EXT_ID, onMessage: {addListener: (f: any) => offscreen.push(f)}}); }}};
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => fetch(String(input).replace('http://127.0.0.1:8000', base), init)) as typeof fetch;
  const worker = installExtension(chrome, {base, fetcher, liveScan: {moodleFetch: site.fetcher, now: () => clock.now, wait: async (ms: number) => { clock.now += ms; await pause(0); }}});
  let request = 0;
  const bridge = async (tab: number, operation: string, payload: unknown = {}) => {
    const sender = {id: EXT_ID, frameId: 0, tab: {id: tab}, documentId: `document-${tab}`, url: 'http://127.0.0.1:5173/'};
    const send = (message: any) => new Promise<any>(resolve => { messages[0](message, sender, resolve); });
    const common = {source: 'moodle-helper-web', type: 'request', version: '1', clientId: `tab-${tab}`};
    const hello = await send({...common, requestId: `r-${tab}-${++request}`, operation: 'hello', payload: {}});
    return send({...common, requestId: `r-${tab}-${++request}`, operation, sessionId: hello.result.sessionId, payload});
  };

  // Sync all starts the scan; while its first request runs, the student clicks Find my courses and Download PDF.
  expect((await bridge(1, 'syncAll')).ok).toBe(true);
  for (let i = 0; i < 400 && !site.starts().length; i++) await pause(10);
  const discovery = bridge(2, 'discoverCourses');
  const started = await bridge(3, 'startMaterialDownload', {datasetId, materialId: 'r-pdf', idempotencyKey: 'click-1'});
  expect(started.result).toMatchObject({supported: true, transfer: {state: 'queued'}});
  const transferId = started.result.transfer.transferId as string;
  expect(tabs).toEqual([{url: `chrome-extension://${EXT_ID}/transfer.html#${transferId}`, active: true}]);

  // The transfer page opened for that transfer.
  const listeners = new Set<(d: DownloadDelta) => void>();
  const downloads: any[] = [];
  const sender = {id: EXT_ID, url: `chrome-extension://${EXT_ID}/transfer.html#${transferId}`, frameId: 0, tab: {id: 41}};
  const view = await runTransfer(transferId, {
    api: {
      descriptor: t => backend(`/api/material-downloads/${t}/descriptor`, 'POST'),
      read: t => backend(`/api/material-downloads/${t}`),
      report: (t, b) => backend(`/api/material-downloads/${t}/status`, 'POST', b),
    },
    fetcher: site.fetcher,
    lease: leaseRequester(() => { const pair = ports(sender); connects[0]!(pair.worker); return pair.page; }),
    parseHtml: html => new DOMParser().parseFromString(html, 'text/html'),
    downloads: {
      download: async (o: any) => { downloads.push(o); setTimeout(() => listeners.forEach(f => f({id: 5, state: {current: 'complete'}})), 5); return 5; },
      cancel: async () => {}, search: async () => [],
      onChanged: {addListener: (f: any) => listeners.add(f), removeListener: (f: any) => listeners.delete(f)},
    },
    blobs: {create: () => 'blob:transfer/1', revoke: () => {}},
    render: () => {}, pollMs: 50, closed: new AbortController().signal,
  });
  await discovery;
  expect(view.phase).toBe('complete');
  expect(downloads).toEqual([{url: 'blob:transfer/1', filename: 'fixture-document.pdf', conflictAction: 'uniquify', saveAs: false}]);
  expect((await backend(`/api/material-downloads/${transferId}`))).toMatchObject({state: 'complete', downloadId: 5});

  const urls = site.starts().map(e => e.url);
  expect(urls.filter(u => u === VIEW)).toHaveLength(1);
  expect(urls).toContain(SHELL_URL);
  expect(urls.some(u => /course\/view\.php\?id=900[12]$/.test(u))).toBe(true);
  // At most one in-flight Moodle request across the worker and the transfer page, starts >= 1 s apart.
  expect(site.maxActive()).toBe(1);
  const starts = site.starts();
  for (let i = 1; i < starts.length; i++) expect(starts[i]!.at - starts[i - 1]!.at).toBeGreaterThanOrEqual(1000);
  const events = site.trace.map(e => e.event);
  for (let i = 0; i < events.length; i += 2) expect(events.slice(i, i + 2)).toEqual(['start', 'end']);
  worker.dispose();
}, 90000);
