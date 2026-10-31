import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CourseTag, PageHeader } from "@/components/mh/bits";
import { dispatchDownload, prepareBackup, previewRestore, type PreparedBackup, type RestorePreview } from "@/domain/backup";
import { currentDataset } from "@/services/local-documents";
import type { AiAvailability } from "@/services/adapter";
import { useApp } from "@/lib/app-store";
import { BridgeClient } from "@/services/extension-adapter";
import { BridgeError } from "../../../shared/src/bridge";
import { TeachingCalendarSettings } from "@/components/mh/TeachingCalendarSettings";
import { WorkloadWeights } from "@/components/mh/WorkloadWeights";
import { ReminderSettingsPanel } from "@/components/mh/ReminderSettings";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Moodle Helper" },
      { name: "description", content: "Tracked courses, semester weeks, workload weights, reminders, sync status, backup and local data controls." },
      { property: "og:title", content: "Settings — Moodle Helper" },
      { property: "og:description", content: "Control what Moodle Helper tracks and stores on this device." },
    ],
  }),
  component: SettingsPage,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-lg border bg-card p-5"><h2 className="mb-3 text-lg font-semibold">{title}</h2>{children}</section>;
}

export function BridgeConnection() {
  const [guidance, setGuidance] = useState("Check the optional extension connection. The local HTTP app remains available.");
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const client = new BridgeClient();
    try {
      await client.connect();
      setGuidance("Local repository bridge ready. Moodle collection is unavailable. The dashboard continues using the local HTTP backend.");
    } catch (e) {
      setGuidance(e instanceof BridgeError ? e.message : "Reload the dashboard and reconnect.");
    } finally {client.dispose();setBusy(false);}
  };
  return <div className="my-3 space-y-2">
    <p role="status" className="text-sm">{guidance}</p>
    <p className="text-xs text-muted-foreground">Use Chrome 106 or newer on localhost:5173 or 127.0.0.1:5173. Enable the extension and allow local site access. Start the backend on 127.0.0.1:8000. After a timeout, reload or backend restart, a write may have completed: reconnect and refresh saved data before manually retrying. Live Moodle identity and collection setup are separate and unavailable here.</p>
    <Button variant="outline" disabled={busy} onClick={() => void check()}>{busy ? "Checking extension…" : "Check / reconnect extension"}</Button>
  </div>;
}

/** Confirmed saved values only; pending/error/retry live in the provider across navigation. */
export function TrackedCourses() {
  const { snap, selectionPending, selectionError, saveCourseSelection, retryCourseSelection } = useApp();
  if (!snap) return null;
  const selected = snap.settings.trackedCourseIds;
  return <Section title="Tracked courses">
    {!snap.courses.length && <p className="text-sm text-muted-foreground">No discovered courses are available yet.</p>}
    {selected.length === 0 && <p className="mb-3 text-sm text-muted-foreground">No courses selected. No courses will be synced.</p>}
    <ul className="space-y-3" aria-busy={selectionPending}>
      {snap.courses.map((course) => {
        const discovery = course.discovery;
        const title = discovery ? discovery.title.kind === "known" ? discovery.title.value : "Title unavailable" : course.name;
        const status = discovery
          ? discovery.currentTermStatus === "unknown" ? "Current term uncertain" : discovery.currentTermStatus === "past" ? "Past course" : "Current course"
          : course.current ? "Legacy suggestion: current (unverified)" : "Current term uncertain";
        return <li key={course.id} className="flex items-start justify-between gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" aria-label={`Track ${title}`} disabled={selectionPending}
              checked={selected.includes(course.id)} onChange={(event) => void saveCourseSelection(event.target.checked
                ? [...selected, course.id] : selected.filter((id) => id !== course.id))} />
            <span className="space-y-1"><CourseTag course={course} /><span className="block font-medium">{title}</span>
              {discovery?.termIndicators.kind === "known"
                ? discovery.termIndicators.value.map((term, index) => <span key={index} className="block text-xs text-muted-foreground">{term}</span>)
                : <span className="block text-xs text-muted-foreground">Term indicators unavailable</span>}
            </span>
          </label>
          <span className="text-xs text-muted-foreground">{status}</span>
        </li>;
      })}
    </ul>
    {selectionPending && <p role="status" className="mt-3 text-sm">Saving course selection…</p>}
    {selectionError && <div role="alert" className="mt-3 text-sm text-destructive">
      <p>{selectionError} Previous saved selection is shown. Retry to save your intended selection.</p>
      <Button variant="outline" className="mt-2" disabled={selectionPending} onClick={retryCourseSelection}>Retry course selection</Button>
    </div>}
  </Section>;
}

