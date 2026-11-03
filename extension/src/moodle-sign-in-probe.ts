/**
 * #46 read-only SDU Moodle sign-in probe (the producer for onboarding AC1).
 *
 * Runs only when the bridge `checkMoodleSignIn` operation asks (the onboarding sign-in
 * step being shown, or its Check again click), and only in the trusted real namespace
 * (#20's collection context in `verified` mode); the demo dataset gets `signal: null`
 * and nothing is requested. Single-flight: concurrent callers share one run and result.
 *
 * Exactly one Moodle request: `GET /my/courses.php` through #82's discovery route
 * (`startDiscoveryRequest`) and the worker's one #20 request authority, paced like
 * discovery (start >= 1 s apart, 503/429 retried at most twice). No POST, no
 * `lib/ajax/service.php`, no sesskey. Classification uses #20's observed access check in
 * the offscreen document on the reduced envelope only (`<body>` id and classes):
 * `signed_out` -> signed out, `accessible` -> signed in, anything else -> no signal.
 * A body over 1 MiB comes back truncated with empty text and is never classified.
 *
 * The page text is read only by `reducedBody` and dropped; it is never stored, logged,
 * put in a message, the backend or the reply. The result is not persisted.
 */
import {SIGN_IN_PROBE, type SignInResult, type SignInSignal} from '../../shared/src/bridge';
import {discoveryAccessRequest, pacedDiscoveryRequest} from './course-discovery';
import type {AccessChecker} from './moodle-page-analysis';
import {MY_COURSES_URL} from './moodle-page-source';
import type {RequestAuthority} from './scan-coordinator';

export type SignInProbeOptions = {
  base:string; fetcher:typeof fetch; authority:RequestAuthority; access:AccessChecker;
  now:()=>number; wait:(ms:number)=>Promise<void>;
  /** In-process test seams only. */
  moodleFetch?:typeof fetch; requestLimitMs?:number; backendTimeoutMs?:number;
};

export function createSignInProbe(options:SignInProbeOptions) {
  let current:Promise<SignInResult>|undefined;

  async function verified():Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.backendTimeoutMs ?? 10_000);
    try {
      const response = await options.fetcher(options.base + '/api/collection-context', {method:'GET', credentials:'omit', redirect:'error', cache:'no-store',
        signal:controller.signal, headers:{Accept:'application/json'}});
      if (!response.ok) return false;
      return (await response.json())?.mode === 'verified';
    } catch {
      return false;
    } finally { clearTimeout(timer); }
  }

  async function signal():Promise<SignInSignal|null> {
    if (!await verified()) return null;
    const outcome = await pacedDiscoveryRequest(options, {method:'GET', url:MY_COURSES_URL});
    if (outcome.kind === 'failed') return null;
    // Over 1 MiB: the text is empty, so the check would see a bare 200 /my/courses.php. No signal.
    if (outcome.value.truncated) return null;
    let state:string;
    try { state = (await options.access(discoveryAccessRequest(outcome.value, 'my-courses'))).status; } catch { return null; }
    if (state === 'signed_out') return {state:'signed_out', ...SIGN_IN_PROBE};
    if (state === 'accessible') return {state:'signed_in', ...SIGN_IN_PROBE};
    return null;
  }

  async function run():Promise<SignInResult> {
    let value:SignInSignal|null = null;
    try { value = await signal(); } catch { value = null; }
    return {signal:value, checkedAt:new Date(options.now()).toISOString()};
  }

  return {
    /** Single-flight: a second tab asking during a run gets that run's result. */
    check():Promise<SignInResult> {
      current ??= run().finally(() => { current = undefined; });
      return current;
    },
  };
}
