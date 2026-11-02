/**
 * #14 quiz collector for the ONE SDU variant verified by #3 (live inspection
 * 2026-11-01): English UI (`<html lang="en">`, body `lang-en`), theme `alpha`
 * (RaiseUI). Two page sources are supported:
 *
 * - the quiz view page `/mod/quiz/view.php?id=<cmid>` with a finished attempt
 *   (`body#page-mod-quiz-view`, body classes `cmid-<cmid>` / `course-<id>` (Addendum 3),
 *   `[data-region="activity-dates"] > div` "Opened: ..." / "Closed: ...",
 *   `.quizinfo p` "Attempts allowed: N" / "Time limit: ...", one
 *   `div.rui-attempts-list` with one `h4.card-title` attempt and `.rui-infobox`
 *   Status/Started/Completed (no `.card` wrapper is required: none exists live),
 *   `.box.quizattempt > p.text-start` "No more attempts are allowed", next to the
 *   observed `div.continuebutton` "Back to the course" (Addendum 4); the dates
 *   region may start with a decorative text-less `svg` (Addendum 4));
 * - the course page quiz card `li.activity.modtype_quiz#module-<cmid>` with its
 *   `.instancename` and activity dates (body classes `format-topics` /
 *   `course-<id>`, Addendum 3).
 *
 * Evidence: _docs/compatibility/sdu-moodle.md (matrix rows 4 and 7, quiz field
 * table, navigation/access table, and the 2026-11-01 Addendum 3 re-check of body
 * classes and the attempts block) and the #4 observed-structure fixtures. The
 * raw-model decisions follow _docs/quiz-collection-contract.md: opening and
 * closing stay separate raw observations with source wording; closing means quiz
 * close, never exam start; no closing row means open-ended; attempt facts keep
 * their wording and are never turned into counts; absent attempt info is
 * explicit unknown. Only the course-module id (cmid) is observable, so the quiz
 * instance id stays explicit unknown. The view-page title element was not
 * recorded by #3, so the view page title stays unknown; the course card title
 * comes from the observed `.instancename`.
 *
 * Anything outside the verified variant (other languages, other themes, the
 * standard `table.quizattemptsummary`, in-progress or multiple attempts, date
 * labels other than "Opened:"/"Closed:") is an explicit `unsupported` result.
 * The output is internal raw evidence: it is not Snapshot, not the wire
 * RawQuizObservation, and it is not dispatched by the page-refresh registry
 * (ingestion belongs to #18/#20). Pure and read-only: no fetch, navigation,
 * storage, logging or DOM writes. Diagnostics carry fixed reasons only.
 */
import type { MoodleAccessInput } from "./moodle-access";
import { exact } from "./moodle-dates";
import type { DateValue } from "../../frontend/src/domain/types";

const origin = "https://moodle.sdu.edu.kz";
const loginUrl = "https://moodle.sdu.edu.kz/login/index.php" as const;
/** #3: displayed times are in the user's Moodle time zone, observed as UTC+5. */
const observedOffset = "+05:00", observedZone = "Asia/Almaty";

export type QuizPageKind = "quiz_view" | "course_quiz_card";
export interface QuizVariant {
  readonly id: string;
  readonly page: QuizPageKind;
  readonly language: "en";
  readonly theme: "alpha";
  readonly evidence: string;
}
/** Verified-support registry. Only #3-observed variants may be listed here. */
export const SUPPORTED_QUIZ_VARIANTS: readonly QuizVariant[] = Object.freeze([
  Object.freeze({ id: "sdu-en-alpha/quiz-finished-no-attempts-left", page: "quiz_view", language: "en", theme: "alpha",
    evidence: "#3 matrix row 7 (2026-11-01); fixture observed/quiz-finished.html" } as const),
  Object.freeze({ id: "sdu-en-alpha/course-page-format-topics", page: "course_quiz_card", language: "en", theme: "alpha",
    evidence: "#3 matrix row 4 (2026-11-01); fixture observed/course-page.html" } as const),
]);
export function supportedQuizVariant(page: QuizPageKind, language: string, theme: string): QuizVariant | undefined {
  return SUPPORTED_QUIZ_VARIANTS.find(v => v.page === page && v.language === language && v.theme === theme);
}

