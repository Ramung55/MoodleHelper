// @vitest-environment jsdom
/**
 * #46 AC1 repo checks for the read-only SDU sign-in probe, through the installed extension
 * entry (installExtension), its bridge, the #20 request authority, the offscreen document
 * and #82's discovery page source, against real loopback HTTP and a file SQLite backend
 * (tests/live_scan_network_app.py). Moodle is an injected fetch serving #20's observed
 * login fixtures and #82's synthetic /my/courses.php shell (invented sesskey); time is an
 * injected clock. No real Moodle site, Chrome or account is used. Response variants
 * written inline below (user name/id, policy page, oversized body) are INVENTED.
 */
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, readFile, mkdir, readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, afterEach, beforeAll, expect, it, vi} from 'vitest';
import {installExtension} from '../extension/src/index';
import {installOffscreen} from '../extension/src/offscreen';
import {createWorker} from '../extension/src/dashboard-bridge';
import {validResult} from '../shared/src/bridge';
import {CLEANUP_TIMEOUT_MS, cleanUp, removeTemporaryDirectory, stopBackend, stopBackends} from './backend-cleanup';

const root = path.resolve(import.meta.dirname, '..');
const python = path.join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const fixtures = path.join(root, 'tests/fixtures/moodle');
const ORIGIN = 'https://moodle.sdu.edu.kz';
/** #93: the dataset account of tests/live_scan_network_app.py, the invented id of observed/m-cfg-user-id.txt. */
const ACCOUNT = '987650';
const SHELL_URL = `${ORIGIN}/my/courses.php`;
const SESSKEY = '0InventedFixtureKey0';
const USER = 'Invented Student Example', USER_ID = '7350001';
const OUT = {state: 'signed_out', source: 'sdu_session_probe', context: 'my_courses'};
const IN = {state: 'signed_in', source: 'sdu_session_probe', context: 'my_courses'};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const FILE = 'sign-in-probe.test.ts';
let dir: string;
let shell: string, loginPage: string, loginRedirect: any, coursePage: string;
const running: Backend[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sign-in-probe-'));
  // #82's synthetic shell, plus an INVENTED user name and id the probe must never pass on.
  shell = (await readFile(path.join(fixtures, 'my-courses-shell.html'), 'utf8'))
    .replace('</dl>', `</dl><span class="usertext">${USER}</span><script>M.cfg={"userid":${USER_ID}};</script>`);
  loginPage = await readFile(path.join(fixtures, 'observed/login-page.html'), 'utf8');
  loginRedirect = JSON.parse(await readFile(path.join(fixtures, 'observed/login-redirect-course.json'), 'utf8'));
  coursePage = await readFile(path.join(fixtures, 'observed/course-page.html'), 'utf8');
  expect(shell).toContain(`"sesskey":"${SESSKEY}"`);
  expect(loginPage).toMatch(/<body[^>]*id="page-login-index"[^>]*lang-ru/);
});
afterAll(() => cleanUp(FILE, () => stopBackends(FILE, running), () => removeTemporaryDirectory(dir)), CLEANUP_TIMEOUT_MS);
afterEach(() => { vi.restoreAllMocks(); });

