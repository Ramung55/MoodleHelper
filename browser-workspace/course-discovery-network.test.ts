// @vitest-environment jsdom
/**
 * #82 repo checks for "Find my SDU courses", through the installed extension entry
 * (installExtension), its bridge, the #20 request authority, the offscreen document
 * and the discovery page source, against real loopback HTTP and a file SQLite
 * backend. Moodle is an injected fetch serving the synthetic /my/courses.php shell
 * (tests/fixtures/moodle/my-courses-shell.html, invented sesskey) and the observed
 * enrolled-courses fixtures; time is an injected clock. No real Moodle site, Chrome
 * or account is used. Response variants written inline below are INVENTED.
 */
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, writeFile, readFile, mkdir, readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, afterEach, beforeAll, expect, it, vi} from 'vitest';
import {installExtension} from '../extension/src/index';
import {installOffscreen} from '../extension/src/offscreen';
import {startDiscoveryRequest, createMoodlePageSource, ENROLLED_METHOD} from '../extension/src/moodle-page-source';
import {leaseRequester, runTransfer, type DownloadDelta, type LeaseClientPort} from '../extension/src/material-transfer';
import type {LeasePort} from '../extension/src/moodle-request-authority';

const root = path.resolve(import.meta.dirname, '..');
const python = path.join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const fixtures = path.join(root, 'tests/fixtures/moodle');
const ORIGIN = 'https://moodle.sdu.edu.kz';
const SHELL_URL = `${ORIGIN}/my/courses.php`;
const SESSKEY = '0InventedFixtureKey0';
const SERVICE_URL = `${ORIGIN}/lib/ajax/service.php?sesskey=${SESSKEY}&info=${ENROLLED_METHOD}`;
const SIGN_IN = 'Sign in to SDU Moodle to continue.';
const FAILED = 'Could not read your SDU courses. Try again later.';
const DEMO = 'Course discovery is not available in the demo dataset.';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let dir: string;
let shell: string, inprogress: string, loginPage: string, loginRedirect: any;
const running: Backend[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'course-discovery-'));
  shell = await readFile(path.join(fixtures, 'my-courses-shell.html'), 'utf8');
  inprogress = await readFile(path.join(fixtures, 'observed/enrolled-courses-inprogress.json'), 'utf8');
  loginPage = await readFile(path.join(fixtures, 'observed/login-page.html'), 'utf8');
  loginRedirect = JSON.parse(await readFile(path.join(fixtures, 'observed/login-redirect-course.json'), 'utf8'));
  expect(shell).toContain(`"sesskey":"${SESSKEY}"`);
  expect(loginPage).toMatch(/<body[^>]*id="page-login-index"[^>]*lang-ru|<body[^>]*lang-ru[^>]*id="page-login-index"/);
});
afterAll(async () => {
  for (const backend of running) await backend.stop();
  await rm(dir, {recursive: true, force: true});
});
// Each check stops its backend at once, so the parallel suites are not slowed by idle servers.
afterEach(() => { vi.restoreAllMocks(); });

