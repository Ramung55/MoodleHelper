/** Invented structural calendar contract; live SDU compatibility is unverified. */
import {
  detectMoodleAccess,
  detectObservedMoodleAccess,
  type MoodleAccessInput,
  type MoodleAccessResult,
} from "./moodle-access";
import { realDay, exact, dateValue } from "./moodle-dates";
import type { DateValue } from "../../frontend/src/domain/types";
export interface CalendarDateObservation {
  value: DateValue;
  rawText: string;
  location: string;
}
export interface CalendarCandidate {
  sourceEventId: string;
  sourceOccurrenceId?: string;
  sourceSeriesId?: string;
  sourceCourseId?: string;
  title: string;
  sourceUrl: string;
  observedAt: string;
  start?: CalendarDateObservation;
  end?: CalendarDateObservation;
  date?: CalendarDateObservation;
  activity?: {
    moduleType: "assign" | "quiz";
    sourceActivityId: string;
    sourceCourseModuleId: string;
    sourceUrl: string;
  };
}
export interface RawCalendarObservation extends CalendarCandidate {
  sourceCourseId: string;
}
export type CalendarReviewReason =
  | "unknown_kind"
  | "missing_course"
  | "unreliable_course"
  | "unknown_date"
  | "missing_dates"
  | "event_conflict";
export interface CalendarReview {
  candidate: CalendarCandidate;
  reasons: CalendarReviewReason[];
}
type Coverage = "complete" | "partial" | "none";
type Diagnostic = {
  reason:
    | "access_error"
    | "invalid_batch_arguments"
    | "invalid_page"
    | "malformed_record"
    | "empty_marker";
  pageIndex: number;
  recordIndex?: number;
};
export interface CalendarPage {
  access: MoodleAccessResult;
  range?: { start: string; end: string };
  coverage: Coverage;
  candidateCount: number;
  paginationPending: boolean;
}
export interface CalendarCollection {
  observations: RawCalendarObservation[];
  review: CalendarReview[];
  exclusions: {
    reason:
      "site_event" | "personal_event" | "non_assessment" | "unselected_course";
    pageIndex: number;
    recordIndex: number;
  }[];
  diagnostics: Diagnostic[];
  pages: CalendarPage[];
  coverage: Coverage;
  scope: "supplied_ranges_only";
  error?: "invalid_batch_arguments";
}
const origin = "https://moodle.sdu.edu.kz";
const normalize = (s: string) => s.replace(/\s+/gu, " ").trim();
const idValid = (s: unknown): s is string =>
  typeof s === "string" && /^[1-9][0-9]*$/.test(s);
