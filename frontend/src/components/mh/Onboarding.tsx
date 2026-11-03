import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app-store";
import { BridgeClient, checkSduSignIn } from "@/services/extension-adapter";
import type { AiAvailability } from "@/services/adapter";
import { TrackedCourses } from "@/routes/settings";
import { TeachingCalendarSettings } from "@/components/mh/TeachingCalendarSettings";
import { ReminderSettingsPanel } from "@/components/mh/ReminderSettings";
import { MockProgress } from "@/components/mh/MockProgress";
import { cn } from "@/lib/utils";
import { APPROVED_ORIGINS, BridgeError, DISCOVERY_MESSAGES, errors, type SignInResult } from "../../../../shared/src/bridge";
import { syncFreshness } from "../../../../shared/src/full-sync";
import type { CourseSyncState } from "@/domain/types";
import {
  classifyHandshake, deriveSteps, emptyHint, hintKey, initialSyncComplete, moodleSignIn, MOODLE_LOGIN_URL, parseHint, resumeStep, STEP_IDS,
  withChoice, withVisit, type Choice, type ExtensionStatus, type Hint, type MoodleAccessSignal, type StepId, type StepState,
} from "@/domain/onboarding";

const TITLES: Record<StepId, string> = {
  connection: "Extension & Moodle connection",
  courses: "Choose tracked courses",
  sync: "Initial sync",
  calendar: "Semester calendar",
  notifications: "Notifications",
  privacy: "Local storage & optional AI",
};
const LABEL: Record<StepState, string> = { done: "Done", choice: "Skipped / chosen", blocked: "Unavailable", todo: "Not finished" };

type Scope = { datasetId: string; epoch: number } | null;
/** The local build and load-unpacked steps (#49 pilot guide). */
export const PILOT_GUIDE_URL = "https://github.com/Ramung55/MoodleHelper/blob/main/_docs/pilot-49.md";

function readStore(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function writeStore(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* hint only */ } }

/** #46 AC2: one selected course's progress from its Snapshot `sync` entry (#20/#21). */
function syncLine(entry: CourseSyncState | undefined): string {
  if (!entry || entry.status === "never") return "not synced yet";
  if (entry.status === "syncing") return `syncing… ${entry.progress}%`;
  if (entry.status === "failed") return `failed: ${entry.error ?? "Earlier data was kept."}`;
  // Incomplete page types are partial coverage, never a full sync.
  if (entry.status === "partial" || entry.coverage !== "full") return "completed with partial coverage (some page types were not read)";
  return "completed (full coverage)";
}

/** #21's shared freshness rule: partial coverage is never shown as a full sync. */
function SyncFreshness({ snap }: { snap: Parameters<typeof syncFreshness>[0] }) {
  const f = syncFreshness(snap, true);
  return <div className="text-xs text-muted-foreground"><p>{f.fullSync}</p>{f.courses.map((line) => <p key={line}>{line}</p>)}</div>;
}

/** Handshake probe via the existing versioned BridgeClient; never installs anything. */
export async function probeExtension(make: () => Pick<BridgeClient, "connect" | "dispose"> = () => new BridgeClient()): Promise<ExtensionStatus> {
  const client = make();
  try { return classifyHandshake({ ok: true, hello: await client.connect() }); }
  catch (error) { return classifyHandshake({ ok: false, error }); }
  finally { client.dispose(); }
}