class Backend {
  child?: ChildProcess; base = ''; port = 0; db: string;
  constructor(public name: string, public demo = false) {
    this.db = path.join(dir, name, demo ? 'demo.sqlite3' : 'live-scan.sqlite3');
  }
  async start() {
    await mkdir(path.dirname(this.db), {recursive: true});
    const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
    this.port = (listener.address() as {port: number}).port; await new Promise<void>(r => listener.close(() => r()));
    this.base = `http://127.0.0.1:${this.port}`;
    const env = this.demo
      ? {...process.env, MOODLE_HELPER_DATABASE_URL: `sqlite:///${this.db.replaceAll('\\', '/')}`, MOODLE_HELPER_DATASET: 'demo'}
      : {...process.env, LIVE_SCAN_TEST_DATABASE: this.db};
    this.child = spawn(python, ['-m', 'uvicorn', this.demo ? 'backend.main:app' : 'tests.live_scan_network_app:app', '--host', '127.0.0.1', '--port', String(this.port)],
      {cwd: root, windowsHide: true, stdio: 'pipe', env});
    let log = ''; this.child.stderr?.on('data', d => log += d);
    running.push(this);
    for (let i = 0; i < 300; i++) { try { if ((await fetch(this.base + '/api/bridge-context')).ok) return; } catch {} if (this.child.exitCode !== null) break; await pause(50); }
    throw Error(log);
  }
  async stop() { await stopBackend(FILE, this.child, this.port); }
  async binding() { return (await (await fetch(this.base + '/api/bridge-context')).json()).binding as string; }
  async write(method: string, route: string, body?: unknown) {
    return fetch(this.base + route, {method, headers: {'Content-Type': 'application/json', 'X-Moodle-Helper-Bridge-Binding': await this.binding()}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  async get(route: string) { return (await fetch(this.base + route)).json(); }
  /** Every byte of the SQLite database files (main file, WAL and journal). */
  async bytes() {
    const names = (await readdir(path.dirname(this.db))).filter(n => n.startsWith(path.basename(this.db)));
    return (await Promise.all(names.map(n => readFile(path.join(path.dirname(this.db), n), 'latin1')))).join('');
  }
}

type Reply = {status: number; body: string; finalUrl?: string; contentType?: string | null; headers?: Record<string, string>};
type Route = (method: string, url: string, attempt: number) => Reply | 'hang-abortable' | 'network-error';
type Event = {event: 'start' | 'end' | 'abort'; method: string; url: string; at: number; init?: RequestInit};
/** Injected Moodle fetch: start/end events on the injected clock, and the in-flight count. */
function moodle(clock: {now: number}, route: Route) {
  const trace: Event[] = [];
  const attempts = new Map<string, number>();
  let active = 0, maxActive = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    const key = method + ' ' + url, attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
    active++; maxActive = Math.max(maxActive, active);
    trace.push({event: 'start', method, url, at: clock.now, ...(init ? {init} : {})});
    const reply = route(method, url, attempt);
    if (reply === 'hang-abortable') return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => {
      active--; trace.push({event: 'abort', method, url, at: clock.now}); reject(new DOMException('Aborted', 'AbortError'));
    }));
    await pause(2); clock.now += 150;
    if (reply === 'network-error') { active--; trace.push({event: 'end', method, url, at: clock.now}); throw new TypeError('Failed to fetch'); }
    const contentType = reply.contentType === undefined ? 'text/html; charset=utf-8' : reply.contentType;
    const response = new Response(reply.body, {status: reply.status, headers: {...(contentType ? {'content-type': contentType} : {}), ...reply.headers}});
    Object.defineProperty(response, 'url', {value: reply.finalUrl ?? url});
    active--; trace.push({event: 'end', method, url, at: clock.now});
    return response;
  }) as typeof fetch;
  return {fetcher, trace, starts: () => trace.filter(e => e.event === 'start'), maxActive: () => maxActive};
}
/** Only the shell GET is answered; any other Moodle request fails the check. */
const only = (reply: (attempt: number) => Reply | 'hang-abortable' | 'network-error'): Route => (method, url, attempt) => {
  if (method === 'GET' && url === SHELL_URL) return reply(attempt);
  throw Error('Unexpected Moodle request ' + method + ' ' + url);
};