class Backend {
  child?: ChildProcess; base = ''; port = 0; db: string;
  constructor(public name: string, public demo = false) {
    this.db = path.join(dir, name, demo ? 'demo.sqlite3' : 'live-scan.sqlite3');
  }
  async start() {
    await mkdir(path.dirname(this.db), {recursive: true});
    if (!this.port) {
      const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
      this.port = (listener.address() as {port: number}).port; await new Promise<void>(r => listener.close(() => r()));
      this.base = `http://127.0.0.1:${this.port}`;
    }
    const env = this.demo
      ? {...process.env, MOODLE_HELPER_DATABASE_URL: `sqlite:///${this.db.replaceAll('\\', '/')}`, MOODLE_HELPER_DATASET: 'demo'}
      : {...process.env, LIVE_SCAN_TEST_DATABASE: this.db};
    this.child = spawn(python, ['-m', 'uvicorn', this.demo ? 'backend.main:app' : 'tests.live_scan_network_app:app', '--host', '127.0.0.1', '--port', String(this.port)],
      {cwd: root, windowsHide: true, stdio: 'pipe', env});
    let log = ''; this.child.stderr?.on('data', d => log += d);
    if (!running.includes(this)) running.push(this);
    for (let i = 0; i < 300; i++) { try { if ((await fetch(this.base + '/api/bridge-context')).ok) return; } catch {} if (this.child.exitCode !== null) break; await pause(50); }
    throw Error(log);
  }
  async stop() { const child = this.child; if (child && child.exitCode === null) await new Promise<void>(r => { child.once('exit', () => r()); child.kill(); }); }
  async binding() { return (await (await fetch(this.base + '/api/bridge-context')).json()).binding as string; }
  async write(method: string, route: string, body?: unknown) {
    return fetch(this.base + route, {method, headers: {'Content-Type': 'application/json', 'X-Moodle-Helper-Bridge-Binding': await this.binding()}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  async get(route: string) { return (await fetch(this.base + route)).json(); }
  async sql(query: string): Promise<any[]> {
    const script = 'import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nprint(json.dumps(c.execute(sys.argv[2]).fetchall()))';
    return JSON.parse((await promisify(execFile)(python, ['-c', script, this.db, query], {windowsHide: true})).stdout);
  }
  /** Every byte of the SQLite database files (main file, WAL and journal). */
  async bytes() {
    const names = (await readdir(path.dirname(this.db))).filter(n => n.startsWith(path.basename(this.db)));
    return (await Promise.all(names.map(n => readFile(path.join(path.dirname(this.db), n), 'latin1')))).join('');
  }
  async runs() { return Promise.all((await this.sql('SELECT id FROM queue_runs ORDER BY rowid')).map(([id]) => this.get('/api/scan/runs/' + id))); }
  async settled(count: number) {
    for (let i = 0; i < 1200; i++) {
      const runs = await this.runs();
      if (runs.length >= count && runs.every(r => ['completed', 'failed', 'cancelled'].includes(r.status))) return runs;
      await pause(25);
    }
    throw Error('Scan did not finish');
  }
}

type Reply = {status: number; body: string; finalUrl?: string; contentType?: string | null; headers?: Record<string, string>};
type Route = (method: string, url: string, attempt: number, body?: string) => Reply | 'hang-abortable';
type Event = {event: 'start' | 'end' | 'abort'; method: string; url: string; at: number; body?: string; init?: RequestInit};
/** Injected Moodle fetch: actual start/end events on the injected clock, and in-flight count. */
function moodle(clock: {now: number}, route: Route) {
  const trace: Event[] = [];
  const attempts = new Map<string, number>();
  let active = 0, maxActive = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    const key = method + ' ' + url, attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
    active++; maxActive = Math.max(maxActive, active);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    trace.push({event: 'start', method, url, at: clock.now, ...(body !== undefined ? {body} : {}), ...(init ? {init} : {})});
    const reply = route(method, url, attempt, body);
    if (reply === 'hang-abortable') return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => {
      active--; trace.push({event: 'abort', method, url, at: clock.now}); reject(new DOMException('Aborted', 'AbortError'));
    }));
    await pause(2); clock.now += 150;
    const contentType = reply.contentType === undefined ? 'text/html; charset=utf-8' : reply.contentType;
    const response = new Response(reply.body, {status: reply.status, headers: {...(contentType ? {'content-type': contentType} : {}), ...reply.headers}});
    Object.defineProperty(response, 'url', {value: reply.finalUrl ?? url});
    active--; trace.push({event: 'end', method, url, at: clock.now});
    return response;
  }) as typeof fetch;
  return {fetcher, trace, starts: () => trace.filter(e => e.event === 'start'), maxActive: () => maxActive};
}
const ok = (body: string): Reply => ({status: 200, body});
const json = (body: string): Reply => ({status: 200, body, contentType: 'application/json; charset=utf-8'});
/** Invented page of `count` courses starting at id `first`. */
const invented = (count: number, first = 9001) => JSON.stringify([{error: false, data: {courses: Array.from({length: count}, (_, i) => ({id: first + i, fullname: `Invented Course ${first + i} (Invented Teacher)`, shortname: 'INV-1-redacted-2028-1'})), nextoffset: count}}]);
/** The shell answers the GET, and `pages` (by offset) answer the POSTs. */
function site(pages: (offset: number, attempt: number) => Reply = () => json(inprogress), shellReply: () => Reply = () => ok(shell)) {
  return (method: string, url: string, attempt: number, body?: string): Reply => {
    if (method === 'GET' && url === SHELL_URL) return shellReply();
    if (method === 'POST' && url === SERVICE_URL) return pages(JSON.parse(body!)[0].args.offset, attempt);
    throw Error('Unexpected Moodle request ' + method + ' ' + url);
  };
}

