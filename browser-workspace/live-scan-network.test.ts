// @vitest-environment jsdom
/**
 * #20 repo checks for the live scan path (AC1-AC4), through the installed
 * extension entry (installExtension), its alarm, startup and bridge wakes, the
 * production page source, request authority, offscreen analysis and live
 * registry, against real loopback HTTP and a file SQLite backend in the real
 * (non-demo) namespace. Moodle is an injected fetch serving the observed-structure
 * fixtures in tests/fixtures/moodle/observed/; time is an injected clock. No real
 * Moodle site, Chrome or account is used. The recorded trace is of actual fetch
 * starts and ends.
 */
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, writeFile, readFile, mkdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, expect, it} from 'vitest';
import {installExtension} from '../extension/src/index';
import {installOffscreen} from '../extension/src/offscreen';
import {installPopup} from '../extension/src/popup';
import {analyzeMoodlePage, type AnalysisRequest, type AnalysisResult} from '../extension/src/moodle-page-analysis';
import {BACKEND} from '../extension/src/dashboard-bridge';
import {formatInstant} from '../shared/src/full-sync';
import {JSDOM} from '../frontend/node_modules/jsdom/lib/api.js';
import {buildMaterialLibrary} from '../frontend/src/domain/material-library';
import {downloadable} from '../frontend/src/domain/material-transfer';
import {CLEANUP_TIMEOUT_MS, cleanUp, removeTemporaryDirectory, stopBackend, stopBackends} from './backend-cleanup';

const root = path.resolve(import.meta.dirname, '..');
const python = process.env.MH_TEST_PYTHON ?? path.join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const fixtures = path.join(root, 'tests/fixtures/moodle/observed');
const ORIGIN = 'https://moodle.sdu.edu.kz';
const SIGN_IN = 'Sign in to SDU Moodle to continue.';
/** #93: the dataset account of tests/live_scan_network_app.py, the invented id of observed/m-cfg-user-id.txt. */
const ACCOUNT = '987650';
const UNCONFIRMED = 'The Moodle account could not be confirmed. Earlier data was kept.';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const FILE = 'live-scan-network.test.ts';
let dir: string;
let html: Record<string, string>;
/** #93: the inline page configuration every signed-in fixture page is served with. */
let config: string;
const running: Backend[] = [];
const releaseHangs: (() => void)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'live-scan-'));
  html = {};
  for (const name of ['course-page.html', 'quiz-finished.html', 'not-found.html', 'login-page.html', 'assign-submitted.html',
    'assign-not-submitted.html', 'calendar-upcoming.html'])
    html[name] = await readFile(path.join(fixtures, name), 'utf8');
  config = (await readFile(path.join(fixtures, 'm-cfg-user-id.txt'), 'utf8')).trim();
  expect(config).toContain(`"userId":${ACCOUNT}}`);
  const login = JSON.parse(await readFile(path.join(fixtures, 'login-redirect-course.json'), 'utf8'));
  expect(login.response).toMatchObject({status: 200, finalPath: '/login/index.php'});
});
afterAll(() => cleanUp(FILE,
  () => releaseHangs.forEach(release => release()),
  () => stopBackends(FILE, running),
  () => removeTemporaryDirectory(dir)), CLEANUP_TIMEOUT_MS);

/** Observed course page for one course; other courses get their own course and module ids. */
function coursePage(course: string, change: (page: string) => string = page => page) {
  const page = course === '9001' ? html['course-page.html']!
    : html['course-page.html']!.replaceAll('course-9001', `course-${course}`).replace(/9901(\d\d)/g, `990${course.slice(-1)}$1`);
  return change(page);
}
function quizPage(course: string, cmid: string) {
  return html['quiz-finished.html']!.replace('cmid-990103', `cmid-${cmid}`).replace('course-9001', `course-${course}`);
}
/** #83: the observed assignment pages (990101 submitted, 990102 not submitted), renumbered for other courses. */
function assignPage(course: string, cmid: string) {
  const page = html[cmid.endsWith('01') ? 'assign-submitted.html' : 'assign-not-submitted.html']!;
  return page.replace(/cmid-9901(\d\d)/, `cmid-${cmid}`).replace('course-9001', `course-${course}`);
}
const quizzes = (course: string) => [`990${course.slice(-1)}03`, `990${course.slice(-1)}09`];
const assignments = (course: string) => [`990${course.slice(-1)}01`, `990${course.slice(-1)}02`];
const courseUrl = (course: string) => `${ORIGIN}/course/view.php?id=${course}`;
const quizUrl = (cmid: string) => `${ORIGIN}/mod/quiz/view.php?id=${cmid}`;
const assignUrl = (cmid: string) => `${ORIGIN}/mod/assign/view.php?id=${cmid}`;
const CALENDAR = `${ORIGIN}/calendar/view.php?view=upcoming`;
/** Every Moodle request of one course job: course page, assignments, quizzes and the upcoming calendar. */
const jobUrls = (course: string) => [courseUrl(course), ...assignments(course).map(assignUrl), ...quizzes(course).map(quizUrl), CALENDAR];

class Backend {
  child?: ChildProcess; base = ''; port = 0; db: string; clock?: string;
  constructor(public name: string, withClock = false) {
    this.db = path.join(dir, name, 'live-scan.sqlite3');
    if (withClock) this.clock = path.join(dir, name, 'clock');
  }
  async start() {
    await mkdir(path.dirname(this.db), {recursive: true});
    if (this.clock && !this.port) await writeFile(this.clock, '1000');
    if (!this.port) {
      const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
      this.port = (listener.address() as {port: number}).port; await new Promise<void>(r => listener.close(() => r()));
      this.base = `http://127.0.0.1:${this.port}`;
    }
    this.child = spawn(python, ['-m', 'uvicorn', 'tests.live_scan_network_app:app', '--host', '127.0.0.1', '--port', String(this.port)],
      {cwd: root, windowsHide: true, stdio: 'pipe', env: {...process.env, LIVE_SCAN_TEST_DATABASE: this.db, ...(this.clock ? {LIVE_SCAN_TEST_CLOCK: this.clock} : {})}});
    let log = ''; this.child.stderr?.on('data', d => log += d);
    if (!running.includes(this)) running.push(this);
    for (let i = 0; i < 300; i++) { try { if ((await fetch(this.base + '/api/bridge-context')).ok) return; } catch {} if (this.child.exitCode !== null) break; await pause(50); }
    throw Error(log);
  }
  async stop() { await stopBackend(FILE, this.child, this.port); }
  async tick(seconds: number) { await writeFile(this.clock!, String(Number(await readFile(this.clock!, 'utf8')) + seconds)); }
  async binding() { return (await (await fetch(this.base + '/api/bridge-context')).json()).binding as string; }
  async write(method: string, route: string, body?: unknown) {
    return fetch(this.base + route, {method, headers: {'Content-Type': 'application/json', 'X-Moodle-Helper-Bridge-Binding': await this.binding()}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  async get(route: string) { return (await fetch(this.base + route)).json(); }
  async sql(query: string): Promise<any[]> {
    const script = 'import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nprint(json.dumps(c.execute(sys.argv[2]).fetchall()))';
    return JSON.parse((await promisify(execFile)(python, ['-c', script, this.db, query], {windowsHide: true})).stdout);
  }
  /** Three Moodle-mapped courses; `selected` are tracked. Returns courseId by Moodle id. */
  async seed(selected: string[], all = ['9001', '9002', '9003']) {
    const response = await this.write('POST', '/api/courses/discovery', {observations: all.map(id => ({sourceCourseId: id, sourceUrl: courseUrl(id),
      title: {kind: 'known', value: `Fictional course ${id}`}, termIndicators: {kind: 'unknown'}})), moodleUserId: ACCOUNT});
    expect(response.status).toBe(200);
    const ids = Object.fromEntries((await response.json()).courses.map((c: any) => [c.discovery.sourceCourseId, c.id]));
    expect((await this.write('PUT', '/api/tracked-courses', selected.map(id => ids[id]))).status).toBe(200);
    return ids as Record<string, string>;
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
  async pages(jobId: string) { return this.get(`/api/scan/jobs/${jobId}/pages`); }
}

type Reply = {status: number; body: string; finalUrl?: string; contentType?: string; headers?: Record<string, string>};
type Route = (url: string, attempt: number) => Reply | 'hang' | 'hang-abortable';
/** Injected Moodle fetch: actual start/end events on the injected clock, and in-flight count. */
function moodle(clock: {now: number}, route: Route, hold?: Promise<void>) {
  const trace: {event: 'start' | 'end' | 'abort'; url: string; at: number}[] = [];
  const attempts = new Map<string, number>();
  let active = 0, maxActive = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(init).toMatchObject({method: 'GET', credentials: 'include', redirect: 'follow', cache: 'no-store'});
    expect(init?.body).toBeUndefined();
    const attempt = (attempts.get(url) ?? 0) + 1; attempts.set(url, attempt);
    active++; maxActive = Math.max(maxActive, active);
    trace.push({event: 'start', url, at: clock.now});
    if (hold) await hold;
    const reply = route(url, attempt);
    if (reply === 'hang') return new Promise<Response>(resolve => releaseHangs.push(() => resolve(new Response('', {status: 503}))));
    if (reply === 'hang-abortable') return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => {
      active--; trace.push({event: 'abort', url, at: clock.now}); reject(new DOMException('Aborted', 'AbortError'));
    }));
    await pause(2); clock.now += 150;
    const response = new Response(reply.body, {status: reply.status, headers: {'content-type': reply.contentType ?? 'text/html; charset=utf-8', ...reply.headers}});
    Object.defineProperty(response, 'url', {value: reply.finalUrl ?? url});
    active--; trace.push({event: 'end', url, at: clock.now});
    return response;
  }) as typeof fetch;
  return {fetcher, trace, starts: () => trace.filter(e => e.event === 'start'), maxActive: () => maxActive};
}
/** A signed-in page: the observed body plus the `M.cfg` script that shows the account (`id` replaces it). */
const signedIn = (body: string, id = ACCOUNT) => body.replace('</body>', `<script>${config.replace(`"userId":${ACCOUNT}`, `"userId":${id}`)}</script></body>`);
const ok = (body: string): Reply => ({status: 200, body: signedIn(body)});
/** The observed pages of the selected courses. */
const observedSite = (url: string): Reply => {
  const course = /course\/view\.php\?id=(\d+)$/.exec(url)?.[1];
  if (course) return ok(coursePage(course));
  const cmid = /mod\/quiz\/view\.php\?id=(\d+)$/.exec(url)?.[1];
  if (cmid) return ok(quizPage(`900${cmid.slice(3, 4)}`, cmid));
  const assign = /mod\/assign\/view\.php\?id=(\d+)$/.exec(url)?.[1];
  if (assign) return ok(assignPage(`900${assign.slice(3, 4)}`, assign));
  if (url === CALENDAR) return ok(html['calendar-upcoming.html']!);
  throw Error('Unexpected Moodle request ' + url);
};

