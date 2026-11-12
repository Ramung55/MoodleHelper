/**
 * #82 worker-side course discovery: "Find my SDU courses".
 *
 * Runs only on the student's explicit click (the bridge `discoverCourses`
 * operation), and only in the trusted real namespace (#20's collection context in
 * `verified` mode); the demo dataset answers with a fixed message and nothing is
 * requested. One run at a time: concurrent callers share the same run and result.
 *
 * Moodle requests, each through #20's single-flight request authority (at most one
 * in flight, starts >= 1 s apart, durable pacing in backend/scan_gate.py):
 * 1. `GET /my/courses.php`. Its text is read here only for the fixed
 *    `"sesskey":"<alphanumeric>"` pattern and the `<body>` id and classes; the
 *    offscreen document gets the reduced envelope only, never the text.
 * 2. One enrolled-courses POST per page (owner decision D1): offset 0, then
 *    `offset + 24` while a page is full, at most 4 pages. `nextoffset` is ignored.
 * Then one `POST /api/courses/discovery` with the bridge binding: new courses are
 * untracked and missing courses are kept by the backend.
 *
 * The sesskey lives in one local variable of `run()` and is used only to build the
 * POST URLs of that run. It is never stored, logged, put in a message, an error, a
 * backend request or the reply. Failures map to fixed messages only.
 *
 * #93: the signed-in user id is read from the same `/my/courses.php` text (`M.cfg`
 * `"userId"`) and sent only in the ingest body, where the backend compares it with the
 * dataset's account. Its fixed 409 messages are returned to the dashboard as they are.
 */
import {DISCOVERY_MESSAGES, type DiscoveryMessage, type DiscoveryResult} from '../../shared/src/bridge';
import {parseEnrolledCourses, type RawCourseObservation} from './moodle-courses';
import {moodleUserId, reducedBody, type AccessChecker, type AccessRequest} from './moodle-page-analysis';
import {ENROLLED_METHOD, MY_COURSES_URL, enrolledCoursesUrl, startDiscoveryRequest, type DiscoveryRequest, type DiscoveryResponse} from './moodle-page-source';
import {ACQUIRE_LIMIT_MS, type RequestAuthority} from './scan-coordinator';
import {retryAfterDeadline, scanRetryDecision} from './scan-retry';

export const DISCOVERY_LIMIT = 24;
/** The one classification this worker requests; #84 records it in each observation from here. */
export const DISCOVERY_CLASSIFICATION = 'inprogress' as const;
const SESSKEY = /"sesskey":"([A-Za-z0-9]{1,64})"/;
const SERVICE_URL = 'https://moodle.sdu.edu.kz/lib/ajax/service.php';

export type CourseDiscoveryOptions = {
  base:string; fetcher:typeof fetch; authority:RequestAuthority; access:AccessChecker;
  now:()=>number; wait:(ms:number)=>Promise<void>;
  /** In-process test seams only. */
  moodleFetch?:typeof fetch; requestLimitMs?:number; backendTimeoutMs?:number;
};
export type Outcome = {kind:'response';value:Extract<DiscoveryResponse,{networkFailure:false}>}|{kind:'failed'};
export type PacedOptions = Pick<CourseDiscoveryOptions,'authority'|'now'|'wait'|'moodleFetch'|'requestLimitMs'>;
class Stop { constructor(readonly reply:{message:DiscoveryMessage}) {} }
const stop = (message:keyof typeof DISCOVERY_MESSAGES) => new Stop({message:DISCOVERY_MESSAGES[message]});

/**
 * One Moodle discovery-route request under #20's request authority: acquire, start, release
 * no earlier than start + 1000 ms; 503/429 retried at most twice (#20 policy). Shared with the
 * #46 sign-in probe, so both use the same pacing and the worker's one authority.
 */
