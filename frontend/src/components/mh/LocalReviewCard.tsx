import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/mh/DateInput";
import { CourseTag, TYPE_LABEL } from "@/components/mh/bits";
import { formatDate } from "@/domain/dates";
import { personalDateError } from "@/domain/personal-event";
import { mapTeachingWeek } from "@/domain/teaching-weeks";
import type { MentionLocation } from "@/domain/assessment-mentions";
import { AssessmentType, LocalSyllabusDate, type DateValue, type ExtractionCandidate } from "@/domain/types";
import { useApp } from "@/lib/app-store";
import { BackendResponseError } from "@/services/http-adapter";
import { inspectLocalReviewEvidence, submitLocalReview, type LocalChoice, type LocalReviewEvidence } from "@/services/local-review";

const REASON: Record<string, string> = {
  clear_explicit: "Clear explicit date", incomplete_extraction: "Text extraction was incomplete", evidence_missing: "Original evidence was not retained",
  location_missing: "Source location is missing", source_unavailable: "Original document was unavailable", context_unverified: "Course/dataset context was not verified",
  association_ambiguous: "Several dates or assessments are mentioned together", date_missing: "No date was found", date_not_explicit: "Date is not explicit",
  year_inferred: "Year was inferred, not written", locale_ambiguous: "Day/month order is ambiguous", contradictory: "Source facts contradict each other",
  policy_or_heading: "Grading-policy or heading wording", conflicting_match: "May relate to an existing item", mapping_unresolved: "Teaching week has no resolved calendar mapping",
  timezone_unresolved: "Time zone is unresolved", language_unknown: "Language is unknown", ocr_review: "Text came from OCR", ocr_low_quality: "OCR quality is low",
  ocr_synthetic: "OCR text is synthetic", ocr_provenance_missing: "OCR provenance is missing", week_only: "Only a teaching week is given",
};

/** Human description of the original location; geometry stays local and is rendered as inert text. */
export function describeLocation(location: MentionLocation): string {
  if (location.kind === "pdf_row") {
    const first = location.items[0];
    return `PDF page ${location.page}, text row of ${location.items.length} item(s)${first ? ` starting at x ${Math.round(first.transform[4] ?? 0)}, y ${Math.round(first.transform[5] ?? 0)}` : ""}`;
  }
  if (location.kind === "docx_paragraph") return `DOCX ${location.paragraph.location.part}, body block ${location.paragraph.location.bodyBlock}, paragraph ${location.paragraph.location.paragraph}`;
  if (location.kind === "docx_row") return `DOCX ${location.part}, body block ${location.bodyBlock}, table ${location.table}, row ${location.row}, cell(s) ${location.cells.map(cell => cell.cell).join(", ")}`;
  const quality = [location.engine ? `engine ${location.engine}` : "engine not recorded", location.dpi ? `${location.dpi} DPI` : "DPI not recorded", location.confidence !== undefined ? `OCR engine score ${Math.round(location.confidence)} (text recognition only, not source verification)` : "no OCR score", location.reviewNeeded ? "page flagged for review" : "", location.synthetic ? "synthetic OCR text" : ""].filter(Boolean).join(", ");
  return `OCR page ${location.page}, region [${location.bounds.map(value => Math.round(value)).join(", ")}]; ${quality}`;
}

/** Calendar/date/zone/week validation for a local correction; returns per-field errors. */
export function correctionErrors(title: string, date: DateValue | undefined): { title?: string; date?: string } {
  const errors: { title?: string; date?: string } = {};
  if (!title.trim()) errors.title = "Enter a title.";
  else if (title.length > 512) errors.title = "Use at most 512 characters.";
  const dateError = personalDateError(date);
  if (dateError) errors.date = dateError;
  else if (!LocalSyllabusDate.safeParse(date).success) errors.date = date?.kind === "exact" ? "Choose a supported time zone in Settings and a valid date and time." : "Enter a valid date or teaching week.";
  return errors;
}

