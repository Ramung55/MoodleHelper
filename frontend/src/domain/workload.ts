import { resolveAssessmentId, viewAssessment, type AssessmentView } from "./assessments";
import type { Settings, Snapshot } from "./types";
import { teachingSlots } from "./teaching-weeks";

export interface WorkloadTotals { total: number; outstanding: number; weighted: number }
export interface WeekLoad extends WorkloadTotals { week: number; items: AssessmentView[]; overloaded: boolean }
export interface WeeklyWorkload { weeks: WeekLoad[]; unallocated: AssessmentView[]; unallocatedSummary: WorkloadTotals }
export const WEIGHT_ERROR = "Workload weights must include finite, nonnegative numbers for exam, assignment, quiz and other.";
export const OVERFLOW_ERROR = "Workload total exceeds the supported numeric range. Lower the configured weights.";
const kinds = ["exam", "assignment", "quiz", "other"] as const;
export function weightsError(weights: unknown): string | null {
  return !weights || typeof weights !== "object" || kinds.some(kind => typeof (weights as any)[kind] !== "number" || !Number.isFinite((weights as any)[kind]) || (weights as any)[kind] < 0) ? WEIGHT_ERROR : null;
}
export function weightOf(v: AssessmentView, s: Settings): number {
  const error = weightsError(s.weights); if (error) throw new Error(error);
  return s.weights[v.a.type];
}
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${fingerprint(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function uniqueProjection<T>(items: T[] | undefined, key: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items ?? []) {
    const id = key(item), previous = result.get(id);
    if (previous && fingerprint(previous) !== fingerprint(item)) throw new Error(`Conflicting canonical projection for assessment ${id}. Refresh reconciliation before calculating workload.`);
    result.set(id, item);
  }
  return result;
}
/** Recompute dates/eligibility; caller-supplied derived flags are not authority. */
export function canonicalWorkloadViews(views: AssessmentView[], s: Settings, snapshot?: Snapshot): AssessmentView[] {
  const authoritative = uniqueProjection(snapshot?.reconciliation?.logicalAssessments, item => item.id);
  const overlays = uniqueProjection(snapshot?.reconciliation?.logicalOverlays, item => item.assessmentId);
  const byId = new Map<string, { value: AssessmentView; fingerprint: string }>();
  for (const input of views) {
    const id = snapshot ? resolveAssessmentId(snapshot, input.a.id) : input.a.id;
    const assessment = authoritative.get(id) ?? input.a;
    if (assessment.id !== id) throw new Error(`Canonical assessment ${id} is unavailable. Refresh reconciliation before calculating workload.`);
    const overlay = authoritative.has(id) ? overlays.get(id) : input.overlay;
    const identity = fingerprint({ assessment, overlay });
    const previous = byId.get(id);
    if (previous && previous.fingerprint !== identity) throw new Error(`Conflicting records for assessment ${id}. Refresh reconciliation before calculating workload.`);
    if (!previous) byId.set(id, { value: viewAssessment(assessment, overlay, s, snapshot), fingerprint: identity });
  }
  return [...byId].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, item]) => item.value);
}
/** Dimensionless estimates, not hours. Canonical ID ordering fixes fractional accumulation order. */
export function weeklyLoad(views: AssessmentView[], s: Settings, snapshot?: Snapshot): WeeklyWorkload {
  const error = weightsError(s.weights); if (error) throw new Error(error);
  const map = new Map<number, WeekLoad>();
  const unallocated: AssessmentView[] = [], unallocatedSummary = { total: 0, outstanding: 0, weighted: 0 };
  for (const slot of s.teachingCalendar ? teachingSlots(s.teachingCalendar) : []) {
    if (slot.week !== null) map.set(slot.week, { week: slot.week, total: 0, outstanding: 0, weighted: 0, items: [], overloaded: false });
  }
  const add = (totals: WorkloadTotals, value: AssessmentView) => {
    totals.total++;
    if (value.outstanding) {
      totals.outstanding++; totals.weighted += s.weights[value.a.type];
      if (!Number.isFinite(totals.weighted)) throw new Error(OVERFLOW_ERROR);
    }
  };
  for (const value of canonicalWorkloadViews(views, s, snapshot)) {
    if (value.hidden) continue;
    const slot = value.week === null ? undefined : map.get(value.week);
    if (!slot) { unallocated.push(value); add(unallocatedSummary, value); }
    else { slot.items.push(value); add(slot, value); }
  }
  const weeks = [...map.values()].map(value => ({ ...value, overloaded: value.outstanding > s.thresholds.maxOutstanding || value.weighted > s.thresholds.maxWeighted }));
  return { weeks, unallocated, unallocatedSummary };
}
