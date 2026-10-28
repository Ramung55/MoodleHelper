import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/domain/dates";
import { latest } from "@/domain/assessments";
import type { Snapshot, Overlay } from "@/domain/types";
import { useApp } from "@/lib/app-store";

type Source = NonNullable<Snapshot["reconciliation"]>["sources"][number];
type Pair = NonNullable<Snapshot["reconciliation"]>["pairs"][number];

function details(s: Snapshot, source: Source) {
  const a = s.assessments.find((item) => item.id === source.assessmentId);
  const evidence = a && latest(a.sources, source.kind);
  const course = s.courses.find((item) => item.id === source.courseId);
  return { a, evidence, course };
}

function sourceLabel(s: Snapshot, source: Source) {
  const { a, evidence, course } = details(s, source);
  return `${source.kind === "moodle" ? "Moodle" : "Syllabus"}: ${a?.title ?? "Unavailable"} · ${course?.code ?? "Unknown course"} · ${evidence ? formatDate(evidence.date, s.settings.timezone) : "Date unknown"}`;
}

const FIELDS = ["titleOverride", "dateOverride", "hidden", "completed"] as const;
type Field = typeof FIELDS[number];
const LABELS: Record<Field, string> = { titleOverride: "display title", dateOverride: "personal date and baseline", hidden: "hidden state", completed: "completion state" };

function value(overlay: Overlay | undefined, field: Field): unknown {
  if (!overlay) return undefined;
  if (field === "dateOverride") return overlay.dateOverride ? [overlay.dateOverride, overlay.overrideBase ?? null] : undefined;
  return overlay[field];
}

function showValue(v: unknown, s: Snapshot): string {
  if (v === undefined) return "Not set";
  if (Array.isArray(v)) return `${formatDate(v[0], s.settings.timezone)} (baseline: ${v[1] ? formatDate(v[1], s.settings.timezone) : "not set"})`;
  return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
}

function PairCard({ pair, s, left, right }: { pair: Pair; s: Snapshot; left: Source; right: Source }) {
  const { run } = useApp();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const first = s.overlays.find((o) => o.assessmentId === left.assessmentId);
  const second = s.overlays.find((o) => o.assessmentId === right.assessmentId);
  const conflicts = FIELDS.filter((field) => {
    const a = value(first, field), b = value(second, field);
    return a !== undefined && b !== undefined && JSON.stringify(a) !== JSON.stringify(b);
  });
  const firstSubmission = details(s, left).a?.submission;
  const secondSubmission = details(s, right).a?.submission;
  const submissionConflict = firstSubmission && secondSubmission && JSON.stringify(firstSubmission) !== JSON.stringify(secondSubmission);
  return <article className="rounded-lg border bg-card p-4 space-y-2">
    <p className="font-semibold">Possible match — review both originals</p>
    <p className="text-sm">{sourceLabel(s, left)}</p>
    <p className="text-sm">{sourceLabel(s, right)}</p>
    {conflicts.map((field) => <label key={field} className="block text-sm">
      Choose {LABELS[field]}:
      <select aria-label={`Choose ${LABELS[field]}`} className="ml-2 rounded border bg-card p-1" value={choices[field] ?? ""} onChange={(e) => setChoices({ ...choices, [field]: e.target.value })}>
        <option value="">Choose a value</option>
        <option value={left.id}>{left.kind}: {showValue(value(first, field), s)}</option>
        <option value={right.id}>{right.kind}: {showValue(value(second, field), s)}</option>
      </select>
    </label>)}
    {submissionConflict && <label className="block text-sm">Choose submission observation:
      <select aria-label="Choose submission observation" className="ml-2 rounded border bg-card p-1" value={choices.submission ?? ""} onChange={(e) => setChoices({ ...choices, submission: e.target.value })}>
        <option value="">Choose an observation</option>
        <option value={left.id}>{left.kind}: {firstSubmission.status} · {firstSubmission.observedAt}</option>
        <option value={right.id}>{right.kind}: {secondSubmission.status} · {secondSubmission.observedAt}</option>
      </select>
    </label>}
    <div className="flex gap-2">
      <Button size="sm" disabled={conflicts.some((field) => !choices[field]) || !!submissionConflict && !choices.submission} onClick={() => void run((a) => a.decideReconciliation(pair.id, pair.fingerprint, pair.reviewRevision, "confirm", choices))}>Confirm match</Button>
      <Button size="sm" variant="outline" onClick={() => void run((a) => a.decideReconciliation(pair.id, pair.fingerprint, pair.reviewRevision, "reject", {}))}>Reject match</Button>
    </div>
  </article>;
}