export async function pacedDiscoveryRequest(options:PacedOptions, request:DiscoveryRequest):Promise<Outcome> {
  for (let attempt = 1; ; attempt++) {
    let token:string|undefined;
    const since = options.now();
    while (!token) {
      const reservation = await options.authority.acquire(options.now());
      if (typeof reservation === 'string') token = reservation;
      else if (reservation && typeof reservation === 'object') token = reservation.token;
      else if (reservation === 'exhausted' || !(options.now() - since < ACQUIRE_LIMIT_MS)) return {kind:'failed'};
      else await options.wait(100);
    }
    let handle:ReturnType<typeof startDiscoveryRequest>;
    try {
      handle = startDiscoveryRequest(request, {...(options.moodleFetch ? {fetcher:options.moodleFetch} : {}),
        ...(options.requestLimitMs ? {requestLimitMs:options.requestLimitMs} : {})});
    } catch {
      await options.authority.releaseAfterTermination(token, 0);
      return {kind:'failed'};
    }
    const startedAt = options.now();
    let value:DiscoveryResponse|undefined;
    try { value = await handle.completion; } catch { /* failed below */ }
    let settled = false;
    try { settled = await handle.termination; } catch { /* fail closed */ }
    // An unsettled fetch keeps the authority held (fail closed).
    if (!settled) return {kind:'failed'};
    const retry = !!value && !value.networkFailure && (value.status === 503 || value.status === 429);
    const failedAt = options.now();
    const retryAfter = retry && !value!.networkFailure ? value!.retryAfter : undefined;
    const serverDeadline = retryAfter !== undefined ? retryAfterDeadline(failedAt, retryAfter) : 0;
    const decision = retry ? scanRetryDecision(failedAt, attempt, retryAfter) : undefined;
    const deadline = Math.max(startedAt + 1000, serverDeadline ?? 0, decision?.kind === 'retry' ? decision.notBefore : 0);
    if (!await options.authority.releaseAfterTermination(token, deadline)) return {kind:'failed'};
    if (!value || value.networkFailure) return {kind:'failed'};
    if (retry) {
      if (decision?.kind !== 'retry' || serverDeadline === undefined || deadline > failedAt + 86_400_000) return {kind:'failed'};
      await options.wait(Math.max(0, deadline - options.now()));
      continue;
    }
    return {kind:'response', value};
  }
}

/**
 * The reduced envelope for #20's observed access check: the URLs without any query that
 * could hold a sesskey, the status, the content type and the `<body>` id and classes.
 * The page text itself never leaves the worker.
 */
export function discoveryAccessRequest(value:Extract<DiscoveryResponse,{networkFailure:false}>, route:AccessRequest['route']):AccessRequest {
  // The service URL carries the sesskey: neither URL is sent with its query.
  const requestedUrl = route === 'my-courses' ? MY_COURSES_URL : SERVICE_URL;
  const final = new URL(value.finalUrl);
  const finalUrl = route === 'my-courses' && final.pathname === '/my/courses.php' ? value.finalUrl : final.origin + final.pathname;
  return {route, body:reducedBody(value.text),
    envelope:{requestedUrl, finalUrl, httpStatus:value.status, networkFailure:false, ...(value.contentType !== undefined ? {contentType:value.contentType} : {})}};
}

