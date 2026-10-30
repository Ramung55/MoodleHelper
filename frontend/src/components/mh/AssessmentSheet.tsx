import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { displayDate as formatDate, dueState, redactUnsafeLinks, safeSourceHref, sourceFreshness } from "@/domain/deadline-display";
import { LocalEvidenceView } from "./LocalEvidenceView";
import { resolveAssessmentId } from "@/domain/assessments";
import { useApp } from "@/lib/app-store";
import { CourseTag, SubmissionBadge, TYPE_LABEL } from "./bits";
import { DateInput } from "./DateInput";
import type { DateValue, DeadlineAssertion } from "@/domain/types";
import type { OverlayPatch } from "@/services/adapter";
import { personalDateError } from "@/domain/personal-event";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

function historyDate(value: DeadlineAssertion, timezone: string): string {
  if (value.kind === "removed") return "Removed";
  const shown = formatDate(value, timezone);
  return value.kind === "exact" ? `${shown} (${value.iso}, ${value.tz})` : shown;
}

function sameValue(a: DateValue | undefined, b: DateValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Imported overrides: absent (Use source date) and an intentional "No date" are valid; other forms use the strict #34 checks. */
export function importedDateError(date: DateValue | undefined): string | null {
  if (!date || date.kind === "unknown") return null;
  return personalDateError(date);
}

/** Only fields changed from the saved overlay are sent, so unrelated saves never recapture the date baseline. */
export function dirtyOverlayPatch(saved: { titleOverride?: string; dateOverride?: DateValue } | undefined, title: string, date: DateValue | undefined): OverlayPatch {
  const patch: OverlayPatch = {};
  const nextTitle = title.trim() || undefined;
  if (nextTitle !== (saved?.titleOverride || undefined)) patch.titleOverride = nextTitle ?? null;
  if (!sameValue(date, saved?.dateOverride)) patch.dateOverride = date ?? null;
  return patch;
}

/** Source links are revalidated at the display boundary; unsafe ones are never echoed. */
export function SourceLink({ url, label }: { url: string; label: string }) {
  const href = safeSourceHref(url);
  if (!href) return <span className="text-xs text-muted-foreground">Source link unavailable</span>;
  return <a className="text-xs text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={href} target="_blank" rel="noreferrer noopener">{label}</a>;
}

export function AssessmentSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { views, snap, run } = useApp();
  const resolvedId = id && snap ? resolveAssessmentId(snap, id) : id;
  const v = views.find((x) => x.a.id === resolvedId);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState<DateValue | undefined>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = useRef(false);
  const lastId = useRef<string | null>(null);
  if (resolvedId) lastId.current = resolvedId;
  const mutate = async (fn: Parameters<typeof run>[0], failure: string, after?: () => void) => {
    if (busy.current) return false;
    busy.current = true; setPending(true); setErrors({});
    const ok = await run(fn);
    busy.current = false; setPending(false);
    if (ok) after?.(); else setErrors({ save: failure });
    return ok;
  };

  useEffect(() => {
    setTitle(v?.a.personal ? v.title : v?.overlay?.titleOverride ?? "");
    setDate(v?.a.personal ? v.date : v?.overlay?.dateOverride);
    setErrors({}); setConfirmDelete(false);
  }, [v?.a.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return null;
  const tz = snap.settings.timezone;
  const course = v && snap.courses.find((c) => c.id === v.a.courseId);
  const changes = v ? snap.changes.filter((c) => resolveAssessmentId(snap, c.assessmentId) === v.a.id) : [];
  const originals = v && snap.reconciliation ? snap.reconciliation.aliases.filter((alias) => alias.canonicalId === v.a.id && alias.originalId !== v.a.id).map((alias) => snap.assessments.find((item) => item.id === alias.originalId)).filter((item) => !!item) : [];
  const saved = v?.overlay;
  const hasDateOverride = !!saved?.dateOverride;
  const due = v ? dueState(v, tz, new Date()) : null;
  const fresh = v ? sourceFreshness(v, snap, tz) : null;
  const rawSources = v ? (snap.reconciliation?.sources ?? []).filter((source) => resolveAssessmentId(snap, source.assessmentId) === v.a.id && source.recordId) : [];

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && !busy.current && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" onCloseAutoFocus={(e) => {
        const row = lastId.current && typeof document !== "undefined" ? document.querySelector<HTMLElement>(`[data-assessment-row="${CSS.escape(lastId.current)}"]`) : null;
        if (row) { e.preventDefault(); row.focus(); }
      }}>
        {!v && id && (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-2xl">Assessment not available</SheetTitle>
              <SheetDescription>This link points to an assessment that was removed, merged away or is not tracked. Your other deadlines are unchanged.</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-8"><Button variant="outline" onClick={onClose}>Back to deadlines</Button></div>
          </>
        )}
        {v && (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-2xl break-words [overflow-wrap:anywhere]">{v.title}</SheetTitle>
              <SheetDescription asChild>
                <div className="space-y-1">
                  <CourseTag course={course} />
                  <p>{TYPE_LABEL[v.a.type]}{v.a.personal && " · Personal event"}</p>
                </div>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-8">
              <section>
                <h3 className="mb-2 text-sm font-semibold">Deadline</h3>
                <p className="font-mono text-lg font-semibold">{formatDate(v.date, tz)}</p>
                {v.date.kind === "week" && <p>{v.teachingMapping.resolved ? `${v.teachingMapping.start} – ${v.teachingMapping.end} · ${v.teachingMapping.timezone}` : v.teachingMapping.reason}</p>}
                {v.week && <p className="text-xs text-muted-foreground">Teaching week {v.week}</p>}
                {due && <p className={due.kind === "overdue" ? "text-sm font-semibold text-destructive" : "text-sm text-muted-foreground"}>{due.label}</p>}
                {fresh && <p className={fresh.stale ? "text-sm text-warning-foreground" : "text-xs text-muted-foreground"}>{fresh.label}</p>}
                {v.a.availableFrom && <p className="text-xs text-muted-foreground">Opens {Number.isFinite(Date.parse(v.a.availableFrom)) ? new Date(v.a.availableFrom).toLocaleString("en-GB", { timeZone: tz }) : "date unavailable"}</p>}
                {v.conflict && (
                  <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <p className="font-semibold text-destructive">{v.conflict.comparison === "incomparable" ? "Sources have different date precision" : "Sources disagree"} — {hasDateOverride ? "your date is shown; Moodle is the latest source date" : "Moodle date is used"}</p>
                    <p>Moodle: {formatDate(v.conflict.moodle, tz)}</p>
                    <p>Syllabus: {formatDate(v.conflict.syllabus, tz)}</p>
                  </div>
                )}
                {v.overrideDisagreement && (
                  <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <p className="font-semibold text-destructive">The source date changed after you edited it</p>
                    <p className="text-xs font-semibold uppercase text-destructive">Needs review</p>
                    <p>When you edited (previous baseline): {formatDate(v.overrideDisagreement.was, tz)}</p>
                    <p>Source now{v.sourceKind ? ` (${v.sourceKind})` : ""}: {formatDate(v.overrideDisagreement.now, tz)}</p>
                    <p>Your date: {formatDate(v.date, tz)}</p>
                  </div>
                )}
                {changes.map((c) => (
                  <p key={c.id} className="mt-2 text-sm text-muted-foreground">
                    {c.sourceKind === "syllabus" ? "Syllabus" : c.sourceId ? "Moodle" : "Source (unattributed)"} changed: {historyDate(c.from, tz)} → {historyDate(c.to, tz)}
                    {c.sourceUrl && <> · <SourceLink url={c.sourceUrl} label="Source of this change" /></>}
                    {c.sourceDocumentId && <> · {snap.documents.find((d) => d.id === c.sourceDocumentId)?.name ?? "Document unavailable"}</>}
                    {c.sourceObservedAt && <> · Observed {c.sourceObservedAt}</>} · Detected {c.detectedAt}
                  </p>
                ))}
              </section>

              {!v.a.personal && (
                <section aria-label="Original source values">
                  <h3 className="mb-2 text-sm font-semibold">Original source</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Source title</dt><dd>{v.a.title}</dd>
                    <dt className="text-muted-foreground">Latest source date</dt><dd>{v.sourceDate.kind === "unknown" ? "No source date" : formatDate(v.sourceDate, tz)}{v.sourceKind ? ` · ${v.sourceKind === "moodle" ? "Moodle" : "Syllabus"}` : ""}</dd>
                    <dt className="text-muted-foreground">Shown to you</dt><dd>{v.title} · {v.date.kind === "unknown" && hasDateOverride ? "No date (your choice)" : formatDate(v.date, tz)}{saved?.titleOverride || hasDateOverride ? " (personal override)" : ""}</dd>
                  </dl>
                  {originals.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground" aria-label="Merged source records">
                      {originals.map((item) => <li key={item!.id}>Merged record: {item!.title} · {item!.sources.map((source) => `${source.source} ${formatDate(source.date, tz)}`).join("; ")}</li>)}
                    </ul>
                  )}
                </section>
              )}

              {!v.a.personal && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Moodle submission</h3>
                  <SubmissionBadge status={v.a.submission?.status} />
                  {!v.a.submission && <p className="mt-1 text-sm text-muted-foreground">Moodle submission status unknown — not observed yet. This is not treated as overdue or not submitted.</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Independent of your personal check{v.completed ? " (you marked this done)" : ""}.</p>
                  {v.a.submission?.evidence && <p className="mt-1 text-sm text-muted-foreground">“{v.a.submission.evidence}”</p>}
                  {v.a.submission && <p className="text-xs text-muted-foreground">Observed {Number.isFinite(Date.parse(v.a.submission.observedAt)) ? new Date(v.a.submission.observedAt).toLocaleString("en-GB", { timeZone: tz }) : "time unknown"}</p>}
                </section>
              )}

              <section>
                <h3 className="mb-2 text-sm font-semibold">Sources & evidence</h3>
                <p className="mb-2 text-xs text-muted-foreground">Raw source observations as recorded; the effective date above may come from a newer accepted observation or your override.</p>
                {v.a.sources.length === 0 && <p className="text-sm text-muted-foreground">No source evidence recorded.</p>}
                <ul className="space-y-2">
                  {v.a.sources.map((s, i) => (
                    <li key={i} className="rounded-md border bg-muted/40 p-3 text-sm">
                      <p className="font-medium">{s.source === "moodle" ? "Moodle" : s.source === "syllabus" ? "Syllabus" : "Personal"} · {formatDate(s.date, tz)}</p>
                      <p className="text-xs text-muted-foreground">Observed {Number.isFinite(Date.parse(s.observedAt)) ? new Date(s.observedAt).toLocaleString("en-GB", { timeZone: tz }) : "time unknown"}</p>
                      {s.localEvidence ? <LocalEvidenceView reference={s.localEvidence} /> : <>{s.excerpt && <p className="text-muted-foreground">“{s.excerpt}”</p>}{s.location && <p className="text-xs text-muted-foreground">{s.location}</p>}</>}
                      {s.url && <SourceLink url={s.url} label="Open source in Moodle" />}
                    </li>
                  ))}
                </ul>
                {rawSources.map((source) => {
                  const record = snap.collection?.records.find((item) => item.id === source.recordId);
                  return record && <details key={source.id} className="mt-2 rounded border p-3 text-sm">
                    <summary className="cursor-pointer font-medium">Original {record.kind} observations</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(record.observations, redactUnsafeLinks, 2)}</pre>
                  </details>;
                })}
              </section>

              <section className="space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">Your changes</h3>
                <p className="text-xs text-muted-foreground">These never change Moodle or the original source facts.</p>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" aria-busy={pending} disabled={pending} checked={v.completed} onChange={(e) => { const completed = e.target.checked; void mutate((a) => a.updateOverlay(v.a.id, { completed }), "Completion was not saved. Retry when the backend is available."); }} />
                  I've finished this (personal check)
                </label>
                {v.completed && v.needsAttention && (
                  <p className="text-xs text-destructive">Moodle still shows {v.a.submission?.status === "draft" ? "a draft" : v.a.submission?.status === "not_submitted" ? "not submitted" : "a resubmission request"} — it stays visible.</p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="ttl">Display title</Label>
                  <Input id="ttl" disabled={pending} aria-invalid={!!errors.title} aria-describedby="personal-title-error" placeholder={v.a.title} value={title} onChange={(e) => setTitle(e.target.value)} />
                  {!v.a.personal && <p className="text-xs text-muted-foreground">Saved: {saved?.titleOverride ? `“${saved.titleOverride}”` : "source title"}</p>}
                  {errors.title && <p id="personal-title-error" role="alert" className="text-sm text-destructive">{errors.title}</p>}
                </div>
                <div className="space-y-1">
                  <Label>Your date</Label>
                  <fieldset disabled={pending}><DateInput value={date} onChange={setDate} allowEmpty={!v.a.personal} allowUnknown={!v.a.personal} personalTimezone={v.a.personal ? tz : date?.kind === "exact" ? date.tz : tz} errorId="personal-date-error" /></fieldset>
                  {!v.a.personal && <p className="text-xs text-muted-foreground">Saved: {saved?.dateOverride ? saved.dateOverride.kind === "unknown" ? "No date (your choice)" : formatDate(saved.dateOverride, tz) : "source date"}</p>}
                  {errors.date && <p id="personal-date-error" role="alert" className="text-sm text-destructive">{errors.date}</p>}
                </div>
                {errors.save && <p role="alert" className="text-sm text-destructive">{errors.save}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={pending} onClick={async () => {
                    if (busy.current) return;
                    const invalid: Record<string, string> = {};
                    if (v.a.personal) {
                      if (!title.trim()) invalid.title = "Enter a title.";
                      const error = personalDateError(date); if (error) invalid.date = error;
                    } else {
                      const error = importedDateError(date); if (error) invalid.date = error;
                    }
                    setErrors(invalid); if (Object.keys(invalid).length) return;
                    const patch: OverlayPatch = v.a.personal ? { titleOverride: title.trim() || undefined, dateOverride: date } : dirtyOverlayPatch(saved, title, date);
                    if (!Object.keys(patch).length) return;
                    await mutate((a) => a.updateOverlay(v.a.id, patch), "Changes were not saved. Your entries are retained; retry when the backend is available.");
                  }}>{pending ? "Saving…" : "Save changes"}</Button>
                  {!v.a.personal && saved?.titleOverride && (
                    <Button size="sm" disabled={pending} variant="outline" onClick={() => mutate((a) => a.updateOverlay(v.a.id, { titleOverride: null }), "The title was not reset. Retry when the backend is available.", () => setTitle(""))}>Reset title</Button>
                  )}
                  {!v.a.personal && hasDateOverride && (
                    <Button size="sm" disabled={pending} variant="outline" onClick={() => mutate((a) => a.updateOverlay(v.a.id, { dateOverride: null }), "The date was not reset. Retry when the backend is available.", () => setDate(undefined))}>Reset date</Button>
                  )}
                  <Button size="sm" disabled={pending} variant="outline" onClick={() => mutate((a) => a.updateOverlay(v.a.id, { hidden: !v.hidden }), v.hidden ? "The item was not restored. Retry when the backend is available." : "The item was not hidden. Retry when the backend is available.")}>
                    {v.hidden ? "Restore item" : "Hide item"}
                  </Button>
                  {v.a.personal && (
                    <Button size="sm" disabled={pending} variant="destructive" onClick={() => setConfirmDelete(true)}>Delete event</Button>
                  )}
                </div>
              </section>
              {v.a.personal && <AlertDialog open={confirmDelete} onOpenChange={(open) => !busy.current && setConfirmDelete(open)}>
                <AlertDialogContent>
                  <AlertDialogHeader><AlertDialogTitle>Delete personal event?</AlertDialogTitle><AlertDialogDescription>Delete “{v.title}” and its personal changes? Other events and Moodle records will remain.</AlertDialogDescription></AlertDialogHeader>
                  <AlertDialogFooter>
                    <Button variant="outline" disabled={pending} onClick={() => setConfirmDelete(false)}>Cancel</Button>
                    <Button variant="destructive" disabled={pending} onClick={async () => {
                      if (busy.current) return;
                      busy.current = true; setPending(true); setErrors({});
                      const ok = await run((a) => a.deletePersonalEvent(v.a.id));
                      busy.current = false; setPending(false); setConfirmDelete(false);
                      if (ok) onClose(); else setErrors({ save: "The event was not deleted. Retry when the backend is available." });
                    }}>{pending ? "Deleting…" : "Confirm deletion"}</Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