/** The installed extension, with fake Chrome events, recorded backend traffic and an in-process offscreen document. */
function install(backend: Backend, clock: {now: number}, moodleFetch: typeof fetch, extra: Record<string, unknown> = {}) {
  const messages: any[] = [], offscreen: any[] = [];
  const offscreenMessages: unknown[] = [], storageWrites: unknown[] = [], backendTrace: {method: string; path: string; body?: string}[] = [];
  const runtime: any = {id: 'probe-test', getURL: (p: string) => `chrome-extension://probe-test/${p}`,
    onMessage: {addListener: (f: any) => messages.push(f)}, onStartup: {addListener: () => {}}, onInstalled: {addListener: () => {}},
    sendMessage: (message: unknown, callback: (reply: unknown) => void) => { offscreenMessages.push(structuredClone(message)); for (const listener of offscreen) listener(message, {id: 'probe-test'}, callback); }};
  const record = (...args: unknown[]) => storageWrites.push(args);
  const chrome: any = {runtime, alarms: {create: () => {}, clear: () => {}, onAlarm: {addListener: () => {}}},
    storage: {local: {set: record, get: (_: unknown, cb?: (v: unknown) => void) => cb?.({})}, session: {set: record, get: (_: unknown, cb?: (v: unknown) => void) => cb?.({})}},
    permissions: {contains: (_: unknown, cb: (allowed: boolean) => void) => cb(true)},
    offscreen: {createDocument: async () => { installOffscreen({id: 'probe-test', onMessage: {addListener: (f: any) => offscreen.push(f)}}); }}};
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input).replace('http://127.0.0.1:8000', backend.base));
    backendTrace.push({method: init?.method ?? 'GET', path: url.pathname, ...(typeof init?.body === 'string' ? {body: init.body} : {})});
    return fetch(url, init);
  }) as typeof fetch;
  const worker = installExtension(chrome, {base: backend.base, fetcher,
    liveScan: {moodleFetch, now: () => clock.now, wait: async (ms: number) => { clock.now += ms; await pause(0); }, ...extra}});
  let request = 0;
  const replies: unknown[] = [];
  const bridge = async (tab: number, operation: string, payload: unknown = {}) => {
    const sender = {id: 'probe-test', frameId: 0, tab: {id: tab}, documentId: `document-${tab}`, url: 'http://127.0.0.1:5173/'};
    const send = (message: any) => new Promise<any>(resolve => { messages[0](message, sender, resolve); });
    const common = {source: 'moodle-helper-web', type: 'request', version: '1', clientId: `tab-${tab}`};
    const hello = await send({...common, requestId: `r-${tab}-${++request}`, operation: 'hello', payload: {}});
    const reply = await send({...common, requestId: `r-${tab}-${++request}`, operation, sessionId: hello.result.sessionId, payload});
    replies.push(reply);
    return reply;
  };
  return {worker, bridge, replies, offscreenMessages, storageWrites, backendTrace};
}
function spacing(starts: {at: number}[]) {
  for (let i = 1; i < starts.length; i++) expect(starts[i]!.at - starts[i - 1]!.at).toBeGreaterThanOrEqual(1000);
}
/** One real-namespace backend and one forward-only clock: the durable gate keeps earlier pacing. */
const shared = {now: Date.parse('2028-03-05T10:00:00Z')};
const fresh = () => { shared.now += 300_000; return shared; };
let sharedBackend: Backend | undefined;
async function realBackend() {
  if (!sharedBackend) { sharedBackend = new Backend('real'); await sharedBackend.start(); }
  return sharedBackend;
}
const ok = (body: string): Reply => ({status: 200, body});

