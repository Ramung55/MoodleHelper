// #86: the toolbar popup shows the real dataset's state and drives Sync all through the worker.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { buildDemoSnapshot } from '@/services/fixtures';
import { installPopup, type PopupEnvironment } from '../../../extension/src/popup';
import type { PopupOperation } from '../../../extension/src/dashboard-bridge';
import { errors, SIGN_IN_PROBE } from '../../../shared/src/bridge';

// vitest runs from frontend/; the packaged popup page is the DOM under test.
const POPUP_HTML = readFileSync(resolve(process.cwd(), '../extension/public/popup.html'), 'utf8');
const BODY = POPUP_HTML.slice(POPUP_HTML.indexOf('<body>') + 6, POPUP_HTML.indexOf('<script'));
const BINDING = 'a'.repeat(32);
const FULL = '2028-03-05T10:00:00.000000+00:00';
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

type Options = { connection?: unknown; mode?: string; selected?: string[]; down?: boolean; sync?: any[] };
function backend(options: Options = {}) {
  const snapshot = buildDemoSnapshot();
  snapshot.settings.trackedCourseIds = options.selected ?? ['c-csc', 'c-math']; snapshot.settings.timezone = 'UTC';
  snapshot.sync = options.sync ?? [
    { courseId: 'c-csc', status: 'ok', coverage: 'full', lastSuccessAt: FULL, progress: 100 },
    { courseId: 'c-math', status: 'ok', coverage: 'full', lastSuccessAt: FULL, progress: 100 },
  ];
  const state = { snapshot, down: !!options.down, requests: [] as string[] };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; state.requests.push(`${init?.method} ${path}`);
    if (state.down) throw new TypeError('Failed to fetch');
    const value = path === '/api/bridge-context' ? { version: '1', binding: BINDING }
      : path === '/api/snapshot' ? state.snapshot
      : path === '/api/connection' ? (options.connection ?? { state: 'connected', message: 'Real dataset.', extensionDetected: true })
      : path === '/api/collection-context' ? { version: '1', binding: BINDING, mode: options.mode ?? 'verified', selectionRevision: 'r1', courses: [] }
      : { courseIds: state.snapshot.settings.trackedCourseIds };
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return { state, fetcher: fetcher as unknown as typeof fetch };
}
const signal = (value: 'signed_in' | 'signed_out' | null) => ({ ok: true, result: { signal: value && { state: value, ...SIGN_IN_PROBE }, checkedAt: '2028-03-05T10:00:00Z' } });
function environment(replies: Partial<Record<'syncAll' | 'checkMoodleSignIn', () => unknown>> = {}) {
  const sent: string[] = [], opened: string[] = [];
  const env: PopupEnvironment = {
    send: vi.fn(async (operation: PopupOperation) => { sent.push(operation); return (replies[operation] ?? (() => signal('signed_in')))(); }),
    openTab: (url) => { opened.push(url); },
    now: () => new Date(2028, 2, 5, 9, 7),
  };
  return { env, sent, opened };
}
const text = () => document.body.textContent!;
const visible = (id: string) => !document.getElementById(id)!.closest('[hidden]');
const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();
function open(options: Options = {}, replies: Parameters<typeof environment>[0] = {}) {
  document.body.innerHTML = BODY;
  const server = backend(options), seam = environment(replies);
  const popup = installPopup(document, server.fetcher, localStorage, undefined, seam.env);
  return { ...server, ...seam, popup };
}

