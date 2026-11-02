/**
 * #11 synthetic/unobserved DOM policy; no claim of live SDU compatibility (#3).
 * Read-only batch, one caller dataset; no fetch, storage, selection or DOM writes.
 * This raw contract is NOT Course/Snapshot: #12/ingestion must resolve required
 * code/color/current and namespace identity before persistence. trackedCourseIds
 * remains personal. IDs are canonical positive decimal STRINGS (no precision loss).
 *
 * Supported lists: #10-accessible /my/ or /course/index.php; exactly one
 * main[data-region=courses] with h1. Cards are article[data-course-id], containing
 * exactly one a[data-role=course-link][href]. Title uses data-role=course-title;
 * multiple data-role=course-term elements explicitly supply multiple indicators.
 * Course href query vocabulary is literally ?id=<canonical decimal>, with no
 * encoded aliases or empty trailing parameters. URLs are rebuilt from the ID.
 * Text is whitespace-normalized; absent/blank fields are explicit unknown.
 * nav[data-region=course-pagination] with a[href], button, or rel=next signals
 * pending pages. data-incomplete or data-truncated on main prevents completeness.
 * data-role=courses-empty is the explicit empty state (incompatible with cards).
 * Missing structure, nested cards, duplicate title nodes and skipped candidates
 * prevent completeness. Diagnostics expose only fixed reasons and numeric indices.
 *
 * Dedup by string ID, first-seen order; unknowns may fill from known duplicates.
 * Conflicting known title/term sets become sticky unknown (never last-writer wins).
 * Term sets are sorted/deduplicated; conflicting sets are not silently unioned.
 * Empty lists still require genuine #10 evidence, e.g. an ordinary course-index
 * navigation link in main; the empty marker cannot establish authentication.
 * complete means supplied synthetic structural page coverage ONLY, never proof
 * of live enrollment completeness. Any pagination remains partial across a batch.
 */
import { detectMoodleAccess, type MoodleAccessInput, type MoodleAccessResult } from "./moodle-access";

export type Observed<T> = { kind: "known"; value: T } | { kind: "unknown" };
export interface RawCourseObservation {
  sourceCourseId: string;
  sourceUrl: string;
  title: Observed<string>;
  termIndicators: Observed<string[]>;
  /** #84: the first shortname segment only (enrolled-courses parser). Absent means unknown. */
  code?: Observed<string>;
  /** #84: the classification the extension itself requested, never read from a response. */
  classification?: "inprogress";
}
export type DiscoveryCoverage = "complete" | "partial" | "none";
export type CourseDiagnosticReason = "unsupported_list_route" | "malformed_list" |
  "incomplete_list" | "pagination_pending" | "empty_unconfirmed" |
  "missing_identity" | "unsafe_url" | "identity_mismatch" | "malformed_card" |
  "title_conflict" | "term_conflict" | "malformed_response" | "page_cap_reached" | "code_conflict";
export interface CourseDiagnostic {
  pageIndex: number;
  recordIndex?: number;
  reason: CourseDiagnosticReason;
}
export interface CoursePageDiscovery {
  pageIndex: number;
  access: MoodleAccessResult;
  coverage: DiscoveryCoverage;
  paginationPending: boolean;
  candidateCount: number;
}
export interface CourseDiscovery {
  observations: RawCourseObservation[];
  pages: CoursePageDiscovery[];
  diagnostics: CourseDiagnostic[];
  coverage: DiscoveryCoverage;
  paginationPending: boolean;
  suppliedPageCount: number;
}

const unknown = (): { kind: "unknown" } => ({ kind: "unknown" });
const text = (node: Element): string => (node.textContent ?? "").replace(/\s+/gu, " ").trim();
const decimalId = (id: string | null): id is string => id !== null && /^[1-9][0-9]*$/.test(id);