/** The installed extension, with fake Chrome events and an in-process offscreen document. */
function install(backend: Backend, clock: {now: number}, moodleFetch: typeof fetch, extra: Record<string, unknown> = {}) {
  const alarms: ((alarm: {name: string}) => void)[] = [], startup: (() => void)[] = [], messages: any[] = [], offscreen: any[] = [];
  const created: unknown[] = [], tabs: unknown[] = [];
  const runtime: any = {id: 'live-scan-test', getURL: (p: string) => `chrome-extension://live-scan-test/${p}`,
    onMessage: {addListener: (f: any) => messages.push(f)}, onStartup: {addListener: (f: any) => startup.push(f)}, onInstalled: {addListener: () => {}},
    sendMessage: (message: unknown, callback: (reply: unknown) => void) => { for (const listener of offscreen) listener(message, {id: 'live-scan-test'}, callback); }};
  const chrome: any = {runtime, alarms: {create: () => {}, clear: () => {}, onAlarm: {addListener: (f: any) => alarms.push(f)}},
    tabs: {create: (o: unknown, cb?: (tab: {id: number}) => void) => { tabs.push(o); cb?.({id: 41}); }},
    permissions: {contains: (_: unknown, cb: (allowed: boolean) => void) => cb(true)},
    offscreen: {createDocument: async (options: unknown) => { created.push(options); installOffscreen({id: 'live-scan-test', onMessage: {addListener: (f: any) => offscreen.push(f)}}); }}};
  /** Every backend request of the worker and its bridge (method and path). */
  const requests: string[] = [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace('http://127.0.0.1:8000', backend.base);
    requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    return fetch(url, init);
  }) as typeof fetch;
  const worker = installExtension(chrome, {base: backend.base, fetcher,
    liveScan: {moodleFetch, now: () => clock.now, wait: async (ms: number) => { clock.now += ms; await pause(0); }, ...extra}});
  let request = 0;
  const bridge = async (tab: number, operation: string, payload: unknown = {}) => {
    const sender = {id: 'live-scan-test', frameId: 0, tab: {id: tab}, documentId: `document-${tab}`, url: 'http://127.0.0.1:5173/'};
    const send = (message: any) => new Promise<any>(resolve => { messages[0](message, sender, resolve); });
    const common = {source: 'moodle-helper-web', type: 'request', version: '1', clientId: `tab-${tab}`};
    const hello = await send({...common, requestId: `r-${++request}`, operation: 'hello', payload: {}});
    return send({...common, requestId: `r-${++request}`, operation, sessionId: hello.result.sessionId, payload});
  };
  return {worker, created, tabs, requests, messages, alarm: () => alarms[0]!({name: 'moodle-helper-mock-queue'}), startup: () => startup[0]!(), bridge};
}

function spacing(starts: {at: number}[]) {
  for (let i = 1; i < starts.length; i++) expect(starts[i]!.at - starts[i - 1]!.at).toBeGreaterThanOrEqual(1000);
}