it('AC1: real dataset shows the connection, sign-in, the #21 headline and a closed Details, and no mock text', async () => {
  const { popup, sent } = open();
  await popup.ready;
  expect(document.querySelector('h1')!.textContent).toBe('Moodle Helper');
  expect(document.getElementById('connection')!.textContent).toBe('Extension on · Backend connected · Your data');
  expect(document.getElementById('sign-in')!.textContent).toBe('Signed in to SDU Moodle');
  expect(document.getElementById('full-sync')!.textContent).toBe('Successful full sync: 05/03/2028, 10:00:00 (UTC)');
  expect((document.getElementById('details') as HTMLDetailsElement).open).toBe(false);
  expect(document.getElementById('freshness')!.textContent).toContain('No individual-page refresh recorded.');
  expect(sent).toEqual(['checkMoodleSignIn']);
  const shown = [...document.body.querySelectorAll('*')].filter(node => !node.closest('[hidden]') && node.children.length === 0).map(node => node.textContent).join(' ');
  expect(shown).not.toMatch(/mock|Demonstration|fictional/i);
  expect(visible('sync-all')).toBe(true); expect((document.getElementById('sync-all') as HTMLButtonElement).disabled).toBe(false);
  expect(visible('start')).toBe(false);
  popup.dispose();
});

it('AC1/D6: signed out shows the Sign in link; a not-checked probe falls back to a fixed signed-out sync error', async () => {
  let { popup } = open({}, { checkMoodleSignIn: () => signal('signed_out') });
  await popup.ready;
  const link = document.querySelector<HTMLAnchorElement>('#sign-in a')!;
  expect(document.getElementById('sign-in')!.textContent).toBe('Signed out of SDU Moodle. Sign in');
  expect(link.href).toBe('https://moodle.sdu.edu.kz/login/index.php'); expect(link.target).toBe('_blank');
  popup.dispose();
  ({ popup } = open({}, { checkMoodleSignIn: () => signal(null) }));
  await popup.ready;
  expect(document.getElementById('sign-in')!.textContent).toBe('Moodle sign-in not checked');
  popup.dispose();
  ({ popup } = open({ sync: [{ courseId: 'c-csc', status: 'failed', coverage: 'none', progress: 0, error: 'Sign in to SDU Moodle to continue.' }] }, { checkMoodleSignIn: () => signal(null) }));
  await popup.ready;
  expect(document.getElementById('sign-in')!.textContent).toBe('Signed out of SDU Moodle. Sign in');
  popup.dispose();
});

it('AC2: Sync all sends one worker request on a double click, then shows started, syncing and the updated headline', async () => {
  let release: (value: unknown) => void = () => {};
  const syncing = (id: string) => ({ courseId: id, status: 'syncing' as const, coverage: 'none' as const, progress: 0 });
  const { popup, sent, state, requests } = (() => { const opened = open({ sync: [] }, { syncAll: () => new Promise(resolve => { release = resolve; }) }); return { ...opened, requests: opened.state.requests }; })();
  await popup.ready;
  expect(document.getElementById('full-sync')!.textContent).toBe('No successful full sync yet.');
  vi.useFakeTimers();
  click('sync-all'); click('sync-all');
  expect(sent.filter(op => op === 'syncAll')).toHaveLength(1);
  expect((document.getElementById('sync-all') as HTMLButtonElement).disabled).toBe(true);
  const queued = structuredClone(state.snapshot); queued.sync = [syncing('c-csc'), { courseId: 'c-math', status: 'ok' as const, coverage: 'full' as const, lastSuccessAt: FULL, progress: 100 }];
  release({ ok: true, result: queued });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById('sync-result')!.textContent).toBe('Sync started.');
  expect(document.getElementById('sync-progress')!.textContent).toBe('Syncing 1 of 2 courses…');
  // The popup never sends POST /api/sync itself.
  expect(requests.some(r => r.includes('/api/sync'))).toBe(false);
  state.snapshot.sync = [{ courseId: 'c-csc', status: 'ok', coverage: 'full', lastSuccessAt: FULL, progress: 100 }, { courseId: 'c-math', status: 'ok', coverage: 'full', lastSuccessAt: FULL, progress: 100 }];
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(document.getElementById('full-sync')!.textContent).toBe('Successful full sync: 05/03/2028, 10:00:00 (UTC)'));
  expect(visible('sync-progress')).toBe(false);
  const reads = requests.filter(r => r === 'GET /api/snapshot').length;
  await vi.advanceTimersByTimeAsync(9000);
  expect(requests.filter(r => r === 'GET /api/snapshot').length).toBe(reads);
  popup.dispose();
});

