import { compareSubmicro, instantMicros, sameDate, sortKey } from "./dates";
import { mapTeachingDate, type TeachingMapping } from "./teaching-weeks";
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
  sourceKind?: SourceEvidence["source"];
  week: number | null;
  teachingMapping: TeachingMapping;
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

function newest(sources: SourceEvidence[]): SourceEvidence[] {
  return [...sources].sort((x, y) => {
    const aTime = instantMicros(x.observedAt), bTime = instantMicros(y.observedAt);
    if (aTime !== bTime) return aTime === null ? 1 : bTime === null ? -1 : aTime < bTime ? 1 : -1;
    const fraction = compareSubmicro(x.observedAt, y.observedAt);
    if (fraction) return -fraction;
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

export function latest(sources: SourceEvidence[], src: SourceEvidence["source"]) {
  return newest(sources.filter((s) => s.source === src))[0];
}

export function effectiveSources(snapshot: Snapshot, a: Assessment): SourceEvidence[] {
  const revisions = (snapshot.syllabusRevisions ?? []).filter((s) => resolveAssessmentId(snapshot,s.assessmentId) === resolveAssessmentId(snapshot,a.id));
  const evidence = revisions.length ? a.sources.filter((s) => s.source !== "syllabus") : [...a.sources];
  for (const revision of revisions) {
    const link = revision.links.at(-1);
    const original = snapshot.assessments.find((item) => item.id === link?.assessmentId);
    if (original && link) evidence.push(...original.sources.filter((item) => item.source === "syllabus" && JSON.stringify(item.date) === JSON.stringify(link.date)));
  }
  const sources = (snapshot.reconciliation?.sources ?? []).filter((s) => s.kind === "moodle" && resolveAssessmentId(snapshot, s.assessmentId) === resolveAssessmentId(snapshot, a.id));
  if (!sources.length) return evidence;
  const records = snapshot.collection?.records ?? [];
  const current: SourceEvidence[] = evidence.filter((s) => s.source !== "moodle");
  const candidates: { id: string; evidence: SourceEvidence }[] = [];
  for (const source of sources) {
    const state = snapshot.deadlineStreams?.find((s) => s.sourceId === source.id);
    if (state) {
      if (state.accepted && state.accepted.kind !== "removed" && state.acceptedAt && state.sourceUrl)
        candidates.push({ id: source.id, evidence: { source: "moodle", date: state.accepted, observedAt: state.acceptedAt, url: state.sourceUrl } });
      continue;
    }
    if (source.state === "ambiguous") continue;
    const record = records.find((r) => r.id === source.recordId);
    const urls = record && "observations" in record ? record.observations.map((o) => "sourceUrl" in o ? o.sourceUrl : undefined) : [];
    for (const evidence of a.sources.filter((e) => e.source === "moodle" && e.url && urls.includes(e.url))) {
      const owners = sources.filter((other) => {
        const otherRecord = records.find((r) => r.id === other.recordId);
        return otherRecord?.observations.some((o) => "sourceUrl" in o && o.sourceUrl === evidence.url);
      });
      if (owners.length === 1) candidates.push({ id: source.id, evidence });
    }
  }
  candidates.sort((a, b) => {
    const x = instantMicros(a.evidence.observedAt), y = instantMicros(b.evidence.observedAt);
    if (x !== y) return x === null ? 1 : y === null ? -1 : x > y ? -1 : 1;
    const fraction = compareSubmicro(a.evidence.observedAt, b.evidence.observedAt);
    if (fraction) return -fraction;
    return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
  });
  if (candidates[0]) current.push(candidates[0].evidence);
  return current;
}

export function isOutstanding(a: Assessment, o?: Overlay): boolean {
  if (o?.hidden) return false;
  const st = a.submission?.status;
  if (st === "draft" || st === "reopened") return true;
  if (o?.completed) return false;
  return st !== "submitted";
}

export function viewAssessment(a: Assessment, o: Overlay | undefined, s: Settings, snapshot?: Snapshot): AssessmentView {
  const sources = snapshot ? effectiveSources(snapshot, a) : a.sources;
  const sourceDate = sources.length ? reconciledSourceDate(sources) : { kind: "unknown" as const };
  const date = o?.dateOverride ?? sourceDate;
  const m = latest(sources, "moodle");
  const sy = latest(sources, "syllabus");
  const conflict = m && sy && m.date.kind !== "unknown" && sy.date.kind !== "unknown" && !sameDate(m.date, sy.date)
    ? { moodle: m.date, syllabus: sy.date, comparison: m.date.kind === sy.date.kind ? "different" as const : "incomparable" as const }
    : undefined;
  const removedBaseline = snapshot && o?.overrideBase && snapshot.changes.some((change) =>
    resolveAssessmentId(snapshot, change.assessmentId) === resolveAssessmentId(snapshot, a.id) &&
    change.to.kind === "removed" && change.from.kind !== "removed" && sameDate(change.from, o.overrideBase!) &&
    snapshot.deadlineStreams?.some((stream) => stream.sourceId === change.sourceId && stream.accepted?.kind === "removed"));
  const overrideDisagreement =
    o?.dateOverride && o.overrideBase && (!sameDate(o.overrideBase, sourceDate) || removedBaseline)
      ? { was: o.overrideBase, now: sourceDate }
      : undefined;
  const st = a.submission?.status;
  const teachingMapping = mapTeachingDate(date, s.teachingCalendar);
  return {
    a,
    overlay: o,
    title: o?.titleOverride || a.title,
    date,
    sourceDate,
    sourceKind: m?.date.kind !== "unknown" && m ? "moodle" : sy?.date.kind !== "unknown" && sy ? "syllabus" : undefined,
    week: teachingMapping.resolved ? teachingMapping.week : null,
    teachingMapping,
    conflict,
    overrideDisagreement,
    hidden: !!o?.hidden,
    completed: !!o?.completed,
    outstanding: isOutstanding(a, o),
    needsAttention: !o?.hidden && (st === "draft" || st === "reopened"),
    sort: date.kind === "week" ? teachingMapping.resolved ? Date.parse(teachingMapping.start) : Infinity : sortKey(date, s.semesterStart),
  };
}

export function viewAll(as: Assessment[], overlays: Overlay[], s: Settings, snapshot?: Snapshot): AssessmentView[] {
  const byId = new Map(overlays.map((o) => [o.assessmentId, o]));
  return as
    .filter((a) => s.trackedCourseIds.includes(a.courseId) || a.personal)
    .map((a) => viewAssessment(a, byId.get(a.id), s, snapshot))
    .sort((x, y) => x.sort - y.sort);
}
