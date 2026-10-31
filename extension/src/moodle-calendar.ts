/** Invented structural calendar contract; live SDU compatibility is unverified. */
import {
  detectMoodleAccess,
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
  return m && canonical(raw, path, `?id=${m[1]}`) ? m[1] : null;
}
function signature(c: CalendarCandidate): string {
  const dates = (["start", "end", "date"] as const).map((field) => {
    const d = c[field];
    if (!d) return null;
    const v = d.value;
    if (v.kind === "exact") {
      const precision = /T\d\d:\d\d(Z|[+-])/.test(v.iso)
        ? "minute"
        : (/\.(\d{1,3})/.exec(v.iso)?.[1].length ?? "second");
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
  const title = normalize(headings[0].textContent ?? "");
  const query = `?event=${event}${occurrence === null ? "" : `&occurrence=${occurrence}`}`;
  if (
    !title ||
    !canonical(links[0].getAttribute("href"), "/calendar/view.php", query)
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
    ? linkedId(courses[0].getAttribute("href"), "/course/view.php")
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
    const a = activities[0],
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
      exclusionReason?: CalendarCollection["exclusions"][number]["reason"];
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
      const main = mains[0],
        headings = main.querySelectorAll("h1"),
        start = main.getAttribute("data-range-start") ?? "",
        end = main.getAttribute("data-range-end") ?? "";
      if (
        headings.length !== 1 ||
        !normalize(headings[0].textContent ?? "") ||
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
          result.pages[index].coverage = "partial";
        });
      }
      if (item.exclusionReason) continue;
      if (item.reasons.length) {
        result.review.push({
          candidate: item.candidate,
          reasons: [...new Set(item.reasons)],
        });
        item.pages.forEach((index) => {
          result.pages[index].coverage = "partial";
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