export type QuizDateField = "opening" | "closing";
export interface QuizDateObservation {
  value: DateValue;
  /** Full visible row text, e.g. "Closed: Saturday, 4 March 2028, 9:00 AM". */
  rawText: string;
  label: "Opened:" | "Closed:";
  /** closing is the quiz close time; it is never an exam start or appointment. */
  meaning: "quiz_open" | "quiz_close";
  location: `quiz.${QuizDateField}`;
  /** Observed SDU quirk (Addendum 4, 2026-11-01): the shown weekday disagrees with its own
   *  day/month/year. The numeric date and time are authoritative; the mismatch is flagged,
   *  never hidden. Absent when the weekday agrees. */
  weekdayMismatch?: WeekdayMismatch;
}
export interface WeekdayMismatch { shown: string; computed: string }
export type QuizAttemptField = "state" | "allowed" | "used" | "remaining" | "other";
export interface QuizAttemptFact {
  field: QuizAttemptField;
  /** Source label, e.g. "Attempts allowed", "Time limit", "Status", "Started". */
  label: string;
  /** Visible source wording, kept as is (never converted into counts). */
  rawText: string;
  location: `quiz.attemptInformation.${QuizAttemptField}`;
  /** Attempt card title, e.g. "Attempt 1", for rui-attempts-list facts. */
  attempt?: string;
}
export type QuizAttemptInformation =
  | { kind: "known"; facts: QuizAttemptFact[]; unknownFields: QuizAttemptField[] }
  | { kind: "unknown" };
export type Known<T> = { kind: "known"; value: T } | { kind: "unknown" };
export interface QuizObservation {
  variant: string;
  sourceCourseId: string;
  sourceCourseModuleId: string;
  /** The quiz instance id is not observable on the verified variant. */
  sourceActivityId: { kind: "unknown" };
  sourceUrl: string;
  sourcePageUrl: string;
  title: Known<string>;
  observedAt: string;
  opening?: QuizDateObservation;
  closing?: QuizDateObservation;
  /** "open_ended" when no "Closed:" row is shown: no deadline is guessed. */
  close: "quiz_close" | "open_ended";
  attemptInformation: QuizAttemptInformation;
}
export type QuizReason =
  | "signed_out" | "denied" | "missing_source" | "network_failure" | "invalid_envelope"
  | "untrusted_origin" | "unsupported_response" | "invalid_observed_at"
  | "transient_response" | "missing_structure" | "malformed_structure" | "identity_mismatch"
  | "unsafe_url" | "invalid_date" | "duplicate_date"
  | "unsupported_page" | "unsupported_language" | "unsupported_theme"
  | "unsupported_date_label" | "unsupported_attempt_layout";
export interface QuizDiagnostic { reason: QuizReason; index?: number }
export interface QuizParseResult {
  /** complete: every quiz source on the page parsed; incomplete: partial or broken
   *  structure; unsupported: not the verified variant; error: access failure. */
  status: "complete" | "incomplete" | "unsupported" | "error";
  page: QuizPageKind | "unknown";
  variant?: string;
  observations: QuizObservation[];
  diagnostics: QuizDiagnostic[];
  loginUrl?: typeof loginUrl;
}

const errorReasons = new Set<QuizReason>(["signed_out", "denied", "missing_source", "network_failure", "invalid_envelope",
  "untrusted_origin", "unsupported_response", "invalid_observed_at"]);
const unsupportedReasons = new Set<QuizReason>(["unsupported_page", "unsupported_language", "unsupported_theme",
  "unsupported_date_label", "unsupported_attempt_layout"]);
function failure(reason: QuizReason, page: QuizParseResult["page"] = "unknown"): QuizParseResult {
  const status = errorReasons.has(reason) ? "error" : unsupportedReasons.has(reason) ? "unsupported" : "incomplete";
  return { status, page, observations: [], diagnostics: [{ reason }], ...(reason === "signed_out" ? { loginUrl } : {}) };
}
class QuizFailure extends Error { constructor(readonly reason: QuizReason) { super(reason); } }
const fail = (reason: QuizReason): never => { throw new QuizFailure(reason); };

