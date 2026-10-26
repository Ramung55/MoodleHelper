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