function SettingsPage() {
  const { snap, run, adapter, conn, syncAll, syncing } = useApp();
  const s = snap!;
  const st = s.settings;
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [ai, setAi] = useState<AiAvailability | null>(null);
  useEffect(() => {
    let alive = true;
    void adapter.aiAvailability().then((value) => alive && setAi(value)).catch((e: unknown) => {
      if (!alive) return;
      const reason = e instanceof Error ? e.message : "Could not check AI availability.";
      setAi({ available: false, reason });
      toast.error(reason);
    });
    return () => { alive = false; };
  }, [adapter]);
  const upd = (p: Partial<typeof st>) => run((a) => a.updateSettings(p));
  const num = (v: string) => Math.max(0, Number(v) || 0);

  const [exp, setExp] = useState<{ phase: "idle" | "preparing" | "ready" | "requested" | "error"; prepared?: PreparedBackup; error?: string }>({ phase: "idle" });
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const prepareExport = async () => {
    if (exp.phase === "preparing") return;
    setExp({ phase: "preparing" });
    try {
      const prepared = await prepareBackup(() => adapter.load(), () => currentDataset());
      setExp({ phase: "ready", prepared });
    } catch (e) {
      setExp({ phase: "error", error: e instanceof Error ? e.message : "Could not prepare the backup." });
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
      setExp({ phase: "error", prepared, error: "Could not start the download. Nothing was saved; retry." });
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 lg:grid-cols-2">
        <TrackedCourses />

        <Section title="Connection & sync">
          <BridgeConnection />
          <p className="text-sm"><strong>State:</strong> {conn?.state === "demo" ? "Demo mode (no extension)" : conn?.state}</p>
          <p className="mb-3 text-sm text-muted-foreground">{conn?.message}</p>
          <ul className="mb-3 space-y-1 text-sm">
            {s.sync.map((c) => (
              <li key={c.courseId} className="flex justify-between gap-2">
                <span>{s.courses.find((x) => x.id === c.courseId)?.code}</span>
                <span className={c.status === "failed" ? "text-destructive" : c.status === "partial" ? "text-warning-foreground" : "text-muted-foreground"}>
                  {c.status === "syncing" ? `Syncing ${c.progress}%` : `${c.status} · ${c.coverage} coverage`}{c.lastSuccessAt && ` · ok ${new Date(c.lastSuccessAt).toLocaleString("en-GB", { timeZone: st.timezone })}`}
                </span>
              </li>
            ))}
          </ul>
          {s.sync.filter((c) => c.error).map((c) => <p key={c.courseId} className="text-xs text-destructive">{s.courses.find((x) => x.id === c.courseId)?.code}: {c.error}</p>)}
          <Button className="mt-3" onClick={syncAll} disabled={syncing}>{syncing ? "Syncing…" : "Sync all courses (demo)"}</Button>
        </Section>

        <TeachingCalendarSettings />
        <Section title="Legacy semester / display settings">
          <p className="mb-2 text-xs text-muted-foreground">Historical compatibility fields only; these do not configure the explicit teaching calendar.</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label htmlFor="ss">Week 1 starts</Label><Input id="ss" type="date" value={st.semesterStart} onChange={(e) => e.target.value && upd({ semesterStart: e.target.value })} /></div>
            <div className="space-y-1"><Label htmlFor="sw">Weeks</Label><Input id="sw" type="number" min={1} max={30} value={st.semesterWeeks} onChange={(e) => upd({ semesterWeeks: Math.min(30, Math.max(1, num(e.target.value))) })} /></div>
            <div className="col-span-2 space-y-1"><Label htmlFor="tz">Display timezone</Label>
              <select id="tz" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={st.timezone} onChange={(e) => upd({ timezone: e.target.value })}>
                {["Asia/Almaty", "Asia/Qyzylorda", "Asia/Aqtobe", "UTC", "Europe/Moscow"].map((z) => <option key={z}>{z}</option>)}
              </select>
            </div>
          </div>
        </Section>

        <Section title="Workload">
          <p className="mb-2 text-xs text-muted-foreground">Estimates, not study hours.</p>
          <WorkloadWeights />
        </Section>

        <Section title="Reminders">
          <ReminderSettingsPanel />
          <p className="mt-2 text-xs text-muted-foreground">Browser notifications are shown by the Moodle Helper Chrome extension only while Chrome is open. Every alert is also kept on the Alerts page. If notifications are blocked, allow them for Moodle Helper in Chrome (chrome://settings/content/notifications) or your system settings, then reconnect; the dashboard never asks repeatedly.</p>
        </Section>

        <Section title="AI explanations (optional)">
          <p className="text-sm text-muted-foreground">{ai?.available === false ? ai.reason : "Checking…"}</p>
          <p className="mt-2 text-xs text-muted-foreground">When available, you'll see the provider, the exact excerpts, what leaves your device and retention terms before anything is sent.</p>
          <label className="mt-3 flex items-center justify-between text-sm">Allow asking before sending excerpts <Switch disabled={!ai?.available} checked={st.ai.enabled} onCheckedChange={(v) => upd({ ai: { ...st.ai, enabled: v } })} /></label>
        </Section>

        <Section title="Backup & local data">
          <p className="mb-3 text-xs text-muted-foreground">Backups contain records, settings and your personal changes. Original documents and downloaded files are not included.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={exp.phase === "preparing"} onClick={() => void prepareExport()}>{exp.phase === "preparing" ? "Preparing…" : "Export backup"}</Button>
            <label className="inline-flex cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-muted">
              Restore…
              <input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPreview(previewRestore(await f.text(), s)); e.target.value = ""; }} />
            </label>
            {adapter.resetDemo && <Button variant="outline" onClick={() => run((a) => a.resetDemo!()).then((ok) => ok && toast.success("Demo data reset"))}>Reset demo</Button>}
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="destructive">Delete local data</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete all local data?</AlertDialogTitle>
                  <AlertDialogDescription>This clears records and tracked courses in the local backend. Other settings are retained. It does not touch Moodle or files saved on your disk.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => run((a) => a.deleteLocalData())}>Delete</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </Section>
      </div>

      <AlertDialog open={exp.phase !== "idle" && exp.phase !== "preparing"} onOpenChange={(o) => !o && setExp({ phase: "idle" })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{exp.phase === "error" ? "Backup not exported" : "Export this backup?"}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {exp.phase === "error" && <p role="alert">{exp.error}</p>}
                {exp.prepared && exp.phase !== "error" && (
                  <>
                    <p>Prepared {new Date(exp.prepared.backup.exportedAt).toLocaleString("en-GB")} · format version {exp.prepared.backup.version} · {exp.prepared.bytes.toLocaleString("en-GB")} bytes. Later changes are not included unless you prepare again.</p>
                    <table className="mt-3 w-full text-sm"><thead><tr><th className="text-left">Item</th><th>Records</th></tr></thead>
                      <tbody>{exp.prepared.backup.summary!.counts.map((c) => <tr key={c.label}><td>{c.label}</td><td className="text-center">{c.count}</td></tr>)}</tbody></table>
                    <p className="mt-3 text-xs">Not included: {exp.prepared.backup.summary!.exclusions.join("; ")}. Redacted fields: {exp.prepared.backup.summary!.redactions}.</p>
                    {exp.phase === "requested" && <p className="mt-3" role="status">Download requested; check your browser downloads.</p>}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <Button variant="outline" onClick={() => void prepareExport()}>{exp.phase === "error" ? "Retry" : "Prepare again"}</Button>
            {exp.prepared && exp.phase !== "error" && <Button onClick={downloadExport}>Download</Button>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{preview?.ok ? "Restore this backup?" : "Can't restore"}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {preview?.ok ? (
                  <>
                    <p>Exported {new Date(preview.backup.exportedAt).toLocaleString("en-GB")}. Everything currently stored will be replaced.</p>
                    <table className="mt-3 w-full text-sm"><thead><tr><th className="text-left">Item</th><th>Now</th><th>Backup</th></tr></thead>
                      <tbody>{preview.diff.map((d) => <tr key={d.label}><td>{d.label}</td><td className="text-center">{d.current}</td><td className="text-center">{d.incoming}</td></tr>)}</tbody></table>
                  </>
                ) : <p>{preview?.error}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {preview?.ok && <AlertDialogAction onClick={() => run((a) => a.replaceAll(preview.backup.data)).then((ok) => ok && toast.success("Backup restored"))}>Restore</AlertDialogAction>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
