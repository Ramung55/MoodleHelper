/** Pure synthetic/unobserved #13 contract. No live SDU selector claim or Snapshot mapping. */
import { detectMoodleAccess, type MoodleAccessInput, type MoodleAccessResult } from "./moodle-access";
import type { DateValue } from "../../frontend/src/domain/types";

export type AssignmentDateField = "opening" | "due" | "cutoff";
export interface AssignmentDateObservation { value: DateValue; rawText: string; location: string }
export type AssignmentDates = Partial<Record<AssignmentDateField, AssignmentDateObservation>>;
export interface RawAssignmentObservation {
  sourceCourseId: string; sourceActivityId: string; sourceCourseModuleId: string;
  sourceUrl: string; title: string; observedAt: string;
  baseDates: AssignmentDates;
  individualExtensions: { field: AssignmentDateField; date: AssignmentDateObservation; evidence: string; scope: "individual" }[];
  effectiveDates: AssignmentDates;
}
export type AssignmentDiagnostic = "access_error" | "unsafe_url" | "identity_mismatch" |
  "malformed_assignment" | "incomplete_assignment" | "unsupported_date" | "invalid_date" |
  "duplicate_date" | "invalid_observed_at";
export type AssignmentParseResult =
  | { status: "success"; access: MoodleAccessResult; observation: RawAssignmentObservation }
  | { status: "error"; access: MoodleAccessResult; reason: AssignmentDiagnostic };

const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const idValid = (value: string | null): value is string => value !== null && /^[1-9][0-9]*$/.test(value);
const origin = "https://moodle.sdu.edu.kz";

function linkId(raw: string | null, path: string): string | null {
  if (!raw || !new RegExp(`^(?:https://moodle\\.sdu\\.edu\\.kz(?::443)?)?${path.replaceAll(".", "\\.")}\\?id=([1-9][0-9]*)$`).test(raw)) return null;
  try { const url = new URL(raw, origin); return url.searchParams.get("id"); } catch { return null; }
}

function realDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function exact(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && realDay(match[1]) && +match[2] <= 23 && +match[3] <= 59 &&
    +(match[4] ?? 0) <= 59 && +(match[7] ?? 0) <= 23 && +(match[8] ?? 0) <= 59 && Number.isFinite(Date.parse(value));
}

function dateValue(node: Element): DateValue | null {
  const value = node.getAttribute("datetime") ?? "";
  const tz = node.getAttribute("data-timezone");
  if (realDay(value)) return tz === null ? { kind: "date", date: value } : null;
  if (!exact(value) || !tz || /^(?:Z|[+-]\d|(?:UTC|GMT)[+-])/i.test(tz) || tz !== tz.trim()) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return null; }
  return { kind: "exact", iso: value, tz };
}

function copy(date: AssignmentDateObservation): AssignmentDateObservation {
  return { ...date, value: { ...date.value } };
}

export function parseMoodleAssignment(input: MoodleAccessInput, observedAt: string): AssignmentParseResult {
  const access = detectMoodleAccess(input);
  const fail = (reason: AssignmentDiagnostic): AssignmentParseResult => ({ status: "error", access, reason });
  if (access.status !== "accessible") return fail("access_error");
  try {
    if (typeof observedAt !== "string" || !exact(observedAt)) return fail("invalid_observed_at");
    const moduleId = linkId(input.finalUrl, "/mod/assign/view.php");
    const requestedId = linkId(input.requestedUrl, "/mod/assign/view.php");
    if (!moduleId || !requestedId) return fail("unsafe_url");
    if (moduleId !== requestedId) return fail("identity_mismatch");
    const mains = input.document.querySelectorAll('main[data-region="activity"]');
    const articles = input.document.querySelectorAll('article[data-region="assignment"]');
    if (mains.length !== 1 || articles.length !== 1 || !mains[0].contains(articles[0])) return fail("malformed_assignment");
    const main = mains[0], article = articles[0];
    if ([main, article].some(node => node.hasAttribute("data-incomplete") || node.hasAttribute("data-truncated"))) return fail("incomplete_assignment");
    const courseId = article.getAttribute("data-course-id"), activityId = article.getAttribute("data-assignment-id"), articleModuleId = article.getAttribute("data-course-module-id");
    if (!idValid(courseId) || !idValid(activityId) || !idValid(articleModuleId)) return fail("malformed_assignment");
    const headings = article.querySelectorAll("h1"), assignmentLinks = article.querySelectorAll('a[data-role="assignment-link"]'), courseLinks = article.querySelectorAll('a[data-role="course-link"]');
    if (headings.length !== 1 || assignmentLinks.length !== 1 || courseLinks.length !== 1) return fail("malformed_assignment");
    const title = normalize(headings[0].textContent ?? "");
    if (!title) return fail("malformed_assignment");
    const linkedModule = linkId(assignmentLinks[0].getAttribute("href"), "/mod/assign/view.php"), linkedCourse = linkId(courseLinks[0].getAttribute("href"), "/course/view.php");
    if (!linkedModule || !linkedCourse) return fail("unsafe_url");
    if (linkedModule !== moduleId || articleModuleId !== moduleId || linkedCourse !== courseId) return fail("identity_mismatch");
    const baseDates: AssignmentDates = {}, extensions: AssignmentDates = {};
    const individualExtensions: RawAssignmentObservation["individualExtensions"] = [];
    // Any recognized machine-date candidate must satisfy the full structural vocabulary.
    for (const node of article.querySelectorAll("time, [datetime], [data-date-field], [data-date-scope], [data-extension-evidence]")) {
      const field = node.getAttribute("data-date-field"), scope = node.getAttribute("data-date-scope");
      if (node.localName !== "time" || !["opening", "due", "cutoff"].includes(field ?? "") || !["base", "individual"].includes(scope ?? "")) return fail("unsupported_date");
      const key = field as AssignmentDateField;
      const target = scope === "base" ? baseDates : extensions;
      if (target[key]) return fail("duplicate_date");
      const value = dateValue(node), rawText = normalize(node.textContent ?? "");
      if (!value || !rawText) return fail("invalid_date");
      const date = { value, rawText, location: `assignment.${scope}.${key}` };
      const evidence = normalize(node.getAttribute("data-extension-evidence") ?? "");
      if (scope === "individual" && !evidence || scope === "base" && node.hasAttribute("data-extension-evidence")) return fail("unsupported_date");
      target[key] = date;
      if (scope === "individual") individualExtensions.push({ field: key, date: copy(date), evidence, scope: "individual" });
    }
    const effectiveDates: AssignmentDates = {};
    for (const field of ["opening", "due", "cutoff"] as const) {
      const date = extensions[field] ?? baseDates[field];
      if (date) effectiveDates[field] = copy(date);
    }
    return { status: "success", access, observation: { sourceCourseId: courseId, sourceActivityId: activityId,
      sourceCourseModuleId: moduleId, sourceUrl: `${origin}/mod/assign/view.php?id=${moduleId}`,
      title, observedAt, baseDates, individualExtensions, effectiveDates } };
  } catch { return fail("malformed_assignment"); }
}
