import { instantMicros, sameDate, sortKey, weekOf } from "./dates";
import type { Assessment, DateValue, Overlay, Settings, SourceEvidence, Snapshot } from "./types";

export function resolveAssessmentId(snapshot: Snapshot, id: string): string {
  return snapshot.reconciliation?.aliases.find((alias) => alias.originalId === id)?.canonicalId ?? id;
}

export interface AssessmentView {
  a: Assessment;
  overlay?: Overlay;
  title: string;
  /** Date shown to the student (override wins for display) */
  date: DateValue;
  /** Reconciled source date: Moodle beats syllabus */
  sourceDate: DateValue;
  week: number | null;
  /** Moodle and syllabus disagree */
  conflict?: { moodle: DateValue; syllabus: DateValue; comparison: "different" | "incomparable" };
  /** Source date moved after the student set an override */
  overrideDisagreement?: { was: DateValue; now: DateValue };
  hidden: boolean;
  completed: boolean;
  outstanding: boolean;
  /** Draft or reopened stays visible even if personally completed */
  needsAttention: boolean;
  sort: number;
}

const PRIORITY: Record<SourceEvidence["source"], number> = { moodle: 0, syllabus: 1, personal: 2 };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${canonical(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function observed(source: SourceEvidence): number {
  return instantMicros(source.observedAt) ?? Number.NEGATIVE_INFINITY;
}

function newest(sources: SourceEvidence[]): SourceEvidence[] {
  return [...sources].sort((x, y) => {
    const difference = observed(y) - observed(x);
    if (Number.isFinite(difference) && difference !== 0) return difference;
    if (observed(x) !== observed(y)) return observed(y) > observed(x) ? 1 : -1;
    const a = canonical(x), b = canonical(y);
    return a === b ? 0 : a < b ? 1 : -1;
  });
}

/** For confirmed matches Moodle's date has priority over the syllabus date. */
export function reconciledSourceDate(sources: SourceEvidence[]): DateValue {
  const sorted = newest(sources).sort((x, y) => PRIORITY[x.source] - PRIORITY[y.source]);
  const perSource = sorted.filter((s, i) => sorted.findIndex((x) => x.source === s.source) === i);
  return (perSource.find((s) => s.date.kind !== "unknown") ?? perSource[0]).date;
}

function latest(sources: SourceEvidence[], src: SourceEvidence["source"]) {
  return newest(sources.filter((s) => s.source === src))[0];
}

export function isOutstanding(a: Assessment, o?: Overlay): boolean {
  if (o?.hidden) return false;
  const st = a.submission?.status;
  if (st === "draft" || st === "reopened") return true;
  if (o?.completed) return false;
  return st !== "submitted";
}

export function viewAssessment(a: Assessment, o: Overlay | undefined, s: Settings): AssessmentView {
  const sourceDate = reconciledSourceDate(a.sources);
  const date = o?.dateOverride ?? sourceDate;
  const m = latest(a.sources, "moodle");
  const sy = latest(a.sources, "syllabus");
  const conflict = m && sy && m.date.kind !== "unknown" && sy.date.kind !== "unknown" && !sameDate(m.date, sy.date)
    ? { moodle: m.date, syllabus: sy.date, comparison: m.date.kind === sy.date.kind ? "different" as const : "incomparable" as const }
    : undefined;
  const overrideDisagreement =
    o?.dateOverride && o.overrideBase && !sameDate(o.overrideBase, sourceDate)
      ? { was: o.overrideBase, now: sourceDate }
      : undefined;
  const st = a.submission?.status;
  return {
    a,
    overlay: o,
    title: o?.titleOverride || a.title,
    date,
    sourceDate,
    week: weekOf(date, s.semesterStart, s.timezone),
    conflict,
    overrideDisagreement,
    hidden: !!o?.hidden,
    completed: !!o?.completed,
    outstanding: isOutstanding(a, o),
    needsAttention: !o?.hidden && (st === "draft" || st === "reopened"),
    sort: sortKey(date, s.semesterStart),
  };
}

export function viewAll(as: Assessment[], overlays: Overlay[], s: Settings): AssessmentView[] {
  const byId = new Map(overlays.map((o) => [o.assessmentId, o]));
  return as
    .filter((a) => s.trackedCourseIds.includes(a.courseId) || a.personal)
    .map((a) => viewAssessment(a, byId.get(a.id), s))
    .sort((x, y) => x.sort - y.sort);
}