function canonical(raw: string | null, path: string, query = ""): boolean {
  return (
    raw !== null &&
    (raw === path + query ||
      raw === origin + path + query ||
      raw === origin + ":443" + path + query)
  );
}
function linkedId(raw: string | null, path: string): string | null {
  const m = /\?id=([1-9][0-9]*)$/.exec(raw ?? "");
  // Group 1 is required in the regex, so it is defined whenever m is.
  return m && canonical(raw, path, `?id=${m[1]}`) ? m[1]! : null;
}
function signature(c: CalendarCandidate): string {
  const dates = (["start", "end", "date"] as const).map((field) => {
    const d = c[field];
    if (!d) return null;
    const v = d.value;
    if (v.kind === "exact") {
      const precision = /T\d\d:\d\d(Z|[+-])/.test(v.iso)
        ? "minute"
        : // Group 1 is required in the regex, so it is defined whenever exec matches.
          (/\.(\d{1,3})/.exec(v.iso)?.[1]!.length ?? "second");
      return [Date.parse(v.iso), precision];
    }
    return [v, v.kind === "unknown" ? d.rawText : null];
  });
  return JSON.stringify([
    c.title,
    c.sourceCourseId ?? null,
    c.sourceSeriesId ?? null,
    c.activity ?? null,
    dates,
  ]);
}
function parseArticle(
  article: Element,
  observedAt: string,
): {
  candidate: CalendarCandidate;
  reasons: CalendarReviewReason[];
  kind: string | null;
} | null {
  if (
    article.getAttribute("data-region") !== "calendar-event" ||
    article.querySelector("article")
  )
    return null;
  const event = article.getAttribute("data-event-id"),
    occurrence = article.getAttribute("data-occurrence-id"),
    series = article.getAttribute("data-series-id");
  if (
    !idValid(event) ||
    ((occurrence !== null || series !== null) &&
      (!idValid(occurrence) || !idValid(series)))
  )
    return null;
  const headings = article.querySelectorAll("h2"),
    links = article.querySelectorAll('a[data-role="event-link"]');
  if (headings.length !== 1 || links.length !== 1) return null;
  // headings.length is checked to be 1 above, so index 0 is defined.
  const title = normalize(headings[0]!.textContent ?? "");
  const query = `?event=${event}${occurrence === null ? "" : `&occurrence=${occurrence}`}`;
  if (
    !title ||
    // links.length is checked to be 1 above, so index 0 is defined.
    !canonical(links[0]!.getAttribute("href"), "/calendar/view.php", query)
  )
    return null;
  const candidate: CalendarCandidate = {
    sourceEventId: event,
    title,
    sourceUrl: `${origin}/calendar/view.php${query}`,
    observedAt,
  };
  if (occurrence !== null && series !== null) {
    candidate.sourceOccurrenceId = occurrence;
    candidate.sourceSeriesId = series;
  }
  const reasons: CalendarReviewReason[] = [];
  const course = article.getAttribute("data-course-id"),
    courses = article.querySelectorAll('a[data-role="course-link"]');
  if ((course !== null && !idValid(course)) || courses.length > 1) return null;
  const linkedCourse = courses.length
    ? // This branch runs only when courses.length is non-zero.
      linkedId(courses[0]!.getAttribute("href"), "/course/view.php")
    : null;
  if (courses.length && !linkedCourse) return null;
  if (course === null) reasons.push("missing_course");
  else if (!linkedCourse || linkedCourse !== course)
    reasons.push("unreliable_course");
  else candidate.sourceCourseId = course;
  const activities = article.querySelectorAll('a[data-role="activity-link"]');
  if (
    activities.length > 1 ||
    article.querySelector(
      '[data-activity-id]:not(a[data-role="activity-link"])',
    )
  )
    return null;
  if (activities.length) {
    // This block runs only when activities.length is non-zero.
    const a = activities[0]!,
      instance = a.getAttribute("data-activity-id");
    const assign = linkedId(a.getAttribute("href"), "/mod/assign/view.php"),
      quiz = linkedId(a.getAttribute("href"), "/mod/quiz/view.php");
    if (!idValid(instance) || (!assign && !quiz)) return null;
    const moduleType = assign ? "assign" : "quiz",
      cm = (assign ?? quiz)!;
    candidate.activity = {
      moduleType,
      sourceActivityId: instance,
      sourceCourseModuleId: cm,
      sourceUrl: `${origin}/mod/${moduleType}/view.php?id=${cm}`,
    };
  }
  for (const node of article.querySelectorAll(
    "time, [datetime], [data-date-field], [data-date-unknown], [data-timezone]",
  )) {
    const field = node.getAttribute("data-date-field");
    if (
      (field !== "start" && field !== "end" && field !== "date") ||
      candidate[field]
    )
      return null;
    const rawText = normalize(node.textContent ?? "");
    if (!rawText) return null;
    let value: DateValue | null;
    if (
      node.localName === "span" &&
      node.hasAttribute("data-date-unknown") &&
      !node.hasAttribute("datetime") &&
      !node.hasAttribute("data-timezone")
    ) {
      value = { kind: "unknown" };
      reasons.push("unknown_date");
    } else if (
      node.localName === "time" &&
      !node.hasAttribute("data-date-unknown")
    )
      value = dateValue(node);
    else return null;
    if (
      !value ||
      (field === "date" && value.kind !== "date" && value.kind !== "unknown")
    )
      return null;
    candidate[field] = { value, rawText, location: `calendar.${field}` };
  }
  if (candidate.date && (candidate.start || candidate.end)) return null;
  if (!candidate.start && !candidate.end && !candidate.date)
    reasons.push("missing_dates");
  const start = candidate.start?.value,
    end = candidate.end?.value;
  if (
    (start?.kind === "exact" &&
      end?.kind === "exact" &&
      Date.parse(end.iso) < Date.parse(start.iso)) ||
    (start?.kind === "date" && end?.kind === "date" && end.date < start.date)
  )
    return null;
  const kind = article.getAttribute("data-event-kind");
  if (!["assessment", "site", "personal", "other"].includes(kind ?? ""))
    reasons.push("unknown_kind");
  return { candidate, reasons: [...new Set(reasons)], kind };
}
export function collectMoodleCalendar(
  inputs: readonly MoodleAccessInput[],
  selectedSourceCourseIds: readonly string[],
  observedAt: string,
): CalendarCollection {
  const result: CalendarCollection = {
    observations: [],
    review: [],
    exclusions: [],
    diagnostics: [],
    pages: [],
    coverage: "none",
    scope: "supplied_ranges_only",
  };
  const validBatch =
    Array.isArray(selectedSourceCourseIds) &&
    selectedSourceCourseIds.every(idValid) &&
    typeof observedAt === "string" &&
    exact(observedAt);
  if (!validBatch) result.error = "invalid_batch_arguments";
  const groups = new Map<
    string,
    {
      candidate: CalendarCandidate;
      reasons: CalendarReviewReason[];
      pages: Set<number>;
      signature: string;
      selected: boolean;
      exclusionReason?:
        | CalendarCollection["exclusions"][number]["reason"]
        | undefined;
      pageIndex: number;
      recordIndex: number;
    }[]
  >();
  inputs.forEach((input, pageIndex) => {
    const access = detectMoodleAccess(input);
    const page: CalendarPage = {
      access,
      coverage: "none",
      candidateCount: 0,
      paginationPending: false,
    };
    result.pages.push(page);
    const diagnostic = (reason: Diagnostic["reason"], recordIndex?: number) =>
      result.diagnostics.push({
        reason,
        pageIndex,
        ...(recordIndex === undefined ? {} : { recordIndex }),
      });
    if (access.status !== "accessible") {
      diagnostic("access_error");
      return;
    }
    if (!validBatch) {
      diagnostic("invalid_batch_arguments");
      return;
    }
    try {
      const mains = input.document.querySelectorAll(
        'main[data-region="calendar"]',
      );
      if (
        !canonical(input.requestedUrl, "/calendar/view.php") ||
        !canonical(input.finalUrl, "/calendar/view.php") ||
        mains.length !== 1
      ) {
        diagnostic("invalid_page");
        return;
      }
      // The check above returned unless mains has exactly one element.
      const main = mains[0]!,
        headings = main.querySelectorAll("h1"),
        start = main.getAttribute("data-range-start") ?? "",
        end = main.getAttribute("data-range-end") ?? "";
      if (
        headings.length !== 1 ||
        // headings.length !== 1 is checked first, so index 0 is defined here.
        !normalize(headings[0]!.textContent ?? "") ||
        !realDay(start) ||
        !realDay(end) ||
        start > end
      ) {
        diagnostic("invalid_page");
        return;
      }
      page.range = { start, end };
      page.coverage = "complete";
      page.paginationPending = !!main.querySelector(
        'nav[data-region="calendar-pagination"] a[href], nav[data-region="calendar-pagination"] button',
      );
      if (
        page.paginationPending ||
        main.hasAttribute("data-incomplete") ||
        main.hasAttribute("data-truncated")
      )
        page.coverage = "partial";
      const articles = main.querySelectorAll("article");
      page.candidateCount = articles.length;
      const empty = main.querySelectorAll('[data-role="calendar-empty"]');
      if (
        (!articles.length && empty.length !== 1) ||
        (articles.length && empty.length)
      ) {
        diagnostic("empty_marker");
        page.coverage = "partial";
      }
      articles.forEach((article, recordIndex) => {
        if (article.parentElement?.closest("article")) {
          diagnostic("malformed_record", recordIndex);
          page.coverage = "partial";
          return;
        }
        const parsed = parseArticle(article, observedAt);
        if (
          !parsed ||
          article.hasAttribute("data-incomplete") ||
          article.hasAttribute("data-truncated")
        ) {
          diagnostic("malformed_record", recordIndex);
          page.coverage = "partial";
          return;
        }
        const { candidate, reasons, kind } = parsed;
        const selected =
          candidate.sourceCourseId !== undefined &&
          selectedSourceCourseIds.includes(candidate.sourceCourseId);
        const exclusionReason =
          kind === "site"
            ? "site_event"
            : kind === "personal"
              ? "personal_event"
              : kind === "other"
                ? "non_assessment"
                : kind === "assessment" &&
                    candidate.sourceCourseId !== undefined &&
                    !selected
                  ? "unselected_course"
                  : undefined;
        if (exclusionReason)
          result.exclusions.push({
            reason: exclusionReason,
            pageIndex,
            recordIndex,
          });
        if (reasons.length && !exclusionReason) page.coverage = "partial";
        const key = JSON.stringify([
            candidate.sourceEventId,
            candidate.sourceOccurrenceId ?? null,
          ]),
          sig = signature(candidate) + JSON.stringify(kind);
        const group = groups.get(key) ?? [];
        const same = group.find((item) => item.signature === sig);
        if (same) {
          same.pages.add(pageIndex);
          same.reasons = [...new Set([...same.reasons, ...reasons])];
        } else
          group.push({
            candidate,
            reasons,
            pages: new Set([pageIndex]),
            signature: sig,
            selected,
            exclusionReason,
            pageIndex,
            recordIndex,
          });
        groups.set(key, group);
      });
    } catch {
      diagnostic("invalid_page");
      page.coverage = "none";
      delete page.range;
    }
  });
  for (const group of groups.values()) {
    const conflict = group.length > 1;
    for (const item of group) {
      if (conflict) {
        item.reasons.push("event_conflict");
        item.pages.forEach((index) => {
          // Every index in item.pages is a pageIndex whose page was pushed into result.pages.
          result.pages[index]!.coverage = "partial";
        });
      }
      if (item.exclusionReason) continue;
      if (item.reasons.length) {
        result.review.push({
          candidate: item.candidate,
          reasons: [...new Set(item.reasons)],
        });
        item.pages.forEach((index) => {
          // Every index in item.pages is a pageIndex whose page was pushed into result.pages.
          result.pages[index]!.coverage = "partial";
        });
      } else if (item.selected)
        result.observations.push(item.candidate as RawCalendarObservation);
    }
  }
  result.coverage =
    result.pages.length && result.pages.every((p) => p.coverage === "complete")
      ? "complete"
      : result.pages.some((p) => p.range)
        ? "partial"
        : "none";
  return result;
}