function courseUrl(href: string | null, base: string): URL | null {
  if (!href || /[\s\\]/u.test(href) || /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i.test(href)) return null;
  try {
    const url = new URL(href, base);
    const keys = [...url.searchParams.keys()];
    if (url.protocol !== "https:" || url.hostname !== "moodle.sdu.edu.kz" ||
        url.username || url.password || url.port || url.pathname !== "/course/view.php" ||
        href.includes("#") || !/^\?id=[1-9][0-9]*$/.test(url.search) || keys.length !== 1 || keys[0] !== "id" ||
        !decimalId(url.searchParams.get("id"))) return null;
    return url;
  } catch { return null; }
}

/** Independently callable; input envelopes are evaluated by #10, never trusted labels. */
export function collectMoodleCourses(inputs: readonly MoodleAccessInput[]): CourseDiscovery {
  const observations: RawCourseObservation[] = [];
  const pages: CoursePageDiscovery[] = [];
  const diagnostics: CourseDiagnostic[] = [];
  const byId = new Map<string, RawCourseObservation>();
  const conflicts = new Map<string, Set<"title" | "termIndicators">>();
  inputs.forEach((input, pageIndex) => {
    const access = detectMoodleAccess(input);
    const page: CoursePageDiscovery = { pageIndex, access, coverage: "none", paginationPending: false, candidateCount: 0 };
    pages.push(page);
    const report = (reason: CourseDiagnosticReason, recordIndex?: number) => {
      diagnostics.push({ pageIndex, ...(recordIndex === undefined ? {} : { recordIndex }), reason });
    };
    if (access.status !== "accessible") return;
    // #10 has validated this URL/envelope; still isolate unexpected DOM failures.
    try {
      if (!["/my/", "/course/index.php"].includes(new URL(input.finalUrl).pathname)) {
        report("unsupported_list_route"); return;
      }
      const mains = input.document.querySelectorAll('main[data-region="courses"]');
      // mains.length is checked to be 1 before indexing, so index 0 is defined.
      if (mains.length !== 1 || !mains[0]!.querySelector("h1")) { report("malformed_list"); return; }
      // The check above returned unless mains has exactly one element.
      const main = mains[0]!;
      const cards = [...main.querySelectorAll("article")];
      page.candidateCount = cards.length;
      const start = diagnostics.length;
      page.paginationPending = !!input.document.querySelector(
        'nav[data-region="course-pagination"] a[href], nav[data-region="course-pagination"] button, nav[data-region="course-pagination"][rel="next"]',
      );
      if (page.paginationPending) report("pagination_pending");
      if (main.hasAttribute("data-incomplete") || main.hasAttribute("data-truncated")) report("incomplete_list");
      const empty = main.querySelectorAll('[data-role="courses-empty"]');
      if (empty.length > 1 || (cards.length && empty.length)) report("malformed_list");
      if (!cards.length && !empty.length) report("empty_unconfirmed");
      cards.forEach((card, recordIndex) => {
        if (card.parentElement?.closest("article") || card.querySelector("article")) {
          report("malformed_card", recordIndex); return;
        }
        const id = card.getAttribute("data-course-id");
        if (!decimalId(id)) { report("missing_identity", recordIndex); return; }
        const links = card.querySelectorAll('a[data-role="course-link"]');
        if (links.length !== 1) { report("unsafe_url", recordIndex); return; }
        // links.length is checked to be 1 above, so index 0 is defined.
        const url = courseUrl(links[0]!.getAttribute("href"), input.finalUrl);
        if (!url) { report("unsafe_url", recordIndex); return; }
        if (url.searchParams.get("id") !== id) { report("identity_mismatch", recordIndex); return; }
        const titles = card.querySelectorAll('[data-role="course-title"]');
        const terms = [...new Set([...card.querySelectorAll('[data-role="course-term"]')].map(text).filter(Boolean))].sort();
        // The ternary only indexes when titles.length is 1.
        const title = titles.length === 1 ? text(titles[0]!) : "";
        if (titles.length > 1) report("malformed_card", recordIndex);
        const next: RawCourseObservation = {
          sourceCourseId: id,
          sourceUrl: `https://moodle.sdu.edu.kz/course/view.php?id=${id}`,
          title: title ? { kind: "known", value: title } : unknown(),
          termIndicators: terms.length ? { kind: "known", value: terms } : unknown(),
        };
        const previous = byId.get(id);
        if (!previous) { byId.set(id, next); observations.push(next); return; }
        const sticky = conflicts.get(id) ?? new Set<"title" | "termIndicators">();
        conflicts.set(id, sticky);
        for (const field of ["title", "termIndicators"] as const) {
          const before = previous[field];
          const after = next[field];
          if (sticky.has(field) || after.kind === "unknown") continue;
          if (before.kind === "known" && JSON.stringify(before.value) !== JSON.stringify(after.value)) {
            previous[field] = unknown(); sticky.add(field);
            report(field === "title" ? "title_conflict" : "term_conflict", recordIndex);
          } else if (before.kind === "unknown") {
            if (field === "title") previous.title = next.title;
            else previous.termIndicators = next.termIndicators;
          }
        }
      });
      page.coverage = diagnostics.length === start ? "complete" : "partial";
    } catch { report("malformed_list"); page.coverage = "none"; }
  });
  // Cross-page conflicts also invalidate the earlier page's completeness.
  if (conflicts.size) {
    for (const page of pages) if (page.coverage === "complete" &&
      [...conflicts.values()].some(fields => fields.size > 0)) page.coverage = "partial";
  }
  const coverage: DiscoveryCoverage = pages.length && pages.every(page => page.coverage === "complete")
    ? "complete" : pages.some(page => page.coverage !== "none") ? "partial" : "none";
  return { observations, pages, diagnostics, coverage,
    paginationPending: pages.some(page => page.paginationPending), suppliedPageCount: inputs.length };
}