it('AC1-AC3: Sync all scans only the selected courses, one Moodle request at a time, with durable readback', async () => {
  const backend = new Backend('ac1'); await backend.start();
  const ids = await backend.seed(['9001', '9002']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  let open!: () => void;
  const site = moodle(clock, observedSite, new Promise<void>(resolve => open = resolve));
  const first = install(backend, clock, site.fetcher);
  // Two dashboard tabs click Sync all while the alarm and startup wake fire: two runs share the jobs.
  // The first Moodle response is held until both tabs got their reply, so both runs link the same jobs.
  const [one, two] = await Promise.all([first.bridge(1, 'syncAll'), first.bridge(2, 'syncAll'), first.alarm(), first.startup()]);
  open();
  for (const reply of [one, two]) {
    expect(reply.ok).toBe(true);
    expect(reply.result.sync.filter((s: any) => s.status === 'syncing').map((s: any) => s.courseId).sort()).toEqual([ids['9001'], ids['9002']].sort());
  }
  const runs = await backend.settled(2);
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    expect(run.status).toBe('completed');
    expect(run.courseIds).toEqual([ids['9001'], ids['9002']].sort());
    expect(run.jobs.map((j: any) => j.courseId).sort()).toEqual([ids['9001'], ids['9002']].sort());
  }
  expect(runs[0].jobs.map((j: any) => j.id).sort()).toEqual(runs[1].jobs.map((j: any) => j.id).sort());
  // Only the selected course pages, the assignment and quiz pages discovered on them, each once,
  // and the upcoming calendar once per course job (#83).
  const urls = site.starts().map(e => e.url);
  expect([...urls].sort()).toEqual([...jobUrls('9001'), ...jobUrls('9002')].sort());
  expect(urls.filter(u => u === CALENDAR)).toHaveLength(2);
  expect(urls.some(u => u.includes('9003') || /pluginfile|mod\/(resource|url|forum|page|folder)\/|action=/.test(u))).toBe(false);
  expect(site.maxActive()).toBe(1);
  spacing(site.starts());
  expect(first.created).toEqual([{url: 'chrome-extension://live-scan-test/offscreen.html', reasons: ['DOM_PARSER'], justification: expect.any(String)}]);
  // AC2: page evidence per job, before and after a backend restart.
  const readback = async () => Object.fromEntries(await Promise.all(runs[0].jobs.map(async (j: any) => [j.courseId, await backend.pages(j.id)])));
  const before = await readback();
  const requestedAt = (url: string) => new Date(site.starts().find(e => e.url === url)!.at).toISOString();
  const calendarTimes: string[] = [];
  for (const course of ['9001', '9002']) {
    const {pages, incompleteReasons} = before[ids[course]!];
    const by = (type: string) => pages.filter((p: any) => p.pageType === type);
    const n = course.slice(-1);
    // #83 AC4: material is the course-page row with the material collector; checked means ok or partial
    // with a collector and the observedAt of its own request.
    expect(by('course')).toEqual([expect.objectContaining({collector: 'material', outcome: 'ok', coverage: 'complete', scope: 'supplied_pages_only',
      reasons: [], pageUrl: courseUrl(course), observedAt: requestedAt(courseUrl(course))})]);
    expect(by('assignment').map((p: any) => [p.pageUrl, p.collector, p.outcome, p.coverage, p.reasons])).toEqual(assignments(course).map(cm => [assignUrl(cm), 'assignment', 'ok', 'complete', []]));
    expect(by('quiz').map((p: any) => [p.pageUrl, p.outcome, p.coverage, p.reasons])).toEqual(quizzes(course).map(cm => [quizUrl(cm), 'ok', 'complete', []]));
    for (const page of [...by('quiz'), ...by('assignment')]) // observedAt is the time of that request
      expect(page.observedAt).toBe(requestedAt(page.pageUrl));
    const [calendar] = by('calendar');
    expect(by('calendar')).toHaveLength(1);
    expect(calendar).toMatchObject({collector: 'calendar', outcome: 'partial', coverage: 'partial', scope: 'supplied_ranges_only', reasons: ['undiscovered'], pageUrl: CALENDAR});
    calendarTimes.push(calendar.observedAt);
    // #94: each fetched assignment page also gives its submission status, with no extra request.
    expect(by('submission').map((p: any) => [p.pageUrl, p.collector, p.outcome, p.coverage, p.reasons, p.observedAt])).toEqual(
      assignments(course).map(cm => [assignUrl(cm), 'submission', 'ok', 'complete', [], requestedAt(assignUrl(cm))]));
    // Resource and URL pages are recorded without a request.
    expect(by('material').map((p: any) => [p.pageUrl, p.outcome, p.coverage, p.reasons])).toEqual(
      [`resource/view.php?id=990${n}04`, `resource/view.php?id=990${n}05`, `url/view.php?id=990${n}06`].map(tail => [`${ORIGIN}/mod/${tail}`, 'unavailable', 'none', ['unsupported_page', 'collector_unavailable']]));
    expect(by('unsupported')).toHaveLength(2);
    expect(pages.every((p: any) => ['quiz', 'assignment', 'submission', 'course'].includes(p.pageType) || p.coverage !== 'complete')).toBe(true);
    expect(incompleteReasons).toEqual(expect.arrayContaining(['collector_unavailable', 'undiscovered', 'unsupported_page']));
  }
  // Each course job's calendar row carries the time of its own calendar request.
  expect(calendarTimes.sort()).toEqual(site.starts().filter(e => e.url === CALENDAR).map(e => new Date(e.at).toISOString()).sort());
  const snapshot = await backend.get('/api/snapshot');
  for (const course of ['9001', '9002']) {
    const entry = snapshot.sync.find((s: any) => s.courseId === ids[course]);
    expect(entry).toMatchObject({status: 'partial', coverage: 'partial', progress: 100});
    expect(entry.lastSuccessAt).toBeTruthy();
  }
  expect(snapshot.sync.some((s: any) => s.courseId === ids['9003'])).toBe(false);
  expect(snapshot.assessments.filter((a: any) => a.type === 'quiz').map((a: any) => a.title).sort())
    .toEqual(['Fictional Recap Quiz', 'Fictional Recap Quiz', 'Fictional Warm-up Quiz', 'Fictional Warm-up Quiz']);
  // #83: the scanned courses' assignments show their real due dates from the assignment pages.
  const due = (iso: string) => ({kind: 'exact', iso, tz: 'Asia/Almaty'});
  for (const course of ['9001', '9002']) {
    const moodle = snapshot.reconciliation.logicalAssessments.filter((a: any) => a.courseId === ids[course] && a.type === 'assignment' && a.sources.some((s: any) => s.source === 'moodle'));
    expect(moodle.map((a: any) => [a.title, a.sources.find((s: any) => s.source === 'moodle').date]).sort()).toEqual([
      ['Fictional Essay Outline', due('2028-03-08T23:59:00+05:00')], ['Fictional Lab Report', due('2028-03-07T14:30:00+05:00')]]);
    // #94: observed/assign-submitted.html (990x01) and observed/assign-not-submitted.html (990x02).
    expect(moodle.map((a: any) => [a.title, a.submission?.status, a.submission?.evidence, a.submissionStale]).sort()).toEqual([
      ['Fictional Essay Outline', 'submitted', 'Submitted for grading', false],
      ['Fictional Lab Report', 'not_submitted', 'No submissions have been made yet', false]]);
  }
  const records = snapshot.collection.records;
  const submissions=records.filter((r: any) => r.kind === 'submission');
  expect(submissions).toHaveLength(4);
  for (const record of submissions) expect(record.observations.at(-1).attempted).not.toHaveProperty('sourceActivityId');
  expect(records.filter((r: any) => r.kind === 'calendar').map((r: any) => r.observations[0].activity.sourceCourseModuleId).sort()).toEqual(['990102', '990201']);
  expect(records.filter((r: any) => r.kind === 'material').map((r: any) => [r.observations[0].sourceCourseModuleId, r.observations[0].kind]).sort()).toEqual(
    [['990104', 'file'], ['990105', 'file'], ['990106', 'link'], ['990107', 'link'], ['990204', 'file'], ['990205', 'file'], ['990206', 'link'], ['990207', 'link']]);
  expect(snapshot.collection.refreshes.every((r: any) => r.evidenceMode === 'verified')).toBe(true);
  // #83 owner Chrome check: the course-page material list is stored as collected material records
  // (snapshot.collection.records), which the Materials page lists. The legacy Snapshot.materials list is
  // never written by a scan, so its count is 0 by design; the resource and URL pages themselves stay
  // unrequested (`unsupported_page`/`collector_unavailable` readback rows above).
  expect(snapshot.materials).toEqual([]);
  const library = buildMaterialLibrary(snapshot);
  expect(library).toHaveLength(8);
  for (const course of ['9001', '9002']) {
    const n = course.slice(-1);
    expect(library.filter(i => i.courseId === ids[course]).map(i => [i.provenance, i.kind, i.type, i.destination?.href]).sort()).toEqual([
      ['collected', 'file', 'pdf', `${ORIGIN}/mod/resource/view.php?id=990${n}04`], ['collected', 'file', 'pptx', `${ORIGIN}/mod/resource/view.php?id=990${n}05`],
      ['collected', 'link', 'link', `${ORIGIN}/mod/url/view.php?id=990${n}06`], ['collected', 'link', 'unknown', undefined]].sort());
  }
  await backend.stop(); await backend.start();
  expect(await readback()).toEqual(before);
  const afterRestart=await backend.get('/api/snapshot');
  expect(afterRestart.collection.records.filter((r: any) => r.kind === 'submission')).toEqual(submissions);
  // AC3(b): spacing holds across a service-worker restart (dispose, then a fresh install).
  first.worker.dispose();
  const lastStart = site.starts().at(-1)!.at;
  const second = install(backend, clock, site.fetcher);
  expect((await backend.write('POST', '/api/sync')).status).toBe(200);
  second.alarm();
  await backend.settled(3);
  const after = site.starts().slice(12);
  expect(after).toHaveLength(12);
  expect(after[0]!.at - lastStart).toBeGreaterThanOrEqual(1000);
  spacing(site.starts()); expect(site.maxActive()).toBe(1);
  second.worker.dispose();
}, 60000);

it('#46: the real dataset reports the verified collection mode the dashboard reads, and a bridged Sync all starts the scan without an alarm', async () => {
  const backend = new Backend('hello'); await backend.start();
  const ids = await backend.seed(['9001']);
  expect((await backend.get('/api/collection-context')).mode).toBe('verified');
  expect((await backend.get('/api/connection')).state).not.toBe('demo');
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock, observedSite);
  const app = install(backend, clock, site.fetcher);
  // No alarm or startup wake: the bridge's own wake after the 200 starts the queued job.
  const reply = await app.bridge(1, 'syncAll');
  expect(reply.ok).toBe(true);
  const [run] = await backend.settled(1);
  expect(run.status).toBe('completed');
  expect(run.courseIds).toEqual([ids['9001']]);
  expect(site.starts().map(e => e.url)).toContain(courseUrl('9001'));
  app.worker.dispose();
}, 60000);

