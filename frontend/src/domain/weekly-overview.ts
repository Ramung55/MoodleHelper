import type { AssessmentView } from "./assessments";
import type { Settings } from "./types";
import type { WeekLoad } from "./workload";

/** Documented product defaults (#37). Displayed, never applied over saved custom values. */
export const WORKLOAD_DEFAULTS = { weights: { exam: 3, assignment: 2, quiz: 1, other: 0 }, thresholds: { maxOutstanding: 5, maxWeighted: 10 } } as const;

/** Inspectable reason for an item's contribution, mirroring #36 precedence (no recalculation). */
export function contributionReason(v: AssessmentView): string {
  const status = v.a.submission?.status;
  if (v.outstanding) {
    if (v.needsAttention) return `Counts as outstanding: Moodle status "${status?.replace("_", " ")}" takes precedence over personal completion.`;
    return "Counts as outstanding: not submitted or marked complete.";
  }
  if (status === "submitted") return "Counted in total only: submitted in Moodle, not outstanding.";
  if (v.completed) return "Counted in total only: marked personally complete, not outstanding.";
  return "Counted in total only: not outstanding.";
}

export function precisionLabel(v: AssessmentView): string {
  const labels: Record<string, string> = { exact: "exact time", date: "date only", week: "week only", unknown: "unknown date" };
  return labels[v.date.kind] ?? v.date.kind;
}

/** Reason an item is outside every teaching week. Never invents week 0 or midnight. */
export function unallocatedReason(v: AssessmentView): string {
  if (v.date.kind === "unknown") return "Unknown date";
  if (!v.teachingMapping.resolved) return v.teachingMapping.reason;
  return "Outside the configured teaching weeks";
}

/** Busy iff strictly above either threshold; returns text reasons (not color alone). */
export function busyReasons(w: Pick<WeekLoad, "outstanding" | "weighted">, t: Settings["thresholds"]): string[] {
  const reasons: string[] = [];
  if (w.outstanding > t.maxOutstanding) reasons.push(`${w.outstanding} outstanding is above the threshold of ${t.maxOutstanding}`);
  if (w.weighted > t.maxWeighted) reasons.push(`weighted estimate ${w.weighted} is above the threshold of ${t.maxWeighted}`);
  return reasons;
}

export type WorkloadDraft = { exam: string; assignment: string; quiz: string; other: string; maxOutstanding: string; maxWeighted: string };
export type WorkloadDraftErrors = Partial<Record<keyof WorkloadDraft, string>>;
export function draftFrom(s: Pick<Settings, "weights" | "thresholds">): WorkloadDraft {
  return { exam: String(s.weights.exam), assignment: String(s.weights.assignment), quiz: String(s.weights.quiz), other: String(s.weights.other), maxOutstanding: String(s.thresholds.maxOutstanding), maxWeighted: String(s.thresholds.maxWeighted) };
}
const parse = (text: string): number | null => { const t = text.trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
/** Validates without coercion: blank, negative, nonfinite or non-numeric text is a field error. */
export function validateDraft(d: WorkloadDraft): { errors: WorkloadDraftErrors; value?: Pick<Settings, "weights" | "thresholds"> } {
  const errors: WorkloadDraftErrors = {}; const n: Record<string, number> = {};
  for (const key of Object.keys(d) as (keyof WorkloadDraft)[]) {
    const value = parse(d[key]);
    if (value === null) errors[key] = d[key].trim() ? "Enter a finite number." : "Required.";
    else if (value < 0) errors[key] = "Must be zero or more.";
    else if (key === "maxOutstanding" && !Number.isInteger(value)) errors[key] = "Must be a whole number.";
    else n[key] = value;
  }
  if (Object.keys(errors).length) return { errors };
  return { errors, value: { weights: { exam: n.exam, assignment: n.assignment, quiz: n.quiz, other: n.other }, thresholds: { maxOutstanding: n.maxOutstanding, maxWeighted: n.maxWeighted } } };
}
