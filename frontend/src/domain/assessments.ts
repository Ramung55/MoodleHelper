import { sameDate, sortKey, weekOf } from "./dates";
import type { Assessment, DateValue, Overlay, Settings, SourceEvidence } from "./types";

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
  conflict?: { moodle: DateValue; syllabus: DateValue };
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

/** For confirmed matches Moodle's date has priority over the syllabus date. */
export function reconciledSourceDate(sources: SourceEvidence[]): DateValue {
  const sorted = [...sources].sort((x, y) => {
    const p = PRIORITY[x.source] - PRIORITY[y.source];
    if (p !== 0) return p;
    // within a source, the latest observation wins
    return Date.parse(y.observedAt) - Date.parse(x.observedAt);
  });
  const newest = sorted.filter((s, i) => sorted.findIndex((x) => x.source === s.source) === i);
  return (newest.find((s) => s.date.kind !== "unknown") ?? newest[0]).date;
}

function latest(sources: SourceEvidence[], src: SourceEvidence["source"]) {
  return sources
    .filter((s) => s.source === src)
    .sort((x, y) => Date.parse(y.observedAt) - Date.parse(x.observedAt))[0];
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
  const conflict = m && sy && m.date.kind !== "unknown" && sy.date.kind !== "unknown" && !sameDate(m.date, sy.date) ? { moodle: m.date, syllabus: sy.date } : undefined;
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
