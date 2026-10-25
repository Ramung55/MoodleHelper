import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { viewAll, type AssessmentView } from "@/domain/assessments";
import { eligibleAlerts } from "@/domain/alerts";
import { weeklyLoad, type WeekLoad } from "@/domain/workload";
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
  currentWeek: number | null;
  syncing: boolean;
  run: (fn: (a: MoodleHelperAdapter) => Promise<Snapshot>) => Promise<boolean>;
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

  useEffect(() => {
    let alive = true;
    Promise.all([adapter.load(), adapter.connection(), detectExtension()])
      .then(([s, c, detected]) => {
        if (!alive) return;
        setSnap(s);
        setConn(detected ? { ...c, extensionDetected: true, message: "Extension detected, but live sync is not implemented yet. Still showing demo data." } : c);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load local data"));
    return () => {
      alive = false;
    };
  }, [adapter]);

  const run = useCallback(
    async (fn: (a: MoodleHelperAdapter) => Promise<Snapshot>) => {
      try {
        setSnap(await fn(adapter));
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong. Your saved data was not changed.");
        return false;
      }
    },
    [adapter],
  );

  const syncAll = useCallback(async () => {
    setSyncing(true);
    try {
      const s = await adapter.syncAll(setSnap);
      setSnap(s);
      const failed = s.sync.filter((c) => c.status === "failed").length;
      if (failed) toast.warning(`${failed} course(s) failed to sync. Earlier data was kept.`);
      else toast.success("Demo sync finished");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed. Your saved data was not changed.");
    } finally {
      setSyncing(false);
    }
  }, [adapter]);

  const derived = useMemo(() => {
    if (!snap) return { views: [], weeks: [], unallocated: [], currentWeek: null };
    const views = viewAll(snap.assessments, snap.overlays, snap.settings);
    const { weeks, unallocated } = weeklyLoad(views, snap.settings);
    const start = Date.parse(snap.settings.semesterStart);
    const currentWeek = Math.floor((Date.now() - start) / (7 * 86_400_000)) + 1;
    return { views, weeks, unallocated, currentWeek };
  }, [snap]);

  // Persist newly eligible alerts (delivery keys prevent repeats)
  useEffect(() => {
    if (!snap) return;
    const fresh = eligibleAlerts(derived.views, derived.weeks, snap.changes, snap.settings, Date.now(), snap.alerts);
    if (fresh.length) void run((a) => a.saveAlerts([...fresh, ...snap.alerts]));
  }, [snap, derived, run]);

  return <Ctx.Provider value={{ adapter, snap, conn, error, syncing, run, syncAll, setSnap, ...derived }}>{children}</Ctx.Provider>;
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