it('signed in: exactly one GET /my/courses.php with the #20 init flags, gate acquire and release around it; two tabs share it; nothing leaks or persists', async () => {
  const backend = await realBackend();
  const clock = fresh();
  const consoleCalls: unknown[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args) => { consoleCalls.push(args); });
  const site = moodle(clock, only(() => ok(shell)));
  const app = install(backend, clock, site.fetcher);
  const before = await backend.get('/api/snapshot');
  const [one, two] = await Promise.all([app.bridge(1, 'checkMoodleSignIn'), app.bridge(2, 'checkMoodleSignIn')]);
  for (const reply of [one, two]) expect(reply).toMatchObject({ok: true, result: {signal: IN}});
  expect(two.result).toEqual(one.result);
  expect(Object.keys(one.result).sort()).toEqual(['checkedAt', 'signal']);
  expect(one.result.checkedAt).toBe(new Date(clock.now).toISOString());
  const starts = site.starts();
  expect(starts.map(e => [e.method, e.url])).toEqual([['GET', SHELL_URL]]);
  expect(starts[0]!.init).toMatchObject({method: 'GET', credentials: 'include', redirect: 'follow', cache: 'no-store'});
  expect(starts[0]!.init!.body).toBeUndefined();
  expect(site.trace.some(e => /service(-nologin)?\.php/.test(e.url) || e.method !== 'GET')).toBe(false);
  const gate = app.backendTrace.filter(r => r.path.startsWith('/api/scan/gate/')).map(r => r.path).filter((p, i, all) => p !== all[i - 1]);
  expect(gate).toEqual(['/api/scan/gate/acquire', '/api/scan/gate/release']);
  // Only the reduced envelope reaches the offscreen document.
  expect(app.offscreenMessages).toHaveLength(1);
  expect(app.offscreenMessages[0]).toMatchObject({type: 'access', request: {route: 'my-courses', body: {id: '', classes: []}, envelope: {requestedUrl: SHELL_URL, finalUrl: SHELL_URL, httpStatus: 200}}});
  // No backend write of the probe's own (the worker's background queue/scan calls aside).
  expect(app.backendTrace.filter(r => r.method !== 'GET' && !/^\/api\/(queue|scan|reminders)\//.test(r.path))).toEqual([]);
  const after = await backend.get('/api/snapshot');
  for (const key of ['courses', 'settings', 'sync', 'collection']) expect(after[key]).toEqual(before[key]);
  const everywhere = JSON.stringify([app.replies, consoleCalls, app.storageWrites, app.offscreenMessages, app.backendTrace, after]);
  const bytes = await backend.bytes();
  for (const value of [SESSKEY, USER, USER_ID, 'sdu_session_probe']) {
    expect(bytes).not.toContain(value);
    if (value !== 'sdu_session_probe') expect(everywhere).not.toContain(value);
  }
  expect(app.storageWrites).toEqual([]);
  // Not persisted: a later check probes again.
  expect((await app.bridge(1, 'checkMoodleSignIn')).result.signal).toEqual(IN);
  expect(site.starts()).toHaveLength(2); spacing(site.starts());
  app.worker.dispose();
}, 60000);

it('signed out: the observed login redirect, a /my/courses.php login body and HTTP 401 each give the signed_out signal with no other request', async () => {
  const backend = await realBackend();
  const clock = fresh();
  const cases: Reply[] = [
    // observed/login-redirect-course.json with the requested URL set to /my/courses.php, and login-page.html.
    {status: loginRedirect.response.status, body: loginPage, finalUrl: ORIGIN + loginRedirect.response.finalPath, contentType: loginRedirect.response.contentType},
    {status: 200, body: loginPage, finalUrl: ORIGIN + loginRedirect.response.finalPath},
    {status: 200, body: loginPage, finalUrl: SHELL_URL},
    {status: 401, body: '<!doctype html><html><body></body></html>'},
  ];
  for (const reply of cases) {
    const site = moodle(clock, only(() => reply));
    const app = install(backend, clock, site.fetcher);
    expect((await app.bridge(1, 'checkMoodleSignIn')).result.signal).toEqual(OUT);
    expect(site.starts().map(e => [e.method, e.url])).toEqual([['GET', SHELL_URL]]);
    expect(JSON.stringify(app.offscreenMessages)).not.toContain('<');
    app.worker.dispose();
  }
}, 60000);

it('not verified: network error, timeout, 403, 5xx after the retries, non-HTML, a body over 1 MiB and another final path give no signal', async () => {
  const backend = await realBackend();
  const clock = fresh();
  const run = async (reply: (attempt: number) => Reply | 'hang-abortable' | 'network-error', extra: Record<string, unknown> = {}) => {
    const site = moodle(clock, only(reply));
    const app = install(backend, clock, site.fetcher, extra);
    const result = await app.bridge(1, 'checkMoodleSignIn');
    expect(result).toMatchObject({ok: true, result: {signal: null}});
    expect(site.maxActive()).toBe(1);
    expect(site.starts().every(e => e.method === 'GET' && e.url === SHELL_URL)).toBe(true);
    app.worker.dispose();
    return site;
  };
  expect((await run(() => 'network-error')).starts()).toHaveLength(1);
  const hung = await run(() => 'hang-abortable', {requestLimitMs: 300});
  expect(hung.trace.map(e => e.event)).toEqual(['start', 'abort']);
  expect((await run(() => ({status: 403, body: '<html><body id="page-site-index"></body></html>'}))).starts()).toHaveLength(1);
  expect((await run(() => ({status: 500, body: '<html><body></body></html>'}))).starts()).toHaveLength(1);
  // 503: three attempts (two #20 retries), then no signal.
  const busy = await run(() => ({status: 503, body: '<html><body></body></html>'}));
  expect(busy.starts()).toHaveLength(3); spacing(busy.starts());
  clock.now += 200_000;
  expect((await run(() => ({...ok('{"courses":[]}'), contentType: 'application/json'}))).starts()).toHaveLength(1);
  expect((await run(() => ({...ok('{}'), contentType: null}))).starts()).toHaveLength(1);
  // Over 1 MiB on /my/courses.php: truncated, so never classified as signed in.
  expect((await run(() => ok(shell.replace('</body>', 'x'.repeat(1_100_000) + '</body>')))).starts()).toHaveLength(1);
  // Over 1 MiB login page: truncated as well, no signal.
  await run(() => ({status: 200, body: loginPage + ' '.repeat(1_100_000), finalUrl: SHELL_URL}));
  // A 200 that ends on another path (an INVENTED site-policy page).
  await run(() => ({status: 200, body: '<html><body id="page-admin-tool-policy-index"></body></html>', finalUrl: `${ORIGIN}/admin/tool/policy/index.php`}));
}, 90000);

it('shares the request authority with a running #20 fixture scan: requests never overlap and start >= 1000 ms apart', async () => {
  const backend = new Backend('interleave'); await backend.start();
  const seeded = await backend.write('POST', '/api/courses/discovery', {observations: ['9001', '9002'].map(id => ({sourceCourseId: id, sourceUrl: `${ORIGIN}/course/view.php?id=${id}`,
    title: {kind: 'known', value: `Fictional course ${id}`}, termIndicators: {kind: 'unknown'}})), moodleUserId: ACCOUNT});
  const ids = (await seeded.json()).courses.map((c: any) => c.id);
  expect((await backend.write('PUT', '/api/tracked-courses', ids)).status).toBe(200);
  const clock = fresh();
  const site = moodle(clock, (method, url) => {
    const course = /course\/view\.php\?id=(\d+)$/.exec(url)?.[1];
    if (course) return ok(coursePage.replaceAll('course-9001', `course-${course}`).replace(/<li class="activity[\s\S]*?<\/li>/g, ''));
    if (url === `${ORIGIN}/calendar/view.php?view=upcoming`) return ok('<!doctype html><html lang="en"><head></head><body class="lang-en"></body></html>');
    if (method === 'GET' && url === SHELL_URL) return ok(shell);
    throw Error('Unexpected Moodle request ' + method + ' ' + url);
  });
  const app = install(backend, clock, site.fetcher);
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  // Under a loaded parallel run the scan can take a few seconds to make its first request.
  for (let i = 0; i < 3000 && !site.starts().length; i++) await pause(10);
  expect((await app.bridge(2, 'checkMoodleSignIn')).result.signal).toEqual(IN);
  // Let the scan read a few more pages after the probe.
  const seen = site.starts().length;
  for (let i = 0; i < 200 && site.starts().length < seen + 2; i++) await pause(10);
  const urls = site.starts().map(e => e.url);
  expect(urls[0]).toMatch(/course\/view\.php\?id=900[12]$/);
  expect(urls.filter(u => u === SHELL_URL)).toHaveLength(1);
  expect(site.trace.every(e => e.method === 'GET')).toBe(true);
  expect(site.maxActive()).toBe(1); spacing(site.starts());
  app.worker.dispose();
  // Each request ends before the next one starts (a scan request still in flight may close the trace).
  const events = site.trace.map(e => e.event);
  if (events.at(-1) === 'start') events.pop();
  for (let i = 0; i < events.length; i += 2) expect(events.slice(i, i + 2)).toEqual(['start', 'end']);
}, 60000);

it('demo dataset: no signal and no Moodle request', async () => {
  const backend = new Backend('demo', true); await backend.start();
  expect((await backend.get('/api/connection')).state).toBe('demo');
  const clock = fresh();
  const site = moodle(clock, only(() => ok(shell)));
  const app = install(backend, clock, site.fetcher);
  expect((await app.bridge(1, 'checkMoodleSignIn')).result).toMatchObject({signal: null});
  expect(site.trace).toEqual([]);
  expect(app.offscreenMessages).toEqual([]);
  app.worker.dispose();
  await backend.stop();
}, 60000);

it('bridge: closed reply only; an invalid reply is INVALID_RESPONSE, a non-empty payload VALIDATION, no session RECONNECT_REQUIRED', async () => {
  const at = '2028-03-05T10:00:00.000Z';
  expect(validResult('checkMoodleSignIn', {signal: null, checkedAt: at})).toBe(true);
  expect(validResult('checkMoodleSignIn', {signal: OUT, checkedAt: at})).toBe(true);
  for (const bad of [
    {signal: null}, {signal: null, checkedAt: 'yesterday'}, {signal: null, checkedAt: at, userid: USER_ID},
    {signal: {...IN, source: 'other'}, checkedAt: at}, {signal: {...IN, context: 'dashboard'}, checkedAt: at},
    {signal: {...IN, state: 'unknown'}, checkedAt: at}, {signal: {...IN, sesskey: SESSKEY}, checkedAt: at}, {message: 'x'},
  ]) expect(validResult('checkMoodleSignIn', bad)).toBe(false);
  let answer: unknown = {signal: {...IN, sesskey: SESSKEY}, checkedAt: at};
  const probe = vi.fn(async () => answer);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({version: '1', binding: 'a'.repeat(32)})));
  const handler = createWorker({runtimeId: 'extension', grant: async () => true, fetcher: fetcher as any, checkMoodleSignIn: probe as any});
  const sender = {id: 'extension', frameId: 0, tab: {id: 3}, documentId: 'doc-1', url: 'http://127.0.0.1:5173/'};
  const common = {source: 'moodle-helper-web', type: 'request', version: '1', clientId: 'client-1'};
  let n = 0;
  const hello = await handler({...common, requestId: `r${++n}`, operation: 'hello', payload: {}}, sender);
  const sessionId = hello!.result.sessionId;
  const ask = (payload: unknown = {}, session: string | null = sessionId) =>
    handler({...common, requestId: `r${++n}`, operation: 'checkMoodleSignIn', ...(session ? {sessionId: session} : {}), payload}, sender);
  expect((await ask())!.error?.code).toBe('INVALID_RESPONSE');
  expect(JSON.stringify(await ask())).not.toContain(SESSKEY);
  expect((await ask({force: true}))!.error?.code).toBe('VALIDATION');
  expect((await ask({}, null))!.error?.code).toBe('RECONNECT_REQUIRED');
  expect((await ask({}, 'unknown-session'))!.error?.code).toBe('RECONNECT_REQUIRED');
  expect(probe).toHaveBeenCalledTimes(2);
  answer = {signal: OUT, checkedAt: at};
  expect(await ask()).toMatchObject({ok: true, result: {signal: OUT, checkedAt: at}});
  // The probe has no backend path of its own: only hello read /api/bridge-context.
  expect(fetcher).toHaveBeenCalledTimes(1);
});
