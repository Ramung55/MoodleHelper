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
    // Hidden items are ineligible for new reminders of any kind, including source-change notices.
    if (v?.hidden) continue;
    push({
      kind: "change",
      assessmentId: c.assessmentId,
      message: `${v?.title ?? "An assessment"} moved from ${c.from.kind === "removed" ? "removed" : formatDate(c.from, s.timezone)} to ${c.to.kind === "removed" ? "removed" : formatDate(c.to, s.timezone)}`,
      deliveryKey: `change:${c.id}`,
    });
  }
  return out;
}

/** #39 precision-preserving change wording; mirrors backend alert_delivery.assertion_text. */
export function describeAssertion(value: DeadlineChange["from"] | undefined): string {
  if (!value) return "unknown date";
  if (value.kind === "removed") return "deadline removed";
  if (value.kind === "date") return `${value.date} (date only, no time given)`;
  if (value.kind === "week") return `teaching week ${value.week} (week only)`;
  if (value.kind === "exact") {
    const at = Date.parse(value.iso);
    if (!Number.isFinite(at)) return "unknown date";
    let zone = value.tz || "UTC";
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    } catch {
      zone = "UTC";
      parts = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    }
    const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")} ${zone}`;
  }
  return "unknown date";
}

export type AlertDestination =
  | { to: "/deadlines"; id: string }
  | { to: "/planner" }
  | { to: "/alerts" };

/** Closed destination resolver shared by in-dashboard clicks and the extension worker mapping. */
export function alertDestination(alert: Alert, resolve: (id: string) => string): AlertDestination {
  const ctx = alert.context;
  const target = ctx?.assessmentId ?? alert.assessmentId;
  if (ctx?.destination === "week") return { to: "/planner" };
  if ((!ctx || ctx.destination === "assessment") && target) return { to: "/deadlines", id: resolve(target) };
  return { to: "/alerts" };
}

export const DELIVERY_DISABLED_TEXT = "Browser notifications disabled; alerts remain here.";

/** Truthful delivery wording: a request is never claimed as an OS display. */
export function deliveryLabel(alert: Alert): string | null {
  const d = alert.delivery;
  if (!d) return null;
  switch (d.state) {
    case "pending": return "Browser notification pending (Chrome extension)";
    case "issued": return "Browser notification outcome unknown";
    case "shown": return "Sent to Chrome notifications";
    case "denied": return DELIVERY_DISABLED_TEXT;
    case "failed": return "Browser notification failed; alert kept here";
    case "unknown": return "Browser notification outcome unknown";
    default:
      return d.errorCode === "disabled" ? "Notifications are off; dashboard only"
        : d.errorCode === "ineligible" ? "Hidden or done; dashboard only"
        : d.errorCode === "stale" ? "Missed while Chrome was closed; dashboard only" : "Dashboard only";
  }
}
