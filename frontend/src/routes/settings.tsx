import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CourseTag, Details, PageHeader } from "@/components/mh/bits";
import { MockProgress } from "@/components/mh/MockProgress";
import {
  dispatchDownload,
  prepareBackup,
  previewRestore,
  readBackupFile,
  type PreparedBackup,
  type RestorePreview,
} from "@/domain/backup";
import { currentDataset } from "@/services/local-documents";
import {
  EraseOutcomeUnknown,
  RestoreOutcomeUnknown,
  type AiAvailability,
  type DataContext,
  type EraseCleanup,
  type RestoreContext,
} from "@/services/adapter";
import { beginErase, finishDashboardCleanup } from "@/services/local-erase";
import { useApp } from "@/lib/app-store";
import { datasetLine, extensionLine, syncButtonLabel } from "@/domain/live-sync";
import { friendlyInstant } from "@/domain/dates";
import { MOODLE_LOGIN_URL } from "@/domain/onboarding";
import { syncFreshness } from "../../../shared/src/full-sync";
import { BridgeClient } from "@/services/extension-adapter";
import { BridgeError, DISCOVERY_MESSAGES } from "../../../shared/src/bridge";
import { TeachingCalendarSettings } from "@/components/mh/TeachingCalendarSettings";
import { WorkloadWeights } from "@/components/mh/WorkloadWeights";
import { ReminderDetails, ReminderSettingsPanel } from "@/components/mh/ReminderSettings";
import { ThemeSettings } from "@/components/mh/Theme";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Moodle Helper" },
      {
        name: "description",
        content:
          "Tracked courses, semester weeks, workload weights, reminders, sync status, backup and local data controls.",
      },
      { property: "og:title", content: "Settings — Moodle Helper" },
      {
        property: "og:description",
        content: "Control what Moodle Helper tracks and stores on this device.",
      },
    ],
  }),
  component: SettingsPage,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** #87 T1: the bridge guidance (Chrome version, origins, ports) kept verbatim for Details. */
export function BridgeGuidance() {
  return (
    <p>
      Use Chrome 109 or newer on localhost:5173 or 127.0.0.1:5173. Enable the extension and allow
      local site access. Start the backend on 127.0.0.1:8000. After a timeout, reload or backend
      restart, a write may have completed: reconnect and refresh saved data before manually
      retrying. Live Moodle identity and collection setup are separate and unavailable here.
    </p>
  );
}

/**
 * The extension status in one line plus Check / reconnect (#46, #49 AC3). Standalone it carries its own
 * Details with the bridge guidance; Settings passes `guidance={false}` and shows it in its one Details.
 */
export function BridgeConnection({
  liveSync = false,
  status = "Extension status not checked yet.",
  guidance = true,
}: { liveSync?: boolean; status?: string; guidance?: boolean } = {}) {
  const [checked, setChecked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const client = new BridgeClient();
    try {
      await client.connect();
      setChecked(
        liveSync
          ? "Extension connected. Moodle collection is ready: Sync all reads your selected courses."
          : "Extension connected. Moodle collection is unavailable, so saved data is shown.",
      );
    } catch (e) {
      setChecked(e instanceof BridgeError ? e.message : "Reload the dashboard and reconnect.");
    } finally {
      client.dispose();
      setBusy(false);
    }
  };
  return (
    <div className="my-2 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm">
          {checked ?? status}
        </p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void check()}>
          {busy ? "Checking extension…" : "Check / reconnect extension"}
        </Button>
      </div>
      {guidance && (
        <Details>
          <BridgeGuidance />
        </Details>
      )}
    </div>
  );
}

