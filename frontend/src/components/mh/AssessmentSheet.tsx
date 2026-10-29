import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDate } from "@/domain/dates";
import { resolveAssessmentId } from "@/domain/assessments";
import { useApp } from "@/lib/app-store";
import { CourseTag, SubmissionBadge, TYPE_LABEL } from "./bits";
import { DateInput } from "./DateInput";
import type { DateValue, DeadlineAssertion } from "@/domain/types";
import { personalDateError } from "@/domain/personal-event";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

function historyDate(value: DeadlineAssertion, timezone: string): string {
  if (value.kind === "removed") return "Removed";
  const shown = formatDate(value, timezone);
  return value.kind === "exact" ? `${shown} (${value.iso}, ${value.tz})` : shown;
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

  useEffect(() => {
    setTitle(v?.a.personal ? v.title : v?.overlay?.titleOverride ?? "");
    setDate(v?.a.personal ? v.date : v?.overlay?.dateOverride);
    setErrors({}); setConfirmDelete(false);
  }, [v?.a.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return null;
  const tz = snap.settings.timezone;
  const course = v && snap.courses.find((c) => c.id === v.a.courseId);
  const changes = v ? snap.changes.filter((c) => resolveAssessmentId(snap, c.assessmentId) === v.a.id) : [];
  const rawSources = v ? (snap.reconciliation?.sources ?? []).filter((source) => resolveAssessmentId(snap, source.assessmentId) === v.a.id && source.recordId) : [];

  return (
    <Sheet open={!!v} onOpenChange={(o) => !o && !busy.current && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {v && (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-2xl">{v.title}</SheetTitle>
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
                {v.a.availableFrom && <p className="text-xs text-muted-foreground">Opens {new Date(v.a.availableFrom).toLocaleString("en-GB", { timeZone: tz })}</p>}
                {v.conflict && (
                  <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <p className="font-semibold text-destructive">{v.conflict.comparison === "incomparable" ? "Sources have different date precision — Moodle date is used" : "Sources disagree — Moodle date is used"}</p>
                    <p>Moodle: {formatDate(v.conflict.moodle, tz)}</p>
                    <p>Syllabus: {formatDate(v.conflict.syllabus, tz)}</p>
                  </div>
                )}
                {v.overrideDisagreement && (
                  <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <p className="font-semibold text-destructive">The source date changed after you edited it</p>
                    <p>When you edited: {formatDate(v.overrideDisagreement.was, tz)}</p>
                    <p>Source now{v.sourceKind ? ` (${v.sourceKind})` : ""}: {formatDate(v.overrideDisagreement.now, tz)}</p>
                    <p>Your date: {formatDate(v.date, tz)}</p>
                  </div>
                )}
                {changes.map((c) => (
                  <p key={c.id} className="mt-2 text-sm text-muted-foreground">
                    {c.sourceKind === "syllabus" ? "Syllabus" : c.sourceId ? "Moodle" : "Source (unattributed)"} changed: {historyDate(c.from, tz)} → {historyDate(c.to, tz)}
                    {c.sourceUrl && <> · <a href={c.sourceUrl}>Source</a></>}
                    {c.sourceDocumentId && <> · {snap.documents.find((d) => d.id === c.sourceDocumentId)?.name ?? "Document unavailable"}</>}
                    {c.sourceObservedAt && <> · Observed {c.sourceObservedAt}</>} · Detected {c.detectedAt}
                  </p>
                ))}
              </section>

              {!v.a.personal && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Moodle submission</h3>
                  <SubmissionBadge status={v.a.submission?.status} />
                  {v.a.submission?.evidence && <p className="mt-1 text-sm text-muted-foreground">“{v.a.submission.evidence}”</p>}
                  {v.a.submission && <p className="text-xs text-muted-foreground">Observed {new Date(v.a.submission.observedAt).toLocaleString("en-GB", { timeZone: tz })}</p>}
                </section>
              )}

              <section>
                <h3 className="mb-2 text-sm font-semibold">Sources & evidence</h3>
                <ul className="space-y-2">
                  {v.a.sources.map((s, i) => (
                    <li key={i} className="rounded-md border bg-muted/40 p-3 text-sm">
                      <p className="font-medium capitalize">{s.source} · {formatDate(s.date, tz)}</p>
                      {s.excerpt && <p className="text-muted-foreground">“{s.excerpt}”</p>}
                      {s.location && <p className="text-xs text-muted-foreground">{s.location}</p>}
                      {s.url && (
                        <a className="text-xs text-primary underline" href={s.url} target="_blank" rel="noreferrer">Open in Moodle</a>
                      )}
                    </li>
                  ))}
                </ul>
                {rawSources.map((source) => {
                  const record = snap.collection?.records.find((item) => item.id === source.recordId);
                  return record && <details key={source.id} className="mt-2 rounded border p-3 text-sm">
                    <summary className="cursor-pointer font-medium">Original {record.kind} observations</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(record.observations, null, 2)}</pre>
                  </details>;
                })}
              </section>

              <section className="space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">Your changes</h3>
                <p className="text-xs text-muted-foreground">These never change Moodle or the original source facts.</p>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" disabled={pending} checked={v.completed} onChange={(e) => run((a) => a.updateOverlay(v.a.id, { completed: e.target.checked }))} />
                  I've finished this (personal check)
                </label>
                {v.completed && v.needsAttention && (
                  <p className="text-xs text-destructive">Moodle still shows {v.a.submission?.status === "draft" ? "a draft" : v.a.submission?.status === "not_submitted" ? "not submitted" : "a resubmission request"} — it stays visible.</p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="ttl">Display title</Label>
                  <Input id="ttl" disabled={pending} aria-invalid={!!errors.title} aria-describedby="personal-title-error" placeholder={v.a.title} value={title} onChange={(e) => setTitle(e.target.value)} />
                  {errors.title && <p id="personal-title-error" role="alert" className="text-sm text-destructive">{errors.title}</p>}
                </div>
                <div className="space-y-1">
                  <Label>Your date</Label>
                  <fieldset disabled={pending}><DateInput value={date} onChange={setDate} allowEmpty={!v.a.personal} personalTimezone={v.a.personal ? tz : undefined} errorId="personal-date-error" /></fieldset>
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
                    }
                    setErrors(invalid); if (Object.keys(invalid).length) return;
                    busy.current = true; setPending(true);
                    const ok = await run((a) => a.updateOverlay(v.a.id, { titleOverride: (v.a.personal ? title.trim() : title) || undefined, dateOverride: date }));
                    busy.current = false; setPending(false);
                    if (!ok) setErrors({ save: "Changes were not saved. Your entries are retained; retry when the backend is available." });
                  }}>{pending ? "Saving…" : "Save changes"}</Button>
                  <Button size="sm" disabled={pending} variant="outline" onClick={() => run((a) => a.updateOverlay(v.a.id, { hidden: !v.hidden }))}>
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
