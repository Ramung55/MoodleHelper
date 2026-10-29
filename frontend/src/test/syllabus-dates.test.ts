import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectMentionUnits } from "@/domain/assessment-mentions";
import { parseSyllabusMention, type SyllabusDateContext } from "@/domain/syllabus-dates";
const identity = { datasetId: "dataset", courseId: "course", digest: "document" };
const mention = async (text: string) => (await detectMentionUnits(identity, [{ text, location: { kind: "ocr_region", page: 1, bounds: [0, 0, 100, 20], synthetic: true } }], new AbortController().signal))[0]!;
const parse = async (text: string, context?: SyllabusDateContext) => parseSyllabusMention(await mention(text), context).dates;
beforeEach(() => vi.stubGlobal("crypto", webcrypto)); afterEach(() => vi.unstubAllGlobals());
describe("explicit local syllabus dates", () => {
  it.each([
    ["Quiz due 12 March 2027", "2027-03-12"], ["Exam March 12, 2027", "2027-03-12"],
    ["Задание 12 марта 2027", "2027-03-12"], ["Тест 12 мар. 2027", "2027-03-12"],
    ["Exam 2028-02-29", "2028-02-29"], ["Quiz 13/04/2027", "2027-04-13"],
    ["Quiz 04/13/2027", "2027-04-13"], ["Quiz 04.04.2027", "2027-04-04"],
  ])("parses %s without inventing a time", async (text, date) => {
    const [proposal] = await parse(text!);
    expect(proposal).toMatchObject({ date: { kind: "date", date }, state: "proposed", status: "unconfirmed" });
    expect(text!.slice(proposal!.start, proposal!.end)).toBe(proposal!.expression);
    expect(proposal!.date).not.toHaveProperty("iso"); expect(proposal!.date).not.toHaveProperty("tz");
  });
  it("requires declared numeric order rather than language/browser inference", async () => {
    expect((await parse("Экзамен 03/04/2027"))[0]!.reasons.join(" ")).toMatch(/Ambiguous numeric/);
    expect((await parse("Exam 03/04/2027", { dateOrder: "DMY" }))[0]!.date).toEqual({ kind: "date", date: "2027-04-03" });
    expect((await parse("Exam 03/04/2027", { dateOrder: "MDY" }))[0]!.date).toEqual({ kind: "date", date: "2027-03-04" });
    for (const context of [{ dateOrder: "AUTO" }, { dateOrder: "DMY", conflictingDateOrder: true }]) expect((await parse("Exam 03/04/2027", context))[0]!.reasons.join(" ")).toMatch(/invalid or conflicting/);
  });
  it("keeps missing years unresolved except one explicit semester placement", async () => {
    expect((await parse("Quiz 12 March"))[0]!.reasons.join(" ")).toMatch(/Missing year/);
    const [inferred] = await parse("Quiz 12 March", { semester: { start: "2027-01-01", end: "2027-06-30" } });
    expect(inferred).toMatchObject({ expression: "12 March", date: { kind: "date", date: "2027-03-12" }, yearInferredFrom: { start: "2027-01-01", end: "2027-06-30" } });
    for (const semester of [{ start: "2027-04-01", end: "2027-06-30" }, { start: "2027-01-01", end: "2028-06-30" }]) expect((await parse("Quiz 12 March", { semester }))[0]!.date.kind).toBe("unknown");
  });
  it.each(["Exam 2027-02-29", "Quiz 31 April 2027", "Quiz 31/04/2027", "Exam 2027-03-12 25:00Z"])("rejects impossible source value %s", async (text) => {
    const [proposal] = await parse(text); expect(proposal!.state).toBe("invalid"); expect(proposal!.date.kind).toBe("unknown");
  });
  it("retains written times, requires timezone evidence and rejects DST gaps/overlaps", async () => {
    const [without] = await parse("Exam 2027-03-12 14:00");
    expect(without).toMatchObject({ date: { kind: "unknown" }, wallTime: { date: "2027-03-12", time: "14:00" } });
    expect((await parse("Exam 2027-03-12T14:00+05:00"))[0]).toMatchObject({ date: { kind: "exact", iso: "2027-03-12T14:00:00+05:00", tz: "UTC" }, zoneProvenance: { kind: "offset", value: "+05:00" } });
    expect((await parse("Exam 2027-03-12 14:00", { timezone: { zone: "Asia/Almaty", source: "course" } }))[0]).toMatchObject({ date: { kind: "exact", iso: "2027-03-12T09:00:00.000Z", tz: "Asia/Almaty" } });
    expect((await parse("Exam 2026-03-08 02:30 America/New_York"))[0]!.reasons.join(" ")).toMatch(/gap/);
    expect((await parse("Exam 2026-11-01 01:30 America/New_York"))[0]!.reasons.join(" ")).toMatch(/overlap/);
  });
  it("keeps distinct labels and date identities while flagging ranges/multiple mentions", async () => {
    const source = await mention("Exam opens 2027-03-10 closes 2027-03-12");
    const first = parseSyllabusMention(source);
    expect(first.dates.map((p) => p.label)).toEqual(["opens", "closes"]);
    expect(first.dates.map((p) => p.date.kind)).toEqual(["date", "date"]);
    expect(parseSyllabusMention(source).dates.map((p) => p.id)).toEqual(first.dates.map((p) => p.id));
    expect(first.mention).toBe(source);
    for (const text of ["Exam 2027-03-10 to 2027-03-12", "Exam and quiz opens 2027-03-10 closes 2027-03-12"]) for (const proposal of await parse(text)) expect(proposal.date.kind).toBe("unknown");
    const equivalent = await parse("Exam opens 12 March 2027 closes 2027-03-12");
    expect(equivalent.map((value) => value.date)).toEqual([{ kind: "date", date: "2027-03-12" }, { kind: "date", date: "2027-03-12" }]);
    expect(equivalent[0]!.id).not.toBe(equivalent[1]!.id);
    expect((await parse("Exam due 12 March 2027 deadline 2027-03-12")).every((value) => value.date.kind === "unknown")).toBe(true);
    const ambiguousSource = await mention("Exam 03/04/2027");
    expect(parseSyllabusMention(ambiguousSource, { dateOrder: "DMY" }).dates[0]!.id).toBe(parseSyllabusMention(ambiguousSource, { dateOrder: "MDY" }).dates[0]!.id);
  });
  it("does not convert week/relative prose or two-digit years and never borrows adjacent rows", async () => {
    for (const text of ["Quiz Week 6", "Exam next Friday", "Quiz 12 March 27"]) expect((await parse(text))[0]!.date.kind).toBe("unknown");
    const proposals = await detectMentionUnits(identity, [
      { text: "Quiz 1", location: { kind: "ocr_region", page: 1, bounds: [0, 0, 100, 20], synthetic: true } },
      { text: "Exam 2027-03-12", location: { kind: "ocr_region", page: 1, bounds: [0, 40, 100, 20], synthetic: true } },
    ], new AbortController().signal);
    expect(parseSyllabusMention(proposals[0]!).dates[0]!.date.kind).toBe("unknown");
    expect(parseSyllabusMention(proposals[1]!).dates[0]!.date).toEqual({ kind: "date", date: "2027-03-12" });
  });
  it.each(["Exam 12 March 20270", "Exam 2027-03-12 2pm", "Exam 2027-03-12 14:00 EST", "Exam 2027-03-12 14:00+0500", "Exam 2027-03-12 14:00:30Z"])("retains unsupported expression %s instead of silently dropping written precision", async (text) => {
    const [proposal] = await parse(text, { semester: { start: "2027-01-01", end: "2027-06-30" }, timezone: { zone: "UTC", source: "document" } });
    expect(proposal!.date.kind).toBe("unknown"); expect(proposal!.reasons.join(" ")).toMatch(/unsupported/i);
  });
  it.each(["Exam 14:00 on 12 March 2027", "Exam 12 March 2027 14:00Z and 15:00Z", "Exam after 12 March 2027", "Exam March 12th 2027"])("keeps unsupported association/relative grammar unresolved: %s", async (text) => {
    expect((await parse(text, { timezone: { zone: "UTC", source: "course" }, semester: { start: "2027-01-01", end: "2027-06-30" } }))[0]!.date.kind).toBe("unknown");
  });
});