it('#41 owner live check: a scanned PDF resource is offered the download and one bridged click queues its transfer', async () => {
  const backend = new Backend('download'); await backend.start();
  const ids = await backend.seed(['9001']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock, observedSite);
  const app = install(backend, clock, site.fetcher);
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  expect((await backend.settled(1))[0].status).toBe('completed');
  const snapshot = await backend.get('/api/snapshot');
  expect(snapshot.materials).toEqual([]);
  // The Materials page offers the control from the scanned records only: the PDF and PPTX
  // resources, never the links (#85 also never offers an unknown type).
  const library = buildMaterialLibrary(snapshot).filter(i => i.courseId === ids['9001']);
  expect(library.filter(downloadable).map(i => [i.type, i.destination?.href]).sort()).toEqual([
    ['pdf', `${ORIGIN}/mod/resource/view.php?id=990104`], ['pptx', `${ORIGIN}/mod/resource/view.php?id=990105`]]);
  const pdf = library.find(i => i.type === 'pdf')!;
  // One explicit click: the dashboard's bridged start with the scanned record's id.
  const {datasetId} = await backend.get('/api/local-context');
  const before = site.starts().length;
  const started = await app.bridge(2, 'startMaterialDownload', {datasetId, materialId: pdf.recordId, idempotencyKey: 'live-check-click'});
  expect(started.ok).toBe(true);
  expect(started.result).toMatchObject({supported: true, transfer: {state: 'queued', materialId: pdf.recordId}});
  const transferId = started.result.transfer.transferId as string;
  expect(app.tabs).toEqual([{url: `chrome-extension://live-scan-test/transfer.html#${transferId}`, active: true}]);
  // The backend resolved the scanned record in verified mode to its exact view.php?id=<cmid>.
  expect((await backend.get('/api/collection-context')).mode).toBe('verified');
  const descriptor = await (await backend.write('POST', `/api/material-downloads/${transferId}/descriptor`)).json();
  expect(descriptor).toMatchObject({url: `${ORIGIN}/mod/resource/view.php?id=990104`, format: 'pdf', materialId: pdf.recordId});
  expect(site.starts().length).toBe(before); // Registering a transfer makes no Moodle request.
  app.worker.dispose();
}, 60000);

it('AC2/AC4: forbidden, missing, non-topics and truncated pages are requested once and stay incomplete', async () => {
  const backend = new Backend('incomplete'); await backend.start();
  const ids = await backend.seed(['9001', '9002', '9003']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock, url => {
    if (url === courseUrl('9002')) return ok(coursePage('9002', page => page.replace('format-topics ', 'format-weeks ')));
    if (url === courseUrl('9003')) return ok(coursePage('9003', page => page.replace('</body>', `<p>${'x'.repeat(1_100_000)}</p></body>`)));
    if (url === quizUrl('990103')) return {status: 403, body: '<!doctype html><html lang="en"><body class="lang-en"></body></html>'};
    if (url === quizUrl('990109')) return {status: 404, body: html['not-found.html']!};
    return observedSite(url);
  });
  const app = install(backend, clock, site.fetcher);
  expect((await backend.write('POST', '/api/sync')).status).toBe(200);
  app.alarm();
  const [run] = await backend.settled(1);
  expect(run.jobs.every((j: any) => j.state === 'completed')).toBe(true);
  const urls = site.starts().map(e => e.url);
  expect([...urls].sort()).toEqual([...jobUrls('9001'), courseUrl('9002'), courseUrl('9003')].sort());
  const job = (course: string) => run.jobs.find((j: any) => j.courseId === ids[course]).id;
  const first = (await backend.pages(job('9001'))).pages;
  expect(first.find((p: any) => p.pageUrl === quizUrl('990103'))).toMatchObject({pageType: 'quiz', outcome: 'forbidden', coverage: 'none', reasons: ['forbidden']});
  expect(first.find((p: any) => p.pageUrl === quizUrl('990109'))).toMatchObject({pageType: 'quiz', outcome: 'failed', coverage: 'none', reasons: ['access_error']});
  for (const course of ['9002', '9003']) {
    const {pages, incompleteReasons} = await backend.pages(job(course));
    expect(pages.find((p: any) => p.pageUrl === courseUrl(course))).toMatchObject({outcome: 'failed', coverage: 'none', reasons: ['access_error']});
    expect(incompleteReasons).toEqual(expect.arrayContaining(['access_error', 'undiscovered']));
  }
  const snapshot = await backend.get('/api/snapshot');
  expect(snapshot.sync.map((s: any) => [s.status, s.coverage])).toEqual([['partial', 'partial'], ['partial', 'partial'], ['partial', 'partial']]);
  app.worker.dispose();
}, 60000);

it('AC3(c)(d): 503 and 429 retries wait 2 s and 5 s, or a longer Retry-After, with at most three attempts', async () => {
  const backend = new Backend('retry'); await backend.start();
  await backend.seed(['9001', '9002']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock, (url, attempt) => {
    if (url === courseUrl('9001') && attempt < 3) return {status: 503, body: '<html><body></body></html>'};
    if (url === courseUrl('9002') && attempt === 1) return {status: 429, body: '<html><body></body></html>', headers: {'Retry-After': '120'}};
    return observedSite(url);
  });
  const app = install(backend, clock, site.fetcher);
  expect((await backend.write('POST', '/api/sync')).status).toBe(200);
  app.alarm();
  const [run] = await backend.settled(1);
  expect(run.status).toBe('completed');
  const events = (url: string) => site.trace.filter(e => e.url === url);
  const flaky = events(courseUrl('9001'));
  expect(flaky.filter(e => e.event === 'start')).toHaveLength(3);
  expect(flaky[2]!.at - flaky[1]!.at).toBeGreaterThanOrEqual(2000); // retry 1 after the first failed request ended
  expect(flaky[4]!.at - flaky[3]!.at).toBeGreaterThanOrEqual(5000); // retry 2 after the second ended
  const limited = events(courseUrl('9002'));
  expect(limited.filter(e => e.event === 'start')).toHaveLength(2);
  expect(limited[2]!.at - limited[1]!.at).toBeGreaterThanOrEqual(120_000);
  expect(site.maxActive()).toBe(1); spacing(site.starts());
  app.worker.dispose();
}, 60000);

it('AC3(d)(e): a malformed Retry-After is not retried and an always-503 page fails after three attempts', async () => {
  for (const [name, header] of [['malformed', 'soon'], ['always', undefined]] as const) {
    const backend = new Backend(name); await backend.start();
    const ids = await backend.seed(['9001']);
    const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
    const site = moodle(clock, () => ({status: 503, body: '<html><body></body></html>', ...(header ? {headers: {'Retry-After': header}} : {})}));
    const app = install(backend, clock, site.fetcher);
    expect((await backend.write('POST', '/api/sync')).status).toBe(200);
    app.alarm();
    const [run] = await backend.settled(1);
    expect(site.starts()).toHaveLength(header ? 1 : 3);
    const evidence = await backend.pages(run.jobs[0].id);
    expect(evidence.incompleteReasons).toContain('request_failed');
    const entry = (await backend.get('/api/snapshot')).sync.find((s: any) => s.courseId === ids['9001']);
    if (header) {
      // No retry: the job fails with the fixed reason (and the gate stays occupied, fail closed).
      expect(run.jobs[0]).toMatchObject({state: 'failed', errorCode: 'request_failed'});
      expect(entry).toMatchObject({status: 'failed', error: 'Moodle could not be read for this course. Earlier data was kept.'});
    } else {
      // The page ends failed/request_failed after three attempts; the course stays incomplete.
      expect(evidence.pages.find((p: any) => p.pageUrl === courseUrl('9001'))).toMatchObject({outcome: 'failed', coverage: 'none', reasons: ['request_failed']});
      expect(entry).toMatchObject({status: 'partial', coverage: 'partial'});
    }
    // The trace is finite: later wakes find no work and make no request.
    app.alarm(); app.startup(); await pause(300);
    expect(site.starts()).toHaveLength(header ? 1 : 3);
    app.worker.dispose();
  }
}, 60000);

