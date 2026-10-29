import type { AssessmentView } from "./assessments";
import type { Settings } from "./types";
import { teachingSlots } from "./teaching-weeks";

export interface WeekLoad {
  week: number;
  total: number;
  outstanding: number;
  weighted: number;
  items: AssessmentView[];
  overloaded: boolean;
}

export function weightOf(v: AssessmentView, s: Settings): number {
  return s.weights[v.a.type];
}

/**
 * Weighted workload per teaching week. Estimates, not study hours.
 * Hidden items are excluded; reconciled duplicates are already a single assessment.
 */
export function weeklyLoad(views: AssessmentView[], s: Settings): { weeks: WeekLoad[]; unallocated: AssessmentView[] } {
  const map = new Map<number, WeekLoad>();
  const unallocated: AssessmentView[] = [];
  for (const slot of s.teachingCalendar ? teachingSlots(s.teachingCalendar) : []) {
    const w = slot.week;
    if (w === null) continue;
    map.set(w, { week: w, total: 0, outstanding: 0, weighted: 0, items: [], overloaded: false });
  }
  for (const v of views) {
    if (v.hidden) continue;
    if (v.week == null || !map.has(v.week)) {
      unallocated.push(v);
      continue;
    }
    const wl = map.get(v.week)!;
    wl.total++;
    wl.items.push(v);
    if (v.outstanding) {
      wl.outstanding++;
      wl.weighted += weightOf(v, s);
    }
  }
  const weeks = [...map.values()].map((w) => ({
    ...w,
    overloaded: w.outstanding > s.thresholds.maxOutstanding || w.weighted > s.thresholds.maxWeighted,
  }));
  return { weeks, unallocated };
}
