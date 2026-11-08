/**
 * #16 assignment submission status mapper for ONE SDU assignment view page
 * `/mod/assign/view.php?id=<cmid>` (English UI, `<html lang="en">`, body `lang-en`).
 *
 * Evidence basis (owner decision, 2026-11-02; _docs/assignment-submission-contract.md):
 *
 * - `submitted`: `td.submissionstatussubmitted` "Submitted for grading". Observed on SDU
 *   (_docs/compatibility/sdu-moodle.md, Addenda 5 and 6; fixture observed/assign-submitted.html).
 * - `not_submitted`: a class-less status cell "No submissions have been made yet". Observed on
 *   SDU (Addenda 5 and 6; fixture observed/assign-not-submitted.html).
 * - `draft`: `td.submissionstatusdraft` "Draft (not submitted)" and
 *   `reopened`: `td.submissionstatusreopened` "Reopened". Upstream, NOT seen on SDU:
 *   moodle/moodle MOODLE_405_STABLE c0690bbc765fccacd4956452cbff3f6aacad77c5,
 *   mod/assign/lang/en/assign.php keys `submissionstatus_draft` / `submissionstatus_reopened`,
 *   cell class `'submissionstatus' . <status>` from mod/assign/classes/output/renderer.php,
 *   cited 2026-11-02. They stay Unavailable / UNVERIFIED on SDU.
 * - `unknown`: everything else (unrecognised wording, other languages, a class and text that
 *   disagree, no or conflicting status rows, `submissionstatusmarked` "Graded", team or
 *   `new` submissions, inaccessible or unreadable pages).
 *
 * The actual #10 `detectMoodleAccess` runs first. Its `accessible` verdict needs the synthetic
 * #10 session navigation and `main[data-region]` markers, which #3 did not record on SDU
 * assignment pages, so an observed-structure page reports `ambiguous_content`. Only those two
 * reasons let the mapper read the page; every other access reason (signed out, denied, 404 and
 * other unsupported responses, network failure, transient or contradictory responses, invalid
 * envelopes) is `unknown` and carries that reason. The observed page structure
 * (`body#page-mod-assign-view`, `cmid-<id>` / `course-<id>`) is then required.
 *
 * Identity (QA on #16, 2026-11-02): the caller supplies the course and course-module ids it
 * requested. Every result carries both. A body class that shows either id must equal it, as must
 * the requested and final URL ids; otherwise `identity_mismatch`. Inaccessible pages show no body
 * class, so their result carries the caller's ids. A network failure without a final URL falls
 * back to the requested URL for the access check and identity.
 *
 * Only the `.submissionstatustable` row whose `th` is "Submission status" is read. Body, title,
 * headings, grade, grading-status, comments, file-submission and completion-control text is never
 * evidence, so a grade never implies `submitted` and a personal completion check never changes
 * the result. A recognised state needs the exact class AND the exact English text (after
 * whitespace normalisation); not-submitted needs a cell with no `submissionstatus*` class.
 * `actionRequired` is true only for the explicit `submissionstatusreopened` "Reopened" cell.
 *
 * `state` values are exactly the #5 `SubmissionStatus` enum, the strings
 * `backend/submission_retention.py:retain_submission` accepts. Storing results is #81.
 * Pure and read-only: no fetch, navigation, storage, logging or DOM writes. Diagnostics are
 * fixed codes; wording is only the scoped status-cell text of a recognised state.
 */
import {
  detectMoodleAccess,
  type MoodleAccessInput,
  type MoodleAccessReason,
  type MoodleAccessStatus,
} from "./moodle-access";
import { exact } from "./moodle-dates";
import type { SubmissionStatus } from "../../frontend/src/domain/types";

const origin = "https://moodle.sdu.edu.kz";
const assignPath = "/mod/assign/view.php";

export type SubmissionEvidenceBasis = "observed-sdu" | "upstream-not-seen-on-sdu";
interface RecognisedCell {
  readonly state: Exclude<SubmissionStatus, "unknown">;
  readonly wording: string;
  readonly cellClass: string | null;
  readonly evidenceBasis: SubmissionEvidenceBasis;
}
/** The only recognised status cells. `cellClass: null` means a cell without any `submissionstatus*` class. */
export const RECOGNISED_SUBMISSION_CELLS: readonly RecognisedCell[] = Object.freeze([
  Object.freeze({ state: "submitted", wording: "Submitted for grading", cellClass: "submissionstatussubmitted", evidenceBasis: "observed-sdu" } as const),
  Object.freeze({ state: "not_submitted", wording: "No submissions have been made yet", cellClass: null, evidenceBasis: "observed-sdu" } as const),
  Object.freeze({ state: "draft", wording: "Draft (not submitted)", cellClass: "submissionstatusdraft", evidenceBasis: "upstream-not-seen-on-sdu" } as const),
  Object.freeze({ state: "reopened", wording: "Reopened", cellClass: "submissionstatusreopened", evidenceBasis: "upstream-not-seen-on-sdu" } as const),
]);

