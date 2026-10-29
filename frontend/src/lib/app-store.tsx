import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { resolveAssessmentId, viewAll, type AssessmentView } from "@/domain/assessments";
import { eligibleAlerts } from "@/domain/alerts";
import { weeklyLoad, type WeekLoad, type WorkloadTotals } from "@/domain/workload";
import { mapTeachingDate } from "@/domain/teaching-weeks";
import type { Snapshot } from "@/domain/types";
import { getAdapter, type MoodleHelperAdapter } from "@/services";
import type { ConnectionInfo } from "@/services/adapter";
import { detectExtension } from "@/services/extension-adapter";

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
  retryLoad: () => void;
  run: (fn: (a: MoodleHelperAdapter) => Promise<Snapshot>) => Promise<boolean>;
  selectionPending: boolean;
  selectionError: string | null;
  saveCourseSelection: (ids: string[]) => Promise<void>;
  retryCourseSelection: () => void;
  syncAll: () => Promise<void>;
  setSnap: (s: Snapshot) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const adapter = getAdapter();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<ConnectionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
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
    Promise.all([adapter.load(), adapter.connection(), detectExtension()])
      .then(([s, c, detected]) => {
        if (!alive) return;
        setError(null);
        setSnap(s);
        setConn(detected ? { ...c, extensionDetected: true, message: "Extension detected, but live sync is not implemented yet. Still showing demo data." } : c);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load local data"));
    return () => {
      alive = false;
    };
  }, [adapter, loadAttempt]);

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

  const syncAll = useCallback(async () => {
    setSyncing(true);
    try {
      const s = await enqueue(() => adapter.syncAll(setSnap));
      setSnap(s);
      const failed = s.sync.filter((c) => c.status === "failed").length;
      if (failed) toast.warning(`${failed} course(s) failed to sync. Earlier data was kept.`);
      else toast.success("Demo sync finished");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed. Your saved data was not changed.");
    } finally {
      setSyncing(false);
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
    if (!snap || derived.workloadError) return;
    const changes = snap.changes.map((change) => ({ ...change, assessmentId: resolveAssessmentId(snap, change.assessmentId) }));
    const fresh = eligibleAlerts(derived.views, derived.weeks, changes, snap.settings, Date.now(), snap.alerts);
    if (fresh.length) void run((a) => a.saveAlerts([...fresh, ...snap.alerts]));
  }, [snap, derived, run]);

  return <Ctx.Provider value={{ adapter, snap, conn, error, syncing, retryLoad, run, syncAll, setSnap, selectionPending, selectionError, saveCourseSelection, retryCourseSelection, ...derived }}>{children}</Ctx.Provider>;
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
