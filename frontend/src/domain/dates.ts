import type { DateValue } from "./types";

const DAY = 86_400_000;

function parseYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function toYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Teaching week (1-based) for a calendar day, or null if before semester start. */
export function weekOfYmd(ymd: string, semesterStart: string): number | null {
  const diff = Math.floor((parseYmd(ymd) - parseYmd(semesterStart)) / DAY);
  if (diff < 0) return null;
  return Math.floor(diff / 7) + 1;
}

/** Calendar day of an exact timestamp in the display timezone. */
export function ymdInTz(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return parts;
}

export function weekOf(d: DateValue, semesterStart: string, tz: string): number | null {
  switch (d.kind) {
    case "exact":
      return weekOfYmd(ymdInTz(d.iso, tz), semesterStart);
    case "date":
      return weekOfYmd(d.date, semesterStart);
    case "week":
      return d.week;
    case "unknown":
      return null;
  }
}

/** Sort key; week-only items sort at the start of their week, unknown last. */
export function sortKey(d: DateValue, semesterStart: string): number {
  switch (d.kind) {
    case "exact":
      return Date.parse(d.iso);
    case "date":
      return parseYmd(d.date) + DAY - 1;
    case "week":
      return parseYmd(semesterStart) + (d.week - 1) * 7 * DAY;
    case "unknown":
      return Number.MAX_SAFE_INTEGER;
  }
}

export function sameDate(a: DateValue | undefined, b: DateValue | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "exact" && b.kind === "exact") {
    const left = Date.parse(a.iso), right = Date.parse(b.iso);
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function formatDate(d: DateValue, tz: string): string {
  switch (d.kind) {
    case "exact":
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(d.iso));
    case "date":
      return (
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "UTC",
          weekday: "short",
          day: "numeric",
          month: "short",
        }).format(new Date(parseYmd(d.date))) + " (no time)"
      );
    case "week":
      return `Week ${d.week} (no exact date)`;
    case "unknown":
      return d.note ? `Date unknown — ${d.note}` : "Date unknown";
  }
}

export function weekRange(week: number, semesterStart: string): { start: string; end: string } {
  const s = parseYmd(semesterStart) + (week - 1) * 7 * DAY;
  return { start: toYmd(s), end: toYmd(s + 6 * DAY) };
}
