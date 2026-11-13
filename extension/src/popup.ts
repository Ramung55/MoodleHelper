import { BACKEND, type PopupOperation, type PopupReply } from './dashboard-bridge';
import { DISCOVERY_MESSAGES, errors, validResult, validSchema, type SignInResult } from '../../shared/src/bridge';
import { createMockProgress, type ProgressState } from '../../shared/src/mock-progress';
import { syncFreshness, type FullSyncAttestation } from '../../shared/src/full-sync';
import { VISIT_MESSAGES, VISIT_STATE_SOURCE, visitRoute, type VisitState } from './page-visit';

declare const __MOODLE_HELPER_DASHBOARD_URL__: string | undefined;
/** #86 D3: the approved Pages dashboard; a local dev build may inject an approved dev URL (extension/build.ts). */
export const DASHBOARD_URL = typeof __MOODLE_HELPER_DASHBOARD_URL__ === 'string' ? __MOODLE_HELPER_DASHBOARD_URL__ : 'https://ramung55.github.io/MoodleHelper/';
export const SIGN_IN_URL = 'https://moodle.sdu.edu.kz/login/index.php';
export const START_COMMAND = 'uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000';

/** #86 runtime/tab seam. The installed popup uses chrome.runtime and chrome.tabs. */
export type PopupEnvironment = {
  /** Sends `{source:'moodle-helper-popup', operation}` to this extension's worker. */
  send?: (operation: PopupOperation) => Promise<unknown>;
  openTab?: (url: string) => void;
  /** #95: the active tab's live-update state; `null` when that page has none yet. */
  pageVisit?: () => Promise<VisitState | null | undefined>;
  dashboardUrl?: string;
  now?: () => Date;
};

function chromeEnvironment(): PopupEnvironment {
  const chromeApi = (globalThis as any).chrome;
  const env: PopupEnvironment = {};
  if (typeof chromeApi?.runtime?.sendMessage === 'function') env.send = (operation) => new Promise((resolve) => {
    try {
      chromeApi.runtime.sendMessage({ source: 'moodle-helper-popup', operation }, (reply: unknown) => resolve(chromeApi.runtime.lastError ? undefined : reply));
    } catch { resolve(undefined); }
  });
  if (typeof chromeApi?.tabs?.create === 'function') env.openTab = (url) => { chromeApi.tabs.create({ url }); };
  if (typeof chromeApi?.tabs?.query === 'function' && typeof chromeApi?.runtime?.sendMessage === 'function') env.pageVisit = () => new Promise((resolve) => {
    try {
      chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs: { id?: number; url?: string }[] | undefined) => {
        const tab = chromeApi.runtime.lastError ? undefined : tabs?.[0];
        // Without host access Chrome hides a tab's URL: such a page is not an SDU page either.
        if (!tab || typeof tab.url !== 'string' || !visitRoute(tab.url)) { resolve({ status: 'not_supported', message: VISIT_MESSAGES.not_supported }); return; }
        chromeApi.runtime.sendMessage({ source: VISIT_STATE_SOURCE, tabId: tab.id }, (reply: unknown) => resolve(chromeApi.runtime.lastError ? undefined : reply as VisitState | null));
      });
    } catch { resolve(undefined); }
  });
  return env;
}

function popupReply(value: unknown, operation: PopupOperation): PopupReply | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const reply = value as any;
  if (reply.ok === true) return validResult(operation, reply.result) ? reply : undefined;
  if (reply.ok === false && typeof reply.error?.code === 'string' && Object.hasOwn(errors, reply.error.code)) return reply;
  return undefined;
}

const hhmm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

type Loaded =
  | { kind: 'unreachable' }
  | { kind: 'demo'; snapshot: any }
  | { kind: 'real'; snapshot: any; verified: boolean };

/**
 * The toolbar popup (#86). Real dataset: connection, Moodle sign-in, the #21 freshness
 * rule, Sync all through the worker, Open dashboard and Reconnect. Demo dataset (or an
 * unreadable connection): the #21 mock scan progress, labelled. The optional fifth
 * argument is a test seam; existing four-argument calls keep working.
 */
