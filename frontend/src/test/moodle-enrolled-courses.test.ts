/**
 * #82 enrolled-courses parser. Driven by the observed fixtures in
 * tests/fixtures/moodle/observed/. The other response variants below (instructor
 * names, nextoffset 8, full pages, error envelopes) are INVENTED inline for these
 * tests; they are not observed and are not added to observed/.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENROLLED_PAGE_CAP, enrolledCourseCode, enrolledCourseTitle, parseEnrolledCourses } from "../../../extension/src/moodle-courses";

const observed = resolve(__dirname, "../../../tests/fixtures/moodle/observed");
const inprogress = readFileSync(resolve(observed, "enrolled-courses-inprogress.json"), "utf8");
const pastEmpty = readFileSync(resolve(observed, "enrolled-courses-past-empty.json"), "utf8");
const LIMIT = 24;
/** Invented page: `count` courses from `first`, with every unused field Moodle returns. */
function invented(count: number, first = 1, extra: Record<string, unknown> = {}, name = (id: number) => `Invented Course ${id}`) {
  return JSON.stringify([{ error: false, data: { courses: Array.from({ length: count }, (_, i) => ({
    id: first + i, fullname: name(first + i), shortname: `INV${first + i}-1-redacted-2028-1`, idnumber: "", startdate: 1, enddate: 2,
    viewurl: `https://moodle.example.invalid/course/view.php?id=${first + i}`, coursecategory: "Invented Term", visible: true, hidden: false,
    isfavourite: false, hasprogress: true, progress: 0 })), ...extra } }]);
}
const known = (value: string) => ({ kind: "known", value });

