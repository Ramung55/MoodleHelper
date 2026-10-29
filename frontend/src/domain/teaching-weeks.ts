import { realCalendarDate, teachingCalendarError, teachingSlots } from "../../../shared/src/teaching-calendar.js";
import type { DateValue, TeachingCalendar } from "./types";
import type { AssessmentMention } from "./assessment-mentions";
export { teachingCalendarError, teachingSlots };
export type TeachingMapping = { resolved: true; week: number; start: string; end: string; timezone: string } | { resolved: false; reason: string };

export function mapTeachingWeek(week: number, calendar?: TeachingCalendar): TeachingMapping {
  if (!Number.isInteger(week) || week < 1 || week > 30) return { resolved: false, reason: "Week number must be an integer from 1 to 30." };
  if (!calendar) return { resolved: false, reason: "Teaching calendar is not configured; legacy semester fields are not a verified map." };
  const reason = teachingCalendarError(calendar); if (reason) return { resolved: false, reason };
  const slot = teachingSlots(calendar).find((value) => value.week === week);
  return slot ? { resolved: true, week, start: slot.start, end: slot.end, timezone: calendar.timezone } : { resolved: false, reason: "Week reference is outside the configured teaching calendar." };
}
export function mapTeachingDate(value: DateValue, calendar?: TeachingCalendar): TeachingMapping {
  if (value.kind === "week") return mapTeachingWeek(value.week, calendar);
  if (!calendar) return { resolved: false, reason: "Teaching calendar is not configured." };
  const error = teachingCalendarError(calendar); if (error) return { resolved: false, reason: error };
  let date: string;
  if (value.kind === "date") date = value.date;
  else if (value.kind === "exact") {
    if (!realCalendarDate(value.iso.slice(0, 10)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.iso) || !Number.isFinite(Date.parse(value.iso))) return { resolved: false, reason: "Exact source timestamp cannot be mapped safely." };
    try {
      const parts = new Intl.DateTimeFormat("en", { timeZone: calendar.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value.iso));
      const part = (name: string) => parts.find((p) => p.type === name)?.value;
      date = `${part("year")!.padStart(4, "0")}-${part("month")}-${part("day")}`;
    } catch { return { resolved: false, reason: "Calendar timezone is unavailable in this browser." }; }
  } else return { resolved: false, reason: "The source date or teaching week is unknown." };
  if (!realCalendarDate(date)) return { resolved: false, reason: "The source calendar date is invalid." };
  const slot = teachingSlots(calendar).find((candidate) => date >= candidate.start && date <= candidate.end);
  if (!slot) return { resolved: false, reason: "The source date is outside the explicit semester boundaries." };
  if (slot.week === null) return { resolved: false, reason: "The source date falls in an excluded full-week break." };
  return { resolved: true, week: slot.week, start: slot.start, end: slot.end, timezone: calendar.timezone };
}
export function parseTeachingWeek(mention: AssessmentMention, calendar?: TeachingCalendar): { parentId: string; rawText: string; expressions: { text: string; start: number; end: number; week: number }[]; value: DateValue; mapping: TeachingMapping } {
  const rawText = mention.rawScheduleText;
  const matches = [...rawText.matchAll(/(?<![\p{L}\p{N}])(?:weeks?|недел(?:я|и|е|ю))[ \t]+(-?\d+(?:[.,]\d+)?)(?![\p{L}\p{N}])/giu)];
  const expressions = matches.map((match) => ({ text: match[0], start: match.index!, end: match.index! + match[0].length, week: Number(match[1]!.replace(",", ".")) }));
  if (expressions.some((expression) => /^\s*(?:[–—/&+-]\s*\d|,\s+\d|(?:and|or|to|through|и|или|до|по)\s+\d)/iu.test(rawText.slice(expression.end)))) return { parentId: mention.id, rawText, expressions, value: { kind: "unknown" }, mapping: { resolved: false, reason: "Multiple/ranged week references need review." } };
  if (expressions.length !== 1 || mention.reasons.some((reason) => reason.startsWith("Multiple assessment mentions"))) return { parentId: mention.id, rawText, expressions, value: { kind: "unknown" }, mapping: { resolved: false, reason: expressions.length ? "Multiple/conflicting week or assessment mentions need review." : "No supported explicit teaching-week wording was found." } };
  const week = expressions[0]!.week; const mapping = mapTeachingWeek(week, calendar);
  return { parentId: mention.id, rawText, expressions, value: Number.isInteger(week) && week >= 1 && week <= 30 ? { kind: "week", week } : { kind: "unknown" }, mapping };
}