/** The installed extension, with fake Chrome events, recorded backend traffic and an in-process offscreen document. */
function install(backend: Backend, clock: {now: number}, moodleFetch: typeof fetch, extra: Record<string, unknown> = {}) {
  const alarms: ((alarm: {name: string}) => void)[] = [], messages: any[] = [], offscreen: any[] = [];
  const offscreenMessages: unknown[] = [], storageWrites: unknown[] = [], backendTrace: {method: string; path: string; headers: any; body?: string}[] = [];
  const runtime: any = {id: 'discovery-test', getURL: (p: string) => `chrome-extension://discovery-test/${p}`,
    onMessage: {addListener: (f: any) => messages.push(f)}, onStartup: {addListener: () => {}}, onInstalled: {addListener: () => {}},
    sendMessage: (message: unknown, callback: (reply: unknown) => void) => { offscreenMessages.push(structuredClone(message)); for (const listener of offscreen) listener(message, {id: 'discovery-test'}, callback); }};
  const record = (...args: unknown[]) => storageWrites.push(args);
  const chrome: any = {runtime, alarms: {create: () => {}, clear: () => {}, onAlarm: {addListener: (f: any) => alarms.push(f)}},
    storage: {local: {set: record, get: (_: unknown, cb?: (v: unknown) => void) => cb?.({})}, session: {set: record, get: (_: unknown, cb?: (v: unknown) => void) => cb?.({})}},
    permissions: {contains: (_: unknown, cb: (allowed: boolean) => void) => cb(true)},
    offscreen: {createDocument: async () => { installOffscreen({id: 'discovery-test', onMessage: {addListener: (f: any) => offscreen.push(f)}}); }}};
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input).replace('http://127.0.0.1:8000', backend.base));
    backendTrace.push({method: init?.method ?? 'GET', path: url.pathname, headers: init?.headers, ...(typeof init?.body === 'string' ? {body: init.body} : {})});
    return fetch(url, init);
  }) as typeof fetch;
  const worker = installExtension(chrome, {base: backend.base, fetcher,
    liveScan: {moodleFetch, now: () => clock.now, wait: async (ms: number) => { clock.now += ms; await pause(0); }, ...extra}});
  let request = 0;
  const replies: unknown[] = [];
  const bridge = async (tab: number, operation: string) => {
    const sender = {id: 'discovery-test', frameId: 0, tab: {id: tab}, documentId: `document-${tab}`, url: 'http://127.0.0.1:5173/'};
    const send = (message: any) => new Promise<any>(resolve => { messages[0](message, sender, resolve); });
    const common = {source: 'moodle-helper-web', type: 'request', version: '1', clientId: `tab-${tab}`};
    const hello = await send({...common, requestId: `r-${tab}-${++request}`, operation: 'hello', payload: {}});
    const reply = await send({...common, requestId: `r-${tab}-${++request}`, operation, sessionId: hello.result.sessionId, payload: {}});
    replies.push(reply);
    return reply;
  };
  const writes = () => backendTrace.filter(r => r.path === '/api/courses/discovery');
  return {worker, bridge, replies, offscreenMessages, storageWrites, backendTrace, writes, alarm: () => alarms[0]!({name: 'moodle-helper-mock-queue'})};
}
const discovered = (snapshot: any) => snapshot.courses.filter((c: any) => c.discovery).map((c: any) => c.discovery.sourceCourseId).sort();
function spacing(starts: {at: number}[]) {
  for (let i = 1; i < starts.length; i++) expect(starts[i]!.at - starts[i - 1]!.at).toBeGreaterThanOrEqual(1000);
}
/**
 * One real-namespace backend for the checks that need no seeded selection (they run in
 * file order: nothing is written before the happy path), so few servers start beside the
 * other parallel suites. One clock that only moves forward: the durable gate keeps the
 * pacing of earlier checks.
 */
const shared = {now: Date.parse('2028-03-05T10:00:00Z')};
const fresh = () => { shared.now += 300_000; return shared; };
let sharedBackend: Backend | undefined;
async function realBackend() {
  if (!sharedBackend) { sharedBackend = new Backend('real'); await sharedBackend.start(); }
  return sharedBackend;
}