/** Fixed reasons for an `unknown` result. */
export type SubmissionUnknownReason =
  | "inaccessible"
  | "missing_structure"
  | "unsupported_language"
  | "missing_status_row"
  | "conflicting_status_rows"
  | "malformed_status_row"
  | "unrecognised_status"
  | "class_text_mismatch";
export type SubmissionStatusError = "invalid_observed_at" | "unsafe_url" | "identity_mismatch";

export interface SubmissionStatusObservation {
  state: SubmissionStatus;
  /** Scoped status-cell text of a recognised state; absent for `unknown`. */
  wording?: string;
  /** Absent for `unknown`. */
  evidenceBasis?: SubmissionEvidenceBasis;
  /** True only for the explicit upstream reopened cell. */
  actionRequired: boolean;
  /** Caller-supplied, kept character for character. */
  observedAt: string;
  /** Canonical `https://moodle.sdu.edu.kz/mod/assign/view.php?id=<cmid>`. */
  sourceUrl: string;
  /** From body class `course-<id>`, which must equal the caller's expected id; the caller's
   *  expected id when the page shows no class (e.g. an inaccessible page). */
  sourceCourseId: string;
  sourceCourseModuleId: string;
  /** The #10 detector verdict, as fixed primitives. */
  access: { status: MoodleAccessStatus; reason: MoodleAccessReason };
  /** Present only for `unknown`. */
  unknownReason?: SubmissionUnknownReason;
}
/**
 * The scan always knows which course and assignment it requested, so it supplies both ids.
 * Page evidence never overrides them: a `course-<id>` / `cmid-<id>` body class, the requested
 * URL id and the final URL id must all equal them, or the result is `identity_mismatch`.
 */
export interface SubmissionStatusInput extends MoodleAccessInput {
  readonly expectedSourceCourseId: string;
  readonly expectedSourceCourseModuleId: string;
}
export type SubmissionStatusResult =
  | { status: "observed"; observation: SubmissionStatusObservation }
  | { status: "error"; error: SubmissionStatusError };

/** Access reasons that still allow the scoped DOM read (see the module comment). */
const readable = new Set<MoodleAccessReason>(["accessible", "ambiguous_content"]);

const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/gu, " ").trim();

/** A zoned instant with any number of fraction digits; validated, never rewritten. */
function validObservedAt(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return exact(value.replace(/(\.\d{3})\d+/, "$1"));
}

/** Exactly `https://moodle.sdu.edu.kz[:443]/mod/assign/view.php?id=<positive decimal>`, nothing else. */
function assignId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^https:\/\/moodle\.sdu\.edu\.kz(?::443)?\/mod\/assign\/view\.php\?id=([1-9][0-9]*)$/.exec(raw);
  return m ? m[1]! : null;
}
function trustedUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || /[\s\\]/.test(raw) || !/^https:\/\/moodle\.sdu\.edu\.kz(?::443)?\//.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "moodle.sdu.edu.kz" && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function classId(node: Element, prefix: string): string | null | "invalid" {
  const ids = Array.from(node.classList).filter(c => c.startsWith(prefix)).map(c => c.slice(prefix.length));
  if (!ids.length) return null;
  return ids.length === 1 && /^[1-9][0-9]*$/.test(ids[0]!) ? ids[0]! : "invalid";
}

type Classified = Pick<SubmissionStatusObservation, "state" | "wording" | "evidenceBasis" | "unknownReason">;
const unknown = (unknownReason: SubmissionUnknownReason): Classified => ({ state: "unknown", unknownReason });

function classifyCell(cell: Element): Classified {
  const statusClasses = Array.from(cell.classList).filter(c => c.startsWith("submissionstatus"));
  const text = normalize(cell.textContent);
  if (statusClasses.length > 1) return unknown("class_text_mismatch");
  const cellClass = statusClasses[0] ?? null;
  const byClass = RECOGNISED_SUBMISSION_CELLS.find(c => c.cellClass === cellClass);
  const byText = RECOGNISED_SUBMISSION_CELLS.find(c => c.wording === text);
  if (byClass && byText === byClass) {
    return { state: byClass.state, wording: byClass.wording, evidenceBasis: byClass.evidenceBasis };
  }
  // Recognised wording in a cell whose class belongs to another state (or to none): they disagree.
  if (byText) return unknown("class_text_mismatch");
  // Unrecognised wording or class, including other languages and `submissionstatusmarked` "Graded".
  return unknown("unrecognised_status");
}