export function Onboarding({ probe = probeExtension, moodleAccess = null, signInProbe }: {
  probe?: () => Promise<ExtensionStatus>;
  moodleAccess?: MoodleAccessSignal | null;
  /** #46 read-only sign-in probe; defaults to the extension's `checkMoodleSignIn`. */
  signInProbe?: () => Promise<SignInResult>;
}) {
  const { snap, adapter, conn, syncAll, setSnap } = useApp();
  const [extension, setExtension] = useState<ExtensionStatus>({ kind: "checking" });
  const [scope, setScope] = useState<Scope>(null);
  const [hint, setHint] = useState<Hint>(emptyHint);
  const [active, setActive] = useState<StepId | null>(null);
  const [ai, setAi] = useState<AiAvailability | null>(null);
  const scopeRef = useRef<string | null>(null);

  // #46: the sign-in signal comes only from the extension's probe (never persisted).
  const [signal, setSignal] = useState<MoodleAccessSignal | null>(moodleAccess);
  const [signInChecking, setSignInChecking] = useState(false);
  const probed = useRef(false);
  const realData = !!conn && conn.state !== "demo";
  const askSignIn = useCallback(async () => {
    setSignInChecking(true);
    try {
      const result = await (signInProbe ? signInProbe() : adapter.checkMoodleSignIn ? adapter.checkMoodleSignIn() : checkSduSignIn());
      setSignal(result.signal);
    } catch { setSignal(null); }
    finally { setSignInChecking(false); }
  }, [signInProbe, adapter]);

  useEffect(() => {
    let alive = true;
    setExtension({ kind: "checking" });
    void probe().then((status) => alive && setExtension(status));
    return () => { alive = false; };
  }, [probe]);
  /** Check again: the extension handshake, then (real dataset, extension ready) one sign-in probe. */
  const check = useCallback(async () => {
    probed.current = true;
    setExtension({ kind: "checking" });
    const status = await probe();
    setExtension(status);
    if (status.kind === "ready" && realData) await askSignIn();
  }, [probe, realData, askSignIn]);
  useEffect(() => {
    let alive = true;
    void adapter.aiAvailability().then((v) => alive && setAi(v)).catch(() => alive && setAi({ available: false, reason: "External AI is unavailable. No text is sent." }));
    return () => { alive = false; };
  }, [adapter]);

  // Scope the navigation hint to the dataset + lifecycle epoch; a refreshed epoch resets it.
  const epochSignal = snap ? `${snap.settings.trackedCourseIds.join(",")}|${snap.settings.teachingCalendar ? 1 : 0}` : "";
  useEffect(() => {
    let alive = true;
    const load = async () => {
      let next: Scope = null;
      try { const c = await adapter.restoreContext?.(); if (c) next = { datasetId: c.datasetId, epoch: c.epoch }; } catch { next = null; }
      if (!alive) return;
      const key = next ? hintKey(next) : null;
      if (key === scopeRef.current) return;
      scopeRef.current = key;
      setScope(next);
      setHint(key ? parseHint(readStore(key)) : emptyHint());
    };
    void load();
    return () => { alive = false; };
  }, [adapter, epochSignal]);

  /** Capture scope at start; a changed epoch cannot authorize a stale hint write. */
  const record = useCallback(async (update: (h: Hint) => Hint) => {
    const started = scopeRef.current;
    let current: string | null = started;
    try { const c = await adapter.restoreContext?.(); current = c ? hintKey(c) : null; } catch { current = started; }
    if (current !== started) { scopeRef.current = null; setScope(null); setHint(emptyHint()); return; }
    setHint((h) => { const next = update(h); if (started) writeStore(started, JSON.stringify(next)); return next; });
  }, [adapter]);

  // #46 AC2: Start initial sync is an explicit click; its reply (not hello) decides availability.
  const [syncView, setSyncView] = useState<{ pending: boolean; unavailable: string | null; running: boolean; error: string | null }>(
    { pending: false, unavailable: null, running: false, error: null });
  const syncBusy = useRef(false);
  const refreshSnapshot = useCallback(() => adapter.load().then(setSnap).catch(() => undefined), [adapter, setSnap]);
  const startSync = useCallback(async () => {
    if (syncBusy.current) return;
    syncBusy.current = true;
    // Stay on this step whatever the reply, so its outcome is read here.
    setActive("sync");
    setSyncView({ pending: true, unavailable: null, running: false, error: null });
    try {
      const outcome = await syncAll();
      if (outcome.ok) setSyncView({ pending: false, unavailable: null, running: false, error: null });
      else if (outcome.code === "SYNC_ALREADY_RUNNING" || outcome.message === errors.SYNC_ALREADY_RUNNING) {
        // Another start (or tab) already runs it: show that run's progress, not an error.
        setSyncView({ pending: false, unavailable: null, running: true, error: null });
        await refreshSnapshot();
      } else if (outcome.code === "SYNC_UNAVAILABLE" || outcome.message === errors.SYNC_UNAVAILABLE)
        setSyncView({ pending: false, unavailable: outcome.message, running: false, error: null });
      else setSyncView({ pending: false, unavailable: null, running: false, error: outcome.message });
    } finally { syncBusy.current = false; }
  }, [syncAll, refreshSnapshot]);

  const signIn = moodleSignIn(signal);
  const liveSync = realData && extension.kind === "ready" && !syncView.unavailable ? "ready" : "unavailable";
  const states = snap ? deriveSteps({ snap, extension, liveSync, hint, ...(realData ? { signIn: signIn.kind } : {}) }) : null;
  const next = states ? resumeStep(states) : null;
  const current = active ?? next ?? "privacy";
  // Once when the sign-in step is shown (real dataset, extension ready); re-renders never probe again.
  const probeNow = !!snap && current === "connection" && extension.kind === "ready" && realData;
  useEffect(() => {
    if (!probeNow || probed.current) return;
    probed.current = true;
    void askSignIn();
  }, [probeNow, askSignIn]);
  // While a selected course is syncing, re-read the local Snapshot (never Moodle) for its progress.
  const selectedSyncing = !!snap && realData && snap.settings.trackedCourseIds.some((id) => snap.sync.find((s) => s.courseId === id)?.status === "syncing");
  useEffect(() => {
    if (!selectedSyncing || current !== "sync") return;
    const timer = setInterval(() => { void refreshSnapshot(); }, 2000);
    return () => clearInterval(timer);
  }, [selectedSyncing, current, refreshSnapshot]);

  if (!snap || !states) return null;
  const choose = (id: StepId, c: Choice) => { void record((h) => withChoice(h, id, c)); setActive(null); };
  const open = (id: StepId) => { setActive(id); void record((h) => withVisit(h, id)); };
  const empty = !snap.courses.length && !snap.assessments.length;

  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{empty
      ? "First run: work through this checklist. Local dashboard features stay available whenever a live step is unavailable."
      : "Optional setup. Your saved data is kept; nothing here resets it."}{" "}
      {!scope && "Setup progress hints are kept only for this visit (no dataset identity available)."}</p>
    {next === null && <p role="status" className="text-sm">Every step is finished or explicitly skipped. You can revisit any step.</p>}
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="Setup steps"><ol className="space-y-1">
        {STEP_IDS.map((id, i) => <li key={id}>
          <button type="button" aria-current={current === id ? "step" : undefined} onClick={() => open(id)}
            className={cn("flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm", current === id ? "border-primary bg-muted" : "bg-card")}>
            <span>{i + 1}. {TITLES[id]}</span><span className="text-xs text-muted-foreground">{LABEL[states[id]]}</span>
          </button>
        </li>)}
      </ol></nav>
      <section aria-labelledby="setup-step" className="space-y-3 rounded-lg border bg-card p-5">
        <h2 id="setup-step" className="text-lg font-semibold">{TITLES[current]}</h2>

        {current === "connection" && <>
          <p role="status" className="text-sm">{extension.kind === "checking" ? "Checking extension…"
            : extension.kind === "ready" ? `Extension connected. Local repository ready. Moodle collection is ${conn?.liveSync ? "ready" : extension.moodleCollection}.`
            : `${{ missing: "Extension missing.", incompatible: "Extension incompatible.", unavailable: "Extension unavailable.", backend_unavailable: "Local backend unavailable." }[extension.kind]} ${extension.message}`}</p>
          {(extension.kind === "missing" || extension.kind === "incompatible") && <div className="text-sm text-muted-foreground">
            <p>To install (never automatic): build with <code>bun run --cwd extension build</code>, open <code>chrome://extensions</code>, enable Developer mode, choose Load unpacked and select <code>extension/dist</code> (steps in <a className="underline" href={PILOT_GUIDE_URL} target="_blank" rel="noopener noreferrer"><code>_docs/pilot-49.md</code></a>). Use Chrome 109 or newer.</p>
            <p>Open the dashboard only on {APPROVED_ORIGINS.join(" or ")} and allow local site access, then reconnect.</p>
          </div>}
          <p role="status" className="text-sm">{signInChecking ? "Checking Moodle sign-in…" : signIn.message}{" "}
            {signIn.kind !== "signed_in" && <a className="underline" href={MOODLE_LOGIN_URL} target="_blank" rel="noopener noreferrer">Open SDU Moodle sign-in</a>}</p>
          <p className="text-xs text-muted-foreground">An installed extension does not prove you are signed in. Moodle Helper never asks for your Moodle password, cookies or tokens.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={extension.kind === "checking" || signInChecking} onClick={() => void check()}>Check again</Button>
            {states.connection !== "done" && <Button variant="ghost" onClick={() => choose("connection", "skipped")}>Continue locally</Button>}
          </div>
        </>}

        {current === "courses" && <>
          <p className="text-sm text-muted-foreground">Review discovered courses and labels. Nothing is tracked until you tick it; your saved selection is kept when you leave.</p>
          <TrackedCourses />
        </>}

        {current === "sync" && <>
          {!realData
            ? <p role="status" className="text-sm">Initial sync unavailable: {new BridgeError("SYNC_UNAVAILABLE").message} This step stays unfinished. Previously saved data remains visible.</p>
            : extension.kind !== "ready"
              ? <p role="status" className="text-sm">Initial sync needs the Moodle Helper extension. Finish the connection step, then come back. Previously saved data remains visible.</p>
              : syncView.unavailable
                ? <p role="status" className="text-sm">Initial sync unavailable: {syncView.unavailable} This step stays unfinished. Previously saved data remains visible.</p>
                : <p className="text-sm text-muted-foreground">Start initial sync reads your selected courses from SDU Moodle, one page at a time, with your own signed-in session. Nothing starts until you click.</p>}
          {!snap.settings.trackedCourseIds.length && <p className="text-sm">Choose tracked courses first.</p>}
          {liveSync === "ready" && !!snap.settings.trackedCourseIds.length && !initialSyncComplete(snap) && (
            selectedSyncing || syncView.running
              ? <p role="status" className="text-sm">A sync is running. Its progress is shown below.</p>
              : <Button disabled={syncView.pending} onClick={() => void startSync()}>{syncView.pending ? "Starting…" : "Start initial sync"}</Button>)}
          {syncView.error && <p role="alert" className="text-sm text-destructive">{syncView.error}</p>}
          {realData
            ? <>
              <ul className="space-y-1 text-sm">{snap.settings.trackedCourseIds.map((id) => {
                const entry = snap.sync.find((s) => s.courseId === id);
                const course = snap.courses.find((c) => c.id === id);
                return <li key={id}>{course?.code || course?.name || id}: {syncLine(entry)}
                  {entry?.status === "failed" && entry.error === DISCOVERY_MESSAGES.signedOut && <>{" "}
                    <a className="underline" href={MOODLE_LOGIN_URL} target="_blank" rel="noopener noreferrer">Open SDU Moodle sign-in</a></>}</li>;
              })}</ul>
              <SyncFreshness snap={snap} />
            </>
            : <>
              <ul className="text-sm">{snap.sync.filter((s) => snap.settings.trackedCourseIds.includes(s.courseId)).map((s) =>
                <li key={s.courseId}>{snap.courses.find((c) => c.id === s.courseId)?.code ?? s.courseId}: saved status {s.status}{s.error ? ` · ${s.error}` : ""}</li>)}</ul>
              <details className="text-sm"><summary>Demonstration only: mock scan (not your Moodle data)</summary><MockProgress snapshot={snap} /></details>
            </>}
          <Button variant="ghost" onClick={() => choose("sync", "skipped")}>Skip for now</Button>
        </>}

        {current === "calendar" && <>
          <p className="text-sm text-muted-foreground">Enter your explicit teaching calendar. Nothing is filled in from legacy defaults. Date-only deadlines keep their precision, and work without a resolvable week is shown as unallocated rather than guessed.</p>
          <TeachingCalendarSettings />
        </>}

        {current === "notifications" && <>
          <p className="text-sm text-muted-foreground">Reminders are delivered by the Moodle Helper Chrome extension only while Chrome is open and the local backend is running. Every alert is also kept on the Alerts page. Chrome's notification permission belongs to the extension; this page never asks for it.</p>
          <ReminderSettingsPanel />
          <p className="text-xs text-muted-foreground">If notifications are blocked, allow them for Moodle Helper in Chrome (chrome://settings/content/notifications). Declining never blocks the dashboard.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => choose("notifications", "acknowledged")}>Keep these reminder settings</Button>
            <Button variant="ghost" onClick={() => choose("notifications", "declined")}>No notifications</Button>
          </div>
        </>}

        {current === "privacy" && <>
          <h3 className="font-medium">Local storage</h3>
          <p className="text-sm text-muted-foreground">Courses, deadlines, settings and your changes are stored as structured records in a local SQLite database on this computer. Imported PDF/DOCX files, OCR output and evidence stay in this browser's local storage for this dashboard origin. Backups contain records and settings, not original documents or downloaded files. There is no account and no cross-device sync.</p>
          <h3 className="font-medium">Optional external AI</h3>
          <p className="text-sm text-muted-foreground">Off by default. Finishing setup or allowing notifications does not consent to sending anything. You'd be asked at the moment of sending, with the exact excerpts, destination and retention shown.</p>
          <p role="status" className="text-sm">{ai === null ? "Checking AI availability…" : ai.available ? `Provider ${ai.provider} available; still off until you consent at send time.` : `External AI unavailable; no text is sent. ${ai.reason}`}</p>
          <p className="text-xs text-muted-foreground">Declining AI keeps every local feature: local extraction, OCR and review.</p>
          <Button variant="outline" onClick={() => choose("privacy", "acknowledged")}>I understand</Button>
        </>}

        <p className="pt-2 text-sm"><Link to="/" className="underline">Go to dashboard</Link> — available at any time.</p>
      </section>
    </div>
  </div>;
}
