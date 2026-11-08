import type { DateValue } from "./types";

const DAY = 86_400_000;

function parseYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  // String.split always returns at least one element, so y is always defined.
  return Date.UTC(y!, Number(m) - 1, d);
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

/** Parse an explicitly zoned instant without dropping sub-millisecond precision. */
export function instantMicros(iso: string): bigint | null {
  // Match Python's datetime.fromisoformat forms, including compact dates,
  // week dates, arbitrary single-character separators and offset seconds.
  const match =
    /^(\d{4})(?:(-?)(\d{2})\2(\d{2})|(-?)W(\d{2})(?:\5(\d))?)(.)(\d{2})(?:(:?)(\d{2})(?:\10(\d{2}))?)?(?:[.,](\d+))?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?(?:[.,]\d+)?)$/.exec(
      iso,
    );
  if (!match) return null;
  const year = Number(match[1]),
    hour = Number(match[9]),
    minute = Number(match[11] ?? 0),
    second = Number(match[12] ?? 0);
  if (year < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const day = new Date(0);
  day.setUTCHours(0, 0, 0, 0);
  if (match[6]) {
    const week = Number(match[6]),
      weekday = Number(match[7] ?? 1);
    if (week < 1 || week > 53 || weekday < 1 || weekday > 7) return null;
    day.setUTCFullYear(year, 0, 4);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + (week - 1) * 7 + weekday - 1);
    const thursday = new Date(day);
    thursday.setUTCDate(day.getUTCDate() + 4 - weekday);
    if (thursday.getUTCFullYear() !== year) return null;
  } else {
    const month = Number(match[3]),
      date = Number(match[4]);
    day.setUTCFullYear(year, month - 1, date);
    if (
      day.getUTCFullYear() !== year ||
      day.getUTCMonth() !== month - 1 ||
      day.getUTCDate() !== date
    )
      return null;
  }
  const zone = match[14]!;
  let offset = 0n;
  if (zone !== "Z") {
    const z = /^([+-])(\d{2})(?::?(\d{2})(?::?(\d{2}))?)?(?:[.,](\d+))?$/.exec(zone)!;
    const zh = Number(z[2]),
      zm = Number(z[3] ?? 0),
      zs = Number(z[4] ?? 0);
    const seconds = zh * 3600 + zm * 60 + zs;
    // Python normalizes offset minutes/seconds; a zero offset ignores its
    // fractional component. The resulting offset must stay below 24 hours.
    offset =
      BigInt(seconds) * 1000000n + (seconds ? BigInt((z[5] ?? "").padEnd(6, "0").slice(0, 6)) : 0n);
    if (offset >= 86400000000n) return null;
    if (z[1] === "-") offset = -offset;
  }
  const result =
    BigInt(day.getTime() + (hour * 3600 + minute * 60 + second) * 1000) * 1000n +
    BigInt((match[13] ?? "").padEnd(6, "0").slice(0, 6)) -
    offset;
  // Python rejects UTC conversion outside datetime's supported years.
  return result < -62135596800000000n || result > 253402300799999999n ? null : result;
}

export function sameDate(a: DateValue | undefined, b: DateValue | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "exact" && b.kind === "exact") {
    const left = instantMicros(a.iso),
      right = instantMicros(b.iso);
    if (left !== null && right !== null)
      return left === right && compareSubmicro(a.iso, b.iso) === 0;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compare digits beyond microseconds for the strict collected timestamp form. */
export function compareSubmicro(a: string, b: string): number {
  const tail = (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/
      .exec(value)?.[1]
      ?.slice(6)
      .replace(/0+$/, "") ?? "";
  const x = tail(a),
    y = tail(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** A valid IANA zone, or UTC. */
function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function yearIn(ms: number, tz: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric" }).format(ms));
}

/**
 * #87 shared friendly formatter for an instant: `4 Nov, 14:05` in the configured timezone,
 * `4 Nov 2025, 14:05` outside the current year. Invalid input yields "Date unavailable".
 */
export function friendlyInstant(
  value: string | number,
  tz: string,
  now: number = Date.now(),
): string {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "Date unavailable";
  const zone = safeZone(tz);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts["year"]);
  const day = `${Number(parts["day"])} ${MONTHS[Number(parts["month"]) - 1]}${year !== yearIn(now, zone) ? ` ${year}` : ""}`;
  return `${day}, ${parts["hour"]}:${parts["minute"]}`;
}

/** #87 friendly calendar day (`4 Nov`, or `4 Nov 2025` outside the current year) for a `YYYY-MM-DD` value. */
export function friendlyDay(ymd: string, tz = "UTC", now: number = Date.now()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const year = Number(m[1]);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${year !== yearIn(now, safeZone(tz)) ? ` ${year}` : ""}`;
}

/** #87 friendly day range: `9–15 Mar`, `28 Feb – 6 Mar`, with the year only outside the current one. */
export function friendlyRange(
  start: string,
  end: string,
  tz = "UTC",
  now: number = Date.now(),
): string {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start),
    b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!a || !b) return `${start} – ${end}`;
  if (a[1] === b[1] && a[2] === b[2]) {
    const tail = friendlyDay(end, tz, now);
    return `${Number(a[3])}–${tail}`;
  }
  return `${friendlyDay(start, tz, now)} – ${friendlyDay(end, tz, now)}`;
}

export function formatDate(d: DateValue, tz: string): string {
  switch (d.kind) {
    case "exact":
      // Throws on an invalid instant like the former Intl formatter; displayDate guards that.
      if (!Number.isFinite(Date.parse(d.iso))) throw new RangeError("Invalid time value");
      return friendlyInstant(d.iso, tz);
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new RangeError("Invalid time value");
      return `${friendlyDay(d.date, tz)} (no time)`;
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