/**
 * #83 observed SDU upcoming calendar (#3 live inspection 2026-11-01, compatibility
 * report "Calendar" table and matrix row 8; fixture observed/calendar-upcoming.html).
 * The one verified page is `/calendar/view.php?view=upcoming`, English (`lang-en`).
 *
 * - Events are `div.calendar-event-box[data-type="event"]` with `data-event-id`,
 *   `data-course-id`, `data-event-component`, `data-event-eventtype` and
 *   `data-event-title` ("<name> is due"; the suffix is stripped from the title).
 * - The time comes only from the day link `/calendar/view.php?view=day&time=<epoch>`
 *   (epoch precision), shown in UTC+5 (Asia/Almaty). The displayed date text is an
 *   assumed format (manifest `unrecordedFields`) and is never read; the date's raw
 *   text is the observed event title.
 * - The cmid comes from the action link `/mod/assign/view.php?id=<cmid>&action=editsubmission`,
 *   which is never requested, followed or returned. The assignment instance id is not
 *   observable, so, as in the #14 quiz adapter, the cmid stands in as `sourceActivityId`.
 * - Only `mod_assign` / `due` events were observed. Others go to review (`unknown_kind`);
 *   a missing course goes to review (`missing_course`); a missing or non-numeric epoch
 *   gives no date (`missing_dates`); an event outside the selection is an
 *   `unselected_course` exclusion; one event id with different values is `event_conflict`.
 * - Only the upcoming window was seen and calendar pagination is UNVERIFIED, so coverage
 *   is never `complete`.
 * Pure and read-only; access is #20's observed check (route `calendar-upcoming`).
 */