export function ReconciliationReview() {
  const { snap, run, adapter } = useApp();
  const [moodle, setMoodle] = useState("");
  const [syllabus, setSyllabus] = useState("");
  if (!snap?.reconciliation) return null;
  const s = snap;
  const data = s.reconciliation!;
  const pending = data.pairs.filter((p) => p.status === "pending");
  const moodleSources = data.sources.filter((source) => source.kind === "moodle");
  const selected = moodleSources.find((source) => source.id === moodle);
  const selectedAssessment = selected && details(s, selected).a;
  const syllabusSources = data.sources.filter((source) => {
    const a = details(s, source).a;
    return source.kind === "syllabus" && source.courseId === selected?.courseId && a?.type === selectedAssessment?.type;
  });
  const supported = adapter.storage === "backend" || adapter.kind === "extension";
  return <section className="mt-8 space-y-3">
    <h2 className="text-xl font-semibold">Match review ({pending.length})</h2>
    <p className="text-sm text-muted-foreground">Review possible matches separately from extraction. Both original records stay saved.</p>
    {data.sources.some((source) => source.state === "ambiguous") && <p className="text-sm text-destructive">Some source associations have conflicting identifiers. Their original observations are retained and cannot be newly matched until the conflict is resolved.</p>}
    {!supported && <p className="text-sm">Match review requires the local backend; browser demo data stays separate.</p>}
    {pending.map((pair) => {
      const left = data.sources.find((source) => source.id === pair.left);
      const right = data.sources.find((source) => source.id === pair.right);
      return left && right && supported ? <PairCard key={`${pair.id}:${pair.fingerprint}`} pair={pair} s={s} left={left} right={right} /> : null;
    })}
    {supported && moodleSources.length > 0 && <div className="rounded-lg border bg-card p-4 space-y-2">
      <p className="font-medium">Review another pair</p>
      <p className="text-sm text-muted-foreground">Select existing sources from the same course and assessment type, including dates that differ.</p>
      <select aria-label="Moodle source" className="block w-full rounded border bg-card p-2 text-sm" value={moodle} onChange={(e) => { setMoodle(e.target.value); setSyllabus(""); }}>
        <option value="">Choose a Moodle source</option>
        {moodleSources.filter((source) => source.state !== "ambiguous").map((source) => <option key={source.id} value={source.id}>{sourceLabel(s, source)}</option>)}
      </select>
      <select aria-label="Syllabus source" className="block w-full rounded border bg-card p-2 text-sm" value={syllabus} onChange={(e) => setSyllabus(e.target.value)}>
        <option value="">Choose a syllabus source</option>
        {syllabusSources.map((source) => <option key={source.id} value={source.id}>{sourceLabel(s, source)}</option>)}
      </select>
      <Button size="sm" disabled={!moodle || !syllabus} onClick={() => void run((a) => a.proposeReconciliation(moodle, syllabus))}>Review selected pair</Button>
    </div>}
    {data.pairs.some((p) => p.status !== "pending") && <p className="text-sm text-muted-foreground">Decided matches: {data.pairs.filter((p) => p.status === "confirmed").length} confirmed, {data.pairs.filter((p) => p.status === "rejected").length} rejected.</p>}
  </section>;
}
