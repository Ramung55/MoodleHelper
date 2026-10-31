import type { DateValue } from "../../frontend/src/domain/types";
export function realDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function exact(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && realDay(match[1]) && +match[2] <= 23 && +match[3] <= 59 &&
    +(match[4] ?? 0) <= 59 && +(match[7] ?? 0) <= 23 && +(match[8] ?? 0) <= 59 && Number.isFinite(Date.parse(value));
}

export function dateValue(node: Element): DateValue | null {
  const value = node.getAttribute("datetime") ?? "";
  const tz = node.getAttribute("data-timezone");
  if (realDay(value)) return tz === null ? { kind: "date", date: value } : null;
  if (!exact(value) || !tz || /^(?:Z|[+-]\d|(?:UTC|GMT)[+-])/i.test(tz) || tz !== tz.trim()) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return null; }
  return { kind: "exact", iso: value, tz };
}