it('AC3(e)(f): a stalled request is aborted at the time limit; restarts reclaim the gate only after 30 s and the claim cap ends the job', async () => {
  // (f) A fetch that never answers is aborted at the (test-shortened) limit; the next start follows the settled abort.
  const backend = new Backend('abort'); await backend.start();
  await backend.seed(['9001']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock, (url, attempt) => url === courseUrl('9001') && attempt === 1 ? 'hang-abortable' : observedSite(url));
  const app = install(backend, clock, site.fetcher, {requestLimitMs: 300});
  expect((await backend.write('POST', '/api/sync')).status).toBe(200);
  app.alarm();
  const [run] = await backend.settled(1);
  expect(run.status).toBe('completed');
  const course = site.trace.filter(e => e.url === courseUrl('9001')).map(e => e.event);
  expect(course.slice(0, 3)).toEqual(['start', 'abort', 'start']);
  expect(site.trace.findIndex(e => e.event === 'abort')).toBeLessThan(site.trace.findIndex((e, i) => i > 0 && e.event === 'start'));
  const starts = site.trace.filter(e => e.url === courseUrl('9001') && e.event === 'start');
  expect(starts[1]!.at - site.trace.find(e => e.event === 'abort')!.at).toBeGreaterThanOrEqual(2000);
  app.worker.dispose();

  // (e) Worker crashes while a request never settles: each restart waits out the 30 s request limit
  // before reclaiming the gate, and the claim cap of 3 makes the trace finite.
  const crashing = new Backend('crash', true); await crashing.start();
  const ids = await crashing.seed(['9001']);
  const stalled = moodle(clock, () => 'hang');
  expect((await crashing.write('POST', '/api/sync')).status).toBe(200);
  const waitFor = async (count: number) => { for (let i = 0; i < 400 && stalled.starts().length < count; i++) await pause(25); };
  for (let claim = 1; claim <= 3; claim++) {
    const worker = install(crashing, clock, stalled.fetcher);
    if (claim > 1) { await pause(300); expect(stalled.starts()).toHaveLength(claim - 1); clock.now += 30_000; worker.alarm(); }
    await waitFor(claim);
    expect(stalled.starts()).toHaveLength(claim);
    worker.worker.dispose();
    await crashing.tick(61); // the crashed worker's lease expires
  }
  const starts3 = stalled.starts();
  for (let i = 1; i < starts3.length; i++) expect(starts3[i]!.at - starts3[i - 1]!.at).toBeGreaterThanOrEqual(30_000);
  const last = install(crashing, clock, stalled.fetcher);
  clock.now += 30_000; last.alarm();
  const [capped] = await crashing.settled(1);
  expect(capped.jobs[0]).toMatchObject({state: 'failed', errorCode: 'claim_limit', attempts: 3});
  expect(stalled.starts()).toHaveLength(3);
  expect((await crashing.get('/api/snapshot')).sync.find((s: any) => s.courseId === ids['9001']).status).toBe('failed');
  last.worker.dispose();
}, 90000);