/** Confirmed saved values only; pending/error/retry live in the provider across navigation. */
export function TrackedCourses() {
  const {
    snap,
    selectionPending,
    selectionError,
    saveCourseSelection,
    retryCourseSelection,
    discovery,
    discoverCourses,
  } = useApp();
  if (!snap) return null;
  const selected = snap.settings.trackedCourseIds;
  return (
    <Section title="Tracked courses">
      {discovery.available && (
        <div className="mb-3 space-y-2">
          <Button
            variant="outline"
            disabled={discovery.pending}
            onClick={() => void discoverCourses()}
          >
            {discovery.pending ? "Finding courses…" : "Find my SDU courses"}
          </Button>
          {discovery.status && (
            <p role="status" className="text-sm">
              {discovery.status}
            </p>
          )}
          {discovery.error && (
            <p role="alert" className="text-sm text-destructive">
              {discovery.error}
            </p>
          )}
        </div>
      )}
      {!snap.courses.length && (
        <p className="text-sm text-muted-foreground">No discovered courses are available yet.</p>
      )}
      {selected.length === 0 && (
        <p className="mb-3 text-sm text-muted-foreground">
          No courses selected. No courses will be synced.
        </p>
      )}
      <ul className="space-y-3" aria-busy={selectionPending}>
        {snap.courses.map((course) => {
          const discovery = course.discovery;
          const title = discovery
            ? discovery.title.kind === "known"
              ? discovery.title.value
              : "Title unavailable"
            : course.name;
          const status = discovery
            ? discovery.currentTermStatus === "unknown"
              ? "Current term uncertain"
              : discovery.currentTermStatus === "past"
                ? "Past course"
                : "Current course"
            : course.current
              ? "Legacy suggestion: current (unverified)"
              : "Current term uncertain";
          return (
            <li key={course.id} className="flex items-start justify-between gap-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Track ${title}`}
                  disabled={selectionPending}
                  checked={selected.includes(course.id)}
                  onChange={(event) =>
                    void saveCourseSelection(
                      event.target.checked
                        ? [...selected, course.id]
                        : selected.filter((id) => id !== course.id),
                    )
                  }
                />
                <span className="space-y-1">
                  <CourseTag course={course} />
                  <span className="block font-medium">{title}</span>
                  {discovery?.termIndicators.kind === "known" ? (
                    discovery.termIndicators.value.map((term, index) => (
                      <span key={index} className="block text-xs text-muted-foreground">
                        {term}
                      </span>
                    ))
                  ) : (
                    <span className="block text-xs text-muted-foreground">
                      Term indicators unavailable
                    </span>
                  )}
                </span>
              </label>
              <span className="text-xs text-muted-foreground">{status}</span>
            </li>
          );
        })}
      </ul>
      {selectionPending && (
        <p role="status" className="mt-3 text-sm">
          Saving course selection…
        </p>
      )}
      {selectionError && (
        <div role="alert" className="mt-3 text-sm text-destructive">
          <p>
            {selectionError} Previous saved selection is shown. Retry to save your intended
            selection.
          </p>
          <Button
            variant="outline"
            className="mt-2"
            disabled={selectionPending}
            onClick={retryCourseSelection}
          >
            Retry course selection
          </Button>
        </div>
      )}
    </Section>
  );
}

const ERASE_SCOPE = [
  "Courses, deadlines, materials, imported documents, extraction proposals and review decisions",
  "Your overrides, completion marks, personal events, alerts and notification history",
  "All settings (tracked courses, calendar, reminders, workload, AI consent) reset to first-run defaults",
  "Queued scans, imports, extractions, downloads and scheduled reminders",
  "Original PDF/DOCX files, extracted text, OCR results, evidence and review audit stored in this browser",
];
const componentLabel: Record<string, string> = {
  pending: "pending",
  complete: "cleared",
  failed: "failed",
};

