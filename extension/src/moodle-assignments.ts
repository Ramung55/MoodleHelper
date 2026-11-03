/** Pure synthetic/unobserved #13 contract. No live SDU selector claim or Snapshot mapping. */
import { detectMoodleAccess, detectObservedMoodleAccess, type MoodleAccessInput, type MoodleAccessResult } from "./moodle-access";
import { exact, dateValue } from "./moodle-dates";
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
    // Both lengths are checked to be 1 before indexing, so index 0 is defined.
    if (mains.length !== 1 || articles.length !== 1 || !mains[0]!.contains(articles[0]!)) return fail("malformed_assignment");
    // The check above returned unless both lists have exactly one element.
    const main = mains[0]!, article = articles[0]!;
    if ([main, article].some(node => node.hasAttribute("data-incomplete") || node.hasAttribute("data-truncated"))) return fail("incomplete_assignment");
    const courseId = article.getAttribute("data-course-id"), activityId = article.getAttribute("data-assignment-id"), articleModuleId = article.getAttribute("data-course-module-id");
    if (!idValid(courseId) || !idValid(activityId) || !idValid(articleModuleId)) return fail("malformed_assignment");
    const headings = article.querySelectorAll("h1"), assignmentLinks = article.querySelectorAll('a[data-role="assignment-link"]'), courseLinks = article.querySelectorAll('a[data-role="course-link"]');
    if (headings.length !== 1 || assignmentLinks.length !== 1 || courseLinks.length !== 1) return fail("malformed_assignment");
    // headings.length is checked to be 1 above, so index 0 is defined.
    const title = normalize(headings[0]!.textContent ?? "");
    if (!title) return fail("malformed_assignment");
    // Both link lists are checked to have exactly one element above.
    const linkedModule = linkId(assignmentLinks[0]!.getAttribute("href"), "/mod/assign/view.php"), linkedCourse = linkId(courseLinks[0]!.getAttribute("href"), "/course/view.php");
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


/**
 * #83 observed SDU assignment view page (#3 live inspection 2026-11-01, compatibility
 * report "Assignment" table, Addenda 4/5; fixtures observed/assign-submitted.html and
 * observed/assign-not-submitted.html). The one verified variant: English UI
 * (`<html lang="en">`, body `lang-en`), `body#page-mod-assign-view` with the classes
 * `cmid-<cmid>` and `course-<id>`, and an optional `[data-region="activity-dates"]`
 * region whose `div` rows read "Opened: <date>" / "Due: <date>" in the #14 date format
 * (UTC+5, Asia/Almaty).
 *
 * - Access is #20's observed check (`detectObservedMoodleAccess`, route `assign`); the
 *   synthetic `parseMoodleAssignment` above is unchanged.
 * - The page `h2` was not recorded by #3, so it never backs the title: the caller
 *   passes the course-page card title, as the #14 quiz adapter does.
 * - The assignment instance id is not observable; only the cmid is returned.
 * - No dates region (seen live on 2 of 19 assignments, Addendum 5): no dates, never a
 *   guessed one. A weekday that disagrees with its own date (Addendum 4) keeps the
 *   numeric date and the raw text. An invalid date is rejected.
 * - Unobserved variants are explicit failures, never guessed values: any other date
 *   label (for example "Cut-off date:"), an extension or override notice, other
 *   languages (RU/KK) give `unsupported_date` / `unsupported_structure`.
 * - Submission status, grades and file-submission text are never read (submission is #16).
 */
export type ObservedAssignmentReason = "access_error" | "identity_mismatch" | "unsupported_structure" |
  "unsupported_date" | "invalid_date" | "duplicate_date" | "malformed_assignment" | "invalid_observed_at";
export interface ObservedAssignmentDate extends AssignmentDateObservation {
  location: "assignment.base.opening" | "assignment.base.due";
  weekdayMismatch?: WeekdayMismatch;
}
export interface ObservedAssignmentObservation {
  sourceCourseId: string;
  sourceCourseModuleId: string;
  sourceUrl: string;
  observedAt: string;
  opening?: ObservedAssignmentDate;
  due?: ObservedAssignmentDate;
}
export type ObservedAssignmentResult =
  | { status: "success"; access: MoodleAccessResult; observation: ObservedAssignmentObservation }
  | { status: "error"; access: MoodleAccessResult; reason: ObservedAssignmentReason };

export interface WeekdayMismatch { shown: string; computed: string }
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/**
 * The #3 activity-dates format, as read by the #14 quiz collector:
 * "<Weekday>, <d> <Month> <yyyy>, <h:mm> <AM|PM>" in UTC+5. The numeric date and time are
 * authoritative; a weekday that disagrees with them (Addendum 4) is returned as
 * `weekdayMismatch`, never a rejection. Numerically invalid dates and times give null.
 * (Kept here so the quiz collector stays imported only by the live registry and page analysis.)
 */
