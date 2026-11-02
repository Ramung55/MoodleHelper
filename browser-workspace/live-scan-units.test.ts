// @vitest-environment jsdom
/** #20 unit checks: observed access states, the live quiz adapter, page source bounds and offscreen routing. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {expect, it} from 'vitest';
import {detectMoodleAccess, detectObservedMoodleAccess} from '../extension/src/moodle-access';
import {activityLinks} from '../extension/src/moodle-page-analysis';
import {createMoodlePageSource, liveRouteAllowed, MAX_BODY_BYTES, offscreenAnalyzer} from '../extension/src/moodle-page-source';
import {installOffscreen} from '../extension/src/offscreen';
import {liveRegistry, quizRefreshResult} from '../extension/src/page-refresh';
import {validSchema} from '../shared/src/bridge';

const fixtures = path.resolve(import.meta.dirname, '../tests/fixtures/moodle/observed');
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const course = 'https://moodle.sdu.edu.kz/course/view.php?id=9001';
const quiz = 'https://moodle.sdu.edu.kz/mod/quiz/view.php?id=990103';
const envelope = (url: string, status: number, document?: Document, finalUrl = url, contentType = 'text/html; charset=utf-8') =>
  ({requestedUrl: url, finalUrl, httpStatus: status, networkFailure: false, contentType, ...(document ? {document} : {})});

it('classifies observed SDU pages into the existing #10 access states', async () => {
  const page = parse(await readFile(path.join(fixtures, 'course-page.html'), 'utf8'));
  const view = parse(await readFile(path.join(fixtures, 'quiz-finished.html'), 'utf8'));
  const login = parse(await readFile(path.join(fixtures, 'login-page.html'), 'utf8'));
  const missing = parse(await readFile(path.join(fixtures, 'not-found.html'), 'utf8'));
  const route = {kind: 'course', courseId: '9001'} as const, quizRoute = {kind: 'quiz', cmid: '990103', courseId: '9001'} as const;
  const state = (input: any, r: any = route) => { const a = detectObservedMoodleAccess(input, r); return [a.status, a.retryable]; };
  expect(state(envelope(course, 200, page))).toEqual(['accessible', false]);
  expect(state(envelope(quiz, 200, view), quizRoute)).toEqual(['accessible', false]);
  expect(state(envelope(quiz, 200, view), {...quizRoute, courseId: '9002'})).toEqual(['unknown', false]);
  expect(state(envelope(course, 200, login, 'https://moodle.sdu.edu.kz/login/index.php'))).toEqual(['signed_out', false]);
  expect(state(envelope(course, 200, login))).toEqual(['signed_out', false]); // body#page-login-index alone, no text matching
  expect(state(envelope(course, 401))).toEqual(['signed_out', false]);
  expect(state(envelope(course, 403, page))).toEqual(['forbidden', false]);
  expect(state(envelope(course, 404, missing))).toEqual(['unsupported', false]);
  expect(state(envelope(course, 404, page))).toEqual(['unsupported', false]);
  for (const status of [408, 425, 429, 500, 503]) expect(state(envelope(course, status))).toEqual(['unknown', true]);
  expect(state({...envelope(course, 0), networkFailure: true})).toEqual(['unknown', true]);
  expect(state(envelope(course, 200, parse(page.documentElement.outerHTML.replace('format-topics', 'format-weeks'))))).toEqual(['unknown', false]);
  expect(state(envelope(course, 200, page, course, 'application/pdf'))).toEqual(['unsupported', false]);
  expect(state(envelope('https://evil.invalid/course/view.php?id=9001', 200, page))).toEqual(['unsupported', false]);
  // The synthetic #10 vocabulary is unchanged and does not accept the observed page.
  expect(detectMoodleAccess({...envelope(course, 200), document: page}).status).not.toBe('accessible');
  // Links are rebuilt from li.activity.modtype_<type>#module-<cmid>, in page order, never from href.
  expect(activityLinks(page)).toEqual(['forum/view.php?id=990108', 'assign/view.php?id=990101', 'assign/view.php?id=990102', 'quiz/view.php?id=990103',
    'quiz/view.php?id=990109', 'resource/view.php?id=990104', 'resource/view.php?id=990105', 'url/view.php?id=990106', 'page/view.php?id=990107']
    .map(tail => 'https://moodle.sdu.edu.kz/mod/' + tail));
});

it('maps the #14 quiz parser to the QuizRefreshResult wire shape without inventing facts', async () => {
  const view = parse(await readFile(path.join(fixtures, 'quiz-finished.html'), 'utf8'));
  const input = {...envelope(quiz, 200), document: view};
  const result = quizRefreshResult(input, '2028-03-05T10:00:00.000Z', {title: 'Fictional Warm-up Quiz'});
  expect(validSchema('CollectorResult', result)).toBe(true);
  expect(result).toMatchObject({kind: 'quiz', coverage: 'complete', scope: 'visited_activity_only', observations: [{
    sourceCourseId: '9001', sourceCourseModuleId: '990103', sourceActivityId: '990103', title: 'Fictional Warm-up Quiz',
    sourceUrl: quiz, closing: {location: 'quiz.closing', value: {kind: 'exact', iso: '2028-03-04T09:00:00+05:00', tz: 'Asia/Almaty'}},
    attemptInformation: {kind: 'known', unknownFields: ['used']}}]});
  expect(quizRefreshResult(input, '2028-03-05T10:00:00.000Z')).toEqual({kind: 'failed', reasons: ['missing_metadata']});
  expect(quizRefreshResult({...input, finalUrl: 'https://moodle.sdu.edu.kz/login/index.php'}, '2028-03-05T10:00:00.000Z', {title: 'x'}))
    .toEqual({kind: 'failed', reasons: ['access_error']});
  const registry = liveRegistry();
  expect(Object.entries(registry).filter(([, a]) => a.availability === 'available').map(([k]) => k)).toEqual(['quiz']);
});

it('requests only allowed routes, GET with credentials, and bounds non-HTML and oversized bodies', async () => {
  expect(liveRouteAllowed(course)).toBe(true);
  expect(liveRouteAllowed(quiz)).toBe(true);
  for (const url of ['https://moodle.sdu.edu.kz/mod/resource/view.php?id=1', 'https://moodle.sdu.edu.kz/mod/url/view.php?id=1',
    'https://moodle.sdu.edu.kz/pluginfile.php/1/mod_resource/content/1/a.pdf', 'https://moodle.sdu.edu.kz/course/view.php?id=1#x', 'http://moodle.sdu.edu.kz/course/view.php?id=1'])
    expect(liveRouteAllowed(url)).toBe(false);
  const seen: RequestInit[] = [];
  let analyzed = 0;
  const reply = (body: BodyInit, type: string) => (async (_: unknown, init?: RequestInit) => { seen.push(init!); return new Response(body, {status: 200, headers: {'content-type': type}}); }) as typeof fetch;
  const analyze = async () => { analyzed++; return {access: {status: 'accessible', retryable: false, reason: 'accessible', message: ''} as const, links: [], titles: {}, collected: {}}; };
  const context = {sourceCourseId: '9001', collectors: []};
  const pdf = createMoodlePageSource({fetcher: reply('%PDF-1.7', 'application/pdf'), analyze, now: () => 0}).start(course, context);
  const nonHtml = await pdf.completion;
  expect(await pdf.termination).toBe(true);
  expect(nonHtml.access?.status).toBe('unsupported'); expect(analyzed).toBe(0);
  const big = createMoodlePageSource({fetcher: reply('x'.repeat(MAX_BODY_BYTES + 10), 'text/html'), analyze, now: () => 0}).start(course, context);
  expect((await big.completion).bytes).toBeGreaterThan(MAX_BODY_BYTES); expect(analyzed).toBe(0);
  expect(seen.every(init => init.method === 'GET' && init.credentials === 'include' && init.redirect === 'follow' && init.cache === 'no-store' && init.body === undefined)).toBe(true);
  expect(() => createMoodlePageSource({fetcher: reply('', 'text/html'), analyze, now: () => 0}).start('https://moodle.sdu.edu.kz/mod/resource/view.php?id=1', context)).toThrow();
  // An aborted request rejects its completion and still acknowledges termination after the fetch settled.
  const hanging = createMoodlePageSource({fetcher: ((_: unknown, init?: RequestInit) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(Error('aborted'))))) as typeof fetch, analyze, now: () => 0}).start(course, context);
  hanging.abort();
  await expect(hanging.completion).rejects.toThrow();
  expect(await hanging.termination).toBe(true);
});

it('routes analysis through the offscreen document and ignores foreign messages', async () => {
  const listeners: any[] = [];
  installOffscreen({id: 'ext', onMessage: {addListener: f => listeners.push(f)}}, async request => ({access: {status: 'accessible', retryable: false, reason: 'accessible', message: request.sourceCourseId}, links: [], titles: {}, collected: {}}));
  expect(listeners[0]({target: 'other'}, {id: 'ext'}, () => {})).toBeUndefined();
  expect(listeners[0]({target: 'moodle-helper-offscreen', type: 'analyze', request: {}}, {id: 'ext', tab: {id: 1}}, () => {})).toBeUndefined();
  let created = 0;
  const analyzer = offscreenAnalyzer({runtime: {getURL: p => p, sendMessage: (message, callback) => listeners[0](message, {id: 'ext'}, callback)},
    offscreen: {createDocument: async () => { created++; }}});
  const request = {envelope: {requestedUrl: course, finalUrl: course, httpStatus: 200, networkFailure: false}, html: '', sourceCourseId: '9001', collectors: [], observedAt: '2028-03-05T10:00:00.000Z'};
  expect((await analyzer(request)).access.message).toBe('9001');
  await analyzer(request);
  expect(created).toBe(1);
  await expect(offscreenAnalyzer({runtime: {}})(request)).rejects.toThrow();
});
