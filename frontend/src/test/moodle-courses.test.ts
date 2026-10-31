import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectMoodleCourses } from "../../../extension/src/moodle-courses";
import { card, list, page } from "./moodle-courses-fixtures";
import { account, course, denied, login, origin } from "./moodle-access-fixtures";

describe("synthetic raw course discovery", () => {
  it("extracts detached normalized facts, including multiple explicit term indicators", () => {
    const result = collectMoodleCourses([page(list(card("9007199254740993123", "  English \n Русский  ", [" Fall  2026 ", "Весна\n2027"])))]);
    expect(result.observations).toEqual([{ sourceCourseId: "9007199254740993123",
      sourceUrl: `${origin}/course/view.php?id=9007199254740993123`,
      title: { kind: "known", value: "English Русский" },
      termIndicators: { kind: "known", value: ["Fall 2026", "Весна 2027"] } }]);
    expect(result.coverage).toBe("complete");
    expect(result.suppliedPageCount).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it.each([card("1", "", []), card("1", " \n ", [" "]), card("1").replace(/<span.*<\/span>/, "")])(
    "represents blank/absent title and term as unknown without link-text fallback", html => {
      const result = collectMoodleCourses([page(list(html))]);
      expect(result.observations[0].title).toEqual({ kind: "unknown" });
      expect(result.observations[0].termIndicators).toEqual({ kind: "unknown" });
      expect(Object.keys(result.observations[0]).sort()).toEqual(["sourceCourseId", "sourceUrl", "termIndicators", "title"]);
    },
  );

  it("deduplicates sections/pages by exact decimal identity and fills unknowns", () => {
    const result = collectMoodleCourses([page(list(`<section>${card("1", "", [])}</section><section>${card("1")}</section>${card("2")}`)), page(list(card("1") + card("9007199254740992") + card("9007199254740993")))]);
    expect(result.observations.map(item => item.sourceCourseId)).toEqual(["1", "2", "9007199254740992", "9007199254740993"]);
    expect(result.observations[0].title).toEqual({ kind: "known", value: "Fictional course" });
    expect(result.coverage).toBe("complete");
  });

  it.each([false, true])("conflicting values become sticky unknown regardless of ordering (%s)", reverse => {
    const cards = [card("1", "First", ["Fall"]), card("1", "Second", ["Spring"])];
    if (reverse) cards.reverse();
    const result = collectMoodleCourses([...cards, cards[0]].map(html => page(list(html))));
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toEqual({ kind: "unknown" });
    expect(result.observations[0].termIndicators).toEqual({ kind: "unknown" });
    expect(result.diagnostics.map(d => d.reason)).toEqual(["title_conflict", "term_conflict"]);
    expect(result.coverage).toBe("partial");
    expect(result.pages.every(p => p.coverage === "partial")).toBe(true);
  });

  it("normalizes term sets without creating conflicts from markup order", () => {
    const result = collectMoodleCourses([page(list(card("1", "A", ["Spring", "Fall", "Fall"]) + card("1", "A", ["Fall", "Spring"])))]);
    expect(result.coverage).toBe("complete");
    expect(result.observations[0].termIndicators).toEqual({ kind: "known", value: ["Fall", "Spring"] });
  });

  it.each(["", "0", "01", "-1", "1.0", "1e3", "fiction-1", "１２", " 1", "Infinity"])("skips noncanonical identity %s", id => {
    const result = collectMoodleCourses([page(list(card(id)))]);
    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toEqual([{ pageIndex: 0, recordIndex: 0, reason: "missing_identity" }]);
    expect(result.coverage).toBe("partial");
  });

  it.each([
    "https://evil.invalid/course/view.php?id=1", "http://moodle.sdu.edu.kz/course/view.php?id=1",
    "https://moodle.sdu.edu.kz.evil.invalid/course/view.php?id=1", "https://sub.moodle.sdu.edu.kz/course/view.php?id=1",
    "https://user:private@moodle.sdu.edu.kz/course/view.php?id=1", "https://@moodle.sdu.edu.kz/course/view.php?id=1",
    "//user@moodle.sdu.edu.kz/course/view.php?id=1", "https://moodle.sdu.edu.kz:444/course/view.php?id=1",
    "/course/view.php?id=1#", "/course/view.php?id=1#private", "/course/view.php?id=1&id=1",
    "/course/view.php?id=1&id=2", "/course/view.php?id=1&token=private", "/course/view.php?id=1&",
    "/course/view.php?%69d=1", "/course/view.php?id=%31", "/course/view.php?id=1;token=private",
    "/mod/assign/view.php?id=1", "javascript:private", "/course/view.php?id=01", "/course/view.php?id=",
    " https://moodle.sdu.edu.kz/course/view.php?id=1", "https:\\moodle.sdu.edu.kz/course/view.php?id=1",
  ])("rejects unsafe/noncanonical URL %s", href => {
    const result = collectMoodleCourses([page(list(card("1", "private", [], href)))]);
    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toEqual([{ pageIndex: 0, recordIndex: 0, reason: "unsafe_url" }]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("skips missing URL/identity, duplicate links and disagreement", () => {
    const result = collectMoodleCourses([page(list(
      card("1").replace('data-course-id="1"', "") + card("2").replace('href="/course/view.php?id=2"', "") +
      card("3", "A", [], "/course/view.php?id=4") + card("5").replace("</article>", '<a data-role="course-link" href="/course/view.php?id=5"></a></article>'),
    ))]);
    expect(result.observations).toEqual([]);
    expect(result.diagnostics.map(d => d.reason)).toEqual(["missing_identity", "unsafe_url", "identity_mismatch", "unsafe_url"]);
  });

  it("resolves relative anchors using trusted final URL, ignoring malicious base", () => {
    const result = collectMoodleCourses([page('<base href="https://private.invalid/">' + list(card("1", "A", [], "view.php?id=1")), { finalUrl: `${origin}/course/index.php` })]);
    expect(result.observations[0].sourceUrl).toBe(`${origin}/course/view.php?id=1`);
    expect(result.coverage).toBe("complete");
    expect(collectMoodleCourses([page(list(card("1", "A", [], `${origin}:443/course/view.php?id=1`)))]).coverage).toBe("complete");
  });

  it.each(['<a href="?page=2">Next</a>', '<button>More</button>', '<a rel="next" href="?page=2">Next</a>'])("pagination never proves completeness: %s", control => {
    const input = page(list(card(), "", `<nav data-region="course-pagination">${control}</nav>`));
    const result = collectMoodleCourses([input, input]);
    expect(result.coverage).toBe("partial");
    expect(result.paginationPending).toBe(true);
    expect(result.suppliedPageCount).toBe(2);
    expect(result.observations).toHaveLength(1);
  });

  it.each(["data-incomplete", "data-truncated"])("reports explicit incomplete marker %s", marker => {
    expect(collectMoodleCourses([page(list(card(), marker))]).diagnostics[0].reason).toBe("incomplete_list");
  });

  it.each([
    [list(""), "empty_unconfirmed"],
    [list(card(), "", '<span data-role="courses-empty"></span>'), "malformed_list"],
    [list() + list(), "malformed_list"],
    [list(card().replace("</article>", card("2") + "</article>")), "malformed_card"],
    [list(card().replace("</article>", '<span data-role="course-title">Extra</span></article>')), "malformed_card"],
  ])("does not claim complete malformed/ambiguous lists", (html, reason) => {
    const result = collectMoodleCourses([page(html)]);
    expect(result.coverage).not.toBe("complete");
    expect(result.diagnostics.some(d => d.reason === reason)).toBe(true);
  });

  it("requires explicit empty evidence, and empty batch is none", () => {
    const result = collectMoodleCourses([page(list('<span data-role="courses-empty"></span>'))]);
    expect(result.coverage).toBe("complete");
    expect(result.observations).toEqual([]);
    expect(collectMoodleCourses([])).toMatchObject({ coverage: "none", suppliedPageCount: 0, paginationPending: false });
    const withoutAccessLink = list('<span data-role="courses-empty"></span>').replace('<a href="/course/index.php">All courses</a>', "");
    expect(collectMoodleCourses([page(withoutAccessLink)]).coverage).toBe("none");
  });

  it("reports safe constants for malformed DOM implementations and envelope errors", () => {
    const broken = page();
    vi.spyOn(broken.document, "querySelectorAll").mockImplementation(() => { throw Error("private token password"); });
    const result = collectMoodleCourses([broken, page(list(), { finalUrl: "private token" })]);
    expect(result.coverage).toBe("none");
    expect(result.observations).toEqual([]);
    expect(result.pages.map(p => p.access.reason)).toEqual(["invalid_envelope", "invalid_envelope"]);
    expect(JSON.stringify(result)).not.toMatch(/private|token|password/);
    vi.restoreAllMocks();
  });

  it.each([
    page(denied), page(login), page(list(), { networkFailure: true }),
    page(account + course, { finalUrl: `${origin}/course/view.php?id=1` }),
    page(list(), { httpStatus: 206 }), page(list(), { finalUrl: "https://evil.invalid/my/" }),
  ])("preserves successful observations with inaccessible/unsupported pages", failed => {
    const result = collectMoodleCourses([page(), failed]);
    expect(result.observations).toHaveLength(1);
    expect(result.coverage).toBe("partial");
    expect(result.pages[1].coverage).toBe("none");
    expect(collectMoodleCourses([failed]).coverage).toBe("none");
  });

  it("does not trust fabricated access status or #4 fact labels", () => {
    const html = readFileSync(resolve(process.cwd(), "../tests/fixtures/moodle/courses.html"), "utf8");
    expect(collectMoodleCourses([Object.assign(page(html), { accessStatus: "accessible" })])).toMatchObject({ observations: [], coverage: "none" });
    expect(collectMoodleCourses([page(list('<dl><dd data-fact="course_id">1</dd></dl>'))])).toMatchObject({ observations: [], coverage: "partial" });
  });

  it("keeps envelopes/DOM/saved selections unchanged and never calls effects", () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("private"); });
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const saved = { courses: [{ id: "personal", current: true }], settings: { trackedCourseIds: ["personal"] } };
    const snapshot = JSON.stringify(saved);
    const input = Object.freeze(page());
    const html = input.document.documentElement.outerHTML;
    const batch = Object.freeze([input]);
    const result = collectMoodleCourses(batch);
    result.observations[0].title = { kind: "known", value: "Changed output" };
    expect(input.document.documentElement.outerHTML).toBe(html);
    expect(collectMoodleCourses(batch).observations[0].title).toEqual({ kind: "known", value: "Fictional course" });
    expect(JSON.stringify(saved)).toBe(snapshot);
    expect(network).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
