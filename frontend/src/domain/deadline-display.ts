import type { AssessmentView } from "./assessments";
import { formatDate } from "./dates";
import type { DateValue, Snapshot } from "./types";

/** Read-only SDU Moodle origin used by ingestion (backend/identity.py MOODLE_ORIGIN). */
export const SDU_ORIGIN = "https://moodle.sdu.edu.kz";
const SOURCE_ROUTE = /^\/(?:course|mod\/(?:assign|quiz|resource|folder|url))\/view\.php$/;

/**
 * Display-boundary revalidation of a source link (#35). Mirrors the ingestion
 * policy for stable activity/course routes: HTTPS SDU origin, no userinfo,
 * port, fragment, whitespace or extra (possibly session-bearing) query params.
 * Returns null when the link must not be rendered as an href.
 */
export function safeSourceHref(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(raw)) return null;
  if (!raw.startsWith(`${SDU_ORIGIN}/`)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "moodle.sdu.edu.kz" || url.username || url.password || url.port || url.hash || raw.includes("#")) return null;
  if (!SOURCE_ROUTE.test(url.pathname) || !/^\?id=[1-9][0-9]{0,17}$/.test(url.search)) return null;
  return url.href === raw ? raw : null;
}

/** JSON replacer that never echoes unsafe link strings from raw observations. */
export function redactUnsafeLinks(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:|^\/\//i.test(value) && !safeSourceHref(value)) return "[link unavailable]";
  return value;
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}

function validYmd(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === ymd;
}

/** True when a date value cannot be shown or compared (legacy/corrupt data). */
export function invalidDate(d: DateValue): boolean {
  if (d.kind === "exact") return !Number.isFinite(Date.parse(d.iso)) || !validTimeZone(d.tz);
  if (d.kind === "date") return !validYmd(d.date);
  if (d.kind === "week") return !Number.isInteger(d.week) || d.week < 1;
  return false;
}

/** Never throws: invalid legacy values show as unavailable instead of crashing or becoming today. */
export function displayDate(d: DateValue, tz: string): string {
  if (invalidDate(d) || !validTimeZone(tz)) return "Invalid date (unavailable)";
  try { return formatDate(d, tz); } catch { return "Invalid date (unavailable)"; }
}

function todayIn(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type DueState =
  | { kind: "overdue"; label: string }
  | { kind: "date_passed"; label: string }
  | { kind: "week_passed"; label: string }
  | { kind: "invalid"; label: string };

/**
 * Precision-aware overdue (#35 AC3). Independent of source freshness.
 * - exact: overdue only after the instant
 * - date-only: "date passed; time unspecified" after the literal day elapsed in the display zone
 * - week: only "past teaching week" when the map is resolved; never an exact overdue badge
 * - unknown: nothing
 */
export function dueState(v: Pick<AssessmentView, "date" | "teachingMapping" | "outstanding">, tz: string, now: Date): DueState | null {
  const d = v.date;
  if (invalidDate(d) || !validTimeZone(tz)) return { kind: "invalid", label: "Invalid date" };
  if (!v.outstanding) return null;
  if (d.kind === "exact") return now.getTime() > Date.parse(d.iso) ? { kind: "overdue", label: "Overdue" } : null;
  if (d.kind === "date") return todayIn(now, tz) > d.date ? { kind: "date_passed", label: "Date passed; time unspecified" } : null;
  if (d.kind === "week" && v.teachingMapping.resolved && validTimeZone(v.teachingMapping.timezone))
    return todayIn(now, v.teachingMapping.timezone) > v.teachingMapping.end ? { kind: "week_passed", label: `Past teaching week ${d.week}` } : null;
  return null;
}

function fmtInstant(iso: string | undefined, tz: string): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso)) || !validTimeZone(tz)) return null;
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export type Freshness = { stale: boolean; label: string };

/**
 * Source freshness from persisted evidence only (#35 AC4): last valid source
 * observation, the course sync state and failed page refreshes for this item's
 * source URLs. No universal age threshold and no guessed fresh timestamp.
 */