const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/gu, " ").trim();

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string" || /[\s\\]/.test(value) || !/^https:\/\//i.test(value)) return null;
  try { return new URL(value); } catch { return null; }
}
function trusted(url: URL, raw: string): boolean {
  return url.protocol === "https:" && url.hostname === "moodle.sdu.edu.kz" && !url.username && !url.password &&
    (!url.port || url.port === "443") && !/^https:\/\/[^/?#]*@/i.test(raw);
}
/** Canonical `<path>?id=<positive decimal>` with no other query keys or fragment. */
function routeId(url: URL, path: string): string | null {
  const m = /^\?id=([1-9][0-9]*)$/.exec(url.search);
  return url.pathname === path && !url.hash && m ? m[1]! : null;
}
/** Live pages use `href`; observed-structure fixtures keep the same relative target in `data-href`. */
function linkTarget(node: Element): string | null {
  return node.getAttribute("href") ?? node.getAttribute("data-href");
}
function linkedQuizId(raw: string | null): string | null {
  if (!raw || /[\s\\]/.test(raw) || /^\/\//.test(raw)) return null;
  const m = /^(?:https:\/\/moodle\.sdu\.edu\.kz(?::443)?)?\/mod\/quiz\/view\.php\?id=([1-9][0-9]*)$/.exec(raw);
  return m ? m[1]! : null;
}
function classId(node: Element, prefix: string): string | null {
  const ids = Array.from(node.classList).filter(c => c.startsWith(prefix)).map(c => c.slice(prefix.length));
  if (ids.length !== 1 || !/^[1-9][0-9]*$/.test(ids[0]!)) return null;
  return ids[0]!;
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/**
 * #3 format: "<Weekday>, <d> <Month> <yyyy>, <h:mm> <AM|PM>" in UTC+5.
 *
 * The weekday must be one of the seven English names, but it is not required to agree with the
 * date: Addendum 4 (2026-11-01) observed SDU showing "Closed: Wednesday, 15 September 2026,
 * 11:00 PM" for a Tuesday, consistent with the "Opened:" line on the same day. The numeric
 * day/month/year/time are authoritative and a disagreeing weekday is returned as
 * `weekdayMismatch`. Numerically invalid dates (e.g. 30 February) and invalid times stay null.
 */
export function parseObservedQuizDateDetail(text: string): { value: DateValue; weekdayMismatch?: WeekdayMismatch } | null {
  const m = /^([A-Z][a-z]+day), ([1-9][0-9]?) ([A-Z][a-z]+) ([0-9]{4}), ([1-9][0-9]?):([0-5][0-9]) (AM|PM)$/.exec(text);
  if (!m) return null;
  const [, weekday, d, monthName, y, h, minute, half] = m as unknown as [string, string, string, string, string, string, string, string];
  const month = months.indexOf(monthName), day = +d, year = +y, hour12 = +h;
  if (month < 0 || hour12 > 12 || !weekdays.includes(weekday)) return null;
  const check = new Date(Date.UTC(year, month, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  const hour = (hour12 % 12) + (half === "PM" ? 12 : 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${y}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${minute}:00${observedOffset}`;
  if (!exact(iso)) return null;
  const computed = weekdays[check.getUTCDay()]!;
  const value: DateValue = { kind: "exact", iso, tz: observedZone };
  return computed === weekday ? { value } : { value, weekdayMismatch: { shown: weekday, computed } };
}
/** The DateValue of `parseObservedQuizDateDetail`; a weekday mismatch alone does not reject the date. */
export function parseObservedQuizDate(text: string): DateValue | null {
  return parseObservedQuizDateDetail(text)?.value ?? null;
}

const dateLabels = { "Opened:": ["opening", "quiz_open"], "Closed:": ["closing", "quiz_close"] } as const;
function parseDates(scope: Element): Pick<QuizObservation, "opening" | "closing" | "close"> {
  const regions = scope.querySelectorAll('[data-region="activity-dates"]');
  if (regions.length > 1) fail("malformed_structure");
  const out: Pick<QuizObservation, "opening" | "closing"> = {};
  for (const row of regions.length ? Array.from(regions[0]!.children) : []) {
    const rawText = normalize(row.textContent);
    // Addendum 4: the quiz view page's dates region starts with a decorative, text-less
    // `<svg class="d-none d-md-flex mr-2">`. Only a text-less svg is skipped; any other
    // child must be an "Opened:"/"Closed:" row.
    if (!rawText && row.localName === "svg") continue;
    const label = Object.keys(dateLabels).find(l => rawText.startsWith(l + " ")) as keyof typeof dateLabels | undefined;
    if (!label) fail(rawText ? "unsupported_date_label" : "malformed_structure");
    const [field, meaning] = dateLabels[label!];
    if (out[field]) fail("duplicate_date");
    const parsed = parseObservedQuizDateDetail(rawText.slice(label!.length + 1));
    if (!parsed) fail("invalid_date");
    out[field] = { value: parsed!.value, rawText, label: label!, meaning, location: `quiz.${field}`,
      ...(parsed!.weekdayMismatch ? { weekdayMismatch: parsed!.weekdayMismatch } : {}) };
  }
  return { ...out, close: out.closing ? "quiz_close" : "open_ended" };
}

function attemptInformation(doc: Document): QuizAttemptInformation {
  const facts: QuizAttemptFact[] = [];
  const fact = (field: QuizAttemptField, label: string, rawText: string, attempt?: string) =>
    facts.push({ field, label, rawText, location: `quiz.attemptInformation.${field}`, ...(attempt ? { attempt } : {}) });
  for (const p of doc.querySelectorAll(".quizinfo p")) {
    const text = normalize(p.textContent);
    if (/^Attempts allowed: \S/.test(text)) fact("allowed", "Attempts allowed", text);
    else if (/^Time limit: \S/.test(text)) fact("other", "Time limit", text);
    // Other quizinfo lines (e.g. the password notice) are not attempt information.
  }
  const lists = doc.querySelectorAll("div.rui-attempts-list");
  if (lists.length > 1) fail("malformed_structure");
  if (lists.length) {
    // Only the observed parts are required: the list, one `h4.card-title` per attempt and the
    // `.rui-infobox` pairs. The live wrappers between them (Addendum 3: `div.w-100 >
    // div.rounded.border.p-3`, and NO `.card` element) are deliberately not required.
    const list = lists[0]!, titles = list.querySelectorAll("h4.card-title");
    // #3 observed exactly one finished attempt; multiple attempts are UNVERIFIED.
    if (titles.length !== 1) fail(titles.length ? "unsupported_attempt_layout" : "malformed_structure");
    const attempt = normalize(titles[0]!.textContent);
    if (!attempt) fail("malformed_structure");
    const seen = new Set<string>();
    for (const box of list.querySelectorAll(".rui-infobox")) {
      const label = normalize(box.querySelector("h5.rui-infobox-title")?.textContent);
      const content = box.querySelectorAll(".rui-infobox-content--small");
      if (!label || content.length !== 1) fail("malformed_structure");
      if (seen.has(label)) fail("malformed_structure");
      seen.add(label);
      const value = normalize(content[0]!.textContent);
      // Marks and Grade are never retained; Duration is not collected.
      if (!["Status", "Started", "Completed"].includes(label)) continue;
      if (!value) fail("malformed_structure");
      // Only the "Finished" state was observed; in-progress attempts are UNVERIFIED.
      if (label === "Status" && value !== "Finished") fail("unsupported_attempt_layout");
      fact(label === "Status" ? "state" : "other", label, value, attempt);
    }
    if (!seen.has("Status")) fail("malformed_structure");
  }
  const boxes = doc.querySelectorAll(".box.quizattempt");
  if (boxes.length > 1) fail("malformed_structure");
  if (boxes.length) {
    // Addendum 4: the box holds `p.text-start` (the status sentence) and `div.continuebutton`
    // ("Back to the course"). Only the sentence is attempt information; any other child (for
    // example start/continue-attempt controls, UNVERIFIED) is not the observed layout.
    const children = Array.from(boxes[0]!.children);
    const sentences = children.filter(c => c.localName === "p" && c.classList.contains("text-start"));
    if (sentences.length !== 1 || children.some(c => c !== sentences[0] &&
        !(c.localName === "div" && c.classList.contains("continuebutton")))) fail("unsupported_attempt_layout");
    const text = normalize(sentences[0]!.textContent);
    // Only this wording was observed; start/continue-attempt controls are UNVERIFIED.
    if (text !== "No more attempts are allowed") fail("unsupported_attempt_layout");
    fact("remaining", "Attempt summary", text);
  }
  if (!facts.length) return { kind: "unknown" };
  const fields: QuizAttemptField[] = ["state", "allowed", "used", "remaining", "other"];
  return { kind: "known", facts, unknownFields: fields.filter(f => !facts.some(x => x.field === f)) };
}

function checkVariant(doc: Document, page: QuizPageKind): QuizVariant {
  const lang = doc.documentElement.getAttribute("lang");
  const bodyLangs = Array.from(doc.body.classList).filter(c => c.startsWith("lang-"));
  // A page without its language marker cannot establish the variant: incomplete, not unsupported.
  if (lang === null || !doc.body.firstElementChild) fail("missing_structure");
  if (lang !== "en" || bodyLangs.some(c => c !== "lang-en")) fail("unsupported_language");
  const themes = new Set<string>();
  for (const node of doc.querySelectorAll('[src*="/theme/"], [href*="/theme/"]')) {
    for (const attr of ["src", "href"]) {
      const m = /\/theme\/[a-z_]+\.php\/([a-z0-9_]+)\//.exec(node.getAttribute(attr) ?? "");
      if (m) themes.add(m[1]!);
    }
  }
  // Theme: #3 records `alpha` as the theme of the SDU site for every inspected page (report header),
  // and `trusted()` pins the host to moodle.sdu.edu.kz, so a page from that host is taken as alpha
  // unless it shows positive evidence of another theme: a `/theme/<script>.php/<name>/` asset with
  // another name, or the standard `table.quizattemptsummary` that alpha replaces. A page with no
  // theme asset URL is not evidence of another theme. Addendum 6 (2026-11-02) recorded `/theme/…/alpha`
  // assets on all 3 live quiz view pages; absence alone is still not treated as another theme.
  if ([...themes].some(t => t !== "alpha") || doc.querySelector("table.quizattemptsummary")) fail("unsupported_theme");
  const variant = supportedQuizVariant(page, "en", "alpha");
  if (!variant) fail("unsupported_page");
  return variant!;
}

function parseQuizView(doc: Document, cmid: string, observedAt: string, pageUrl: string): QuizParseResult {
  const variant = checkVariant(doc, "quiz_view");
  if (doc.body.id !== "page-mod-quiz-view") fail("missing_structure");
  const bodyCm = classId(doc.body, "cmid-"), course = classId(doc.body, "course-");
  if (!bodyCm || !course) fail("missing_structure");
  if (bodyCm !== cmid) fail("identity_mismatch");
  const observation: QuizObservation = {
    variant: variant.id, sourceCourseId: course!, sourceCourseModuleId: cmid, sourceActivityId: { kind: "unknown" },
    sourceUrl: `${origin}/mod/quiz/view.php?id=${cmid}`, sourcePageUrl: pageUrl, title: { kind: "unknown" }, observedAt,
    ...parseDates(doc.body), attemptInformation: attemptInformation(doc),
  };
  return { status: "complete", page: "quiz_view", variant: variant.id, observations: [observation], diagnostics: [] };
}

function parseCoursePage(doc: Document, courseId: string, observedAt: string, pageUrl: string): QuizParseResult {
  const variant = checkVariant(doc, "course_quiz_card");
  const bodyCourse = classId(doc.body, "course-");
  if (!bodyCourse || !doc.body.classList.contains("format-topics") || !doc.querySelector("li.section")) fail("missing_structure");
  if (bodyCourse !== courseId) fail("identity_mismatch");
  const observations: QuizObservation[] = [], diagnostics: QuizDiagnostic[] = [], seen = new Set<string>();
  doc.querySelectorAll("li.activity.modtype_quiz").forEach((card, index) => {
    try {
      const m = /^module-([1-9][0-9]*)$/.exec(card.id);
      if (!m) fail("missing_structure");
      const cmid = m![1]!;
      if (seen.has(cmid)) fail("malformed_structure");
      seen.add(cmid);
      // #3 records the activity link `a[href*="/mod/<mod>/view.php?id=<cmid>"]` but not how many
      // anchors a card holds, so other anchors are ignored. Every anchor that targets the quiz view
      // route must be the canonical same-origin link for this card's cmid, and at least one must exist.
      const quizLinks = Array.from(card.querySelectorAll("a"))
        .map(linkTarget).filter((t): t is string => t !== null && t.includes("/mod/quiz/view.php"));
      if (!quizLinks.length) fail("missing_structure");
      for (const target of quizLinks) {
        const linked = linkedQuizId(target);
        if (!linked) fail("unsafe_url");
        if (linked !== cmid) fail("identity_mismatch");
      }
      const names = card.querySelectorAll(".instancename");
      if (names.length !== 1) fail("missing_structure");
      const name = names[0]!.cloneNode(true) as Element;
      name.querySelectorAll(".accesshide").forEach(n => n.remove());
      const title = normalize(name.textContent);
      observations.push({
        variant: variant.id, sourceCourseId: courseId, sourceCourseModuleId: cmid, sourceActivityId: { kind: "unknown" },
        sourceUrl: `${origin}/mod/quiz/view.php?id=${cmid}`, sourcePageUrl: pageUrl,
        title: title ? { kind: "known", value: title } : { kind: "unknown" }, observedAt,
        // The course card shows no attempt information.
        ...parseDates(card), attemptInformation: { kind: "unknown" },
      });
    } catch (error) {
      diagnostics.push({ reason: error instanceof QuizFailure ? error.reason : "malformed_structure", index });
    }
  });
  return { status: diagnostics.length ? "incomplete" : "complete", page: "course_quiz_card", variant: variant.id, observations, diagnostics };
}

export function parseMoodleQuizPage(input: MoodleAccessInput, observedAt: string): QuizParseResult {
  try {
    if (!input || typeof input !== "object" || typeof input.networkFailure !== "boolean" ||
        !Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599 ||
        (input.contentType !== undefined && typeof input.contentType !== "string")) return failure("invalid_envelope");
    const requested = parseUrl(input.requestedUrl), final = parseUrl(input.finalUrl);
    if (!requested || !final) return failure("invalid_envelope");
    if (!trusted(requested, input.requestedUrl) || !trusted(final, input.finalUrl)) return failure("untrusted_origin");
    const quizId = routeId(requested, "/mod/quiz/view.php"), courseId = routeId(requested, "/course/view.php");
    const page: QuizParseResult["page"] = quizId ? "quiz_view" : courseId ? "course_quiz_card" : "unknown";
    if (page === "unknown") return failure("unsupported_page");
    if (input.networkFailure) return failure("network_failure", page);
    const status = input.httpStatus;
    // #3: an expired or missing session ends at /login/index.php with HTTP 200.
    if (final.pathname === "/login/index.php" || status === 401) return failure("signed_out", page);
    if (status === 403) return failure("denied", page);
    if (status === 404) return failure("missing_source", page);
    if (status >= 300 && status < 400 || status >= 500 || [408, 425, 429].includes(status) || status >= 200 && status < 300 && status !== 200)
      return failure("transient_response", page);
    if (status !== 200) return failure("unsupported_response", page);
    if (input.contentType !== undefined) {
      const mime = input.contentType.split(";", 1)[0]!.trim().toLowerCase();
      if (mime !== "text/html" && mime !== "application/xhtml+xml") return failure("unsupported_response", page);
    }
    if (typeof observedAt !== "string" || !exact(observedAt)) return failure("invalid_observed_at", page);
    const finalId = routeId(final, quizId ? "/mod/quiz/view.php" : "/course/view.php");
    if (finalId !== (quizId ?? courseId)) return failure("identity_mismatch", page);
    const doc = input.document;
    if (!doc || doc.nodeType !== 9 || !doc.documentElement || !doc.body || doc.documentElement.localName !== "html")
      return failure("missing_structure", page);
    const pageUrl = quizId ? `${origin}/mod/quiz/view.php?id=${quizId}` : `${origin}/course/view.php?id=${courseId}`;
    return quizId ? parseQuizView(doc, quizId, observedAt, pageUrl) : parseCoursePage(doc, courseId!, observedAt, pageUrl);
  } catch (error) {
    if (error instanceof QuizFailure) return failure(error.reason, pageOf(input));
    return failure("malformed_structure", pageOf(input));
  }
}
function pageOf(input: MoodleAccessInput): QuizParseResult["page"] {
  try {
    const url = parseUrl(input.requestedUrl);
    return url && routeId(url, "/mod/quiz/view.php") ? "quiz_view" : url && routeId(url, "/course/view.php") ? "course_quiz_card" : "unknown";
  } catch { return "unknown"; }
}
