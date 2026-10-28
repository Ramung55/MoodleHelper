import type { DocxParagraph, LocalExtraction, TextEvidence } from "./local-extraction";

export const MENTION_DETECTOR_VERSION = "mentions-1";
type Identity = Pick<LocalExtraction, "datasetId" | "courseId" | "digest">;
export type MentionLocation =
  | { kind: "pdf_row"; page: number; items: TextEvidence[] }
  | { kind: "docx_paragraph"; paragraph: DocxParagraph }
  | { kind: "docx_row"; part: "word/document.xml"; bodyBlock: number; table: number; row: number; cells: { cell: number; paragraphs: DocxParagraph[] }[] }
  | { kind: "ocr_region"; page: number; bounds: number[]; synthetic: boolean };
export type MentionUnit = { text: string; location: MentionLocation };
export type AssessmentMention = Identity & {
  id: string; detectorVersion: typeof MENTION_DETECTOR_VERSION;
  type: "exam" | "quiz" | "assignment"; title: string; excerpt: string;
  mention: { start: number; end: number; text: string };
  location: MentionLocation; rawScheduleText: string;
  date: { kind: "unknown" }; status: "unconfirmed"; reasons: string[];
};

// Match original Unicode text directly: JS UTF-16 offsets always refer to evidence.
const KEYWORDS = /(?<![\p{L}\p{N}_])(?:final\s+exam(?:ination)?s?|exam(?:ination)?s?|quizz?es|quiz|tests?|assignments?|homework|экзамен(?:ы|а|ов|у|ом|е)?|тест(?:ы|а|ов|у|ом|е)?|контрольн(?:ая|ую|ой|ые)\s+работ(?:а|у|ы|е|ой)|задани(?:е|я|й|ю|ем|и)|домашн(?:ее|его|ему|им|ем)\s+задани(?:е|я|й|ю|ем|и))(?![\p{L}\p{N}_])/giu;
const POLICY = /%|\b(?:grading|grades?|weight|percent|attendance|rules?|policy|policies)\b|оценк|оцениван|процент|посещаем|правил/iu;
// These are scheduling hints only; no calendar/date/week interpretation occurs here.
const SCHEDULE_HINT = /\b(?:week|weeks|due|deadline|scheduled)\b|недел|срок|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}|(?:\d\s*(?:January|February|March|April|May|June|July|August|September|October|November|December|январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр))/iu;
const classify = (keyword: string): AssessmentMention["type"] => /exam|экзамен/iu.test(keyword) ? "exam" : /quiz|test|тест|контрольн/iu.test(keyword) ? "quiz" : "assignment";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

export function mentionUnits(extraction: LocalExtraction): MentionUnit[] {
  if (extraction.format === "pdf") return extraction.pages.flatMap((page) => page.rows.map((row) => ({ text: row.text, location: { kind: "pdf_row" as const, page: page.page, items: row.items } })));
  return extraction.blocks.flatMap((block): MentionUnit[] => block.kind === "paragraph"
    ? [{ text: block.paragraph.text, location: { kind: "docx_paragraph", paragraph: block.paragraph } }]
    : block.rows.map((row) => ({ text: row.cells.map((cell) => cell.paragraphs.map((p) => p.text).join("\n")).join("\t"), location: { kind: "docx_row", part: "word/document.xml", bodyBlock: block.bodyBlock, table: block.table, row: row.row, cells: row.cells } })));
}

function locationKey(location: MentionLocation): unknown {
  if (location.kind === "pdf_row") return [location.kind, location.page, location.items.map((item) => [item.page, item.transform, item.width, item.height])];
  if (location.kind === "docx_paragraph") return [location.kind, location.paragraph.location];
  if (location.kind === "docx_row") return [location.kind, location.part, location.bodyBlock, location.table, location.row];
  return [location.kind, location.page, location.bounds, location.synthetic];
}

/** Adapter boundary also accepts provenance-bearing OCR regions; it does not run OCR. */
export async function detectMentionUnits(identity: Identity, units: MentionUnit[], signal: AbortSignal): Promise<AssessmentMention[]> {
  if (!identity.datasetId || !identity.courseId || !identity.digest) throw new Error("Document context is missing. Extract the document again.");
  if (!globalThis.crypto?.subtle) throw new Error("Secure local identity hashing is unavailable.");
  if (units.length > 10_000) throw new Error("Mention detection supports at most 10,000 source rows. Split the document.");
  const check = () => { if (signal.aborted) throw new DOMException("Detection cancelled", "AbortError"); };
  const seen = new Map<string, string>(); const proposals: AssessmentMention[] = []; let characters = 0;
  for (const unit of units) {
    check(); characters += unit.text.length;
    if (unit.text.length > 10_000 || characters > 1_000_000) throw new Error("The extracted text exceeds the mention detector's row/text limits. Split the document.");
    const key = canonical(locationKey(unit.location)), evidence = canonical(unit);
    if (seen.has(key)) { if (seen.get(key) !== evidence) throw new Error("Conflicting evidence uses the same source location. Extract the document again."); continue; }
    seen.set(key, evidence);
    const mentions = [...unit.text.matchAll(KEYWORDS)];
    const schedule = SCHEDULE_HINT.test(unit.text); const policy = POLICY.test(unit.text);
    for (const match of mentions) {
      check(); if (proposals.length >= 1000) throw new Error("The document has more than 1,000 possible assessments. Split it before detection.");
      const start = match.index!, end = start + match[0].length;
      const reasons = ["Date/week wording has not been interpreted; student review is required."];
      if (!schedule) reasons.push("No scheduled date or week evidence in this source row.");
      if (policy) reasons.push("General grading-policy or rules wording; a scheduled assessment is uncertain.");
      if (!schedule && !policy && !/\d/.test(unit.text) && unit.text.trim().split(/\s+/).length <= 4) reasons.push("Heading-only label; a scheduled assessment is uncertain.");
      if (mentions.length > 1) reasons.push("Multiple assessment mentions share this row; date/column association is ambiguous.");
      if (unit.location.kind === "ocr_region") reasons.push(unit.location.synthetic ? "Synthetic OCR adapter fixture; real OCR has not been performed." : "OCR-derived evidence needs review.");
      const ordinal = /^\s*(?:(?:no\.?|#|№)\s*)?\d{1,3}(?!\d)/iu.exec(unit.text.slice(end));
      const ordinalText = ordinal && !policy && (!schedule || SCHEDULE_HINT.test(unit.text.slice(end + ordinal[0].length))) ? ordinal[0] : "";
      const title = `${match[0]}${ordinalText}`.trim();
      const input = canonical([MENTION_DETECTOR_VERSION, identity.datasetId, identity.courseId, identity.digest, key, start, end, classify(match[0])]);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)); check();
      proposals.push({ ...identity, id: `mention-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`, detectorVersion: MENTION_DETECTOR_VERSION,
        type: classify(match[0]), title, excerpt: unit.text, mention: { start, end, text: unit.text.slice(start, end) }, location: unit.location,
        rawScheduleText: unit.text, date: { kind: "unknown" }, status: "unconfirmed", reasons });
    }
  }
  check(); return proposals;
}

export function detectAssessmentMentions(extraction: LocalExtraction, signal: AbortSignal): Promise<AssessmentMention[]> {
  return detectMentionUnits(extraction, mentionUnits(extraction), signal);
}
