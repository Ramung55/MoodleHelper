import type { AssessmentView } from "./assessments";
import { formatDate } from "./dates";
import type { WeekLoad } from "./workload";
import type { Alert, DeadlineChange, Settings } from "./types";

/**
 * Compute alerts that are eligible now. A stable deliveryKey means unchanged facts never notify twice.
 * Week-only and unknown dates never receive exact-deadline reminders.
 */
export function eligibleAlerts(
  views: AssessmentView[],
  weeks: WeekLoad[],
  changes: DeadlineChange[],
  s: Settings,
  now: number,
  existing: Alert[],
): Alert[] {
  if (!s.reminders.enabled) return [];
  const seen = new Set(existing.map((a) => a.deliveryKey));
  const out: Alert[] = [];
  const push = (a: Omit<Alert, "id" | "createdAt" | "read">) => {
    if (seen.has(a.deliveryKey)) return;
    seen.add(a.deliveryKey);
    out.push({ ...a, id: `al-${a.deliveryKey}`, createdAt: new Date(now).toISOString(), read: false });
  };

  for (const v of views) {
    if (!v.outstanding || v.hidden) continue;
    if (v.date.kind !== "exact" && v.date.kind !== "date") continue;
    const due = v.date.kind === "exact" ? Date.parse(v.date.iso) : Date.parse(`${v.date.date}T23:59:00Z`);
    const hours = (due - now) / 3_600_000;
    if (hours > 0 && hours <= s.reminders.hoursBefore) {
      push({
        kind: "deadline",
        assessmentId: v.a.id,
        message: `${v.title} is due ${formatDate(v.date, s.timezone)}`,
        deliveryKey: `deadline:${v.a.id}:${JSON.stringify(v.date)}:${s.reminders.hoursBefore}`,
      });
    }
  }
  if (s.reminders.busyWeek) {
    for (const w of weeks) {
      if (!w.overloaded) continue;
      push({
        kind: "busy_week",
        message: `Week ${w.week} looks busy: ${w.outstanding} outstanding, weighted ${w.weighted}`,
        deliveryKey: `busy:${w.week}:${w.outstanding}:${w.weighted}`,
      });
    }
  }
  for (const c of changes) {
    const v = views.find((x) => x.a.id === c.assessmentId);
    push({
      kind: "change",
      assessmentId: c.assessmentId,
      message: `${v?.title ?? "An assessment"} moved from ${c.from.kind === "removed" ? "removed" : formatDate(c.from, s.timezone)} to ${c.to.kind === "removed" ? "removed" : formatDate(c.to, s.timezone)}`,
      deliveryKey: `change:${c.id}`,
    });
  }
  return out;
}
