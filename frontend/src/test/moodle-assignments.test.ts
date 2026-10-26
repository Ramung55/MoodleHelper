import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseMoodleAssignment, type RawAssignmentObservation } from "../../../extension/src/moodle-assignments";
import { assignment, assignmentInput, dateNode } from "./moodle-assignments-fixtures";
import { login, denied, origin } from "./moodle-access-fixtures";
const observedAt = "2026-10-26T10:15:00Z";
function parse(html = assignment(), overrides = {}) { return parseMoodleAssignment(assignmentInput(html, overrides), observedAt); }
function observation(html = assignment()): RawAssignmentObservation {
  const result = parse(html);
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error("Expected structural fixture to parse");
  return result.observation;
}
describe("pure synthetic assignment observations (SDU unverified)", () => {
  it.each(["2026-10-26T10:15Z", "2026-10-26T10:15:00+05:00", "2026-10-26T10:15:00.12Z"])("preserves observedAt precision %s", timestamp => {
    expect(parseMoodleAssignment(assignmentInput(), timestamp)).toMatchObject({ status: "success", observation: { observedAt: timestamp } });
  });
  it.each([undefined, null, 123, "", " ", "2026-10-26", "2026-10-26T10:15", "2026-02-30T10:15Z", "2026-10-26T24:15Z", "2026-10-26T10:15+00:60", "private-sentinel-secret"])("rejects invalid observedAt safely", timestamp => {
    const result = parseMoodleAssignment(assignmentInput(), timestamp as string);
    expect(result).toMatchObject({ status: "error", reason: "invalid_observed_at" });
    expect(result).not.toHaveProperty("observation");
    expect(JSON.stringify(result)).not.toContain("private-sentinel-secret");
    expect(parseMoodleAssignment(assignmentInput(login), timestamp as string)).toMatchObject({ status: "error", reason: "access_error" });
  });
  it("rejects malformed runtime envelopes", () => {
    expect(parseMoodleAssignment(null as never, observedAt)).toMatchObject({ status: "error", reason: "access_error" });
  });
  it("retains distinct identities, original facts and all three date meanings", () => {
    const actual = observation(assignment(dateNode("opening", "2026-10-01", "base", "") + dateNode() + dateNode("cutoff", "2026-10-28T22:00Z", "base", 'data-timezone="UTC"')));
    expect(actual).toMatchObject({ sourceCourseId: "101", sourceActivityId: "202", sourceCourseModuleId: "303", sourceUrl: `${origin}/mod/assign/view.php?id=303`, title: "Fictional assignment", observedAt });
    expect(actual.baseDates).toEqual({
      opening: { value: { kind: "date", date: "2026-10-01" }, rawText: "Displayed date", location: "assignment.base.opening" },
      due: { value: { kind: "exact", iso: "2026-10-25T18:30:00+05:00", tz: "Asia/Almaty" }, rawText: "Displayed date", location: "assignment.base.due" },
      cutoff: { value: { kind: "exact", iso: "2026-10-28T22:00Z", tz: "UTC" }, rawText: "Displayed date", location: "assignment.base.cutoff" },
    });
    expect(actual.effectiveDates).toEqual(actual.baseDates);
  });
  it("retains explicit extensions per field and detaches effective facts", () => {
    const bases = ["opening", "due", "cutoff"].map(field => dateNode(field)).join("");
    const extensions = ["opening", "due", "cutoff"].map(field => dateNode(field, "2026-10-29", "individual", 'data-extension-evidence=" Your   individual extension "')).join("");
    const actual = observation(assignment(bases + extensions));
    expect(actual.individualExtensions.map(x => [x.field, x.scope, x.evidence])).toEqual([ ["opening", "individual", "Your individual extension"], ["due", "individual", "Your individual extension"], ["cutoff", "individual", "Your individual extension"] ]);
    for (const field of ["opening", "due", "cutoff"] as const) {
      expect(actual.baseDates[field]?.value.kind).toBe("exact");
      expect(actual.effectiveDates[field]?.value).toEqual({ kind: "date", date: "2026-10-29" });
      expect(actual.effectiveDates[field]).not.toBe(actual.individualExtensions.find(x => x.field === field)?.date);
    }
  });
  it("omits absent due keys and accepts extension-only due without substitution", () => {
    const html = assignment(dateNode("opening") + dateNode("cutoff"));
    expect(observation(html).baseDates).not.toHaveProperty("due");
    expect(observation(html).effectiveDates).not.toHaveProperty("due");
    const result = observation(assignment(dateNode("due", "2026-10-29", "individual", 'data-extension-evidence="Individual due"')));
    expect(result.baseDates).not.toHaveProperty("due");
    expect(result.effectiveDates.due?.value).toEqual({ kind: "date", date: "2026-10-29" });
    expect(observation(assignment("")).effectiveDates).toEqual({});
  });
  it.each(["2024-02-29T13:30Z", "2024-02-29T18:30+05:00", "2024-02-29T13:30:00Z", "2024-02-29T13:30:00.0Z", "2024-02-29T13:30:00.00Z", "2024-02-29T13:30:00.000Z"])("preserves precision and equivalent instant %s", iso => {
    const value = observation(assignment(dateNode("due", iso))).baseDates.due!.value;
    expect(value).toEqual({ kind: "exact", iso, tz: "Asia/Almaty" });
    expect(Date.parse(iso)).toBe(Date.parse("2024-02-29T13:30Z"));
  });
  it.each(["UTC", "Asia/Qyzylorda", "US/Eastern", "Etc/GMT+5"])("accepts recognized named zone %s", tz => {
    expect(parse(assignment(dateNode("due", "2026-10-25T18:30Z", "base", `data-timezone="${tz}"`))).status).toBe("success");
  });
  it.each(["2023-02-29", "2026-04-31", "0000-01-01", "2026-13-01", "2026-00-01", "2026-01-00", "2026-02-30T10:00Z", "2026-10-25T24:00Z", "2026-10-25T10:60Z", "2026-10-25T10:00:60Z", "2026-10-25T10:00+24:00", "2026-10-25T10:00+05:99", "2026-10-25T10:00+00:60", "2026-10-25T10:00", "2026-10-25T10:00.1Z", "2026-10-25T10:00:00.1234Z", "tomorrow", ""])("rejects invalid date %s", iso => {
    expect(parse(assignment(dateNode("due", iso)))).toMatchObject({ status: "error", reason: "invalid_date" });
  });
  it.each(["+05:00", "-0500", "Z", "Mars/Olympus", " UTC", ""])("rejects unsupported timezone %s", tz => {
    expect(parse(assignment(dateNode("due", "2026-10-25T10:00Z", "base", `data-timezone="${tz}"`))).status).toBe("error");
  });
  it("does not attach a timezone or midnight to a date", () => {
    expect(observation(assignment(dateNode("due", "2024-02-29", "base", ""))).baseDates.due!.value).toEqual({ kind: "date", date: "2024-02-29" });
    expect(parse(assignment(dateNode("due", "2024-02-29"))).status).toBe("error");
  });
  it.each([
    dateNode() + dateNode(), dateNode("mystery"), dateNode("due", "2026-10-29", "override", ""),
    dateNode("due", "2026-10-29", "individual", ""), '<time datetime="2026-10-29">Generic date</time>',
    '<span data-date-field="due">Tomorrow</span>', '<time data-date-field="due" data-date-scope="base">Tomorrow</time>',
    dateNode().replace("Displayed   date", " "),
  ])("rejects duplicate, generic, unsupported or ambiguous date structure", dates => expect(parse(assignment(dates)).status).toBe("error"));
  it.each([
    ['data-course-id="101"', 'data-course-id="01"'], ['data-assignment-id="202"', ""],
    ['data-course-module-id="303"', 'data-course-module-id="304"'], ['<h1> Fictional   assignment </h1>', ""],
    ['<h1> Fictional   assignment </h1>', '<h1> </h1>'], ['</article>', '<h1>Duplicate</h1></article>'],
    ['</article>', '<article data-region="assignment"></article></article>'],
    ['<main data-region="activity">', '<main data-region="activity" data-truncated>'],
    ['<article data-region="assignment"', '<article data-incomplete data-region="assignment"'],
    ['href="/course/view.php?id=101"', 'href="/course/view.php?id=999"'],
  ])("rejects malformed identity, heading, nested or incomplete structure", (before, after) => expect(parse(assignment().replace(before, after)).status).toBe("error"));
  it.each(["https://evil.invalid/mod/assign/view.php?id=303", "https://user:secret@moodle.sdu.edu.kz/mod/assign/view.php?id=303", "/mod/assign/view.php?id=303#", "/mod/assign/view.php?id=303&x=1", "/mod/assign/view.php?%69d=303", "/mod/assign/view.php?id=303&id=303", "/mod/assign/view.php?id=0303", "//moodle.sdu.edu.kz/mod/assign/view.php?id=303", "https://moodle.sdu.edu.kz:444/mod/assign/view.php?id=303", "/mod/assign/view.php?id=303 "])("rejects unsafe assignment link %s", href => {
    expect(parse(assignment().replace('href="/mod/assign/view.php?id=303"', `href="${href}"`)).status).toBe("error");
  });
  it("validates both envelope URL identities and accepts explicit default HTTPS port", () => {
    expect(parse(assignment(), { requestedUrl: `${origin}/mod/assign/view.php?id=304` })).toMatchObject({ status: "error", reason: "identity_mismatch" });
    expect(parse(assignment(), { requestedUrl: `${origin}/mod/assign/view.php?id=303&x=1` }).status).toBe("error");
    expect(parse(assignment().replaceAll('href="/', 'href="https://moodle.sdu.edu.kz:443/')).status).toBe("success");
  });
  it.each([[login, {}], [denied, {}], ["", { httpStatus: 403 }], [assignment(), { networkFailure: true }], ["", {}], [assignment(), { httpStatus: 206 }]])("uses real access detector for inaccessible envelopes", (html, overrides) => {
    const result = parse(html as string, overrides);
    expect(result).toMatchObject({ status: "error", reason: "access_error" });
    expect(result).not.toHaveProperty("observation");
  });
  it.each(["courses", "assignment", "login", "denied", "incomplete"])("rejects actual fact-only #4 %s input", name => {
    expect(parse(readFileSync(resolve(process.cwd(), "../tests/fixtures/moodle", `${name}.html`), "utf8")).status).toBe("error");
  });
  it("reads structural facts, returns detached values, leaves DOM/envelope unchanged and has no effects", () => {
    const input = assignmentInput();
    const before = input.document.documentElement.outerHTML;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const logSpy = vi.spyOn(console, "log");
    const first = parseMoodleAssignment(Object.freeze(input), observedAt);
    expect(input.document.documentElement.outerHTML).toBe(before);
    expect(first.status).toBe("success");
    input.document.querySelector("h1")!.textContent = "Changed title";
    input.document.querySelector("time")!.setAttribute("datetime", "2026-10-30T11:00Z");
    const second = parseMoodleAssignment(input, observedAt);
    expect(second).toMatchObject({ observation: { title: "Changed title", baseDates: { due: { value: { iso: "2026-10-30T11:00Z" } } } } });
    expect(first).toMatchObject({ observation: { title: "Fictional assignment", baseDates: { due: { value: { iso: "2026-10-25T18:30:00+05:00" } } } } });
    if (first.status === "success") first.observation.effectiveDates.due!.rawText = "Changed output";
    expect(parseMoodleAssignment(input, observedAt)).not.toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled(); expect(storageSpy).not.toHaveBeenCalled(); expect(logSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("does not echo private sentinel into diagnostic values", () => {
    const result = parse(assignment(dateNode("private-sentinel-secret")));
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("private-sentinel-secret");
  });
});