/**
 * #82 enrolled-courses endpoint parser (`core_course_get_enrolled_courses_by_timeline_classification`,
 * classification `inprogress`). Pure: input is the raw response text of each page, requested in
 * order at offset `index * limit`. Only five observation fields leave this function; every
 * other course field (idnumber, category, dates, viewurl, visibility, favourite, progress) is
 * dropped. Of `shortname` only the code segment is kept (#84, see `enrolledCourseCode`). The URL
 * is rebuilt from the id; `viewurl` is ignored.
 *
 * Paging never uses `nextoffset` (observed to be 8 even when the list was exhausted): a page with
 * fewer courses than `limit` ends the list, a full page asks for one more page at `offset + limit`,
 * and at most ENROLLED_PAGE_CAP pages are requested. A full last page then gives `partial` with
 * `page_cap_reached`. A page that is not JSON, is not `[{error: false, data: {courses: [...]}}]`,
 * or has more courses than `limit` is `malformed_response`, and none of its courses are used.
 */
export const ENROLLED_PAGE_CAP = 4;
export const ENROLLED_TERM = "In progress";
export interface EnrolledCourseDiscovery {
  observations: RawCourseObservation[];
  coverage: DiscoveryCoverage;
  diagnostics: CourseDiagnostic[];
  /** Offset of the next page to request, or null when no further request is made. */
  next: number | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" };
/** Fullname clean-up: decode the five entities, drop one trailing parenthesised group, normalise. */
export function enrolledCourseTitle(fullname: unknown): Observed<string> {
  if (typeof fullname !== "string" || /<\/?[a-z!]/i.test(fullname)) return unknown();
  const decoded = fullname.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => ENTITIES[name]!);
  if (/<\/?[a-z!]/i.test(decoded)) return unknown();
  const title = decoded.replace(/\s*\([^()]*\)\s*$/u, "").replace(/\s+/gu, " ").trim();
  return title ? { kind: "known", value: title } : unknown();
}

/**
 * #84: the code is the first segment of a shortname shaped `<code>-<n>-<login>-<year>-<term>`.
 * Exactly five `-`-separated, nonblank segments are required, otherwise the code is unknown. Only
 * that segment is returned; the rest (including the instructor login) is never kept.
 */
