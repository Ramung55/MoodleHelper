import type { DateValue } from "./types";

export function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function zonedInput(iso: string, timezone: string): string {
  // Invalid, unfinished user input remains editable rather than being normalized.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return iso;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
    const part = (key: string) => parts.find((p) => p.type === key)?.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  } catch { return ""; }
}

/** Resolve wall-clock input in the configured zone, independent of browser timezone. */
export function zonedInstant(local: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || !calendarDate(local.slice(0, 10))) return null;
  const wall = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== local) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    const candidates = new Set<number>();
    // Sampling both sides of a transition finds either applicable UTC offset.
    for (let hour = -36; hour <= 36; hour += 6) {
      const sample = wall + hour * 3_600_000;
      const displayed = Date.parse(`${zonedInput(new Date(sample).toISOString(), timezone)}:00Z`);
      candidates.add(wall - (displayed - sample));
    }
    const matches = [...candidates].filter((instant) => zonedInput(new Date(instant).toISOString(), timezone) === local).sort((a, b) => a - b);
    return matches.length ? new Date(matches[0]!).toISOString() : null;
  } catch { return null; }
}

export function personalDateError(date: DateValue | undefined): string | null {
  if (!date || date.kind === "unknown") return "Choose a date, date and time, or teaching week.";
  if (date.kind === "date") return calendarDate(date.date) ? null : "Enter a real calendar date.";
  if (date.kind === "week") return Number.isInteger(date.week) && date.week >= 1 && date.week <= 30 ? null : "Enter a whole teaching week from 1 to 30.";
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(date.iso) || !calendarDate(date.iso.slice(0, 10)) || !Number.isFinite(Date.parse(date.iso))) return "Enter a valid date and time that exists in the selected timezone.";
  try { new Intl.DateTimeFormat("en", { timeZone: date.tz }); } catch { return "Choose a valid timezone in Settings."; }
  return null;
}