export function sourceFreshness(v: AssessmentView, snap: Snapshot, tz: string): Freshness | null {
  if (v.a.personal) return null;
  const times = v.a.sources.filter((s) => s.source !== "personal").map((s) => s.observedAt).filter((t) => Number.isFinite(Date.parse(t)));
  const last = times.sort((x, y) => Date.parse(y) - Date.parse(x))[0];
  const lastText = fmtInstant(last, tz);
  if (!lastText) return { stale: false, label: "Freshness unknown — no valid observation time" };
  const urls = new Set(v.a.sources.map((s) => s.url).filter(Boolean));
  const failedRefresh = (snap.collection?.refreshes ?? [])
    .filter((r) => urls.has(r.pageUrl) && Number.isFinite(Date.parse(r.observedAt)) && Date.parse(r.observedAt) > Date.parse(last))
    .sort((x, y) => Date.parse(y.observedAt) - Date.parse(x.observedAt))[0];
  if (failedRefresh && (failedRefresh.outcome === "failed" || failedRefresh.outcome === "unavailable"))
    return { stale: true, label: `Stale — last observed ${lastText}; refresh ${failedRefresh.outcome} ${fmtInstant(failedRefresh.observedAt, tz)}` };
  const sync = snap.sync.find((s) => s.courseId === v.a.courseId);
  if (sync && (sync.status === "failed" || sync.status === "partial")) {
    const ok = fmtInstant(sync.lastSuccessAt, tz);
    return { stale: true, label: `Stale — last observed ${lastText}; latest sync ${sync.status}${ok ? `, last successful sync ${ok}` : ", no successful sync recorded"}` };
  }
  if (!sync || sync.status === "never") return { stale: false, label: `Last observed ${lastText}; freshness unknown` };
  return { stale: false, label: `Last observed ${lastText}` };
}

export type Group = { key: string; label: string; detail?: string; order: number };

/** Week grouping uses the resolved #30 interval; everything else is an explicit unresolved category. */
export function weekGroup(v: AssessmentView): Group {
  if (invalidDate(v.date)) return { key: "invalid", label: "Invalid date", order: Infinity };
  if (v.teachingMapping.resolved) return { key: `w${v.teachingMapping.week}`, label: `Week ${v.teachingMapping.week}`, detail: `${v.teachingMapping.start} – ${v.teachingMapping.end}`, order: v.teachingMapping.week };
  if (v.date.kind === "unknown") return { key: "unknown", label: "No date", order: 1e9 + 1 };
  return { key: "unresolved", label: "Unresolved week", detail: "Teaching calendar does not map these dates", order: 1e9 };
}

/** Day grouping keeps exact / date-only / week-only / unknown distinct; never a fabricated midnight. */
export function dayGroup(v: AssessmentView, tz: string): Group {
  const d = v.date;
  if (invalidDate(d) || (d.kind === "exact" && !validTimeZone(tz))) return { key: "invalid", label: "Invalid date", order: Infinity };
  if (d.kind === "exact") {
    const ymd = todayIn(new Date(d.iso), tz);
    const label = new Date(d.iso).toLocaleDateString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
    return { key: `e${ymd}`, label, detail: `Exact time · ${tz}`, order: Date.parse(`${ymd}T00:00:00Z`) };
  }
  if (d.kind === "date") {
    const label = new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
    return { key: `d${d.date}`, label: `${label} · no time`, order: Date.parse(`${d.date}T00:00:00Z`) + 1 };
  }
  if (d.kind === "week") {
    const m = v.teachingMapping;
    return { key: `w${d.week}`, label: `Week ${d.week} · no exact day`, detail: m.resolved ? `${m.start} – ${m.end}` : undefined, order: m.resolved ? Date.parse(`${m.start}T00:00:00Z`) + 2 : 1e15 + d.week };
  }
  return { key: "unknown", label: "Date unknown", order: 1e16 };
}

export const STATUS_FILTERS = ["outstanding", "attention", "done", "hidden"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Hidden items appear only under the explicit Hidden filter. */
export function matchStatus(v: AssessmentView, st?: string): boolean {
  if (st === "hidden") return v.hidden;
  if (v.hidden) return false;
  switch (st) {
    case "outstanding": return v.outstanding;
    case "attention": return v.needsAttention;
    case "done": return v.completed || v.a.submission?.status === "submitted";
    default: return true;
  }
}