export function enrolledCourseCode(shortname: unknown): Observed<string> {
  if (typeof shortname !== "string") return unknown();
  const segments = shortname.split("-");
  if (segments.length !== 5 || segments.some(segment => !segment.trim())) return unknown();
  const code = segments[0]!.replace(/\s+/gu, " ").trim();
  return code.length <= 64 ? { kind: "known", value: code } : unknown();
}

function enrolledPage(body: unknown, limit: number): unknown[] | null {
  let value: unknown;
  try { value = typeof body === "string" ? JSON.parse(body) : undefined; } catch { return null; }
  if (!Array.isArray(value) || value.length !== 1) return null;
  const envelope = value[0] as { error?: unknown; data?: { courses?: unknown } } | null;
  if (!envelope || typeof envelope !== "object" || envelope.error !== false || !envelope.data ||
      typeof envelope.data !== "object" || !Array.isArray(envelope.data.courses)) return null;
  return envelope.data.courses.length > limit ? null : envelope.data.courses;
}

export function parseEnrolledCourses(pages: readonly unknown[], options: { limit: number }): EnrolledCourseDiscovery {
  const limit = options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1) throw RangeError("limit");
  const observations: RawCourseObservation[] = [];
  const diagnostics: CourseDiagnostic[] = [];
  const byId = new Map<string, RawCourseObservation>();
  const conflicted = { title: new Set<string>(), code: new Set<string>() };
  let partial = false, usable = 0, next: number | null = 0;
  pages.slice(0, ENROLLED_PAGE_CAP).forEach((body, pageIndex) => {
    const courses = enrolledPage(body, limit);
    if (!courses) { diagnostics.push({ pageIndex, reason: "malformed_response" }); partial = true; next = null; return; }
    usable++;
    courses.forEach((course, recordIndex) => {
      const id = (course as { id?: unknown } | null)?.id;
      if (!course || typeof course !== "object" || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
        diagnostics.push({ pageIndex, recordIndex, reason: "missing_identity" }); partial = true; return;
      }
      const sourceCourseId = String(id);
      const title = enrolledCourseTitle((course as { fullname?: unknown }).fullname);
      const code = enrolledCourseCode((course as { shortname?: unknown }).shortname);
      const previous = byId.get(sourceCourseId);
      if (!previous) {
        const observation: RawCourseObservation = { sourceCourseId,
          sourceUrl: `https://moodle.sdu.edu.kz/course/view.php?id=${sourceCourseId}`,
          title, termIndicators: { kind: "known", value: [ENROLLED_TERM] }, code };
        byId.set(sourceCourseId, observation); observations.push(observation); return;
      }
      // Unknown fills from known; conflicting known values become sticky unknown.
      for (const [field, next] of [["title", title], ["code", code]] as const) {
        const before = previous[field] ?? unknown();
        if (conflicted[field].has(sourceCourseId) || next.kind === "unknown") continue;
        if (before.kind === "unknown") { previous[field] = next; continue; }
        if (before.value !== next.value) {
          previous[field] = unknown(); conflicted[field].add(sourceCourseId);
          diagnostics.push({ pageIndex, recordIndex, reason: field === "title" ? "title_conflict" : "code_conflict" });
        }
      }
    });
    if (next === null) return;
    if (courses.length < limit) { next = null; return; }
    if (pageIndex + 1 >= ENROLLED_PAGE_CAP) {
      diagnostics.push({ pageIndex, reason: "page_cap_reached" }); partial = true; next = null; return;
    }
    next = (pageIndex + 1) * limit;
  });
  // Fewer pages than the paging rule asks for cannot be complete.
  if (next !== null) partial = true;
  const coverage: DiscoveryCoverage = !usable ? "none" : partial ? "partial" : "complete";
  return { observations, coverage, diagnostics, next };
}
