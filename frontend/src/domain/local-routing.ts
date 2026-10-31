import type { AssessmentMention } from "./assessment-mentions";
import { MENTION_DETECTOR_VERSION, mentionUnits } from "./assessment-mentions";
import type { LocalExtraction } from "./local-extraction";
import type { ParsedAssessmentMention } from "./syllabus-dates";
import { parseTeachingWeek } from "./teaching-weeks";
import { LocalSyllabusProposal, type DateValue, type TeachingCalendar } from "./types";
import { localHash, stableJson, type LocalEvidenceRecord } from "@/services/local-evidence";
export const LOCAL_PIPELINE_VERSION = "local-syllabus-1" as const;

export function traceableMention(mention: AssessmentMention): boolean {
  const location = mention.location;
  if (!location || !mention.excerpt.trim()) return false;
  const positive = (value: number) => Number.isInteger(value) && value > 0;
  const paragraph = (item: any) => item && typeof item.text === "string" && item.location?.part === "word/document.xml" && positive(item.location.bodyBlock) && positive(item.location.paragraph);
  if (location.kind === "pdf_row") return positive(location.page) && location.items.length > 0 && location.items.every(item => item.page === location.page && item.transform.length === 6 && [...item.transform, item.width, item.height].every(Number.isFinite));
  if (location.kind === "docx_paragraph") return paragraph(location.paragraph);
  if (location.kind === "docx_row") return location.part === "word/document.xml" && positive(location.bodyBlock) && positive(location.table) && positive(location.row) && location.cells.length > 0 && location.cells.every(cell => positive(cell.cell) && cell.paragraphs.length > 0 && cell.paragraphs.every(paragraph));
  return positive(location.page) && location.bounds.length === 4 && location.bounds.every(Number.isFinite);
}
/** Finite detector dictionary provenance, never browser locale or inferred document language. */
function language(mention: AssessmentMention): "en" | "ru" | undefined {
  if (mention.detectorVersion !== MENTION_DETECTOR_VERSION) return;
  const keyword = mention.mention.text;
  if (/^(?:final\s+exam(?:ination)?s?|exam(?:ination)?s?|quizz?es|quiz|tests?|assignments?|homework)$/i.test(keyword)) return "en";
  if (/^(?:экзамен(?:ы|а|ов|у|ом|е)?|тест(?:ы|а|ов|у|ом|е)?|контрольн(?:ая|ую|ой|ые)\s+работ(?:а|у|ы|е|ой)|задани(?:е|я|й|ю|ем|и)|домашн(?:ее|его|ему|им|ем)\s+задани(?:е|я|й|ю|ем|и))$/iu.test(keyword)) return "ru";
}
export async function prepareLocalEvidence(extraction: LocalExtraction, mentions: AssessmentMention[], parsed: ParsedAssessmentMention[], calendar: TeachingCalendar | undefined, sourceAvailable: boolean, signal: AbortSignal): Promise<LocalEvidenceRecord[]> {
  if (mentions.length > 1000) throw new Error("Route at most 1,000 proposals at a time.");
  const extractedUnits = new Set(mentionUnits(extraction).map(unit => stableJson(unit)));
  const records: LocalEvidenceRecord[] = [];
  for (const mention of mentions) {
    signal.throwIfAborted();
    if (mention.datasetId !== extraction.datasetId || mention.courseId !== extraction.courseId || mention.digest !== extraction.digest || mention.detectorVersion !== MENTION_DETECTOR_VERSION) throw new Error("Proposal context/version does not match its local extraction.");
    const parent = parsed.find(item => item.mention.id === mention.id);
    if (!parent || parent.mention.datasetId !== mention.datasetId || parent.mention.courseId !== mention.courseId || parent.mention.digest !== mention.digest || parent.dates.some(date => date.parentId !== mention.id)) throw new Error("Interpret all original proposals before routing; source association must be intact.");
    // #29 emits a typed placeholder when no explicit date expression exists.
    // It is not an additional date competing with the independent week parser.
    const week = parseTeachingWeek(mention, calendar), dates = parent.dates.filter(date => date.id !== `${mention.id}/date:unresolved`);
    const singleDate = dates.length === 1 && dates[0].state === "proposed" && dates[0].date.kind !== "unknown" && week.expressions.length === 0;
    const date: DateValue = singleDate ? dates[0].date : dates.length === 0 && week.expressions.length === 1 ? week.value : { kind: "unknown" };
    const reasons = [...mention.reasons, ...dates.flatMap(date => date.reasons)].join(" ");
    const ocr = mention.location?.kind === "ocr_region" ? mention.location : undefined;
    const facts = {
      complete: extraction.format === "pdf" ? extraction.complete && extraction.pages.every(page => page.status !== "ocr_needed") : extraction.complete,
      evidenceRetained: true, traceable: traceableMention(mention) && extractedUnits.has(stableJson({ text: mention.rawScheduleText, location: mention.location })), sourceAvailable, contextVerified: true,
      singleAssociation: !/Multiple assessment mentions/i.test(reasons) && (dates.length === 1 && !week.expressions.length || dates.length === 0 && week.expressions.length === 1),
      explicitDate: singleDate && !dates[0].yearInferredFrom,
      inferredYear: dates.some(date => !!date.yearInferredFrom), localeAmbiguous: /ambiguous numeric|date-order.*(?:invalid|conflicting)|invalid or conflicting/i.test(reasons),
      contradictory: /contradict/i.test(reasons), policyOrHeading: /grading-policy|Heading-only/i.test(reasons),
      conflictingMatch: false, mappingResolved: date.kind === "week" ? week.mapping.resolved : singleDate,
      timezoneResolved: date.kind === "exact" ? !!dates[0]?.zoneProvenance : !dates.some(item => item.wallTime || item.reasons.some(reason => /timezone|written time|clock|hour|minute|offset|local time/i.test(reason))),
      ocr: ocr ? ocr.synthetic ? "synthetic" as const : !ocr.engine || !ocr.dpi ? "missing_provenance" as const : ocr.reviewNeeded || (ocr.confidence !== undefined && ocr.confidence < 80) ? "low_quality" as const : "review" as const : "none" as const,
    };
    const locationId = `loc-${await localHash(mention.location ?? null)}`;
    const proposal = LocalSyllabusProposal.parse({ mentionId: mention.id, locationId, title: mention.title, type: mention.type, date: date.kind === "unknown" ? { kind: "unknown" } : date, ...(language(mention) ? { language: language(mention) } : {}), facts });
    const original = { mention: structuredClone(mention), dates: structuredClone(parent.dates), week: week.value };
    const format = extraction.format === "docx" ? "docx" : "pdf";
    const fingerprint = await localHash({ original, proposal, format, pipelineVersion: LOCAL_PIPELINE_VERSION });
    signal.throwIfAborted();
    records.push({ datasetId: mention.datasetId, courseId: mention.courseId, digest: mention.digest, mentionId: mention.id, locationId, pipelineVersion: LOCAL_PIPELINE_VERSION, format, fingerprint, original, proposal, state: "pending", audit: [{ kind: "retained", at: new Date().toISOString() }] });
  }
  return records;
}