describe("#82 enrolled courses (inprogress)", () => {
  it("gives the three observed courses in response order, with only the five fields", () => {
    const result = parseEnrolledCourses([inprogress], { limit: LIMIT });
    expect(result.observations).toEqual(["9001", "9002", "9003"].map((id, i) => ({
      sourceCourseId: id, sourceUrl: `https://moodle.sdu.edu.kz/course/view.php?id=${id}`,
      title: known(["Fictional Course Alpha", "Fictional Course Beta", "Fictional Course Gamma"][i]!),
      termIndicators: { kind: "known", value: ["In progress"] },
      code: known(["DEMO101", "DEMO202", "DEMO303"][i]!) })));
    expect(result.coverage).toBe("complete");
    expect(result.next).toBeNull();
    expect(result.diagnostics).toEqual([]);
    for (const observation of result.observations) expect(Object.keys(observation).sort()).toEqual(["code", "sourceCourseId", "sourceUrl", "termIndicators", "title"]);
    const text = JSON.stringify(result);
    for (const key of ["shortname", "idnumber", "coursecategory", "startdate", "enddate", "viewurl", "visible", "hidden", "isfavourite", "hasprogress", "progress"])
      expect(text).not.toContain(JSON.stringify(key) + ":");
    // #84: DEMO101 is allowed only as the code; the rest of the shortname never leaves the parser.
    for (const value of ["DEMO101-", "-1-", "redacted", "2028-1", "Fictional Term 2028", "moodle.example.invalid", "1831489200"]) expect(text).not.toContain(value);
    expect(text.match(/DEMO101/g)).toEqual(["DEMO101"]);
    expect(result.observations.every(o => !("classification" in o))).toBe(true);
  });

  it.each([
    ["DEMO101-1-redacted-2028-1", "DEMO101"],
    ["CSS 105-12-login.name-2025-2", "CSS 105"],
  ])("gives the code of the shortname %j", (shortname, code) => {
    expect(enrolledCourseCode(shortname)).toEqual(known(code));
  });

  it.each([
    ["missing", undefined], ["null", null], ["a number", 101], ["an object", { code: "DEMO101" }], ["empty", ""], ["whitespace only", "   "],
    ["one segment", "DEMO101"], ["four segments", "DEMO101-1-redacted-2028"], ["six segments", "DEMO101-1-redacted-2028-1-x"],
    ["an empty code segment", "-1-x-2028-1"], ["an empty middle segment", "DEMO101--x-2028-1"], ["an empty last segment", "DEMO101-1-x-2028-"],
    ["a blank segment", "DEMO101-1- -2028-1"], ["an over-long code", `${"D".repeat(65)}-1-x-2028-1`],
  ])("gives code unknown for a shortname that is %s", (_name, shortname) => {
    expect(enrolledCourseCode(shortname)).toEqual({ kind: "unknown" });
    const course = shortname === undefined ? { id: 5, fullname: "Course" } : { id: 5, fullname: "Course", shortname };
    const result = parseEnrolledCourses([JSON.stringify([{ error: false, data: { courses: [course] } }])], { limit: LIMIT });
    expect(result.observations[0]!.code).toEqual({ kind: "unknown" });
    expect(JSON.stringify(result)).not.toMatch(/redacted|2028/);
  });

  it("gives code unknown for one id with two different codes on two pages, never last-writer-wins", () => {
    const page = (shortname: string, first = 1, count = LIMIT) => JSON.stringify([{ error: false, data: { courses: Array.from({ length: count }, (_, i) => ({
      id: first + i, fullname: `Invented Course ${first + i}`, shortname: first + i === 3 ? shortname : `INV${first + i}-1-redacted-2028-1` })) } }]);
    const conflict = parseEnrolledCourses([page("AAA1-1-x-2028-1"), page("BBB2-1-x-2028-1", 3, 1)], { limit: LIMIT });
    expect(conflict.observations[2]).toEqual(expect.objectContaining({ sourceCourseId: "3", code: { kind: "unknown" } }));
    expect(conflict.diagnostics).toEqual([{ pageIndex: 1, recordIndex: 0, reason: "code_conflict" }]);
    // Sticky: a third page with the first code again does not restore it.
    const third = parseEnrolledCourses([page("AAA1-1-x-2028-1"), page("BBB2-1-x-2028-1", 3, 1), page("AAA1-1-x-2028-1", 3, 1)], { limit: LIMIT });
    expect(third.observations[2]!.code).toEqual({ kind: "unknown" });
    // Same code twice is kept; unknown then known fills in.
    expect(parseEnrolledCourses([page("AAA1-1-x-2028-1"), page("AAA1-1-x-2028-1", 3, 1)], { limit: LIMIT }).observations[2]!.code).toEqual(known("AAA1"));
    expect(parseEnrolledCourses([page("bad"), page("AAA1-1-x-2028-1", 3, 1)], { limit: LIMIT }).observations[2]!.code).toEqual(known("AAA1"));
  });

  it("gives zero courses and complete coverage for the observed empty grouping without nextoffset", () => {
    expect(parseEnrolledCourses([pastEmpty], { limit: LIMIT })).toEqual({ observations: [], coverage: "complete", diagnostics: [], next: null });
  });

  it.each([
    ["Fictional Course Alpha (Fictional Teacher)", "Fictional Course Alpha"],
    ["Calculus (Part 2) (Fictional Teacher)", "Calculus (Part 2)"],
    ["  Spaced \n  Out\tTitle  (Teacher)  ", "Spaced Out Title"],
    ["Law &amp; Order &lt;1&gt; &quot;A&quot; &#39;B&#39;", "Law & Order <1> \"A\" 'B'"],
    ["Plain title", "Plain title"],
  ])("cleans the invented fullname %j", (fullname, title) => {
    expect(enrolledCourseTitle(fullname)).toEqual(known(title));
  });

  it.each(["", "   ", "(Fictional Teacher)", "<b>Bold</b> course", "Course <script>x</script>", "&lt;i&gt;Encoded tag&lt;/i&gt;", 42, null])(
    "gives title unknown for %j", (fullname) => {
      expect(enrolledCourseTitle(fullname)).toEqual({ kind: "unknown" });
    });

  it("never uses nextoffset: 8 courses with nextoffset 8 at limit 24 are complete after one page", () => {
    const result = parseEnrolledCourses([invented(8, 1, { nextoffset: 8 })], { limit: LIMIT });
    expect(result.observations).toHaveLength(8);
    expect(result).toMatchObject({ coverage: "complete", next: null });
  });

  it("asks for the next page at offset + limit after a full page, and an empty next page completes the list", () => {
    const first = parseEnrolledCourses([invented(LIMIT, 1, { nextoffset: 3 })], { limit: LIMIT });
    expect(first.next).toBe(24);
    expect(first.coverage).toBe("partial");
    const done = parseEnrolledCourses([invented(LIMIT, 1), invented(0)], { limit: LIMIT });
    expect(done).toMatchObject({ coverage: "complete", next: null });
    expect(done.observations).toHaveLength(24);
    expect(parseEnrolledCourses([invented(LIMIT, 1), invented(5, 25)], { limit: LIMIT }).observations).toHaveLength(29);
  });

  it("stops at four pages: a fourth full page is partial with page_cap_reached and no fifth request", () => {
    const pages = [1, 25, 49, 73].map(first => invented(LIMIT, first));
    expect(ENROLLED_PAGE_CAP).toBe(4);
    expect(parseEnrolledCourses(pages.slice(0, 3), { limit: LIMIT }).next).toBe(72);
    const capped = parseEnrolledCourses(pages, { limit: LIMIT });
    expect(capped.observations).toHaveLength(96);
    expect(capped).toMatchObject({ coverage: "partial", next: null });
    expect(capped.diagnostics).toEqual([{ pageIndex: 3, reason: "page_cap_reached" }]);
    // A fifth page, even if supplied, is not read.
    expect(parseEnrolledCourses([...pages, invented(3, 97)], { limit: LIMIT }).observations).toHaveLength(96);
  });

  it("keeps a duplicate once, and a duplicate with a conflicting title once with title unknown", () => {
    const same = parseEnrolledCourses([JSON.stringify([{ error: false, data: { courses: [
      { id: 5, fullname: "Same (Teacher A)" }, { id: 5, fullname: "Same (Teacher B)" }] } }])], { limit: LIMIT });
    expect(same.observations).toEqual([expect.objectContaining({ sourceCourseId: "5", title: known("Same") })]);
    expect(same.diagnostics).toEqual([]);
    const pages = [invented(LIMIT, 1), JSON.stringify([{ error: false, data: { courses: [{ id: 3, fullname: "Renamed" }, { id: 3, fullname: "Invented Course 3" }] } }])];
    const conflict = parseEnrolledCourses(pages, { limit: LIMIT });
    expect(conflict.observations).toHaveLength(24);
    expect(conflict.observations[2]).toEqual(expect.objectContaining({ sourceCourseId: "3", title: { kind: "unknown" } }));
    expect(conflict.diagnostics).toEqual([{ pageIndex: 1, recordIndex: 0, reason: "title_conflict" }]);
  });

  it.each([0, -1, 1.5, "9001", null, Number.MAX_SAFE_INTEGER + 2])("skips a course whose id is %j as missing_identity", (id) => {
    const result = parseEnrolledCourses([JSON.stringify([{ error: false, data: { courses: [{ id, fullname: "Bad" }, { id: 7, fullname: "Good" }] } }])], { limit: LIMIT });
    expect(result.observations.map(o => o.sourceCourseId)).toEqual(["7"]);
    expect(result.diagnostics).toEqual([{ pageIndex: 0, recordIndex: 0, reason: "missing_identity" }]);
    expect(result.coverage).toBe("partial");
  });

  it.each([
    ["more courses than the limit", invented(LIMIT + 1)],
    ["a body that is not JSON", "<!doctype html><html><body id=\"page-login-index\"></body></html>"],
    ["an error envelope", JSON.stringify([{ error: true, exception: { errorcode: "invalidsesskey" } }])],
    ["a bare object", JSON.stringify({ error: false, data: { courses: [] } })],
    ["two envelopes", JSON.stringify([{ error: false, data: { courses: [] } }, { error: false, data: { courses: [] } }])],
    ["courses that are not a list", JSON.stringify([{ error: false, data: { courses: {} } }])],
  ])("uses no observation from a page with %s (malformed_response)", (_name, body) => {
    const result = parseEnrolledCourses([body], { limit: LIMIT });
    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toEqual([{ pageIndex: 0, reason: "malformed_response" }]);
    expect(result).toMatchObject({ coverage: "none", next: null });
    const later = parseEnrolledCourses([invented(LIMIT), body], { limit: LIMIT });
    expect(later.observations).toHaveLength(24);
    expect(later).toMatchObject({ coverage: "partial", next: null });
  });
});