export function LocalReviewCard({ c }: { c: ExtractionCandidate }) {
  const { snap, run } = useApp();
  const s = snap!;
  const [evidence, setEvidence] = useState<LocalReviewEvidence>(), [lookupError, setLookupError] = useState("");
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(c.title), [type, setType] = useState(c.type);
  const [date, setDate] = useState<DateValue | undefined>(c.date.kind === "unknown" ? undefined : c.date);
  const [errors, setErrors] = useState<{ title?: string; date?: string }>({});
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [failure, setFailure] = useState<{ message: string; retry: LocalChoice }>();
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    setLookupError("");
    inspectLocalReviewEvidence(c, s, controller.signal).then(result => { if (alive) setEvidence(result); }).catch(error => { if (alive && !controller.signal.aborted) { setEvidence(undefined); setLookupError(error instanceof Error ? error.message : "Stored local evidence is unavailable."); } });
    return () => { alive = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, c.status, c.documentId, reload, s.localSyllabusReceipts]);

  const decide = async (choice: LocalChoice) => {
    if (inFlight.current || !evidence) return;
    if (choice.kind === "correct") {
      const found = correctionErrors(choice.title, choice.date);
      setErrors(found);
      if (found.title || found.date) return;
    }
    inFlight.current = true; setBusy(true); setFailure(undefined);
    let problem: unknown;
    try {
      const ok = await run(async (a) => {
        try { return await submitLocalReview(c, s, evidence, choice, acknowledged, a); }
        catch (error) { problem = error; throw error; }
      });
      if (!ok) {
        setFailure({ message: problem instanceof Error ? problem.message : "The review was not saved.", retry: choice });
        if (problem instanceof BackendResponseError && problem.status === 409) await run((a) => a.load());
      }
    } finally { inFlight.current = false; setBusy(false); setReload(value => value + 1); }
  };

  const original = evidence && evidence.mode !== "unavailable" ? evidence.record.original : undefined;
  const reasons = [...new Set([...(evidence?.receipt?.route.reasons ?? []).map(reason => REASON[reason] ?? reason)])];
  const sourceReasons = original ? [...new Set([...original.mention.reasons, ...original.dates.filter(item => item.state !== "proposed" || item.reasons.length).flatMap(item => item.reasons)])] : [];
  const unknownDate = c.date.kind === "unknown";
  const week = c.date.kind === "week" ? mapTeachingWeek(c.date.week, s.settings.teachingCalendar) : undefined;
  const blocked = !evidence || evidence.mode === "unavailable";
  const needsAck = evidence?.mode === "stored-evidence-only" && !acknowledged;
  const language = c.language === "unknown" ? "Language unknown" : c.language.toUpperCase();
  return (
    <article className="rounded-lg border border-warning bg-card p-4" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{c.title} <span className="text-xs uppercase text-muted-foreground">{TYPE_LABEL[c.type]} · {language}</span></p>
          <CourseTag course={s.courses.find((x) => x.id === c.courseId)} />
        </div>
        <span className="rounded bg-warning px-2 py-0.5 text-xs text-warning-foreground">Deterministic policy · review required</span>
      </div>
      <p className="mt-2 text-sm">Proposed: <strong>{unknownDate ? "Date unresolved in the source" : formatDate(c.date, s.settings.timezone)}</strong></p>
      {week && <p className="text-sm text-muted-foreground">{week.resolved ? `Teaching week preview: Week ${week.week}: ${week.start} – ${week.end} (${week.timezone})` : `Week stays unallocated: ${week.reason}`}</p>}
      {unknownDate && <p className="text-sm text-muted-foreground">The source gives no usable date. It stays in review until you correct it with an explicit date or week; no date is assumed.</p>}
      {reasons.length > 0 && <p className="text-sm text-muted-foreground">Why review: {reasons.join("; ")}</p>}
      {sourceReasons.length > 0 && <ul className="list-disc pl-5 text-sm text-muted-foreground">{sourceReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      {lookupError && <p className="mt-2 text-sm text-destructive">Stored original evidence could not be read: {lookupError}</p>}
      {!evidence && !lookupError && <p className="mt-2 text-xs">Looking up original evidence in this browser…</p>}
      {evidence?.mode === "unavailable" && <div className="mt-2 rounded border border-dashed p-2 text-sm"><p className="font-medium">Original evidence unavailable</p><p>{evidence.reason}</p><p className="text-muted-foreground">Confirm and Correct are blocked until the original file or evidence is recovered. Reject remains available.</p></div>}
      {original && evidence?.mode !== "unavailable" && (
        <div className="mt-2 space-y-1 rounded border p-2 text-sm">
          <p className="text-xs font-medium">{evidence!.mode === "original-available" ? "Original document is available locally." : "Original source unavailable; stored evidence only."}</p>
          <blockquote className="whitespace-pre-wrap border-l-2 pl-2 italic">{original.mention.excerpt}</blockquote>
          <p className="whitespace-pre-wrap">Original date wording: {original.mention.rawScheduleText}</p>
          {original.dates.filter(item => item.expression).map(item => <p key={item.id} className="text-xs">Date expression “{item.expression}” · {item.state === "proposed" ? formatDate(item.date, s.settings.timezone) : `unresolved (${item.state})`}{item.yearInferredFrom ? " · year inferred" : ""}{item.zoneProvenance ? ` · zone from ${item.zoneProvenance.kind}` : item.wallTime ? " · time zone unresolved" : ""}</p>)}
          <p className="text-xs text-muted-foreground">Location: {describeLocation(original.mention.location)}</p>
          {evidence!.mode === "stored-evidence-only" && (
            <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /> I am deciding manually from stored evidence. This is not verification against the original document.</label>
          )}
        </div>
      )}
      {editing && (
        <div className="mt-3 space-y-2">
          <input aria-label="Corrected title" aria-invalid={!!errors.title} aria-describedby={errors.title ? `${c.id}-title-error` : undefined} className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} />
          {errors.title && <p id={`${c.id}-title-error`} className="text-xs text-destructive">{errors.title}</p>}
          <select aria-label="Corrected type" className="h-9 rounded-md border bg-card px-2 text-sm" value={type} onChange={(e) => setType(AssessmentType.parse(e.target.value))}>
            {AssessmentType.options.map(option => <option key={option} value={option}>{TYPE_LABEL[option]}</option>)}
          </select>
          <DateInput value={date} onChange={setDate} allowEmpty={false} personalTimezone={s.settings.timezone} errorId={errors.date ? `${c.id}-date-error` : undefined} />
          {!date && <p className="text-xs text-muted-foreground">Choose a date form: date only, exact date and time, or teaching week.</p>}
          {errors.date && <p id={`${c.id}-date-error`} className="text-xs text-destructive">{errors.date}</p>}
        </div>
      )}
      {failure && <div role="alert" className="mt-2 text-sm text-destructive">{failure.message} <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(failure.retry.kind === "correct" ? { kind: "correct", title, type, date: date ?? { kind: "unknown" } } : failure.retry)}>Retry</Button></div>}
      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <Button size="sm" disabled={busy || blocked || needsAck} onClick={() => void decide({ kind: "correct", title, type, date: date ?? { kind: "unknown" } })}>Save correction</Button>
        ) : (
          <>
            <Button size="sm" disabled={busy || blocked || needsAck || unknownDate} onClick={() => void decide({ kind: "confirm" })}>Confirm</Button>
            <Button size="sm" variant="outline" disabled={busy || blocked} onClick={() => setEditing(true)}>Correct</Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={busy || !evidence} onClick={() => void decide({ kind: "reject" })}>Reject</Button>
      </div>
    </article>
  );
}