it('shares the request authority with a running #20 scan: requests interleave but never overlap', async () => {
  const backend = new Backend('interleave'); await backend.start();
  const seeded = await backend.write('POST', '/api/courses/discovery', {observations: ['9001', '9002'].map(id => ({sourceCourseId: id, sourceUrl: `${ORIGIN}/course/view.php?id=${id}`,
    title: {kind: 'known', value: `Fictional course ${id}`}, termIndicators: {kind: 'unknown'}}))});
  const ids = (await seeded.json()).courses.map((c: any) => c.id);
  expect((await backend.write('PUT', '/api/tracked-courses', ids)).status).toBe(200);
  const coursePage = await readFile(path.join(fixtures, 'observed/course-page.html'), 'utf8');
  const clock = fresh();
  const discovery = site();
  const site_ = moodle(clock, (method, url, attempt, body) => {
    const course = /course\/view\.php\?id=(\d+)$/.exec(url)?.[1];
    if (course) return ok(coursePage.replaceAll('course-9001', `course-${course}`).replace(/<li class="activity[\s\S]*?<\/li>/g, ''));
    return discovery(method, url, attempt, body);
  });
  const app = install(backend, clock, site_.fetcher);
  // Sync all starts the scan; the click comes while the scan's first course page is being read.
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  for (let i = 0; i < 400 && !site_.starts().length; i++) await pause(10);
  const found = await app.bridge(2, 'discoverCourses');
  expect(found.result).toMatchObject({found: 3, coverage: 'complete'});
  const urls = site_.starts().map(e => e.url);
  expect(urls[0]).toMatch(/course\/view\.php\?id=900[12]$/);
  expect(urls.filter(u => u === SHELL_URL || u === SERVICE_URL)).toEqual([SHELL_URL, SERVICE_URL]);
  // Note: the ingest is a backend write, which #20's middleware treats as a selection
  // change, so the running scan is fenced (invalid_context); it is not awaited here.
  expect(site_.maxActive()).toBe(1); spacing(site_.starts());
  // Each request ends before the next one starts.
  const events = site_.trace.map(e => e.event);
  for (let i = 0; i < events.length; i += 2) expect(events.slice(i, i + 2)).toEqual(['start', 'end']);
  app.worker.dispose();
}, 60000);

it('the page source refuses every other POST and every other route without calling fetch', () => {
  const fetcher = vi.fn();
  const call = (override: Record<string, unknown> = {}, args: Record<string, unknown> = {}) =>
    JSON.stringify([{index: 0, methodname: ENROLLED_METHOD, args: {offset: 0, limit: 24, classification: 'inprogress', sort: 'fullname', ...args}, ...override}]);
  const refused: any[] = [
    {method: 'POST', url: SERVICE_URL.replace(ENROLLED_METHOD, 'core_session_time_remaining'), body: call({methodname: 'core_session_time_remaining'})},
    {method: 'POST', url: SERVICE_URL, body: call({methodname: 'core_course_get_courses'})},
    {method: 'POST', url: SERVICE_URL, body: JSON.stringify([...JSON.parse(call()), {...JSON.parse(call())[0], index: 1}])},
    {method: 'POST', url: SERVICE_URL.replace('moodle.sdu.edu.kz', 'moodle.example.invalid'), body: call()},
    {method: 'POST', url: SERVICE_URL.replace('/lib/ajax/service.php', '/lib/ajax/service-nologin.php'), body: call()},
    {method: 'POST', url: SERVICE_URL + '&extra=1', body: call()},
    {method: 'POST', url: `${ORIGIN}/lib/ajax/service.php?info=${ENROLLED_METHOD}&sesskey=${SESSKEY}`, body: call()},
    {method: 'POST', url: SERVICE_URL, body: call({}, {classification: 'all'})},
    {method: 'POST', url: SERVICE_URL, body: call({}, {extra: 1})},
    {method: 'POST', url: SERVICE_URL, body: call({extra: 1})},
    {method: 'POST', url: SERVICE_URL, body: 'not json'},
    {method: 'POST', url: SHELL_URL, body: call()},
    {method: 'GET', url: SERVICE_URL},
    {method: 'GET', url: `${ORIGIN}/my/`},
    {method: 'GET', url: SHELL_URL + '?x=1'},
    {method: 'PUT', url: SERVICE_URL, body: call()},
    {method: 'GET', url: SHELL_URL, body: ''},
  ];
  for (const request of refused) expect(() => startDiscoveryRequest(request, {fetcher})).toThrow('Route not allowed');
  // The #20 scan source stays GET only and has no service route.
  const source = createMoodlePageSource({fetcher, analyze: async () => { throw Error('no'); }, now: () => 0});
  for (const url of [SERVICE_URL, SHELL_URL]) expect(() => source.start(url, {sourceCourseId: '9001', collectors: []})).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('a shell without a sesskey fails with no POST; a signed-out GET asks to sign in, with no POST, write or further request', async () => {
  const backend = await realBackend();
  const clock = fresh();
  const responses: Reply[] = [ok(shell.replace(`"sesskey":"${SESSKEY}"`, '"session":"none"')),
    {status: loginRedirect.response.status, body: loginPage, finalUrl: ORIGIN + loginRedirect.response.finalPath, contentType: loginRedirect.response.contentType}];
  const site_ = moodle(clock, site(undefined, () => responses.shift()!));
  const app = install(backend, clock, site_.fetcher);
  expect((await app.bridge(1, 'discoverCourses')).result).toEqual({message: FAILED});
  expect((await app.bridge(1, 'discoverCourses')).result).toEqual({message: SIGN_IN});
  expect(site_.starts().map(e => e.method)).toEqual(['GET', 'GET']);
  // The observed login redirect has no content type, so its body is not read: the final path decides.
  expect(app.offscreenMessages.at(-1)).toMatchObject({type: 'access', request: {route: 'my-courses', envelope: {finalUrl: `${ORIGIN}/login/index.php`, httpStatus: 200}}});
  expect(JSON.stringify(app.offscreenMessages)).not.toContain('<');
  expect(app.writes()).toEqual([]);
  app.alarm(); await pause(300);
  expect(site_.starts()).toHaveLength(2);
  expect(discovered(await backend.get('/api/snapshot'))).toEqual([]);
  app.worker.dispose();
}, 60000);

it('signed out at a POST (login page or servicerequireslogin) asks to sign in and ingests nothing, not even earlier pages', async () => {
  const backend = await realBackend();
  const clock = fresh();
  const answers: ((offset: number) => Reply)[] = [
    () => ({status: 200, body: loginPage, finalUrl: `${ORIGIN}/login/index.php`}),
    offset => offset === 0 ? json(invented(24)) : json(JSON.stringify([{error: true, exception: {errorcode: 'servicerequireslogin', message: 'Invented'}}])),
  ];
  let current = answers[0]!;
  const site_ = moodle(clock, site(offset => current(offset)));
  const app = install(backend, clock, site_.fetcher);
  expect((await app.bridge(1, 'discoverCourses')).result).toEqual({message: SIGN_IN});
  current = answers[1]!;
  expect((await app.bridge(1, 'discoverCourses')).result).toEqual({message: SIGN_IN});
  expect(site_.starts().map(e => e.method)).toEqual(['GET', 'POST', 'GET', 'POST', 'POST']);
  expect(JSON.parse(site_.starts()[4]!.body!)[0].args.offset).toBe(24);
  expect(app.writes()).toEqual([]);
  expect(JSON.stringify(app.offscreenMessages)).not.toContain(SESSKEY);
  expect(discovered(await backend.get('/api/snapshot'))).toEqual([]);
  app.worker.dispose();
}, 60000);

it('failures end with the fixed message and no backend write: invalidsesskey once, 503/429 retried twice, a stalled fetch aborted, oversize and non-JSON bodies', async () => {
  const backend = await realBackend();
  // One clock for every case: the durable gate keeps the pacing of the earlier cases.
  const clock = fresh();
  const run = async (page: (offset: number, attempt: number) => Reply, extra: Record<string, unknown> = {}) => {
    const site_ = moodle(clock, site(page));
    const app = install(backend, clock, site_.fetcher, extra);
    const reply = await app.bridge(1, 'discoverCourses');
    expect(reply.result).toEqual({message: FAILED});
    expect(app.writes()).toEqual([]);
    expect(site_.maxActive()).toBe(1);
    expect(JSON.stringify([app.replies, app.backendTrace, app.offscreenMessages])).not.toContain(SESSKEY);
    return {site_, app, clock};
  };
  const posts = (s: ReturnType<typeof moodle>) => s.trace.filter(e => e.method === 'POST');
  // invalidsesskey: requested once.
  const invalid = await run(() => json(JSON.stringify([{error: true, exception: {errorcode: 'invalidsesskey', message: 'Invented'}}])));
  expect(posts(invalid.site_).filter(e => e.event === 'start')).toHaveLength(1);
  invalid.app.worker.dispose();
  // 503: three attempts, retries after >= 2 s and >= 5 s.
  const busy = await run(() => ({status: 503, body: '<html><body></body></html>'}));
  const b = posts(busy.site_);
  expect(b.filter(e => e.event === 'start')).toHaveLength(3);
  expect(b[2]!.at - b[1]!.at).toBeGreaterThanOrEqual(2000);
  expect(b[4]!.at - b[3]!.at).toBeGreaterThanOrEqual(5000);
  busy.app.worker.dispose();
  // 429 with a longer Retry-After: waits it out.
  const limited = await run(() => ({status: 429, body: '', headers: {'Retry-After': '120'}}));
  const l = posts(limited.site_);
  expect(l.filter(e => e.event === 'start')).toHaveLength(3);
  expect(l[2]!.at - l[1]!.at).toBeGreaterThanOrEqual(120_000);
  limited.app.worker.dispose();
  // The durable gate kept the 120 s Retry-After of the last refused attempt; let it pass.
  clock.now += 200_000;
  // Oversize and non-JSON bodies.
  for (const page of [() => json(JSON.stringify([{error: false, data: {courses: [], pad: 'x'.repeat(1_100_000)}}])), () => ({...json('<html></html>'), contentType: 'application/json'}), () => ok('<html><body></body></html>')]) {
    const failed = await run(page);
    expect(posts(failed.site_).filter(e => e.event === 'start')).toHaveLength(1);
    failed.app.worker.dispose();
  }
  // A POST that never answers is aborted at the (test-shortened) limit; the next request starts after the abort settled.
  let hang = true;
  const site_ = moodle(clock, site(() => hang ? 'hang-abortable' as any : json(inprogress)));
  const app = install(backend, clock, site_.fetcher, {requestLimitMs: 300});
  expect((await app.bridge(1, 'discoverCourses')).result).toEqual({message: FAILED});
  hang = false;
  expect((await app.bridge(1, 'discoverCourses')).result).toMatchObject({found: 3});
  const events = site_.trace.map(e => `${e.event} ${e.method}`);
  expect(events).toEqual(['start GET', 'end GET', 'start POST', 'abort POST', 'start GET', 'end GET', 'start POST', 'end POST']);
  expect(site_.trace[4]!.at - site_.trace[3]!.at).toBeGreaterThanOrEqual(0);
  spacing(site_.starts());
  app.worker.dispose();
}, 90000);

it('happy path: one GET, one POST and one ingest; three unticked courses; one run for two tabs; the sesskey only in the POST URL', async () => {
  const backend = await realBackend();
  const clock = fresh();
  const consoleCalls: unknown[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args) => { consoleCalls.push(args); });
  const site_ = moodle(clock, site());
  const app = install(backend, clock, site_.fetcher);
  const before = await backend.get('/api/snapshot');
  // Two dashboard tabs click Find my SDU courses at once: one run, the same result.
  const [one, two] = await Promise.all([app.bridge(1, 'discoverCourses'), app.bridge(2, 'discoverCourses')]);
  for (const reply of [one, two]) expect(reply).toMatchObject({ok: true, result: {found: 3, coverage: 'complete'}});
  expect(two.result).toEqual(one.result);
  const starts = site_.starts();
  expect(starts.map(e => [e.method, e.url])).toEqual([['GET', SHELL_URL], ['POST', SERVICE_URL]]);
  expect(starts[0]!.init).toMatchObject({method: 'GET', credentials: 'include', redirect: 'follow', cache: 'no-store'});
  expect(starts[0]!.init!.body).toBeUndefined();
  expect(starts[1]!.init).toMatchObject({method: 'POST', credentials: 'include', redirect: 'follow', cache: 'no-store', headers: {'Content-Type': 'application/json'}});
  expect(JSON.parse(starts[1]!.body!)).toEqual([{index: 0, methodname: ENROLLED_METHOD, args: {offset: 0, limit: 24, classification: 'inprogress', sort: 'fullname'}}]);
  expect(site_.maxActive()).toBe(1); spacing(starts);
  // Gate acquire and release around each Moodle request, then exactly one ingest with the binding.
  // (A busy gate is asked again after a short wait, so repeated acquires collapse into one.)
  const gate = app.backendTrace.filter(r => r.path.startsWith('/api/scan/gate/') || r.path === '/api/courses/discovery').map(r => r.path)
    .filter((p, i, all) => p !== all[i - 1]);
  expect(gate).toEqual(['/api/scan/gate/acquire', '/api/scan/gate/release', '/api/scan/gate/acquire', '/api/scan/gate/release', '/api/courses/discovery']);
  const [ingest] = app.writes();
  expect(ingest!.method).toBe('POST');
  expect(ingest!.headers['X-Moodle-Helper-Bridge-Binding']).toBe(await backend.binding());
  expect(JSON.parse(ingest!.body!)).toEqual({observations: ['9001', '9002', '9003'].map((id, i) => ({sourceCourseId: id, sourceUrl: `${ORIGIN}/course/view.php?id=${id}`,
    title: {kind: 'known', value: ['Fictional Course Alpha', 'Fictional Course Beta', 'Fictional Course Gamma'][i]}, termIndicators: {kind: 'known', value: ['In progress']}}))});
  const snapshot = await backend.get('/api/snapshot');
  expect(discovered(snapshot)).toEqual(['9001', '9002', '9003']);
  expect(snapshot.settings.trackedCourseIds).toEqual(before.settings.trackedCourseIds);
  expect(one.result.snapshot.settings.trackedCourseIds).toEqual(before.settings.trackedCourseIds);
  // The sesskey appears only in the POST URL.
  const everywhere = JSON.stringify([app.backendTrace, app.replies, consoleCalls, app.storageWrites, app.offscreenMessages, snapshot]);
  expect(everywhere).not.toContain(SESSKEY);
  expect(app.offscreenMessages).toHaveLength(1);
  expect(app.offscreenMessages[0]).toMatchObject({type: 'access', request: {route: 'my-courses', envelope: {requestedUrl: SHELL_URL, finalUrl: SHELL_URL, httpStatus: 200}}});
  expect(site_.trace.filter(e => JSON.stringify([e.url, e.body]).includes(SESSKEY)).every(e => e.method === 'POST' && e.url === SERVICE_URL && !(e.body ?? '').includes(SESSKEY))).toBe(true);
  // Data minimisation in the SQLite file and the snapshot.
  const bytes = await backend.bytes();
  for (const value of [SESSKEY, 'DEMO101', 'redacted', 'Fictional Term 2028', 'moodle.example.invalid']) {
    expect(bytes).not.toContain(value);
    expect(JSON.stringify(snapshot)).not.toContain(value);
  }
  app.worker.dispose();
}, 60000);

it('re-discovery keeps every course, the selection and the existing records', async () => {
  const backend = await realBackend();
  const clock = fresh();
  let response = inprogress;
  const site_ = moodle(clock, site(() => json(response)));
  const app = install(backend, clock, site_.fetcher);
  expect((await app.bridge(1, 'discoverCourses')).result).toMatchObject({found: 3});
  let snapshot = await backend.get('/api/snapshot');
  const id = (source: string) => snapshot.courses.find((c: any) => c.discovery?.sourceCourseId === source).id;
  expect((await backend.write('PUT', '/api/tracked-courses', [id('9002')])).status).toBe(200);
  expect((await backend.write('POST', '/api/personal-events', {courseId: id('9002'), title: 'Invented study block', type: 'other', date: {kind: 'date', date: '2028-03-20'}})).status).toBe(200);
  snapshot = await backend.get('/api/snapshot');
  const assessment = snapshot.assessments.find((a: any) => a.courseId === id('9002'));
  expect((await backend.write('PATCH', `/api/assessments/${assessment.id}/overlay`, {completed: true})).status).toBe(200);
  const before = await backend.get('/api/snapshot');
  const parsed = JSON.parse(inprogress);
  parsed[0].data.courses = parsed[0].data.courses.filter((c: any) => c.id !== 9002);
  response = JSON.stringify(parsed);
  for (let run = 0; run < 2; run++) {
    const reply = await app.bridge(1, 'discoverCourses');
    expect(reply.result).toMatchObject({found: 2, coverage: 'complete'});
    const after = await backend.get('/api/snapshot');
    expect(discovered(after)).toEqual(['9001', '9002', '9003']);
    expect(after.settings.trackedCourseIds).toEqual([id('9002')]);
    for (const key of ['courses', 'assessments', 'overlays', 'candidates', 'settings']) expect(after[key]).toEqual(before[key]);
  }
  app.worker.dispose();
}, 60000);

it('demo dataset: the fixed demo message, no Moodle request and no backend write', async () => {
  const backend = new Backend('demo', true); await backend.start();
  expect((await backend.get('/api/connection')).state).toBe('demo');
  const clock = fresh();
  const site_ = moodle(clock, site());
  const app = install(backend, clock, site_.fetcher);
  const before = await backend.get('/api/snapshot');
  expect((await app.bridge(1, 'discoverCourses')).result).toEqual({message: DEMO});
  expect(site_.trace).toEqual([]);
  expect(app.writes()).toEqual([]);
  // Only the installed worker's own background calls (queue, scan, reminders) write; discovery none.
  expect(app.backendTrace.filter(r => r.method !== 'GET' && !/^\/api\/(queue|scan|reminders)\//.test(r.path))).toEqual([]);
  const after = await backend.get('/api/snapshot');
  for (const key of ['courses', 'settings', 'assessments', 'overlays']) expect(after[key]).toEqual(before[key]);
  app.worker.dispose();
}, 60000);

/**
 * #41 repo check "one request at a time": a #20 scan (Sync all), this #82 discovery and
 * one explicit material download run at the same time. The download's transfer page
 * (runTransfer) takes its lease from the installed worker over a fake
 * chrome.runtime.connect port and uses the same injected Moodle fetch, so the trace
 * covers every Moodle request of the worker and the page. It lives in this file so its
 * backend starts after the others here, not in parallel with other suites.
 */
it('#41: a download, a #20 scan and a #82 discovery at the same time: at most 1 in-flight Moodle request, starts >= 1000 ms apart', async () => {
  const backend = new Backend('download'); await backend.start();
  const CMID = '990104', VIEW = `${ORIGIN}/mod/resource/view.php?id=${CMID}`;
  const FILE = `${ORIGIN}/pluginfile.php/55001/mod_resource/content/1/fixture-document.pdf`;
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const r = await backend.write(method, route, body);
    if (!r.ok) throw Error(`${method} ${route} ${r.status} ${await r.text()}`);
    return r.json();
  };
  // Fixture setup: two tracked courses, and one collected PDF resource linked as its exact view.php?id=<cmid>.
  const seeded = await call('/api/courses/discovery', 'POST', {observations: ['9001', '9002'].map(id => ({sourceCourseId: id, sourceUrl: `${ORIGIN}/course/view.php?id=${id}`,
    title: {kind: 'known', value: `Fictional course ${id}`}, termIndicators: {kind: 'unknown'}}))});
  const ids = seeded.courses.filter((c: any) => c.discovery).map((c: any) => c.id);
  expect((await backend.write('PUT', '/api/tracked-courses', ids)).status).toBe(200);
  const ctx = await backend.get('/api/backups/restore-context');
  const data = await backend.get('/api/snapshot');
  const at = '2028-03-01T10:00:00Z';
  data.collection = {reviews: [], refreshes: [], records: [{id: 'r-pdf', courseId: ids[0], kind: 'material', firstObservedAt: at, lastObservedAt: at, observations: [{
    sourcePageUrl: `${ORIGIN}/course/view.php?id=9001`, sourceUrl: VIEW, destinationUrl: VIEW, observedAt: at, location: 'course.material',
    sourceCourseId: '9001', sourceCourseModuleId: CMID, sourceModuleType: 'resource', resourceKey: JSON.stringify([ORIGIN, '9001', 'resource', 'module', CMID]),
    kind: 'file', title: {kind: 'known', value: 'Lecture 1'}, section: {kind: 'unknown'}, fileType: {kind: 'known', value: 'pdf'}, mimeType: {kind: 'unknown'}, references: []}]}]};
  await call('/api/backups/restore', 'POST', {idempotencyKey: 'seed-material-1', expectedDatasetId: ctx.datasetId, expectedEpoch: ctx.epoch, expectedRevision: ctx.revision,
    backup: {app: 'moodle-helper', version: 1, exportedAt: at, note: '', datasetId: ctx.datasetId, data}});
  expect((await backend.get('/api/collection-context')).mode).toBe('verified');
  const datasetId = (await backend.get('/api/backups/restore-context')).datasetId;

  const coursePage = await readFile(path.join(fixtures, 'observed/course-page.html'), 'utf8');
  const clock = fresh();
  const discovery = site();
  const site_ = moodle(clock, (method, url, attempt, body) => {
    const course = /course\/view\.php\?id=(\d+)$/.exec(url)?.[1];
    if (course) return ok(coursePage.replaceAll('course-9001', `course-${course}`).replace(/<li class="activity[\s\S]*?<\/li>/g, ''));
    if (method === 'GET' && url === VIEW) return {status: 200, body: '%PDF-1.7\n1 0 obj\n%%EOF', finalUrl: FILE, contentType: 'application/pdf',
      headers: {'content-disposition': 'inline; filename="fixture-document.pdf"'}};
    return discovery(method, url, attempt, body);
  });
  // The installed extension as in install(), plus tabs and runtime.onConnect, the two Chrome APIs the download path adds.
  const connects: ((port: LeasePort) => void)[] = [], tabs: any[] = [];
  const messages: any[] = [], offscreen: any[] = [];
  const runtime: any = {id: 'discovery-test', getURL: (p: string) => `chrome-extension://discovery-test/${p}`,
    onMessage: {addListener: (f: any) => messages.push(f)}, onStartup: {addListener: () => {}}, onInstalled: {addListener: () => {}},
    onConnect: {addListener: (f: any) => connects.push(f)},
    sendMessage: (message: unknown, callback: (reply: unknown) => void) => { for (const listener of offscreen) listener(message, {id: 'discovery-test'}, callback); }};
  const chrome: any = {runtime, alarms: {create: () => {}, clear: () => {}, onAlarm: {addListener: () => {}}},
    tabs: {create: (o: any, cb?: (tab: {id: number}) => void) => { tabs.push(o); cb?.({id: 41}); }},
    permissions: {contains: (_: unknown, cb: (allowed: boolean) => void) => cb(true)},
    offscreen: {createDocument: async () => { installOffscreen({id: 'discovery-test', onMessage: {addListener: (f: any) => offscreen.push(f)}}); }}};
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => fetch(String(input).replace('http://127.0.0.1:8000', backend.base), init)) as typeof fetch;
  const worker = installExtension(chrome, {base: backend.base, fetcher,
    liveScan: {moodleFetch: site_.fetcher, now: () => clock.now, wait: async (ms: number) => { clock.now += ms; await pause(0); }}});
  let request = 0;
  const bridge = async (tab: number, operation: string, payload: unknown = {}) => {
    const sender = {id: 'discovery-test', frameId: 0, tab: {id: tab}, documentId: `document-${tab}`, url: 'http://127.0.0.1:5173/'};
    const send = (message: any) => new Promise<any>(resolve => { messages[0](message, sender, resolve); });
    const common = {source: 'moodle-helper-web', type: 'request', version: '1', clientId: `tab-${tab}`};
    const hello = await send({...common, requestId: `r-${tab}-${++request}`, operation: 'hello', payload: {}});
    return send({...common, requestId: `r-${tab}-${++request}`, operation, sessionId: hello.result.sessionId, payload});
  };

  // Sync all starts the scan; while its first request runs, the student clicks Find my courses and Download PDF.
  expect((await bridge(1, 'syncAll')).ok).toBe(true);
  for (let i = 0; i < 400 && !site_.starts().length; i++) await pause(10);
  const found = bridge(2, 'discoverCourses');
  const started = await bridge(3, 'startMaterialDownload', {datasetId, materialId: 'r-pdf', idempotencyKey: 'click-1'});
  expect(started.result).toMatchObject({supported: true, transfer: {state: 'queued'}});
  const transferId = started.result.transfer.transferId as string;
  expect(tabs).toEqual([{url: `chrome-extension://discovery-test/transfer.html#${transferId}`, active: true}]);

  // The transfer page opened for that transfer: its lease port carries that tab's sender.
  const sender = {id: 'discovery-test', url: `chrome-extension://discovery-test/transfer.html#${transferId}`, frameId: 0, tab: {id: 41}};
  const connect = (): LeaseClientPort => {
    const toPage = {msg: [] as ((m: any) => void)[], disc: [] as (() => void)[]}, toWorker = {msg: [] as ((m: any) => void)[], disc: [] as (() => void)[]};
    let open = true;
    connects[0]!({name: 'moodle-transfer-lease', sender,
      postMessage: m => { if (open) { const c = structuredClone(m); queueMicrotask(() => toPage.msg.forEach(f => f(c))); } },
      disconnect: () => { if (open) { open = false; queueMicrotask(() => toPage.disc.forEach(f => f())); } },
      onMessage: {addListener: f => toWorker.msg.push(f)}, onDisconnect: {addListener: f => toWorker.disc.push(f)}});
    return {postMessage: m => { if (!open) throw Error('closed'); const c = structuredClone(m); queueMicrotask(() => toWorker.msg.forEach(f => f(c))); },
      disconnect: () => { if (open) { open = false; queueMicrotask(() => toWorker.disc.forEach(f => f())); } },
      onMessage: {addListener: f => toPage.msg.push(f)}, onDisconnect: {addListener: f => toPage.disc.push(f)}};
  };
  const listeners = new Set<(d: DownloadDelta) => void>();
  const downloads: any[] = [];
  const view = await runTransfer(transferId, {
    api: {
      descriptor: t => call(`/api/material-downloads/${t}/descriptor`, 'POST'),
      read: t => call(`/api/material-downloads/${t}`),
      report: (t, b) => call(`/api/material-downloads/${t}/status`, 'POST', b),
    },
    fetcher: site_.fetcher as any, lease: leaseRequester(connect),
    parseHtml: html => new DOMParser().parseFromString(html, 'text/html'),
    downloads: {
      download: async (o: any) => { downloads.push(o); setTimeout(() => listeners.forEach(f => f({id: 5, state: {current: 'complete'}})), 5); return 5; },
      cancel: async () => {}, search: async () => [],
      onChanged: {addListener: (f: any) => listeners.add(f), removeListener: (f: any) => listeners.delete(f)},
    },
    blobs: {create: () => 'blob:transfer/1', revoke: () => {}},
    render: () => {}, pollMs: 50, closed: new AbortController().signal,
  });
  expect((await found).result).toMatchObject({found: 3, coverage: 'complete'});
  expect(view.phase).toBe('complete');
  expect(downloads).toEqual([{url: 'blob:transfer/1', filename: 'fixture-document.pdf', conflictAction: 'uniquify', saveAs: false}]);
  expect(await call(`/api/material-downloads/${transferId}`)).toMatchObject({state: 'complete', downloadId: 5});

  const urls = site_.starts().map(e => e.url);
  expect(urls.filter(u => u === VIEW)).toHaveLength(1);
  expect(urls.filter(u => u === SHELL_URL || u === SERVICE_URL)).toEqual([SHELL_URL, SERVICE_URL]);
  expect(urls.some(u => /course\/view\.php\?id=900[12]$/.test(u))).toBe(true);
  // At most one in-flight Moodle request across the worker and the transfer page; starts >= 1 s apart.
  expect(site_.maxActive()).toBe(1); spacing(site_.starts());
  const events = site_.trace.map(e => e.event);
  for (let i = 0; i < events.length; i += 2) expect(events.slice(i, i + 2)).toEqual(['start', 'end']);
  worker.dispose();
}, 90000);