export const UPCOMING_CALENDAR_URL = `${origin}/calendar/view.php?view=upcoming`;

/** Exact `+05:00` (Asia/Almaty) instant of a Unix epoch in seconds, or null. */
export function observedEpochIso(epoch: string): string | null {
  if (!/^[1-9][0-9]{0,11}$/.test(epoch)) return null;
  const shifted = new Date((Number(epoch) + 5 * 3600) * 1000);
  if (Number.isNaN(shifted.getTime())) return null;
  const iso = shifted.toISOString().slice(0, 19) + "+05:00";
  return exact(iso) ? iso : null;
}
/** Live pages use `href`; observed-structure fixtures keep the same relative target in `data-href`. */
function linkTarget(node: Element): string | null {
  return node.getAttribute("href") ?? node.getAttribute("data-href");
}
/** The one day-link epoch of an event box; null when absent, "invalid" when malformed or ambiguous. */
function dayLinkEpoch(box: Element): string | null | "invalid" {
  const epochs = new Set<string>();
  for (const a of box.querySelectorAll("a")) {
    const raw = linkTarget(a);
    if (!raw || !raw.includes("/calendar/view.php")) continue;
    const m = /^(?:https:\/\/moodle\.sdu\.edu\.kz)?\/calendar\/view\.php\?view=day&time=([^&#]*)$/.exec(raw);
    epochs.add(m && /^[1-9][0-9]*$/.test(m[1]!) ? m[1]! : "invalid");
  }
  if (!epochs.size) return null;
  return epochs.size === 1 ? [...epochs][0]! : "invalid";
}
function actionLinkCmid(box: Element): string | null {
  const ids = new Set<string>();
  for (const a of box.querySelectorAll("a")) {
    const m = /^(?:https:\/\/moodle\.sdu\.edu\.kz)?\/mod\/assign\/view\.php\?id=([1-9][0-9]*)&action=editsubmission$/.exec(linkTarget(a) ?? "");
    if (m) ids.add(m[1]!);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

export function collectObservedMoodleCalendar(
  input: MoodleAccessInput,
  selectedSourceCourseIds: readonly string[],
  observedAt: string,
): CalendarCollection {
  const result: CalendarCollection = { observations: [], review: [], exclusions: [], diagnostics: [], pages: [], coverage: "none", scope: "supplied_ranges_only" };
  const validBatch = Array.isArray(selectedSourceCourseIds) && selectedSourceCourseIds.every(idValid) &&
    typeof observedAt === "string" && exact(observedAt);
  const access: MoodleAccessResult = input && input.requestedUrl === UPCOMING_CALENDAR_URL
    ? detectObservedMoodleAccess(input, { kind: "calendar-upcoming" })
    : { status: "unsupported", retryable: false, reason: "unsupported_route", message: "This page route is not supported." };
  const page: CalendarPage = { access, coverage: "none", candidateCount: 0, paginationPending: false };
  result.pages.push(page);
  const diagnostic = (reason: Diagnostic["reason"], recordIndex?: number) =>
    result.diagnostics.push({ reason, pageIndex: 0, ...(recordIndex === undefined ? {} : { recordIndex }) });
  if (access.status !== "accessible") { diagnostic("access_error"); return result; }
  if (!validBatch) { result.error = "invalid_batch_arguments"; diagnostic("invalid_batch_arguments"); return result; }
  try {
    const doc = input.document, langs = Array.from(doc.body.classList).filter(c => c.startsWith("lang-"));
    // Only the English interface was observed; RU/KK pages are not interpreted.
    if (doc.documentElement.getAttribute("lang") !== "en" || langs.length !== 1 || langs[0] !== "lang-en") { diagnostic("invalid_page"); return result; }
    const boxes = Array.from(doc.querySelectorAll('div.calendar-event-box[data-type="event"]'));
    page.candidateCount = boxes.length;
    page.coverage = "partial";
    const groups = new Map<string, { candidate: CalendarCandidate; reasons: CalendarReviewReason[]; signature: string; selected: boolean; excluded: boolean }[]>();
    boxes.forEach((box, recordIndex) => {
      if (box.parentElement?.closest("div.calendar-event-box")) { diagnostic("malformed_record", recordIndex); return; }
      const event = box.getAttribute("data-event-id"), course = box.getAttribute("data-course-id");
      const rawTitle = normalize(box.getAttribute("data-event-title") ?? "");
      if (!idValid(event) || (course !== null && !idValid(course)) || !rawTitle) { diagnostic("malformed_record", recordIndex); return; }
      const reasons: CalendarReviewReason[] = [];
      const due = box.getAttribute("data-event-component") === "mod_assign" && box.getAttribute("data-event-eventtype") === "due";
      if (!due) reasons.push("unknown_kind");
      const title = due && rawTitle.endsWith(" is due") ? normalize(rawTitle.slice(0, -" is due".length)) : rawTitle;
      if (!title) { diagnostic("malformed_record", recordIndex); return; }
      const candidate: CalendarCandidate = { sourceEventId: event, title, sourceUrl: `${origin}/calendar/view.php?event=${event}`, observedAt };
      if (course === null) reasons.push("missing_course");
      else candidate.sourceCourseId = course;
      const epoch = dayLinkEpoch(box);
      const iso = epoch !== null && epoch !== "invalid" ? observedEpochIso(epoch) : null;
      if (iso) candidate.start = { value: { kind: "exact", iso, tz: "Asia/Almaty" }, rawText: rawTitle, location: "calendar.start" };
      else reasons.push("missing_dates");
      const cmid = due ? actionLinkCmid(box) : null;
      if (cmid) candidate.activity = { moduleType: "assign", sourceActivityId: cmid, sourceCourseModuleId: cmid, sourceUrl: `${origin}/mod/assign/view.php?id=${cmid}` };
      const selected = course !== null && selectedSourceCourseIds.includes(course);
      const excluded = course !== null && !selected;
      if (excluded) result.exclusions.push({ reason: "unselected_course", pageIndex: 0, recordIndex });
      const sig = signature(candidate) + JSON.stringify([due, reasons]);
      const group = groups.get(event) ?? [];
      if (!group.some(item => item.signature === sig)) group.push({ candidate, reasons, signature: sig, selected, excluded });
      groups.set(event, group);
    });
    for (const group of groups.values()) {
      for (const item of group) {
        if (group.length > 1) item.reasons.push("event_conflict");
        if (item.excluded) continue;
        if (item.reasons.length) result.review.push({ candidate: item.candidate, reasons: [...new Set(item.reasons)] });
        else if (item.selected) result.observations.push(item.candidate as RawCalendarObservation);
      }
    }
    // Only the upcoming window was observed; calendar pagination is UNVERIFIED.
    result.coverage = "partial";
  } catch {
    diagnostic("invalid_page");
    page.coverage = "none";
  }
  return result;
}