export function parseObservedActivityDate(text: string): { value: DateValue; weekdayMismatch?: WeekdayMismatch } | null {
  const m = /^([A-Z][a-z]+day), ([1-9][0-9]?) ([A-Z][a-z]+) ([0-9]{4}), ([1-9][0-9]?):([0-5][0-9]) (AM|PM)$/.exec(text);
  if (!m) return null;
  const [, weekday, d, monthName, y, h, minute, half] = m as unknown as string[];
  const month = monthNames.indexOf(monthName!), day = +d!, year = +y!, hour12 = +h!;
  if (month < 0 || hour12 > 12 || !weekdayNames.includes(weekday!)) return null;
  const check = new Date(Date.UTC(year, month, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${y}-${pad(month + 1)}-${pad(day)}T${pad((hour12 % 12) + (half === "PM" ? 12 : 0))}:${minute}:00+05:00`;
  if (!exact(iso)) return null;
  const computed = weekdayNames[check.getUTCDay()]!;
  const value: DateValue = { kind: "exact", iso, tz: "Asia/Almaty" };
  return computed === weekday ? { value } : { value, weekdayMismatch: { shown: weekday!, computed } };
}

const observedLabels = { "Opened:": "opening", "Due:": "due" } as const;
/** Upstream Moodle extension/override status rows (e.g. "Extension due date"); never observed on SDU, so refused. */
const unobservedNotice = /\b(?:extension|override)\b/i;

export function parseObservedMoodleAssignment(input: MoodleAccessInput, observedAt: string, sourceCourseId: string): ObservedAssignmentResult {
  let access: MoodleAccessResult = { status: "unknown", retryable: false, reason: "invalid_envelope", message: "Page evidence is invalid or incomplete." };
  const fail = (reason: ObservedAssignmentReason): ObservedAssignmentResult => ({ status: "error", access, reason });
  try {
    const requested = linkId(input?.requestedUrl ?? null, "/mod/assign/view.php");
    if (!requested || !idValid(sourceCourseId)) return fail("access_error");
    access = detectObservedMoodleAccess(input, { kind: "assign", cmid: requested, courseId: sourceCourseId });
    if (access.status !== "accessible") {
      // A page of this assignment that names another cmid or course is an identity mismatch.
      const body = input.document?.body;
      const mismatch = access.reason === "ambiguous_content" && body?.id === "page-mod-assign-view" &&
        (!body.classList.contains(`cmid-${requested}`) || !body.classList.contains(`course-${sourceCourseId}`));
      return fail(mismatch ? "identity_mismatch" : "access_error");
    }
    if (typeof observedAt !== "string" || !exact(observedAt)) return fail("invalid_observed_at");
    const doc = input.document, body = doc.body;
    const langs = Array.from(body.classList).filter(c => c.startsWith("lang-"));
    if (doc.documentElement.getAttribute("lang") !== "en" || langs.length !== 1 || langs[0] !== "lang-en") return fail("unsupported_structure");
    const ids = (prefix: string) => Array.from(body.classList).filter(c => c.startsWith(prefix));
    if (ids("cmid-").length !== 1 || ids("course-").length !== 1) return fail("identity_mismatch");
    // Extension or override notices (upstream wording; not observed on SDU) are not interpreted.
    for (const node of doc.querySelectorAll(".submissionstatustable th"))
      if (unobservedNotice.test(normalize(node.textContent ?? ""))) return fail("unsupported_date");
    const regions = doc.querySelectorAll('[data-region="activity-dates"]');
    if (regions.length > 1) return fail("malformed_assignment");
    const dates: Pick<ObservedAssignmentObservation, "opening" | "due"> = {};
    for (const row of regions.length ? Array.from(regions[0]!.children) : []) {
      const rawText = normalize(row.textContent ?? "");
      if (!rawText && row.localName === "svg") continue;
      const label = (Object.keys(observedLabels) as (keyof typeof observedLabels)[]).find(l => rawText.startsWith(l + " "));
      if (!label) return fail(rawText ? "unsupported_date" : "malformed_assignment");
      const field = observedLabels[label];
      if (dates[field]) return fail("duplicate_date");
      const parsed = parseObservedActivityDate(rawText.slice(label.length + 1));
      if (!parsed) return fail("invalid_date");
      dates[field] = { value: parsed.value, rawText, location: `assignment.base.${field}`,
        ...(parsed.weekdayMismatch ? { weekdayMismatch: parsed.weekdayMismatch } : {}) };
    }
    return { status: "success", access, observation: { sourceCourseId, sourceCourseModuleId: requested,
      sourceUrl: `${origin}/mod/assign/view.php?id=${requested}`, observedAt, ...dates } };
  } catch { return fail("malformed_assignment"); }
}