it('AC4: a login redirect mid-scan fails the job and every unstarted job without a Moodle request', async () => {
  const backend = new Backend('login'); await backend.start();
  const ids = await backend.seed(['9001', '9002']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  let signedOut = false;
  const site = moodle(clock, url => {
    if (signedOut || url.includes('/mod/')) {
      signedOut = true;
      return {status: 200, body: html['login-page.html']!, finalUrl: `${ORIGIN}/login/index.php`};
    }
    return observedSite(url);
  });
  const app = install(backend, clock, site.fetcher);
  const reply = await app.bridge(1, 'syncAll');
  expect(reply.ok).toBe(true);
  const [run] = await backend.settled(1);
  expect(run.status).toBe('failed');
  expect(run.jobs.every((j: any) => j.state === 'failed' && j.errorCode === 'signed_out')).toBe(true);
  // One course page, then the first activity (assignment) page reached the login page; nothing for the other course.
  const urls = site.starts().map(e => e.url);
  expect(urls).toHaveLength(2);
  expect(urls[1]).toMatch(/mod\/assign\/view\.php/);
  const scanned = urls[0] === courseUrl('9001') ? '9001' : '9002', other = scanned === '9001' ? '9002' : '9001';
  expect(urls.some(u => u === courseUrl(other))).toBe(false);
  const job = (course: string) => run.jobs.find((j: any) => j.courseId === ids[course]).id;
  const failed = await backend.pages(job(scanned));
  expect(failed.pages.find((p: any) => p.pageUrl === urls[1])).toMatchObject({outcome: 'signed_out', reasons: ['signed_out']});
  expect(failed.signInGuidance).toBe(SIGN_IN);
  expect(await backend.pages(job(other))).toMatchObject({pages: [], incompleteReasons: ['signed_out'], signInGuidance: SIGN_IN});
  const snapshot = await backend.get('/api/snapshot');
  for (const course of ['9001', '9002'])
    expect(snapshot.sync.find((s: any) => s.courseId === ids[course])).toMatchObject({status: 'failed', error: SIGN_IN});
  // The one-minute alarm and later wakes cannot keep fetching the login page.
  for (let minute = 0; minute < 3; minute++) { clock.now += 60_000; app.alarm(); app.startup(); await pause(150); }
  expect(site.starts()).toHaveLength(2);
  app.worker.dispose();
}, 60000);

/** #93: the observed site, with each page showing `shown(url)` as its M.cfg user id, or no M.cfg when null. */
const showing = (shown: (url: string) => string | null): Route => url => {
  const reply = observedSite(url), id = shown(url);
  return {...reply, body: id === null ? reply.body.replace(/<script>M\.cfg[^<]*<\/script>/, '') : reply.body.replace(`"userId":${ACCOUNT}`, `"userId":${id}`)};
};

it('#93: a job whose pages disagree or show no id saves nothing, with the same Moodle requests as a saving job', async () => {
  for (const [name, shown] of [['disagree', (url: string) => url.includes('/mod/quiz/') ? '5550001' : ACCOUNT],
    ['none', () => null]] as const) {
    const backend = new Backend(`account-${name}`); await backend.start();
    const ids = await backend.seed(['9001']);
    const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
    const site = moodle(clock, showing(shown));
    const app = install(backend, clock, site.fetcher);
    expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
    const [run] = await backend.settled(1);
    expect(run.status).toBe('failed');
    expect(run.jobs).toEqual([expect.objectContaining({state: 'failed', errorCode: 'account_unconfirmed'})]);
    // The id comes only from pages the job requests anyway: the same URLs, each once.
    expect(site.starts().map(e => e.url).sort()).toEqual(jobUrls('9001').sort());
    const snapshot = await backend.get('/api/snapshot');
    expect(snapshot.sync.find((s: any) => s.courseId === ids['9001'])).toMatchObject({status: 'failed', error: UNCONFIRMED});
    expect(snapshot.collection?.records ?? []).toEqual([]);
    expect((await backend.pages(run.jobs[0].id)).pages).toEqual([]);
    app.worker.dispose();
  }
}, 90000);

it('#93: an always-503 course shows no id but keeps its request_failed page and partial status, and the other course still runs', async () => {
  const backend = new Backend('account-503'); await backend.start();
  const ids = await backend.seed(['9001', '9002']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  // A malformed Retry-After would keep the gate occupied (fail closed), so this uses plain 503s.
  const site = moodle(clock, url => url === courseUrl('9001') ? {status: 503, body: '<html><body></body></html>'} : observedSite(url));
  const app = install(backend, clock, site.fetcher);
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  const [run] = await backend.settled(1);
  const job = (course: string) => run.jobs.find((j: any) => j.courseId === ids[course]);
  expect(job('9001')).toMatchObject({state: 'completed'});
  expect(job('9001').errorCode).toBeUndefined();
  expect((await backend.pages(job('9001').id)).pages.find((p: any) => p.pageUrl === courseUrl('9001')))
    .toMatchObject({outcome: 'failed', coverage: 'none', reasons: ['request_failed']});
  expect(job('9002')).toMatchObject({state: 'completed'});
  expect(site.starts().map(e => e.url).filter(u => u !== courseUrl('9001')).sort()).toEqual(jobUrls('9002').sort());
  const snapshot = await backend.get('/api/snapshot');
  expect(snapshot.sync.find((s: any) => s.courseId === ids['9001'])).toMatchObject({status: 'partial', coverage: 'partial'});
  expect(snapshot.sync.find((s: any) => s.courseId === ids['9002'])).toMatchObject({status: 'partial'});
  // Only the course that showed the dataset account saved records.
  const saved = JSON.stringify(snapshot.collection?.records ?? []);
  expect(saved).toContain('"sourceCourseId":"9002"');
  expect(saved).not.toContain('"sourceCourseId":"9001"');
  app.worker.dispose();
}, 60000);

it('#93: another signed-in account fails the job and every unstarted job of the run without a Moodle request', async () => {
  const MISMATCH = 'The signed-in Moodle account is not the account of this dataset. Earlier data was kept.';
  const other = '5550001';
  const backend = new Backend('account-mismatch'); await backend.start();
  const ids = await backend.seed(['9001', '9002']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock, showing(() => other));
  const app = install(backend, clock, site.fetcher);
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  const [run] = await backend.settled(1);
  expect(run.status).toBe('failed');
  expect(run.jobs.every((j: any) => j.state === 'failed' && j.errorCode === 'account_mismatch')).toBe(true);
  // Only the first job's own pages were requested; the other course was never claimed.
  const urls = site.starts().map(e => e.url);
  const scanned = urls[0] === courseUrl('9001') ? '9001' : '9002', unclaimed = scanned === '9001' ? '9002' : '9001';
  expect([...urls].sort()).toEqual(jobUrls(scanned).sort());
  expect(run.jobs.find((j: any) => j.courseId === ids[unclaimed]).attempts).toBe(0);
  const snapshot = await backend.get('/api/snapshot');
  for (const course of ['9001', '9002'])
    expect(snapshot.sync.find((s: any) => s.courseId === ids[course])).toMatchObject({status: 'failed', error: MISMATCH});
  expect(snapshot.collection?.records ?? []).toEqual([]);
  // The received id is never stored or echoed.
  expect(await backend.sql('SELECT count(*) FROM scan_pages')).toEqual([[0]]);
  expect(JSON.stringify([snapshot, run, await backend.sql('SELECT * FROM queue_jobs')])).not.toContain(other);
  app.worker.dispose();
}, 60000);

it('AC4 owner live check: a Sync all after sign-out is classified from the response that was read, never from a reused analysis', async () => {
  const backend = new Backend('signed-out-after'); await backend.start();
  const ids = await backend.seed(['9001', '9002', '9003']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  let signedOut = false;
  // Signed out, SDU answers each tracked page with the observed login page: the redirect to
  // /login/index.php, or the login page served at the requested URL itself (body#page-login-index).
  const site = moodle(clock, url => !signedOut ? observedSite(url)
    : url.includes('/course/') ? {status: 200, body: html['login-page.html']!}
    : {status: 200, body: html['login-page.html']!, finalUrl: `${ORIGIN}/login/index.php`});
  // The offscreen analysis, but after sign-out it answers a page of a course it analyzed before
  // with that earlier result: a stale or reused analysis reply must not turn a login page into
  // accessible page evidence.
  const earlier = new Map<string, AnalysisResult>();
  const analyzed: string[] = [];
  let reuse = false;
  const analyze = async (request: AnalysisRequest) => {
    analyzed.push(request.envelope.requestedUrl);
    const key = `${request.sourceCourseId} ${request.envelope.requestedUrl}`;
    if (reuse && earlier.has(key)) return earlier.get(key)!;
    const result = await analyzeMoodlePage(request);
    earlier.set(key, result);
    return result;
  };
  const app = install(backend, clock, site.fetcher, {analyze});
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  // The one-minute alarm keeps waking the worker, as in Chrome, until the run settles.
  const settled = async (count: number) => {
    const alarm = setInterval(() => app.alarm(), 500);
    try { return await backend.settled(count); } finally { clearInterval(alarm); }
  };
  const [signedIn] = await settled(1);
  expect(signedIn.status).toBe('completed');
  const firstRequests = site.starts().length;
  // The owner signs out of SDU Moodle, then clicks Sync all again.
  signedOut = true; reuse = true; analyzed.length = 0;
  await pause(1100);
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  const run = (await settled(2)).at(-1);
  expect(run.status).toBe('failed');
  expect(run.jobs.map((j: any) => [j.state, j.errorCode])).toEqual([['failed', 'signed_out'], ['failed', 'signed_out'], ['failed', 'signed_out']]);
  // Exactly one Moodle request after sign-out: the first course page. The login page is never analyzed.
  const after = site.starts().slice(firstRequests).map(e => e.url);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatch(/course\/view\.php\?id=900[123]$/);
  expect(analyzed).toEqual([]);
  const scanned = /id=(\d+)$/.exec(after[0]!)![1]!;
  for (const course of ['9001', '9002', '9003']) {
    const job = run.jobs.find((j: any) => j.courseId === ids[course]);
    const readback = await backend.pages(job.id);
    expect(readback.signInGuidance).toBe(SIGN_IN);
    expect(readback.pages.some((p: any) => p.outcome === 'ok')).toBe(false);
    if (course === scanned) expect(readback.pages.find((p: any) => p.pageUrl === after[0])).toMatchObject({outcome: 'signed_out', reasons: ['signed_out']});
    else expect(readback).toMatchObject({pages: [], incompleteReasons: ['signed_out']});
  }
  const snapshot = await backend.get('/api/snapshot');
  for (const course of ['9001', '9002', '9003'])
    expect(snapshot.sync.find((s: any) => s.courseId === ids[course])).toMatchObject({status: 'failed', error: SIGN_IN});
  for (let minute = 0; minute < 3; minute++) { clock.now += 60_000; app.alarm(); app.startup(); await pause(150); }
  expect(site.starts().length).toBe(firstRequests + 1);
  app.worker.dispose();
}, 120000);

/** #21 AC2: every collector complete; #94: submission is read from the fetched assignment page. */
function allCompletePages(source: string) {
  const observedAt = '2028-03-05T10:00:00.000Z', n = source.slice(-1);
  const page = (pageType: string, collector: string, pageUrl: string, scope: string) => ({pageType, scope, outcome: 'ok', coverage: 'complete',
    reasons: [], observedAt, pageUrl, collector, result: {kind: collector, observations: [], reviews: [], diagnostics: [], pages: [], coverage: 'complete', scope}});
  return [page('course', 'material', courseUrl(source), 'supplied_pages_only'), page('material', 'material', courseUrl(source), 'supplied_pages_only'),
    page('assignment', 'assignment', assignUrl(`990${n}01`), 'visited_activity_only'),
    page('submission', 'submission', assignUrl(`990${n}01`), 'visited_activity_only'),
    page('calendar', 'calendar', CALENDAR, 'supplied_ranges_only'), page('quiz', 'quiz', quizUrl(`990${n}03`), 'visited_activity_only')];
}

/** The production popup (installPopup) in a fresh document against the loopback backend. */
async function popupText(backend: Backend) {
  const dom = new JSDOM('<p id="full-sync">No successful full sync yet.</p><div id="freshness"></div><div id="status"></div><button id="start"></button><button id="cancel"></button><button id="reconnect"></button><button id="example-retry"></button>', {url: 'https://extension.test'});
  const doc = dom.window.document;
  const popup = installPopup(doc, ((url: any, init: any) => fetch(String(url).replace(BACKEND, backend.base), init)) as typeof fetch, dom.window.localStorage);
  try {
    for (let i = 0; i < 200 && !doc.getElementById('freshness')!.textContent; i++) await pause(25);
    const text = doc.body.textContent!;
    expect(text).not.toMatch(/mock/i);
    return {full: doc.getElementById('full-sync')!.textContent!, text};
  } finally { popup.dispose(); dom.window.close(); }
}

it('AC2 (#21): the popup claims a full sync only once every collector completed and keeps it with a later failed attempt', async () => {
  const backend = new Backend('freshness'); await backend.start();
  const ids = await backend.seed(['9001', '9002']);
  const selected = [ids['9001']!, ids['9002']!];
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const first = install(backend, clock, moodle(clock, observedSite).fetcher);
  expect((await first.bridge(1, 'syncAll')).ok).toBe(true);
  await backend.settled(1); first.worker.dispose();
  const entries = async () => (await backend.get('/api/snapshot')).sync.filter((s: any) => selected.includes(s.courseId));
  // (a) #20's fixture scan is partial: no full sync, one completed-scan line per course and the page refresh.
  let shown = await popupText(backend);
  expect(shown.full).toBe('No successful full sync yet.');
  expect(shown.text.match(/Last completed scan \(partial coverage\): /g)).toHaveLength(2);
  expect(shown.text).toContain('Latest page refresh: ');
  expect(shown.text).not.toMatch(/Successful full sync|Last failed scan attempt|fictional/);
  // (b) Every collector complete (#94: submission included): a full sync, kept after restart.
  expect((await backend.write('POST', '/api/sync')).status).toBe(200);
  for (let claim; (claim = (await (await backend.write('POST', '/api/scan/claim', {})).json()).claim);) {
    const finish = await backend.write('POST', '/api/scan/finish', {jobId: claim.job.id, generation: claim.generation, token: claim.token,
      selectionRevision: claim.selectionRevision, outcome: 'completed', pages: allCompletePages(claim.sourceCourseId), incompleteReasons: [], moodleUserId: ACCOUNT});
    expect(finish.status).toBe(200);
  }
  await backend.stop(); await backend.start();
  const full = await entries();
  expect(full.map((s: any) => [s.status, s.coverage])).toEqual([['ok', 'full'], ['ok', 'full']]);
  const timezone = (await backend.get('/api/snapshot')).settings.timezone;
  const earliest = full.map((s: any) => s.lastSuccessAt).sort((a: string, b: string) => Date.parse(a) - Date.parse(b))[0];
  const fullTime = formatInstant(earliest, timezone)!;
  shown = await popupText(backend);
  expect(shown.full).toBe(`Successful full sync: ${fullTime}`);
  expect(shown.text).toContain('Latest page refresh: ');
  expect(shown.text).not.toMatch(/Last failed scan attempt|fictional/);
  // (c) A login redirect fails the next scan; no full sync is claimed.
  await pause(1100);
  const second = install(backend, clock, moodle(clock, () => ({status: 200, body: html['login-page.html']!, finalUrl: `${ORIGIN}/login/index.php`})).fetcher);
  expect((await second.bridge(1, 'syncAll')).ok).toBe(true);
  expect((await backend.settled(3)).at(-1).status).toBe('failed'); second.worker.dispose();
  const after = await entries();
  shown = await popupText(backend);
  // The earlier full sync stays its own fact next to the failed attempt.
  expect(shown.full).toBe(`Successful full sync: ${fullTime}`);
  for (const entry of after) {
    expect(entry).toMatchObject({status: 'failed', coverage: 'full', error: SIGN_IN});
    expect(entry.lastSuccessAt).toBe(full.find((s: any) => s.courseId === entry.courseId).lastSuccessAt);
    expect(Date.parse(entry.lastAttemptAt)).toBeGreaterThan(Date.parse(entry.lastSuccessAt));
    const attempt = formatInstant(entry.lastAttemptAt, timezone)!;
    expect(attempt).not.toBe(fullTime);
    expect(shown.text).toContain(`Last failed scan attempt: `);
    expect(shown.text).toContain(` · ${attempt}`);
  }
  expect(shown.text.match(/Last failed scan attempt: /g)).toHaveLength(2);
}, 60000);

it('#46 AC2/AC4: one Start initial sync gives one POST /api/sync and one run; reopening reads it without a start; a course held by another run gets the fixed already-running 409', async () => {
  const backend = new Backend('onboarding'); await backend.start();
  const ids = await backend.seed(['9001', '9002']);
  const scanRuns = async () => (await backend.sql("SELECT count(*) FROM queue_runs WHERE kind='scan'"))[0][0];
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  let open!: () => void;
  const site = moodle(clock, observedSite, new Promise<void>(resolve => open = resolve));
  const app = install(backend, clock, site.fetcher);
  const syncPosts = () => app.requests.filter(r => r === 'POST /api/sync').length;
  // The setup step's one explicit click.
  const started = await app.bridge(1, 'syncAll');
  expect(started.ok).toBe(true);
  expect(started.result.sync.filter((s: any) => s.status === 'syncing').map((s: any) => s.courseId).sort()).toEqual([ids['9001'], ids['9002']].sort());
  // Leaving and reopening /setup reads the Snapshot (the run's progress) and sends no start.
  for (const tab of [2, 3]) {
    const read = await app.bridge(tab, 'load');
    expect(read.result.sync.filter((s: any) => s.status === 'syncing')).toHaveLength(2);
  }
  expect(syncPosts()).toBe(1);
  expect(await scanRuns()).toBe(1);
  open();
  const [run] = await backend.settled(1);
  expect(run.status).toBe('completed');
  // Incomplete page types: partial coverage with a completed time, never a full sync.
  const snapshot = await backend.get('/api/snapshot');
  for (const course of ['9001', '9002'])
    expect(snapshot.sync.find((s: any) => s.courseId === ids[course])).toMatchObject({status: 'partial', coverage: 'partial', lastSuccessAt: expect.any(String)});
  expect(site.maxActive()).toBe(1); spacing(site.starts());
  app.worker.dispose();
  // A course still held by another kind of run: the fixed 409 message, nothing started.
  expect((await backend.write('POST', '/api/queue/runs', {idempotencyKey: 'mock-46', courseIds: [ids['9001']]})).status).toBe(200);
  const conflict = await backend.write('POST', '/api/sync');
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({message: 'A sync is already running for one of the selected courses. Try again when it finishes.'});
  expect(await scanRuns()).toBe(1);
  expect(syncPosts()).toBe(1);
}, 60000);

// #95 -----------------------------------------------------------------------
const VISIT = {
  saved: 'Deadlines from this page were saved.', notSupported: 'This page is not supported for live updates.',
  notSelected: 'This course is not selected in Moodle Helper. Nothing was saved.', needsSync: 'Run Sync all once to add this activity. Nothing was saved.',
  mismatch: 'The signed-in Moodle account is not the account of this dataset. Nothing was saved.',
  unconfirmed: 'The Moodle account could not be confirmed. Nothing was saved.', signedOut: 'Sign in to SDU Moodle to continue.',
};
let documents = 0;
type App = ReturnType<typeof install>;
/** The content script's one message for a loaded top-frame SDU document, with Chrome's sender data. */
function visitAs(app: App, sender: Record<string, unknown>, course?: string) {
  const message = {source: 'moodle-helper-page-visit', version: '1', ...(course ? {sourceCourseId: course} : {})};
  return new Promise<any>(resolve => { for (const listener of app.messages) if (listener(message, sender, resolve) === true) return; resolve(undefined); });
}
const senderFor = (tab: number, url: string, documentId = `DOC-${tab}-${++documents}`) =>
  ({id: 'live-scan-test', frameId: 0, tab: {id: tab, url}, documentId, url, origin: ORIGIN});
const visitPage = (app: App, tab: number, url: string, course?: string) => visitAs(app, senderFor(tab, url), course);
const collectionWrites = (app: App) => app.requests.filter(r => /^POST \/api\/collection\//.test(r));
/** The installed popup's #95 line, with Chrome's tab query answering `url` for the active tab. */
async function popupPageLine(app: App, tab: number, url: string | undefined) {
  const previous = (globalThis as any).chrome;
  (globalThis as any).chrome = {runtime: {sendMessage: (message: unknown, reply: (value: unknown) => void) => {
    for (const listener of app.messages) if (listener(message, {id: 'live-scan-test', url: 'chrome-extension://live-scan-test/popup.html'}, reply) !== undefined) return;
    reply(undefined);
  }}, tabs: {query: (_: unknown, reply: (tabs: unknown[]) => void) => reply([{id: tab, ...(url ? {url} : {})}])}};
  const dom = new JSDOM('<p id="page-visit" hidden></p><p id="connection"></p>', {url: 'https://extension.test'});
  try {
    const popup = installPopup(dom.window.document, (async () => { throw Error('offline'); }) as typeof fetch, dom.window.localStorage);
    await popup.ready; popup.dispose();
    const line = dom.window.document.getElementById('page-visit')!;
    return line.hidden ? '' : line.textContent;
  } finally { (globalThis as any).chrome = previous; dom.window.close(); }
}

it('#95 AC1/AC4/AC5/AC6: opened course, calendar, assignment and quiz pages save within 10 s; revisits add no duplicates; a changed deadline raises the existing alert', async () => {
  const backend = new Backend('visit-types'); await backend.start();
  const ids = await backend.seed(['9001', '9002']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  let change = (page: string) => page;
  const site = moodle(clock, url => { const reply = observedSite(url); return {...reply, body: change(reply.body)}; });
  const app = install(backend, clock, site.fetcher);
  const records = async (kind: string) => ((await backend.get('/api/snapshot')).collection?.records ?? []).filter((r: any) => r.kind === kind);
  // Course page (materials) and the upcoming calendar save without a Sync all; each visit is one GET of that page.
  for (const [url, course, kind] of [[courseUrl('9001'), '9001', 'material'], [CALENDAR, '1', 'calendar']] as const) {
    const started = Date.now(), before = site.starts().length;
    expect(await visitPage(app, 3, url, course)).toEqual({status: 'saved', message: VISIT.saved});
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(site.starts().slice(before).map(e => e.url)).toEqual([url]);
    expect((await records(kind)).length).toBeGreaterThan(0);
  }
  expect([...new Set((await records('calendar')).map((r: any) => r.courseId))].sort()).toEqual([ids['9001'], ids['9002']].sort());
  // An activity first seen on its own page has no recorded title source (#3): nothing is saved, the popup says why.
  expect(await visitPage(app, 3, quizUrl('990103'), '9001')).toEqual({status: 'needs_sync', message: VISIT.needsSync});
  expect(await records('quiz')).toEqual([]);
  // After one Sync all, the activity pages update the same records.
  expect((await app.bridge(1, 'syncAll')).ok).toBe(true);
  await backend.settled(1);
  const counts = async () => { const s = await backend.get('/api/snapshot'); return [s.collection.records.length, s.assessments.length, s.changes.length]; };
  const baseline = await counts();
  // Opening the same pages again (new documents, and a duplicate notification of one document) adds nothing.
  const sender = senderFor(4, quizUrl('990103'));
  const before = site.starts().length;
  expect(await Promise.all([visitAs(app, sender, '9001'), visitAs(app, sender, '9001')])).toEqual([{status: 'saved', message: VISIT.saved}, {status: 'saved', message: VISIT.saved}]);
  expect(site.starts().length - before).toBe(1);
  expect(await visitPage(app, 4, assignUrl('990102'), '9001')).toEqual({status: 'saved', message: VISIT.saved});
  expect(await visitPage(app, 4, courseUrl('9001'), '9001')).toEqual({status: 'saved', message: VISIT.saved});
  expect(await counts()).toEqual(baseline);
  // Revisits with changed dates: the existing deadline-change alert with old and new dates, no new records.
  change = page => page.replace('Closed: Saturday, 4 March 2028, 9:00 AM', 'Closed: Monday, 6 March 2028, 9:00 AM')
    .replace('Due: Tuesday, 7 March 2028, 2:30 PM', 'Due: Thursday, 9 March 2028, 2:30 PM');
  for (const [url, from, to] of [[quizUrl('990103'), '2028-03-04T09:00', '2028-03-06T09:00'], [assignUrl('990102'), '2028-03-07T14:30', '2028-03-09T14:30']]) {
    const started = Date.now();
    expect(await visitPage(app, 5, url!, '9001')).toEqual({status: 'saved', message: VISIT.saved});
    expect(Date.now() - started).toBeLessThan(10_000);
    const alert = (await backend.get('/api/snapshot')).changes.at(-1);
    expect([alert.from.iso.slice(0, 16), alert.to.iso.slice(0, 16)]).toEqual([from, to]);
  }
  expect(await counts()).toEqual([baseline[0], baseline[1], baseline[2]! + 2]);
  // The dashboard reads the saved dates after a backend restart (reload).
  await backend.stop(); await backend.start();
  const reloaded = await backend.get('/api/snapshot');
  // The dashboard shows a Moodle deadline from its accepted stream value (frontend/src/domain/assessments.ts).
  const accepted = (url: string) => reloaded.deadlineStreams.find((s: any) => s.sourceUrl === url).accepted.iso;
  expect([accepted(quizUrl('990103')), accepted(assignUrl('990102'))]).toEqual(['2028-03-06T09:00:00+05:00', '2028-03-09T14:30:00+05:00']);
  expect(await popupPageLine(app, 5, assignUrl('990102'))).toBe(VISIT.saved);
  app.worker.dispose();
}, 120000);

it('#95 AC2/AC3: unselected courses and unsupported pages save nothing and make no Moodle request; the popup says the page is not supported', async () => {
  const backend = new Backend('visit-refused'); await backend.start();
  await backend.seed(['9001']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  const site = moodle(clock, observedSite);
  const app = install(backend, clock, site.fetcher);
  const before = await backend.get('/api/snapshot');
  for (const [url, course] of [[courseUrl('9002'), '9002'], [courseUrl('9003'), undefined], [assignUrl('990201'), '9002'], [quizUrl('990303'), '9003'], [quizUrl('990103'), undefined]])
    expect(await visitPage(app, 6, url!, course)).toEqual({status: 'not_selected', message: VISIT.notSelected});
  for (const url of [`${ORIGIN}/mod/forum/view.php?id=990107`, `${ORIGIN}/mod/resource/view.php?id=990104`, `${ORIGIN}/my/`, `${ORIGIN}/login/index.php`,
    `${ORIGIN}/calendar/view.php?view=month`, `${courseUrl('9001')}#section-2`, `${ORIGIN}/mod/folder/view.php?id=990108`])
    expect(await visitPage(app, 7, url, '9001')).toEqual({status: 'not_supported', message: VISIT.notSupported});
  // A frame, another origin or another extension is not a visit at all.
  expect(await visitAs(app, {...senderFor(8, courseUrl('9001')), frameId: 2}, '9001')).toBeUndefined();
  expect(await visitAs(app, senderFor(8, 'https://moodle.sdu.edu.kz.example.com/course/view.php?id=9001'), '9001')).toBeUndefined();
  expect(await visitAs(app, {...senderFor(8, courseUrl('9001')), id: 'other-extension'}, '9001')).toBeUndefined();
  expect(site.starts()).toEqual([]);
  expect(collectionWrites(app)).toEqual([]);
  expect(await backend.get('/api/snapshot')).toEqual(before);
  expect(await popupPageLine(app, 7, `${ORIGIN}/mod/forum/view.php?id=990107`)).toBe(VISIT.notSupported);
  expect(await popupPageLine(app, 9, 'https://example.com/')).toBe(VISIT.notSupported);
  expect(await popupPageLine(app, 9, undefined)).toBe(VISIT.notSupported);
  expect(await popupPageLine(app, 6, quizUrl('990103'))).toBe(VISIT.notSelected);
  app.worker.dispose();
}, 60000);

it('#95 + #93: a page showing another account, no account or the sign-in page saves nothing', async () => {
  const backend = new Backend('visit-account'); await backend.start();
  await backend.seed(['9001']);
  const clock = {now: Date.parse('2028-03-05T10:00:00Z')};
  let reply = (url: string): Reply => observedSite(url);
  const app = install(backend, clock, moodle(clock, url => reply(url)).fetcher);
  const before = await backend.get('/api/snapshot');
  reply = url => ({status: 200, body: signedIn(coursePage(url.slice(-4)), '5550001')});
  expect(await visitPage(app, 10, courseUrl('9001'), '9001')).toEqual({status: 'account_mismatch', message: VISIT.mismatch});
  reply = url => ({status: 200, body: coursePage(url.slice(-4))});
  expect(await visitPage(app, 10, courseUrl('9001'), '9001')).toEqual({status: 'account_unconfirmed', message: VISIT.unconfirmed});
  reply = () => ({status: 200, body: html['login-page.html']!, finalUrl: `${ORIGIN}/login/index.php`});
  expect(await visitPage(app, 10, courseUrl('9001'), '9001')).toEqual({status: 'signed_out', message: VISIT.signedOut});
  // A wrong course hint for an activity page is refused before any request.
  reply = observedSite;
  expect((await visitPage(app, 10, assignUrl('990102'), '9002')).status).toBe('not_selected');
  const after = await backend.get('/api/snapshot');
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toContain('5550001');
  app.worker.dispose();
}, 60000);