export function installPopup(doc:Document, fetcher:typeof fetch=fetch, storage:Storage=localStorage, fullSyncAttestation?:FullSyncAttestation, environment?:PopupEnvironment) {
  const env = { ...(environment ?? chromeEnvironment()) };
  const now = env.now ?? (() => new Date());
  const dashboardUrl = env.dashboardUrl ?? DASHBOARD_URL;
  let binding = '', disposed = false, generation = 0, pollSerial = 0, syncing = false, syncInFlight = false, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let state: Loaded | undefined, signIn: SignInResult | undefined, mock: ReturnType<typeof createMockProgress> | undefined;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const show = (id: string, visible: boolean) => { const node = el(id); if (node) node.hidden = !visible; };
  const text = (id: string, value: string) => { const node = el(id); if (node) node.textContent = value; };
  const status = el('status'), freshness = el('freshness');
  const start = el<HTMLButtonElement>('start'), cancel = el<HTMLButtonElement>('cancel'), reconnect = el<HTMLButtonElement>('reconnect');
  const exampleRetry = el<HTMLButtonElement>('example-retry'), syncButton = el<HTMLButtonElement>('sync-all'), openDashboard = el<HTMLButtonElement>('open-dashboard');
  for (const button of [start, cancel, exampleRetry, syncButton]) if (button) button.disabled = true;

  async function request(path:string, schema:string, body?:unknown) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
    try {
      const response=await fetcher(BACKEND+path,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(binding?{'X-Moodle-Helper-Bridge-Binding':binding}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!response.ok) throw new Error('unavailable');
      const text=await response.text(); if(new TextEncoder().encode(text).length>1024*1024) throw new Error('response too large');
      const value=JSON.parse(text); if(!validSchema(schema,value)) throw new Error('invalid response'); return value;
    } finally {clearTimeout(timer);}
  }

  /** D1: every read, with a fresh binding. Only a readable non-demo connection is the real dataset. */
  async function load(): Promise<Loaded> {
    binding = '';
    let snapshot: any;
    try {
      binding = (await request('/api/bridge-context', 'BridgeContext')).binding;
      snapshot = await request('/api/snapshot', 'Snapshot');
    } catch { return { kind: 'unreachable' }; }
    const realData = await request('/api/connection', 'ConnectionInfo').then(c => c.state !== 'demo', () => false);
    if (!realData) return { kind: 'demo', snapshot };
    const verified = await request('/api/collection-context', 'CollectionContext').then(c => c.mode === 'verified', () => false);
    return { kind: 'real', snapshot, verified };
  }

  const selected = (snapshot: any): string[] => snapshot.settings.trackedCourseIds;
  const entries = (snapshot: any) => selected(snapshot).map((id: string) => snapshot.sync.find((s: any) => s.courseId === id));

  function renderFreshness(snapshot: any, realData: boolean) {
    const lines = syncFreshness(snapshot, realData, fullSyncAttestation);
    text('full-sync', lines.fullSync);
    if (!freshness) return;
    freshness.replaceChildren();
    for (const line of [lines.pageRefresh, ...lines.courses]) { const item = doc.createElement('p'); item.textContent = line; freshness.append(item); }
    if (realData) return;
    const saved = doc.createElement('p'); saved.textContent = `Saved data: ${snapshot.courses.length} courses, ${snapshot.assessments.length} assessments. Previous data remains available in the dashboard.`; freshness.append(saved);
    const list = doc.createElement('ul');
    for (const assessment of snapshot.assessments.slice(0, 5)) { const item = doc.createElement('li'); item.textContent = assessment.title; list.append(item); }
    freshness.append(list);
  }

  /** D6: a probe signal wins; otherwise a selected course's fixed signed-out error; otherwise not checked. */
  function signInState(snapshot: any): 'signed_in' | 'signed_out' | 'unknown' {
    if (signIn?.signal) return signIn.signal.state;
    return entries(snapshot).some((entry: any) => entry?.error === DISCOVERY_MESSAGES.signedOut) ? 'signed_out' : 'unknown';
  }
  function renderSignIn(snapshot: any) {
    const line = el('sign-in'); if (!line) return;
    const value = signInState(snapshot);
    line.replaceChildren();
    if (value === 'signed_in') line.textContent = 'Signed in to SDU Moodle';
    else if (value === 'unknown') line.textContent = 'Moodle sign-in not checked';
    else {
      const link = doc.createElement('a'); link.href = SIGN_IN_URL; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Sign in';
      line.append('Signed out of SDU Moodle. ', link);
    }
  }

  function renderReal(snapshot: any, verified: boolean) {
    renderSignIn(snapshot);
    const notes = el('sync-notes');
    const ids = selected(snapshot);
    if (notes) {
      notes.replaceChildren();
      const note = (value: string) => { const p = doc.createElement('p'); p.textContent = value; notes.append(p); };
      if (!verified) note('Live sync is unavailable until Moodle access is verified.');
      if (!ids.length) note('No courses selected. Choose them in the dashboard.');
    }
    const states = entries(snapshot);
    syncing = states.some((entry: any) => entry?.status === 'syncing');
    const done = states.filter((entry: any) => entry?.status !== 'syncing').length;
    text('sync-progress', syncing ? `Syncing ${done} of ${ids.length} courses…` : '');
    show('sync-progress', syncing);
    if (syncButton) syncButton.disabled = syncInFlight || !verified || !ids.length;
    renderFreshness(snapshot, true);
  }

  function render(loaded: Loaded) {
    state = loaded;
    const reachable = loaded.kind !== 'unreachable';
    show('connection', reachable); show('unreachable', !reachable); show('saved', reachable);
    show('real', loaded.kind === 'real'); show('demo', loaded.kind === 'demo');
    if (loaded.kind === 'unreachable') {
      // AC7: no stale numbers, mock controls or Sync all; only the message and Reconnect.
      stopPolling(); stopMock(); text('full-sync', ''); freshness?.replaceChildren(); text('connection', ''); return;
    }
    text('connection', `Extension on · Backend connected · ${loaded.kind === 'real' ? 'Your data' : 'Demo data'}`);
    if (loaded.kind === 'real') { stopMock(); renderReal(loaded.snapshot, loaded.verified); schedulePoll(); }
    else { stopPolling(); renderFreshness(loaded.snapshot, false); startMock(); }
  }

  /** While a selected course is syncing, one timer re-reads /api/snapshot every 3 s. */
  function stopPolling() { ++pollSerial; if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined; }
  function schedulePoll() {
    stopPolling();
    if (!syncing || disposed) return;
    pollTimer = setTimeout(async () => {
      pollTimer = undefined;
      const serial = pollSerial;
      let snapshot: any;
      try { snapshot = await request('/api/snapshot', 'Snapshot'); } catch { snapshot = undefined; }
      if (disposed || serial !== pollSerial || state?.kind !== 'real') return;
      if (snapshot) { state = { ...state, snapshot }; renderReal(snapshot, state.verified); }
      schedulePoll();
    }, 3000);
  }

  // D5: the #21 mock, unchanged, only in the demo dataset.
  const renderMock = (progress: ProgressState) => {
    if (!status || !start || !cancel) return;
    status.replaceChildren();
    const add = (value: string) => { const p = doc.createElement('p'); p.textContent = value; status.append(p); };
    const snapshot = state?.kind === 'demo' ? state.snapshot : undefined;
    const run = progress.current?.run, active = !!run && ['pending', 'running'].includes(run.status);
    if (progress.unavailable) add('Progress unavailable or outcome unknown. Reconnect and read back before retrying. Saved data remains visible.');
    else if (!progress.current?.courseIds.length) add('Select courses in dashboard Settings to start.');
    else if (run) {
      add(`Mock run: ${run.status} · ${run.progress.completed}/${run.progress.total} completed`);
      for (const job of run.jobs) add(`${snapshot?.courses.find((c: any) => c.id === job.courseId)?.name ?? job.courseId}: ${job.state}`);
    }
    if (progress.current?.lastFailedRun) add(`Last failed mock attempt started: ${new Date(progress.current.lastFailedRun.createdAt * 1000).toLocaleString()}`);
    if (progress.uncertain) add('A request may have completed. Reconnect and read back; explicit retry uses the same unresolved key.');
    start.disabled = progress.busy || progress.unavailable || !progress.current?.courseIds.length || active;
    if (exampleRetry) exampleRetry.disabled = start.disabled;
    start.textContent = run && !active ? 'Retry mock run' : 'Start mock run'; cancel.disabled = progress.busy || progress.unavailable || !active;
  };
  // The binding was just read by load(); a mock reconnect only re-reads it when asked again.
  let mockFresh = false;
  const transport = {
    async connect() { if (mockFresh) { mockFresh = false; return; } binding = (await request('/api/bridge-context', 'BridgeContext')).binding; },
    current: () => request('/api/queue/current', 'QueueCurrent'),
    start: (key: string) => request('/api/queue/current', 'QueueRun', { idempotencyKey: key }),
    cancel: (id: string) => request(`/api/queue/runs/${encodeURIComponent(id)}/cancel`, 'QueueRun', {}),
  };
  function startMock() { if (!mock && !disposed) { mockFresh = true; mock = createMockProgress(transport, renderMock, storage); } }
  function stopMock() {
    mock?.dispose(); mock = undefined;
    status?.replaceChildren();
    for (const button of [start, cancel, exampleRetry]) if (button) button.disabled = true;
  }

  /** D2/D6: the #46 probe through the worker, only in the real dataset with live sync verified. */
  async function probe(serial: number) {
    if (!env.send || state?.kind !== 'real' || !state.verified) return;
    const reply = popupReply(await env.send('checkMoodleSignIn'), 'checkMoodleSignIn');
    if (disposed || serial !== generation || state?.kind !== 'real') return;
    signIn = reply?.ok ? reply.result : undefined;
    renderSignIn(state.snapshot);
  }

  async function refresh(): Promise<Loaded> {
    const serial = ++generation;
    stopPolling();
    const loaded = await load();
    if (disposed || serial !== generation) return loaded;
    render(loaded);
    return loaded;
  }

  // D2: Sync all is sent by the worker; one request while one is in flight.
  async function syncAll() {
    if (syncInFlight || state?.kind !== 'real' || !state.verified || !selected(state.snapshot).length) return;
    syncInFlight = true;
    if (syncButton) syncButton.disabled = true;
    const result = (value: string) => { text('sync-result', value); show('sync-result', true); };
    try {
      const reply = env.send ? popupReply(await env.send('syncAll'), 'syncAll') : undefined;
      if (disposed) return;
      if (!reply) { result(errors.RECONNECT_REQUIRED); return; }
      if (!reply.ok) {
        if (reply.error.code === 'BACKEND_UNAVAILABLE') { const loaded = await refresh(); if (loaded.kind !== 'unreachable') result(errors.BACKEND_UNAVAILABLE); return; }
        result(errors[reply.error.code]);
        return;
      }
      result('Sync started.');
      if (state?.kind === 'real') { state = { ...state, snapshot: reply.result }; renderReal(reply.result, state.verified); schedulePoll(); }
    } finally {
      syncInFlight = false;
      if (!disposed && state?.kind === 'real' && syncButton) syncButton.disabled = !state.verified || !selected(state.snapshot).length;
    }
  }

  // D4: Reconnect re-runs every read (and the probe), then says when and what it found.
  let checking = false;
  async function reconnectAll() {
    if (checking) return;
    checking = true;
    if (reconnect) { reconnect.disabled = true; reconnect.textContent = 'Checking…'; }
    try {
      const loaded = await refresh();
      if (disposed) return;
      if (loaded.kind === 'real') await probe(generation);
      else if (loaded.kind === 'demo') await mock?.reconnect();
      if (disposed) return;
      const parts = loaded.kind === 'unreachable' ? ["Can't reach the local backend."]
        : ['Backend connected', loaded.kind === 'real' ? 'Your data' : 'Demo data'];
      if (loaded.kind === 'real' && state?.kind === 'real') {
        const value = signInState(state.snapshot);
        parts.push(value === 'signed_in' ? 'Signed in to SDU Moodle' : value === 'signed_out' ? 'Signed out of SDU Moodle' : 'Moodle sign-in not checked');
      }
      text('checked', `Checked at ${hhmm(now())} · ${parts.join(' · ')}`); show('checked', true);
    } finally {
      checking = false;
      if (reconnect && !disposed) { reconnect.disabled = false; reconnect.textContent = 'Reconnect'; }
    }
  }

  if (start) start.onclick = () => void mock?.start();
  if (exampleRetry) exampleRetry.onclick = () => void mock?.start();
  if (cancel) cancel.onclick = () => void mock?.cancel();
  if (reconnect) reconnect.onclick = () => void reconnectAll();
  if (syncButton) syncButton.onclick = () => void syncAll();
  if (openDashboard) openDashboard.onclick = () => env.openTab?.(dashboardUrl);

  // #95: what live updating did with the page in the active tab (only fixed messages are shown).
  async function renderPageVisit() {
    const value = await env.pageVisit?.().catch(() => undefined);
    if (disposed) return;
    const message = value && Object.values(VISIT_MESSAGES).includes(value.message as never) ? value.message : '';
    text('page-visit', message); show('page-visit', !!message);
  }
  const ready = Promise.all([renderPageVisit(), refresh().then(async (loaded) => { if (loaded.kind === 'real') { signIn = undefined; await probe(generation); } })]).then(() => {});
  return {
    ready,
    reconnect: reconnectAll,
    syncAll,
    openDashboard: () => env.openTab?.(dashboardUrl),
    dispose() { disposed = true; ++generation; stopPolling(); mock?.dispose(); mock = undefined; },
  };
}
