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
  it.each([
    "March 12, 2027 at 3:30 PM", "12 March 2027 12:00am", "12 March 2027 3:30pm", "12 March 2027 3:30 p.m.",
    "12 March 2027 13:00 XYZ", "12 March 2027 13:00xyz", "12 March 2027 13:00 (XYZ)", "12 March 2027 13:00[XYZ]",
    "12 March 2027 13:00 Zebra", "12 March 2027 13:00Zfoo", "12 March 2027 13:00UTCfoo", "12 March 2027 13:00+05:00XYZ",
    "12 March 2027 13:00 UTC +05:00", "12 March 2027 13:00PM XYZ",
    "12 March 2027 13:00\u00a0XYZ", "12 March 2027 3:30\u202fPM", "12 March 2027 13:00 МСК", "12 March 2027 3:30ＰＭ",
  ])("retains complete unsupported clock/zone expression without trusted-zone fallback: %s", async (expression) => {
    const source = await mention(`Exam due ${expression}`);
    const withContext = parseSyllabusMention(source, { timezone: { zone: "Asia/Almaty", source: "course" } }).dates[0]!;
    const withoutContext = parseSyllabusMention(source).dates[0]!;
    expect(withContext).toMatchObject({ date: { kind: "unknown" }, state: "unresolved", expression });
    expect(withContext.reasons.join(" ")).toMatch(/Unsupported.*clock or timezone/);
    expect(withContext.id).toBe(withoutContext.id); expect(withContext.parentId).toBe(source.id);
    expect(source.rawScheduleText.slice(withContext.start, withContext.end)).toBe(expression);
  });
  it.each([
    ["12 March 2027 13:00", "2027-03-12T08:00:00.000Z"],
    ["12 March 2027 13:00Z", "2027-03-12T13:00:00Z"],
    ["12 March 2027 13:00+05:00", "2027-03-12T13:00:00+05:00"],
    ["12 March 2027 13:00 Asia/Almaty", "2027-03-12T08:00:00.000Z"],
  ])("preserves legitimate complete 24-hour grammar with context: %s", async (expression, expected) => {
    const [proposal] = await parse(`Exam due ${expression}`, { timezone: { zone: "Asia/Almaty", source: "course" } });
    expect(proposal).toMatchObject({ state: "proposed", date: { kind: "exact", iso: expected }, expression });
  });
  it.each([
    "2027-03-12T", "2027-03-12T14", "2027-03-12T99", "2027-03-12T14:", "2027-03-12T14:0", "2027-03-12T14:000",
    "2027-03-12 at", "2027-03-12 в", "2027-03-12 at 3 PM", "2027-03-12 at noon", "2027-03-12 at midnight", "2027-03-12 в полдень", "2027-03-12 в полночь", "2027-03-12 at +3",
    "2027-03-12T14:00 (XYZ", "2027-03-12T14:00 [XYZ", "2027-03-12T14:00, XYZ", "2027-03-12T14:00, (XYZ", "2027-03-12T14:00. XYZ",
    "2027-03-12T14:00+", "2027-03-12T14:00+05", "2027-03-12T14:00+05:", "2027-03-12T14:00+05:00.5", "2027-03-12T14:00.5",
    "2027-03-12T14:00 at 3 PM", "2027-03-12T14:00 at noon", "2027-03-12T14:00 and UTC", "2027-03-12T14:00 and at midnight",
  ])("fails closed after committed clock/suffix lexical evidence: %s", async (expression) => {
    const source = await mention(`Exam due ${expression}`);
    const [proposal] = parseSyllabusMention(source, { timezone: { zone: "Asia/Almaty", source: "course" } }).dates;
    expect(proposal).toMatchObject({ date: { kind: "unknown" }, state: "unresolved", expression });
    expect(proposal!.reasons.join(" ")).toMatch(/Unsupported/);
    expect(source.rawScheduleText.slice(proposal!.start, proposal!.end)).toBe(expression);
  });
  it.each([
    ["2027-03-12 at campus", "date"], ["2027-03-12 в аудитории", "date"], ["2027-03-12 submit online", "date"],
    ["2027-03-12 at 14:00 submit online", "exact"], ["2027-03-12 at 14:00 in room 5", "exact"],
    ["2027-03-12 at 14:00 please upload work", "exact"], ["2027-03-12T14:00, please upload work", "exact"],
    ["2027-03-12T14:00. please upload work", "exact"], ["2027-03-12T14:00Z.", "exact"], ["2027-03-12T14:00 Asia/Almaty.", "exact"],
  ])("keeps ordinary prose/punctuation outside supported date expressions: %s", async (text, kind) => {
    expect((await parse(`Exam due ${text}`, { timezone: { zone: "Asia/Almaty", source: "course" } }))[0]!.date.kind).toBe(kind);
  });
});
