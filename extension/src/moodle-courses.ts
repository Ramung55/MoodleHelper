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
}
export type DiscoveryCoverage = "complete" | "partial" | "none";
export type CourseDiagnosticReason = "unsupported_list_route" | "malformed_list" |
  "incomplete_list" | "pagination_pending" | "empty_unconfirmed" |
  "missing_identity" | "unsafe_url" | "identity_mismatch" | "malformed_card" |
  "title_conflict" | "term_conflict";
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
      if (mains.length !== 1 || !mains[0].querySelector("h1")) { report("malformed_list"); return; }
      const main = mains[0];
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
        const url = courseUrl(links[0].getAttribute("href"), input.finalUrl);
        if (!url) { report("unsafe_url", recordIndex); return; }
        if (url.searchParams.get("id") !== id) { report("identity_mismatch", recordIndex); return; }
        const titles = card.querySelectorAll('[data-role="course-title"]');
        const terms = [...new Set([...card.querySelectorAll('[data-role="course-term"]')].map(text).filter(Boolean))].sort();
        const title = titles.length === 1 ? text(titles[0]) : "";
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
