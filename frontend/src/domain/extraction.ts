import { weekOf } from "./dates";
import type { Assessment, ExtractionCandidate, Settings } from "./types";
import { reconciledSourceDate } from "./assessments";

export const SUPPORTED_FORMATS = ["pdf", "docx"] as const;

export function checkFormat(fileName: string): { ok: true; format: "pdf" | "docx" } | { ok: false; reason: string } {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || ext === "docx") return { ok: true, format: ext };
  if (ext === "doc") return { ok: false, reason: "Legacy .doc files are not supported. Save it as .docx or PDF and try again." };
  return { ok: false, reason: `".${ext}" files are not supported. Import a text-based PDF or a DOCX syllabus.` };
}

/**
 * A candidate may become an event automatically only when the date is clear,
 * well-evidenced and not contradicted. Everything else goes to review.
 */
export function canAutoAccept(c: ExtractionCandidate, matches: Assessment[]): boolean {
  if (c.confidence < 0.9) return false;
  if (c.date.kind === "unknown") return false;
  if (!c.excerpt.trim() || !c.location.trim()) return false;
  // a proposed match exists → needs a human decision
  if (matches.length > 0) return false;
  return true;
}

/**
 * Propose (never apply) uncertain matches. Shared activity ids are the only automatic link;
 * titles alone are never enough. Requires same course, same type and same teaching week,
 * so recurring assignments in different weeks stay separate.
 */
export function proposeMatches(c: ExtractionCandidate, assessments: Assessment[], s: Settings): Assessment[] {
  const cw = weekOf(c.date, s.semesterStart, s.timezone);
  if (cw == null) return [];
  return assessments.filter((a) => {
    if (a.personal || a.courseId !== c.courseId || a.type !== c.type) return false;
    return weekOf(reconciledSourceDate(a.sources), s.semesterStart, s.timezone) === cw;
  });
}

/** Turn a confirmed candidate into source evidence. Week-level stays week-level. */
export function candidateToAssessment(c: ExtractionCandidate, now: string): Assessment {
  return {
    id: `syl-${c.id}`,
    courseId: c.courseId,
    title: c.title,
    type: c.type,
    personal: false,
    sources: [{ source: "syllabus", date: c.date, excerpt: c.excerpt, location: c.location, observedAt: now }],
    submission: undefined,
    firstObservedAt: now,
    lastObservedAt: now,
  };
}