it('AC3: not verified and no selection disable Sync all with their messages; 409 shows the fixed text; backend down shows unreachable', async () => {
  let { popup, sent } = open({ mode: 'synthetic' });
  await popup.ready;
  expect(text()).toContain('Live sync is unavailable until Moodle access is verified.');
  expect((document.getElementById('sync-all') as HTMLButtonElement).disabled).toBe(true);
  expect(sent).toEqual([]); // no probe without verified live sync
  popup.dispose();
  ({ popup } = open({ selected: [] }));
  await popup.ready;
  expect(text()).toContain('No courses selected. Choose them in the dashboard.');
  expect((document.getElementById('sync-all') as HTMLButtonElement).disabled).toBe(true);
  popup.dispose();
  ({ popup } = open({}, { syncAll: () => ({ ok: false, error: { code: 'SYNC_ALREADY_RUNNING', message: errors.SYNC_ALREADY_RUNNING } }) }));
  await popup.ready;
  await popup.syncAll();
  expect(document.getElementById('sync-result')!.textContent).toBe(errors.SYNC_ALREADY_RUNNING);
  popup.dispose();
  const down = open({}, { syncAll: () => ({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: errors.BACKEND_UNAVAILABLE } }) });
  await down.popup.ready;
  down.state.down = true;
  await down.popup.syncAll();
  expect(visible('unreachable')).toBe(true); expect(visible('sync-all')).toBe(false);
  down.popup.dispose();
});

it('AC7: an unreachable backend shows only the header, the start command and Reconnect', async () => {
  const errorsLogged = vi.spyOn(console, 'error');
  const { popup, sent } = open({ down: true });
  await popup.ready;
  expect(visible('unreachable')).toBe(true);
  expect(document.querySelector('#unreachable code')!.textContent).toBe('uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000');
  for (const id of ['connection', 'sync-all', 'open-dashboard', 'full-sync', 'start', 'status']) expect(visible(id)).toBe(false);
  expect(document.getElementById('full-sync')!.textContent).toBe('');
  expect(visible('reconnect')).toBe(true);
  expect(sent).toEqual([]); expect(errorsLogged).not.toHaveBeenCalled();
  popup.dispose();
});

it('AC5: Reconnect shows Checking…, then Checked at HH:MM with the result, on every click', async () => {
  const { popup, state } = open();
  await popup.ready;
  const button = document.getElementById('reconnect') as HTMLButtonElement;
  state.down = true;
  const first = popup.reconnect();
  expect(button.textContent).toBe('Checking…'); expect(button.disabled).toBe(true);
  await first;
  expect(button.textContent).toBe('Reconnect'); expect(button.disabled).toBe(false);
  expect(document.getElementById('checked')!.textContent).toBe("Checked at 09:07 · Can't reach the local backend.");
  expect(visible('unreachable')).toBe(true);
  state.down = false;
  await popup.reconnect();
  expect(document.getElementById('checked')!.textContent).toBe('Checked at 09:07 · Backend connected · Your data · Signed in to SDU Moodle');
  expect(visible('connection')).toBe(true); expect(visible('unreachable')).toBe(false);
  popup.dispose();
});

it('AC6: demo dataset shows the labelled mock section, no Sync all and no probe', async () => {
  const { popup, sent } = open({ connection: { state: 'demo', message: 'Demo.', extensionDetected: false } });
  await popup.ready;
  expect(document.getElementById('connection')!.textContent).toBe('Extension on · Backend connected · Demo data');
  expect(visible('start')).toBe(true); expect(visible('sync-all')).toBe(false);
  expect(document.querySelector('#demo h2')!.textContent).toBe('Demo data — mock scan progress');
  await waitFor(() => expect((document.getElementById('start') as HTMLButtonElement).disabled).toBe(false));
  expect(sent).toEqual([]);
  popup.dispose();
});

it('AC4: Open dashboard opens the configured dashboard URL', async () => {
  const { popup, opened } = open();
  await popup.ready;
  click('open-dashboard');
  expect(opened).toEqual(['https://ramung55.github.io/MoodleHelper/']);
  popup.dispose();
});