export function createCourseDiscovery(options:CourseDiscoveryOptions) {
  const fetcher:typeof fetch = (input, init) => options.fetcher(input, init);
  let current:Promise<DiscoveryResult>|undefined;

  async function backend(path:string, binding?:string, body?:unknown):Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.backendTimeoutMs ?? 10_000);
    try {
      const response = await fetcher(options.base + path, {method:body === undefined ? 'GET' : 'POST', credentials:'omit', redirect:'error', cache:'no-store', signal:controller.signal,
        headers:{Accept:'application/json', ...(body === undefined ? {} : {'Content-Type':'application/json', 'X-Moodle-Helper-Bridge-Binding':binding!})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)})});
      if (response.status === 409 && body !== undefined) {
        // #93: the backend's fixed account messages pass through; anything else is a failure.
        const message = (await response.json().catch(() => undefined))?.message;
        throw message === DISCOVERY_MESSAGES.accountMismatch || message === DISCOVERY_MESSAGES.accountUnconfirmed
          ? new Stop({message}) : stop('failed');
      }
      if (!response.ok) throw stop('failed');
      return await response.json();
    } catch (error) {
      throw error instanceof Stop ? error : stop('failed');
    } finally { clearTimeout(timer); }
  }

  /** #20's observed access check, in the offscreen document, on a reduced envelope only. */
  async function access(value:Extract<DiscoveryResponse,{networkFailure:false}>, route:AccessRequest['route']) {
    try { return await options.access(discoveryAccessRequest(value, route)); } catch { throw stop('failed'); }
  }

  const paced = (request:DiscoveryRequest) => pacedDiscoveryRequest(options, request);

  async function run():Promise<DiscoveryResult> {
    try {
      const context = await backend('/api/collection-context');
      if (context?.mode !== 'verified') return {message:DISCOVERY_MESSAGES.demo};
      const shell = await paced({method:'GET', url:MY_COURSES_URL});
      if (shell.kind === 'failed') throw stop('failed');
      // The one sesskey of this run: read here, kept only in this variable.
      const sesskey = shell.value.truncated ? undefined : SESSKEY.exec(shell.value.text)?.[1];
      // #93: the signed-in account, from the same text; no further request.
      const userId = shell.value.truncated ? undefined : moodleUserId(shell.value.text);
      const shellAccess = await access(shell.value, 'my-courses');
      if (shellAccess.status === 'signed_out') throw stop('signedOut');
      if (shellAccess.status !== 'accessible' || !sesskey) throw stop('failed');
      const pages:string[] = [];
      for (let offset = 0; ; ) {
        const body = JSON.stringify([{index:0, methodname:ENROLLED_METHOD, args:{offset, limit:DISCOVERY_LIMIT, classification:DISCOVERY_CLASSIFICATION, sort:'fullname'}}]);
        const page = await paced({method:'POST', url:enrolledCoursesUrl(sesskey), body});
        if (page.kind === 'failed') throw stop('failed');
        const value = page.value;
        const path = new URL(value.finalUrl).pathname;
        const json = (value.contentType ?? '').split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
        if (path === '/login/index.php' || !json) {
          throw stop((await access(value, 'service')).status === 'signed_out' ? 'signedOut' : 'failed');
        }
        if (value.status !== 200 || value.truncated || path !== '/lib/ajax/service.php') throw stop('failed');
        let parsed:unknown;
        try { parsed = JSON.parse(value.text); } catch { throw stop('failed'); }
        const failure = Array.isArray(parsed) && parsed.length === 1 && (parsed[0] as {error?:unknown})?.error === true
          ? (parsed[0] as {exception?:{errorcode?:unknown}}).exception?.errorcode : undefined;
        if (failure === 'servicerequireslogin') throw stop('signedOut');
        pages.push(value.text);
        const result = parseEnrolledCourses(pages, {limit:DISCOVERY_LIMIT});
        if (result.diagnostics.some(d => d.reason === 'malformed_response')) throw stop('failed');
        if (result.next === null) {
          // The classification comes from this worker's own request, never from the response body.
          const observations:RawCourseObservation[] = result.observations.map(observation => ({...observation, classification:DISCOVERY_CLASSIFICATION}));
          const binding = (await backend('/api/bridge-context'))?.binding;
          if (typeof binding !== 'string') throw stop('failed');
          const snapshot = await backend('/api/courses/discovery', binding, {observations, ...(userId ? {moodleUserId:userId} : {})});
          return {snapshot, found:observations.length, coverage:result.coverage === 'complete' ? 'complete' : 'partial'};
        }
        offset = result.next;
      }
    } catch (error) {
      return error instanceof Stop ? error.reply : {message:DISCOVERY_MESSAGES.failed};
    }
  }

  return {
    /** Single-flight: a click during a run gets that run's result. */
    discover():Promise<DiscoveryResult> {
      current ??= run().finally(() => { current = undefined; });
      return current;
    },
  };
}
