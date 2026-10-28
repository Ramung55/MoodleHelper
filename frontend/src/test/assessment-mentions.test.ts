import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectAssessmentMentions, detectMentionUnits, type MentionUnit } from "@/domain/assessment-mentions";
import type { LocalExtraction } from "@/domain/local-extraction";
const identity = { datasetId: "dataset", courseId: "course", digest: "sha256", complete: true as const };
const paragraph = (text: string, index: number): MentionUnit => ({ text, location: { kind: "docx_paragraph", paragraph: { id: `p${index}`, text, location: { part: "word/document.xml", bodyBlock: index, paragraph: index } } } });
const detect = (units: MentionUnit[]) => detectMentionUnits(identity, units, new AbortController().signal);
beforeEach(() => vi.stubGlobal("crypto", webcrypto)); afterEach(() => vi.unstubAllGlobals());
describe("deterministic assessment mentions", () => {
  it.each([
    ["Final EXAM week 6", "exam"], ["Quiz 2 due 29 October 2026", "quiz"], ["TEST 3 week 8", "quiz"],
    ["Homework 1", "assignment"], ["Assignments due week 5", "assignment"], ["Экзамен 5 ноября 2026", "exam"],
    ["Контрольная работа — неделя 6", "quiz"], ["Тесты на неделе 7", "quiz"], ["Домашнее задание №2", "assignment"],
  ])("detects supported bilingual text %s", async (text, type) => {
    const [proposal] = await detect([paragraph(text!, 1)]);
    expect(proposal).toMatchObject({ type, excerpt: text, rawScheduleText: text, date: { kind: "unknown" }, status: "unconfirmed" });
    expect(proposal!.title).toBeTruthy(); expect(text!.slice(proposal!.mention.start, proposal!.mention.end)).toBe(proposal!.mention.text);
  });
  it("marks headings, grading policies, absent schedule and multiple mentions uncertain", async () => {
    const result = await detect([paragraph("Quizzes 20% of the final grade", 1), paragraph("Правила экзамена и посещаемости", 2), paragraph("Exams", 3), paragraph("Assignment 1", 4), paragraph("Quiz and exam week 6", 5), paragraph("Final attendance 20%", 6)]);
    expect(result).toHaveLength(6);
    expect(result[0]!.reasons.join(" ")).toMatch(/policy/);
    expect(result[1]!.reasons.join(" ")).toMatch(/policy/);
    expect(result[2]!.reasons.join(" ")).toMatch(/Heading/);
    expect(result[3]!.reasons.join(" ")).toMatch(/No scheduled date/);
    for (const proposal of result.slice(4)) expect(proposal.reasons.join(" ")).toMatch(/Multiple assessment/);
    expect(new Set(result.slice(4).map((p) => p.id)).size).toBe(2);
  });
  it("keeps dates in their own table rows and retains all cell references", async () => {
    const extraction: LocalExtraction = { ...identity, format: "docx", blocks: [{ kind: "table", id: "t1", table: 1, bodyBlock: 1, rows: [
      { row: 1, cells: [{ cell: 1, paragraphs: [{ id: "quiz1", text: "Quiz 1", location: { part: "word/document.xml", bodyBlock: 1, table: 1, row: 1, cell: 1, paragraph: 1 } }] }, { cell: 2, paragraphs: [{ id: "date1", text: "Week 6", location: { part: "word/document.xml", bodyBlock: 1, table: 1, row: 1, cell: 2, paragraph: 1 } }] }] },
      { row: 2, cells: [{ cell: 1, paragraphs: [{ id: "a2", text: "Assignment 2", location: { part: "word/document.xml", bodyBlock: 1, table: 1, row: 2, cell: 1, paragraph: 1 } }] }, { cell: 2, paragraphs: [{ id: "date2", text: "Week 10", location: { part: "word/document.xml", bodyBlock: 1, table: 1, row: 2, cell: 2, paragraph: 1 } }] }] },
    ] }] };
    const proposals = await detectAssessmentMentions(extraction, new AbortController().signal);
    expect(proposals.map((p) => p.rawScheduleText)).toEqual(["Quiz 1\tWeek 6", "Assignment 2\tWeek 10"]);
    expect(proposals[0]!.location).toMatchObject({ kind: "docx_row", row: 1, cells: expect.any(Array) });
    expect(proposals[0]!.excerpt).not.toContain("10");
  });
  it("replays stable IDs across order changes and isolates location/course/dataset/digest", async () => {
    const units = [paragraph("Quiz 1 week 6", 1), paragraph("Quiz 1 week 6", 2)];
    const first = await detect(units), repeat = await detect([...units].reverse());
    expect(first.map((p) => p.id).sort()).toEqual(repeat.map((p) => p.id).sort());
    expect(first[0]!.id).not.toBe(first[1]!.id);
    expect(await detect([units[0]!, units[0]!])).toHaveLength(1);
    for (const change of [{ courseId: "other" }, { datasetId: "other" }, { digest: "other" }]) expect((await detectMentionUnits({ ...identity, ...change }, [units[0]!], new AbortController().signal))[0]!.id).not.toBe(first[0]!.id);
    const conflict = paragraph("Quiz 1 week 7", 1);
    await expect(detect([units[0]!, conflict])).rejects.toThrow(/Conflicting evidence/);
  });
  it("retains synthetic OCR provenance without claiming OCR execution and cancels without partial proposals", async () => {
    const [proposal] = await detect([{ text: "Экзамен неделя 8", location: { kind: "ocr_region", page: 3, bounds: [10, 20, 100, 20], synthetic: true } }]);
    expect(proposal!.reasons.join(" ")).toMatch(/Synthetic OCR/);
    const controller = new AbortController(); controller.abort();
    await expect(detectMentionUnits(identity, [paragraph("Quiz week 6", 1)], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