/** #56 confirmed full erasure. Cancel changes nothing; partial cleanup is reported truthfully. */
export function EraseLocalData() {
  const { adapter, run, setSnap } = useApp();
  const [state, setState] = useState<{
    open: boolean;
    phase: "confirm" | "erasing" | "unknown" | "partial" | "done" | "failed";
    context?: DataContext | undefined;
    key: string;
    eraseId?: string | undefined;
    cleanup?: EraseCleanup | undefined;
    message?: string | undefined;
  }>({ open: false, phase: "confirm", key: "" });
  const full = !!adapter.eraseLocalData && !!adapter.dataContext;
  const origin = typeof location === "undefined" ? "this browser" : location.origin;
  const open = async () => {
    setState({ open: true, phase: "confirm", key: `erase-${crypto.randomUUID()}` });
    if (!full) return;
    try {
      const context = await adapter.dataContext!();
      setState((s) => ({ ...s, context }));
    } catch (e) {
      setState((s) => ({
        ...s,
        phase: "failed",
        message: `${e instanceof Error ? e.message : "Could not read the local data context."} Nothing was deleted.`,
      }));
    }
  };
  const settle = (eraseId: string, cleanup: EraseCleanup, error?: string) => {
    const clean = cleanup.dashboard === "complete" && cleanup.extension === "complete";
    setState((s) => ({
      ...s,
      eraseId,
      cleanup,
      phase: clean ? "done" : "partial",
      message: clean ? "All local data was deleted." : error,
    }));
    if (clean) toast.success("Local data deleted");
  };
  const confirm = async () => {
    if (!full) {
      setState((s) => ({ ...s, open: false }));
      void run((a) => a.deleteLocalData());
      return;
    }
    const context = state.context;
    if (!context || state.phase === "erasing") return;
    beginErase(); // stop local work in this and cooperative tabs; nothing is cleared yet
    setState((s) => ({ ...s, phase: "erasing", message: undefined }));
    const request = {
      idempotencyKey: state.key,
      expectedDatasetId: context.datasetId,
      expectedEpoch: context.epoch,
      expectedRevision: context.revision,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await adapter.eraseLocalData!(request);
        setSnap(result.snapshot); // hide every pre-delete row immediately
        const outcome = await finishDashboardCleanup(adapter, result);
        settle(result.eraseId, outcome.cleanup, outcome.error);
        return;
      } catch (e) {
        if (e instanceof EraseOutcomeUnknown) {
          setState((s) => ({
            ...s,
            phase: "unknown",
            message: "Deletion outcome unknown; checking the receipt.",
          }));
          continue;
        }
        setState((s) => ({
          ...s,
          phase: "failed",
          message: `${e instanceof Error ? e.message : "Deletion failed."} Your data was not deleted.`,
        }));
        return;
      }
    }
    setState((s) => ({
      ...s,
      phase: "unknown",
      message:
        "Deletion outcome unknown. Reconnect and choose Check again; the same request never deletes twice.",
    }));
  };
  const retry = async () => {
    if (!state.eraseId || !state.context || !state.cleanup) return;
    if (state.cleanup.dashboard !== "complete") {
      const outcome = await finishDashboardCleanup(adapter, {
        eraseId: state.eraseId,
        datasetId: state.context.datasetId,
        epoch: state.context.epoch + 1,
      });
      settle(state.eraseId, outcome.cleanup, outcome.error);
      return;
    }
    try {
      const status = await adapter.eraseStatus!(state.eraseId);
      settle(state.eraseId, status.cleanup);
    } catch (e) {
      setState((s) => ({
        ...s,
        message: e instanceof Error ? e.message : "Could not check cleanup status.",
      }));
    }
  };
  const busy = state.phase === "erasing";
  return (
    <>
      <Button variant="destructive" onClick={() => void open()}>
        Delete local data
      </Button>
      <AlertDialog
        open={state.open}
        onOpenChange={(o) => !o && !busy && setState({ open: false, phase: "confirm", key: "" })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {state.phase === "done"
                ? "Local data deleted"
                : state.phase === "partial"
                  ? "Deletion partly complete"
                  : "Delete all local data?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {(state.phase === "confirm" || state.phase === "failed") && (
                  <>
                    <p>
                      {full
                        ? `This permanently deletes, for the current dataset in ${origin}:`
                        : "This clears records and tracked courses stored by this demo. Other settings are retained."}
                    </p>
                    {full && (
                      <ul className="list-disc pl-5">
                        {ERASE_SCOPE.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                    <p>
                      Moodle, files you downloaded to disk and backup files you exported are not
                      touched. Browser data for this tool in another site address (for example
                      localhost vs 127.0.0.1) or another browser profile is separate and must be
                      deleted there.
                    </p>
                  </>
                )}
                {state.cleanup && (
                  <ul aria-label="Cleanup status">
                    <li>Local backend: deleted</li>
                    <li>
                      This browser's documents and evidence:{" "}
                      {componentLabel[state.cleanup.dashboard]}
                    </li>
                    <li>
                      Extension reminders and transfers: {componentLabel[state.cleanup.extension]}
                      {state.cleanup.extension === "pending"
                        ? " (clears when the extension next connects; ignore if it is not installed)"
                        : ""}
                    </li>
                  </ul>
                )}
                {state.message && (
                  <p role={state.phase === "failed" ? "alert" : "status"}>{state.message}</p>
                )}
                {busy && <p role="status">Deleting…</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {(state.phase === "confirm" ||
              state.phase === "failed" ||
              state.phase === "unknown") && (
              <>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <Button
                  variant="destructive"
                  disabled={busy || (full && !state.context)}
                  onClick={() => void confirm()}
                >
                  {state.phase === "unknown" ? "Check again" : "Delete"}
                </Button>
              </>
            )}
            {state.phase === "partial" && (
              <Button variant="outline" onClick={() => void retry()}>
                Retry cleanup
              </Button>
            )}
            {(state.phase === "partial" || state.phase === "done") && (
              <AlertDialogCancel>Close</AlertDialogCancel>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SettingsPage() {
  const { snap, run, adapter, conn, syncAll, syncing, detecting, setSnap } = useApp();
  const s = snap!;
  const st = s.settings;
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [restore, setRestore] = useState<{
    context?: RestoreContext | undefined;
    key: string;
    phase: "preview" | "restoring" | "unknown" | "done" | "failed";
    message?: string | undefined;
  }>({ key: "", phase: "preview" });
  const openRestore = async (file: File) => {
    const read = await readBackupFile(file);
    if (!read.ok) {
      setPreview({ ok: false, error: read.error });
      return;
    }
    let context: RestoreContext | undefined;
    try {
      context = await adapter.restoreContext?.();
    } catch {
      context = undefined;
    }
    const next = previewRestore(read.text, s, context?.datasetId);
    const restorable = next.ok && next.restorable && !!adapter.restoreBackup;
    const prepared =
      next.ok && next.restorable && !adapter.restoreBackup
        ? {
            ...next,
            restorable: false,
            reason: "Restore requires the local backend connection. Nothing was changed.",
          }
        : next;
    setRestore({ context, key: `restore-${crypto.randomUUID()}`, phase: "preview" });
    setPreview(restorable ? Object.freeze(prepared) : prepared);
  };
  const confirmRestore = async () => {
    if (
      !preview?.ok ||
      !preview.restorable ||
      !restore.context ||
      !adapter.restoreBackup ||
      restore.phase === "restoring"
    )
      return;
    const request = {
      idempotencyKey: restore.key,
      expectedDatasetId: restore.context.datasetId,
      expectedEpoch: restore.context.epoch,
      expectedRevision: restore.context.revision,
      backup: preview.raw,
    };
    setRestore((r) => ({ ...r, phase: "restoring", message: undefined }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await adapter.restoreBackup(request);
        setSnap(result.snapshot);
        let message =
          "Backup restored. Reminders were rebuilt from the restored data; browser alarms update when the extension next reconciles.";
        try {
          await adapter.reminderPlan?.();
        } catch {
          message =
            "Backup restored. Reminders were rebuilt; browser alarm cleanup is pending until the extension reconnects.";
        }
        setRestore((r) => ({ ...r, phase: "done", message }));
        toast.success("Backup restored");
        return;
      } catch (e) {
        if (e instanceof RestoreOutcomeUnknown) {
          setRestore((r) => ({
            ...r,
            phase: "unknown",
            message: "Restore outcome unknown; checking receipt.",
          }));
          continue;
        }
        setRestore((r) => ({
          ...r,
          phase: "failed",
          message: `${e instanceof Error ? e.message : "Restore failed."} Your original data was not replaced.`,
        }));
        return;
      }
    }
    setRestore((r) => ({
      ...r,
      phase: "unknown",
      message:
        "Restore outcome unknown. Reconnect and choose Check again; the same request will not replace data twice.",
    }));
  };
  const [ai, setAi] = useState<AiAvailability | null>(null);
  useEffect(() => {
    let alive = true;
    void adapter
      .aiAvailability()
      .then((value) => alive && setAi(value))
      .catch((e: unknown) => {
        if (!alive) return;
        const reason = e instanceof Error ? e.message : "Could not check AI availability.";
        setAi({ available: false, reason });
        toast.error(reason);
      });
    return () => {
      alive = false;
    };
  }, [adapter]);
  const upd = (p: Partial<typeof st>) => run((a) => a.updateSettings(p));
  // #87 T1: one summary line by default; per-course states, enums and conn.message go under Details.
  const realData = !!conn && conn.state !== "demo";
  const freshness = syncFreshness(s, realData);
  const tracked = st.trackedCourseIds;
  const trackedSync = tracked.map((id) => s.sync.find((c) => c.courseId === id));
  const fullyScanned = trackedSync.filter(
    (c) => c?.status === "ok" && c.coverage === "full",
  ).length;
  const failed = s.sync.filter((c) => c.status === "failed");
  const signedOut = s.sync.filter((c) => c.error === DISCOVERY_MESSAGES.signedOut);
  const courseCode = (id: string) => s.courses.find((x) => x.id === id)?.code ?? "Course";
  const num = (v: string) => Math.max(0, Number(v) || 0);

  const [exp, setExp] = useState<{
    phase: "idle" | "preparing" | "ready" | "requested" | "error";
    prepared?: PreparedBackup;
    error?: string;
  }>({ phase: "idle" });
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const prepareExport = async () => {
    if (exp.phase === "preparing") return;
    setExp({ phase: "preparing" });
    try {
      const prepared = await prepareBackup(
        () => adapter.load(),
        () => currentDataset(),
      );
      setExp({ phase: "ready", prepared });
    } catch (e) {
      setExp({
        phase: "error",
        error: e instanceof Error ? e.message : "Could not prepare the backup.",
      });
    }
  };
  const downloadExport = () => {
    const prepared = exp.prepared;
    if (!prepared) return;
    try {
      cleanup.current?.();
      cleanup.current = dispatchDownload(prepared);
      setExp({ phase: "requested", prepared });
    } catch {
      setExp({
        phase: "error",
        prepared,
        error: "Could not start the download. Nothing was saved; retry.",
      });
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 lg:grid-cols-2">
        <ThemeSettings />
        <TrackedCourses />

        <Section title="Connection & sync">
          <p className="text-sm font-medium">{datasetLine(conn)}</p>
          <BridgeConnection
            liveSync={!!conn?.liveSync}
            status={extensionLine(conn)}
            guidance={false}
          />
          <p className="text-sm">
            {trackedSync.some((c) => c?.status === "syncing")
              ? "Sync running…"
              : `${fullyScanned} of ${tracked.length} ${tracked.length === 1 ? "course" : "courses"} fully scanned`}
          </p>
          {failed.length > 0 && (
            <p className="text-sm text-destructive">
              {failed.length} {failed.length === 1 ? "course" : "courses"} failed to sync. Details
              below.
            </p>
          )}
          {/* #20 AC4: the sign-in request stays visible because it is actionable. */}
          {signedOut.map((c) => (
            <p key={c.courseId} className="text-sm text-destructive">
              {courseCode(c.courseId)}: {c.error}{" "}
              <a
                className="underline"
                href={MOODLE_LOGIN_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open SDU Moodle sign-in
              </a>
            </p>
          ))}
          <Button className="mt-3" onClick={syncAll} disabled={syncing || detecting}>
            {syncButtonLabel(conn, syncing, detecting)}
          </Button>
          <Details>
            <BridgeGuidance />
            <p>
              <strong>State:</strong>{" "}
              {conn?.state === "demo" ? "Demo mode (no extension)" : conn?.state}
            </p>
            <p>{conn?.message}</p>
            {/* #21 AC2: the shared freshness lines, verbatim. */}
            <p>{freshness.fullSync}</p>
            <p>{freshness.pageRefresh}</p>
            {freshness.courses.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <ul aria-label="Sync status per course" className="space-y-0.5">
              {s.sync.map((c) => (
                <li key={c.courseId} className="flex justify-between gap-2">
                  <span>{courseCode(c.courseId)}</span>
                  <span className={c.status === "failed" ? "text-destructive" : undefined}>
                    {c.status === "syncing"
                      ? `Syncing ${c.progress}%`
                      : `${c.status} · ${c.coverage} coverage`}
                    {c.lastSuccessAt && ` · ok ${friendlyInstant(c.lastSuccessAt, st.timezone)}`}
                  </span>
                </li>
              ))}
            </ul>
            {s.sync
              .filter((c) => c.error)
              .map((c) => (
                <p key={c.courseId} className="text-destructive">
                  {courseCode(c.courseId)}: {c.error}
                </p>
              ))}
            {realData && (
              <div>
                <h3 className="font-semibold">Demo: mock scan progress</h3>
                <MockProgress snapshot={s} realData />
              </div>
            )}
          </Details>
        </Section>

        <TeachingCalendarSettings />
        <Section title="Notifications and reminders">
          <p className="mb-3 text-sm text-muted-foreground">
            Notifications show while Chrome is open.
          </p>
          <ReminderSettingsPanel />
          <ReminderDetails />
        </Section>

        <Section title="Workload">
          <p className="mb-2 text-sm text-muted-foreground">Estimates, not study hours.</p>
          <WorkloadWeights />
        </Section>

        <Section title="AI explanations (optional)">
          <p className="text-sm text-muted-foreground">
            Off by default. You'll see exactly what is sent before anything leaves your device.
          </p>
          <p className="mt-2 text-sm">
            {ai === null
              ? "Checking…"
              : ai.available
                ? `Available: ${ai.provider}`
                : "Not available on this device."}
          </p>
          {ai?.available === false && (
            <Details>
              <p>{ai.reason}</p>
            </Details>
          )}
          <label className="mt-3 flex items-center justify-between text-sm">
            Allow asking before sending excerpts{" "}
            <Switch
              disabled={!ai?.available}
              checked={st.ai.enabled}
              onCheckedChange={(v) => upd({ ai: { ...st.ai, enabled: v } })}
            />
          </label>
        </Section>

        <Section title="Backup & local data">
          <p className="mb-3 text-sm text-muted-foreground">
            Backups include your records and settings, not documents or downloaded files.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={exp.phase === "preparing"}
              onClick={() => void prepareExport()}
            >
              {exp.phase === "preparing" ? "Preparing…" : "Export backup"}
            </Button>
            <label className="inline-flex cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-muted">
              Restore…
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void openRestore(f);
                }}
              />
            </label>
            {adapter.resetDemo && (
              <Button
                variant="outline"
                onClick={() =>
                  run((a) => a.resetDemo!()).then((ok) => ok && toast.success("Demo data reset"))
                }
              >
                Reset demo
              </Button>
            )}
            <EraseLocalData />
          </div>
        </Section>

        {/* #87 T3: the whole legacy section sits under one closed disclosure. */}
        <section className="rounded-lg border bg-card p-5 lg:col-span-2">
          <Details summary="Legacy settings" className="mt-0 text-sm">
            <p className="mb-2 text-xs">
              Old compatibility fields. They do not set the teaching calendar.
            </p>
            <div className="grid grid-cols-2 gap-3 text-foreground">
              <div className="space-y-1">
                <Label htmlFor="ss">Week 1 starts</Label>
                <Input
                  id="ss"
                  type="date"
                  value={st.semesterStart}
                  onChange={(e) => e.target.value && upd({ semesterStart: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sw">Weeks</Label>
                <Input
                  id="sw"
                  type="number"
                  min={1}
                  max={30}
                  value={st.semesterWeeks}
                  onChange={(e) =>
                    upd({ semesterWeeks: Math.min(30, Math.max(1, num(e.target.value))) })
                  }
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor="tz">Display timezone</Label>
                <select
                  id="tz"
                  className="h-9 w-full rounded-md border bg-card px-2 text-sm"
                  value={st.timezone}
                  onChange={(e) => upd({ timezone: e.target.value })}
                >
                  {["Asia/Almaty", "Asia/Qyzylorda", "Asia/Aqtobe", "UTC", "Europe/Moscow"].map(
                    (z) => (
                      <option key={z}>{z}</option>
                    ),
                  )}
                </select>
              </div>
            </div>
          </Details>
        </section>
      </div>

      <AlertDialog
        open={exp.phase !== "idle" && exp.phase !== "preparing"}
        onOpenChange={(o) => !o && setExp({ phase: "idle" })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {exp.phase === "error" ? "Backup not exported" : "Export this backup?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {exp.phase === "error" && <p role="alert">{exp.error}</p>}
                {exp.prepared && exp.phase !== "error" && (
                  <>
                    <p>
                      Prepared {new Date(exp.prepared.backup.exportedAt).toLocaleString("en-GB")} ·
                      format version {exp.prepared.backup.version} ·{" "}
                      {exp.prepared.bytes.toLocaleString("en-GB")} bytes. Later changes are not
                      included unless you prepare again.
                    </p>
                    <table className="mt-3 w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">Item</th>
                          <th>Records</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exp.prepared.backup.summary!.counts.map((c) => (
                          <tr key={c.label}>
                            <td>{c.label}</td>
                            <td className="text-center">{c.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-3 text-xs">
                      Not included: {exp.prepared.backup.summary!.exclusions.join("; ")}. Redacted
                      fields: {exp.prepared.backup.summary!.redactions}.
                    </p>
                    {exp.phase === "requested" && (
                      <p className="mt-3" role="status">
                        Download requested; check your browser downloads.
                      </p>
                    )}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <Button variant="outline" onClick={() => void prepareExport()}>
              {exp.phase === "error" ? "Retry" : "Prepare again"}
            </Button>
            {exp.prepared && exp.phase !== "error" && (
              <Button onClick={downloadExport}>Download</Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!preview}
        onOpenChange={(o) => {
          if (!o && restore.phase !== "restoring") setPreview(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {restore.phase === "done"
                ? "Backup restored"
                : preview?.ok
                  ? "Restore this backup?"
                  : "Can't restore"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {preview?.ok ? (
                  <>
                    <p>
                      Exported {new Date(preview.backup.exportedAt).toLocaleString("en-GB")} ·
                      format version {preview.backup.version} ·{" "}
                      {preview.bytes.toLocaleString("en-GB")} bytes · identity{" "}
                      {preview.identity === "match" ? "matches this dataset" : "unavailable"}.
                    </p>
                    <p className="mt-2">
                      Everything currently stored will be replaced, including settings and personal
                      changes.
                    </p>
                    <table className="mt-3 w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">Item</th>
                          <th>Now</th>
                          <th>Backup</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.diff.map((d) => (
                          <tr key={d.label}>
                            <td>{d.label}</td>
                            <td className="text-center">{d.current}</td>
                            <td className="text-center">{d.incoming}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-3 text-xs">
                      Not included: {preview.exclusions.join("; ")}. Document files and downloaded
                      files are not restored; check source and evidence availability afterwards.
                    </p>
                    <p className="mt-2 text-xs">
                      Links in the backup are metadata only; source access is unverified and must be
                      rechecked. Pending reminders are rebuilt once from the restored data, and
                      restored notifications are not shown again.
                    </p>
                    {preview.reason && (
                      <p role="alert" className="mt-2">
                        {preview.reason}
                      </p>
                    )}
                    {restore.message && (
                      <p role={restore.phase === "failed" ? "alert" : "status"} className="mt-2">
                        {restore.message}
                      </p>
                    )}
                  </>
                ) : (
                  <p role="alert">{preview?.error}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.phase === "restoring"}>
              {restore.phase === "done" ? "Close" : "Cancel"}
            </AlertDialogCancel>
            {preview?.ok && preview.restorable && restore.phase !== "done" && (
              <Button
                disabled={restore.phase === "restoring"}
                onClick={() => void confirmRestore()}
              >
                {restore.phase === "restoring"
                  ? "Restoring…"
                  : restore.phase === "unknown"
                    ? "Check again"
                    : "Restore"}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