function classifyPage(doc: Document): Classified {
  const rows = Array.from(doc.querySelectorAll(".submissionstatustable tr")).filter(row => {
    const headers = Array.from(row.children).filter(c => c.localName === "th");
    return headers.length > 0 && headers.some(th => normalize(th.textContent) === "Submission status");
  });
  if (!rows.length) return unknown("missing_status_row");
  if (rows.length > 1) return unknown("conflicting_status_rows");
  const children = Array.from(rows[0]!.children);
  const headers = children.filter(c => c.localName === "th"), cells = children.filter(c => c.localName === "td");
  if (headers.length !== 1 || cells.length !== 1 || children.length !== 2) return unknown("malformed_status_row");
  return classifyCell(cells[0]!);
}

const positiveId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
/** A network failure may come without a final URL; identity then falls back to the requested URL. */
const noFinalUrl = (input: MoodleAccessInput) =>
  input.networkFailure === true && (input.finalUrl === undefined || input.finalUrl === null || input.finalUrl === "");

export function parseMoodleSubmissionStatus(input: SubmissionStatusInput, observedAt: string): SubmissionStatusResult {
  // The #10 detector runs first; it never throws and returns fixed primitives. A network failure
  // without a final URL is checked with the requested URL in its place, so it reports network_failure.
  let envelope: MoodleAccessInput = input;
  try { if (input && noFinalUrl(input)) envelope = { ...input, finalUrl: input.requestedUrl }; } catch { /* detector reports it */ }
  const detected = detectMoodleAccess(envelope);
  const access = { status: detected.status, reason: detected.reason };
  const error = (code: SubmissionStatusError): SubmissionStatusResult => ({ status: "error", error: code });
  let identity: { cmid: string; course: string } | undefined;
  const result = (classified: Classified): SubmissionStatusResult => ({
    status: "observed",
    observation: {
      ...classified, actionRequired: classified.state === "reopened", observedAt,
      sourceUrl: `${origin}${assignPath}?id=${identity!.cmid}`,
      sourceCourseId: identity!.course, sourceCourseModuleId: identity!.cmid, access,
    },
  });
  try {
    if (!validObservedAt(observedAt)) return error("invalid_observed_at");
    const cmid = assignId(input?.requestedUrl);
    if (!cmid) return error("unsafe_url");
    const final = trustedUrl(envelope.finalUrl);
    if (!final) return error("unsafe_url");
    const expectedCourse = input.expectedSourceCourseId, expectedCmid = input.expectedSourceCourseModuleId;
    if (!positiveId(expectedCourse) || !positiveId(expectedCmid) || cmid !== expectedCmid) return error("identity_mismatch");
    identity = { cmid, course: expectedCourse };
    // Inaccessible pages (including the observed HTTP 200 redirect to /login/index.php) stay unknown
    // and carry the caller's ids: such pages show no body classes.
    if (!readable.has(detected.reason) || input.httpStatus !== 200 || final.pathname === "/login/index.php") {
      return result(unknown("inaccessible"));
    }
    const finalId = assignId(envelope.finalUrl);
    if (!finalId) return error("unsafe_url");
    if (finalId !== cmid) return error("identity_mismatch");
    const doc = input.document;
    // Body classes are checked before any other structure, so a page that fails a later check
    // still carries the course id its own `course-<id>` class shows (equal to the expected id).
    const bodyCm = classId(doc.body, "cmid-"), course = classId(doc.body, "course-");
    if (bodyCm === "invalid" || course === "invalid" || (bodyCm && bodyCm !== cmid) ||
        (course && course !== expectedCourse)) return error("identity_mismatch");
    if (course) identity = { cmid, course };
    if (doc.body.id !== "page-mod-assign-view" || !bodyCm || !course) return result(unknown("missing_structure"));
    const lang = doc.documentElement.getAttribute("lang");
    const bodyLangs = Array.from(doc.body.classList).filter(c => c.startsWith("lang-"));
    if (lang !== "en" || bodyLangs.some(c => c !== "lang-en")) return result(unknown("unsupported_language"));
    return result(classifyPage(doc));
  } catch {
    // An unreadable runtime DOM is unknown only when the source identity was already established.
    return identity ? result(unknown("missing_structure")) : error("unsafe_url");
  }
}
