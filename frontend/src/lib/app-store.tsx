import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { resolveAssessmentId, viewAll, type AssessmentView } from "@/domain/assessments";
import { eligibleAlerts } from "@/domain/alerts";
import { weeklyLoad, type WeekLoad, type WorkloadTotals } from "@/domain/workload";
import { mapTeachingDate } from "@/domain/teaching-weeks";
import type { Snapshot } from "@/domain/types";
import { getAdapter, type MoodleHelperAdapter } from "@/services";
import type { ConnectionInfo } from "@/services/adapter";
import { detectExtension, discoverSduCourses, syncAllThroughExtension } from "@/services/extension-adapter";
import { DISCOVERY_MESSAGES } from "../../../shared/src/bridge";
import { connectionWithExtension } from "@/domain/live-sync";
import { onLocalInvalidation, resumeEraseCleanup } from "@/services/local-erase";

/**
 * #46: what one Sync all click did, for callers that show it in place (the setup sync step).
 * `code` is the bridge error code and `status` the HTTP status, when known. Toasts are unchanged.
 */
export type SyncOutcome = { ok: true; snapshot: Snapshot } | { ok: false; message: string; code?: string; status?: number };

interface AppState {
  adapter: MoodleHelperAdapter;
  snap: Snapshot | null;
  conn: ConnectionInfo | null;
  error: string | null;
  views: AssessmentView[];
  weeks: WeekLoad[];
  unallocated: AssessmentView[];
  unallocatedSummary: WorkloadTotals | null;
  workloadError: string | null;
  currentWeek: number | null;
  syncing: boolean;
  /** #87 S2: extension detection and collection mode are still pending; Sync all is disabled (`Checking…`). */
  detecting: boolean;
  retryLoad: () => void;
  run: (fn: (a: MoodleHelperAdapter) => Promise<Snapshot>) => Promise<boolean>;
  selectionPending: boolean;
  selectionError: string | null;
  saveCourseSelection: (ids: string[]) => Promise<void>;
  retryCourseSelection: () => void;
  syncAll: () => Promise<SyncOutcome>;
  setSnap: (s: Snapshot) => void;
  /** #82 "Find my SDU courses": shown only with the extension in the real dataset. */
  discovery: { available: boolean; pending: boolean; status: string | null; error: string | null };
  discoverCourses: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const adapter = getAdapter();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<ConnectionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [detecting, setDetecting] = useState(true);
  const [selectionPending, setSelectionPending] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionBusy = useRef(false);
  const failedSelection = useRef<string[] | null>(null);
  // Serialize provider mutations, so older full-Snapshot responses cannot replace
  // confirmed selections/source refreshes returned by a newer operation.
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(action: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.current.then(action, action);
    mutationQueue.current = result.catch(() => undefined);
    return result;
  }, []);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => {
    setError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    setDetecting(true);
    // #87 S2: the saved data renders as soon as load() and connection() resolve; extension
    // detection and the collection mode finish afterwards. Until then Sync all is disabled
    // (`detecting`), so a click cannot take the non-extension path (#20/#46 worker wake).
    const detection = detectExtension().catch(() => false);
    Promise.all([adapter.load(), adapter.connection()])
      .then(async ([s, c]) => {
        if (!alive) return;
        setError(null);
        setSnap(s);
        setConn(c);
        const detected = await detection;
        // #46: only the real dataset with the extension asks the backend for its collection mode.
        const mode = detected && c.state !== "demo" && adapter.collectionMode ? await adapter.collectionMode().catch(() => undefined) : undefined;
        if (!alive) return;
        setConn(connectionWithExtension(c, detected, mode));
        setDetecting(false);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load local data"));
    // #56: resume an interrupted browser cleanup for the current erase epoch; never seeds or syncs.
    if (adapter.dataContext) void resumeEraseCleanup(adapter).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [adapter, loadAttempt]);
  // #56: another tab erased (or this one did): drop in-memory copies and reload authoritative state.
  useEffect(() => onLocalInvalidation(() => setLoadAttempt((attempt) => attempt + 1)), []);

  const run = useCallback(
    async (fn: (a: MoodleHelperAdapter) => Promise<Snapshot>) => {
      try {
        await enqueue(async () => setSnap(await fn(adapter)));
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong. Your saved data was not changed.");
        return false;
      }
    },
    [adapter, enqueue],
  );

  const saveCourseSelection = useCallback(async (ids: string[]) => {
    if (selectionBusy.current) return;
    selectionBusy.current = true;
    setSelectionPending(true);
    setSelectionError(null);
    const intended = [...ids];
    failedSelection.current = null;
    try {
      await enqueue(async () => setSnap(await adapter.setTrackedCourses(intended)));
    } catch (e) {
      failedSelection.current = intended;
      setSelectionError(`Course selection was not saved. ${e instanceof Error ? e.message : "Check the local backend and try again."}`);
    } finally {
      selectionBusy.current = false;
      setSelectionPending(false);
    }
  }, [adapter, enqueue]);
  const retryCourseSelection = useCallback(() => {
    if (failedSelection.current !== null) void saveCourseSelection(failedSelection.current);
  }, [saveCourseSelection]);

  // #46: in the real dataset with live collection ready, Sync all goes through the extension,
  // whose bridge wakes the scan worker after the 200 instead of waiting for its next alarm.
  const throughExtension = !!conn?.liveSync && adapter.kind !== "extension";
  const syncAll = useCallback(async (): Promise<SyncOutcome> => {
    // #87 S2: nothing is sent before extension detection finishes.
    if (detecting) return { ok: false, message: "Checking…" };
    setSyncing(true);
    try {
      const s = await enqueue(() => throughExtension ? syncAllThroughExtension(setSnap) : adapter.syncAll(setSnap));
      setSnap(s);
      // #20: a real-dataset Sync all only queues the scan (sync entries say syncing);
      // nothing has finished yet, so no success toast is shown.
      const queued = s.sync.some((c) => c.status === "syncing" && s.settings.trackedCourseIds.includes(c.courseId));
      const failed = s.sync.filter((c) => c.status === "failed").length;
      if (queued) { /* progress is shown by the sync entries themselves */ }
      else if (failed) toast.warning(`${failed} course(s) failed to sync. Earlier data was kept.`);
      else toast.success("Demo sync finished");
      return { ok: true, snapshot: s };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Sync failed. Your saved data was not changed.";
      toast.error(message);
      const code = (e as { code?: unknown } | null)?.code, status = (e as { status?: unknown } | null)?.status;
      return { ok: false, message, ...(typeof code === "string" ? { code } : {}), ...(typeof status === "number" ? { status } : {}) };
    } finally {
      setSyncing(false);
    }
  }, [adapter, enqueue, throughExtension, detecting]);

  const [discovery, setDiscovery] = useState<{ pending: boolean; status: string | null; error: string | null }>({ pending: false, status: null, error: null });
  const discoveryBusy = useRef(false);
  const discoveryAvailable = !!conn && conn.state !== "demo" && (adapter.discoverCourses ? adapter.kind === "extension" : conn.extensionDetected);
  const discoverCourses = useCallback(async () => {
    if (discoveryBusy.current) return;
    discoveryBusy.current = true;
    setDiscovery({ pending: true, status: null, error: null });
    try {
      const outcome = await (adapter.discoverCourses ? adapter.discoverCourses() : discoverSduCourses());
      if ("message" in outcome) { setDiscovery({ pending: false, status: null, error: outcome.message }); return; }
      // Serialized with selection saves; the backend never ticks a discovered course.
      await enqueue(async () => setSnap(outcome.snapshot as Snapshot));
      const status = outcome.found === 0 && outcome.coverage === "complete" ? "SDU Moodle lists no in-progress courses."
        : outcome.coverage === "complete" ? `Found ${outcome.found} in-progress courses on SDU Moodle. Tick the ones to track.`
        : `Found ${outcome.found} in-progress courses on SDU Moodle. The list may be incomplete.`;
      setDiscovery({ pending: false, status, error: null });
    } catch (e) {
      // A failure leaves the shown courses and selection as they were; no toast.
      setDiscovery({ pending: false, status: null, error: e instanceof Error ? e.message : DISCOVERY_MESSAGES.failed });
    } finally {
      discoveryBusy.current = false;
    }
  }, [adapter, enqueue]);

  const derived = useMemo(() => {
    if (!snap) return { views: [], weeks: [], unallocated: [], unallocatedSummary: null, workloadError: null, currentWeek: null };
    const views = viewAll(snap.reconciliation?.logicalAssessments ?? snap.assessments, snap.reconciliation?.logicalOverlays ?? snap.overlays, snap.settings, snap);
    const today = mapTeachingDate({ kind: "exact", iso: new Date().toISOString(), tz: "UTC" }, snap.settings.teachingCalendar);
    const currentWeek = today.resolved ? today.week : null;
    try { return { views, ...weeklyLoad(views, snap.settings, snap), workloadError: null, currentWeek }; }
    catch (failure) { return { views, weeks: [], unallocated: [], unallocatedSummary: null, workloadError: failure instanceof Error ? failure.message : "Workload is unavailable. Check workload settings.", currentWeek }; }
  }, [snap]);

  // Persist newly eligible alerts (delivery keys prevent repeats)
  useEffect(() => {
    // #39: the backend persists alerts atomically with their cause; whole-array
    // client saves would overwrite concurrently appended rows and delivery state.
    if (!snap || derived.workloadError || adapter.storage === "backend") return;
    const changes = snap.changes.map((change) => ({ ...change, assessmentId: resolveAssessmentId(snap, change.assessmentId) }));
    const fresh = eligibleAlerts(derived.views, derived.weeks, changes, snap.settings, Date.now(), snap.alerts);
    if (fresh.length) void run((a) => a.saveAlerts([...fresh, ...snap.alerts]));
  }, [snap, derived, run]);

  return <Ctx.Provider value={{ adapter, snap, conn, error, syncing, detecting, retryLoad, run, syncAll, setSnap, selectionPending, selectionError, saveCourseSelection, retryCourseSelection,
    discovery: { available: discoveryAvailable, ...discovery }, discoverCourses, ...derived }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

export function useCourse(id: string) {
  const { snap } = useApp();
  return snap?.courses.find((c) => c.id === id);
}
