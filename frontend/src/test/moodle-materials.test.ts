/** Invented inert structural vocabulary; never captured/live SDU evidence. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectMoodleMaterials, type RawMaterialObservation } from "../../../extension/src/moodle-materials";
import { account, denied, login, origin } from "./moodle-access-fixtures";
const time = "2026-10-26T12:30:00.12+05:00";
const courseLink = '<a data-role="course-link" href="/course/view.php?id=101">Fictional course</a>';
const pdf = "/pluginfile.php/700/mod_resource/content/1/lecture.pdf?forcedownload=1";
const folderFile = "/pluginfile.php/701/mod_folder/content/2/slides.pptx";
const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function moduleNode(moduleId = "201", type = "resource", destination = pdf, attrs = 'data-file-type="pdf"', mime = "application/pdf", title = "Fictional lecture") {
  return `<article data-region="material" data-module-type="${type}" data-course-module-id="${moduleId}" ${attrs}><a data-role="material-link" href="/mod/${type}/view.php?id=${moduleId}">${title}</a>${destination ? `<a data-role="destination" href="${destination}" ${mime ? `type="${mime}"` : ""}>Open</a>` : ""}</article>`;
}
function course(body = moduleNode(), section = "Week 1", attrs = "") {
  return `${account}<main data-region="course-content" ${attrs}><h1>Fictional course</h1>${courseLink}<section data-region="course-section">${section ? `<h2>${section}</h2>` : ""}${body}</section></main>`;
}
function activity(body = "", type = "folder", moduleId = "301", attrs = "") {
  return `${account}<main data-region="activity" data-module-type="${type}" data-course-module-id="${moduleId}" ${attrs}><h1>Fictional folder</h1>${courseLink}<span data-role="material-section">Week 2</span>${body}</main>`;
}
function entry(entryId = "401", kind = "file", children = "", destination = folderFile, attrs = 'data-file-type="pptx"', title = "Identical title") {
  const href = kind === "folder" ? `/mod/folder/view.php?id=301&folder=${entryId}` : destination;
  return `<li data-region="folder-entry" data-entry-kind="${kind}" data-${kind}-id="${entryId}" ${attrs}><a data-role="entry-link" href="${href}" ${kind === "file" ? `type="${pptxMime}"` : ""}>${title}</a>${children ? `<ul>${children}</ul>` : ""}</li>`;
}
function folder(entries = entry(), attrs = "") { return activity(`<ul data-region="folder-contents" ${attrs}>${entries}</ul>`); }
function input(html = course(), path = "/course/view.php?id=101", overrides = {}) {
  return { document: new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html"), requestedUrl: origin + path, finalUrl: origin + path, httpStatus: 200, networkFailure: false, contentType: "text/html", ...overrides };
}
function collect(html = course(), path = "/course/view.php?id=101") { return collectMoodleMaterials([input(html, path)], ["101"], time); }
function reason(result: ReturnType<typeof collect>, code: string) { expect(result.diagnostics.map(item => item.reason)).toContain(code); }
function one(html = course()): RawMaterialObservation { const result = collect(html); expect(result.observations).toHaveLength(1); return result.observations[0]!; }
afterEach(() => vi.restoreAllMocks());

describe("#17 synthetic material collection (live SDU unverified)", () => {
  it("AC1 retains course/section/title/source, explicit PDF/PPTX/DOCX and external lecture metadata", () => {
    const result = collect(course(moduleNode() + moduleNode("202", "resource", pdf, 'data-file-type="pptx"', pptxMime) + moduleNode("203", "resource", pdf, "", docxMime) + moduleNode("204", "url", "https://video.example/watch?v=abc123#part-2", "", "")));
    expect(result.observations.map(item => [item.sourceCourseId, item.sourceCourseModuleId, item.kind, item.fileType])).toEqual([
      ["101", "201", "file", { kind: "known", value: "pdf" }], ["101", "202", "file", { kind: "known", value: "pptx" }],
      ["101", "203", "file", { kind: "known", value: "docx" }], ["101", "204", "link", { kind: "known", value: "link" }],
    ]);
    expect(result.observations[0]!).toMatchObject({ sourceUrl: origin + "/mod/resource/view.php?id=201", sourcePageUrl: origin + "/course/view.php?id=101", destinationUrl: origin + pdf, sourceContextId: "700", title: { kind: "known", value: "Fictional lecture" }, section: { kind: "known", value: "Week 1" }, mimeType: { kind: "known", value: "application/pdf" }, observedAt: time, location: "course.material" });
    expect(result.observations[1]!.mimeType).toEqual({ kind: "known", value: pptxMime });
    expect(result.scope).toBe("supplied_pages_only");
  });
  it("keeps unknown separate from explicit known other and never guesses from names", () => {
    const result = collect(course(moduleNode("201", "resource", pdf, "", "", "pretend.pdf") + moduleNode("202", "resource", pdf, 'data-file-type="other"', "application/zip") + moduleNode("203", "resource", "", 'data-file-type="made-up"', "", ""), ""));
    expect(result.observations.map(item => item.fileType)).toEqual([{ kind: "unknown" }, { kind: "known", value: "other" }, { kind: "unknown" }]);
    expect(result.observations[2]!).toMatchObject({ title: { kind: "unknown" }, section: { kind: "unknown" }, mimeType: { kind: "unknown" } });
    expect(result.observations[2]!).not.toHaveProperty("destinationUrl");
    reason(result, "missing_metadata"); expect(result.review.some(item => item.candidate?.sourceCourseModuleId === "203")).toBe(true);
    expect(result.coverage).toBe("partial");
  });
  it("keeps IDs separate as strings, including huge IDs, and stable JSON tuple identities", () => {
    const huge = "9007199254740993123456789";
    const item = one(course(moduleNode(huge, "resource", pdf, 'data-file-type="pdf" data-resource-id="999"')));
    expect(item.sourceCourseModuleId).toBe(huge); expect(item.sourceResourceId).toBe("999");
    expect(item.resourceKey).toBe(JSON.stringify([origin, "101", "resource", "module", huge]));
    expect(item.sourceContextId).toBe("700");
  });
  it("AC2 preserves nested folder nodes and exact parent/file identities without flattening", () => {
    const result = collect(folder(entry("501", "folder", entry("401") + entry("502", "folder", entry("402")), "", "")), "/mod/folder/view.php?id=301");
    expect(result.observations).toHaveLength(5);
    const [root, parent, file, nested, nestedFile] = result.observations;
    if (!root || !parent || !file || !nested || !nestedFile) throw new Error("Expected complete nested fixture");
    expect(root.resourceKey).toBe(JSON.stringify([origin, "101", "folder", "module", "301"]));
    expect(parent.resourceKey).toBe(JSON.stringify([origin, "101", "folder", "301", "folder", "501"]));
    expect(parent.fileType).toEqual({ kind: "unknown" });
    expect(parent.parentResourceKey).toBe(root.resourceKey); expect(file.parentResourceKey).toBe(parent.resourceKey);
    expect(nested.parentResourceKey).toBe(parent.resourceKey); expect(nestedFile.parentResourceKey).toBe(nested.resourceKey);
    expect(file.resourceKey).toBe(JSON.stringify([origin, "101", "folder", "301", "file", "401"]));
    expect(file.destinationUrl).toBe(origin + folderFile); expect(file.sourceUrl).toBe(root.sourceUrl);
    expect(file.section).toEqual({ kind: "known", value: "Week 2" });
  });
  it("AC3 deduplicates repeats and changed revisions, preserving alternate safe references", () => {
    const first = input(folder(entry("401") + entry("402")), "/mod/folder/view.php?id=301");
    const second = input(folder(entry("401", "file", "", folderFile.replace("/2/", "/3/"))), "/mod/folder/view.php?id=301");
    const result = collectMoodleMaterials([first, first, second], ["101"], time);
    expect(result.observations).toHaveLength(3);
    const files = result.observations.filter(item => item.kind === "file");
    expect(files.map(item => item.sourceFileId)).toEqual(["401", "402"]);
    expect(files[0]!.references.map(item => item.destinationUrl)).toEqual([origin + folderFile, origin + folderFile.replace("/2/", "/3/")]);
    expect(files[0]!).not.toHaveProperty("destinationUrl"); reason(result, "field_conflict");
  });
  it("deduplicates course and module observations independent of time/title/instance metadata availability", () => {
    const page = activity(`<a data-role="destination" href="${pdf}" type="application/pdf">Open</a>`, "resource", "201", 'data-file-type="pdf" data-resource-id="777"');
    const result = collectMoodleMaterials([input(course()), input(page, "/mod/resource/view.php?id=201")], ["101"], time);
    expect(result.observations).toHaveLength(1); expect(result.observations[0]!.sourceResourceId).toBe("777");
    expect(result.observations[0]!.references).toHaveLength(2); reason(result, "field_conflict");
  });
  it("fills unknown duplicates and keeps known conflicts sticky through later repeats", () => {
    const a = input(course(moduleNode("201", "resource", pdf, "", "", ""), ""));
    const b = input(course()); const c = input(course(moduleNode("201", "resource", pdf, 'data-file-type="pptx"', pptxMime, "Changed")));
    const filled = collectMoodleMaterials([a, b], ["101"], time).observations[0]!;
    expect(filled.title).toEqual({ kind: "known", value: "Fictional lecture" }); expect(filled.section).toEqual({ kind: "known", value: "Week 1" });
    const conflicted = collectMoodleMaterials([a, b, c, b], ["101"], time).observations[0]!;
    expect(conflicted.title).toEqual({ kind: "unknown" }); expect(conflicted.fileType).toEqual({ kind: "unknown" }); expect(conflicted.mimeType).toEqual({ kind: "unknown" });
  });
  it("type/MIME contradictions stay unknown even after a consistent duplicate", () => {
    const conflict = input(course(moduleNode("201", "resource", pdf, 'data-file-type="pptx"')));
    const result = collectMoodleMaterials([conflict, input(course())], ["101"], time);
    expect(result.observations[0]!.fileType).toEqual({ kind: "unknown" }); reason(result, "type_conflict");
    reason(collect(course(moduleNode("201", "url", "https://example.org/lecture", 'data-file-type="pdf"', "application/pdf"))), "type_conflict");
  });
  it("rejects contradictory instance identity rather than choosing a last writer", () => {
    const result = collect(course(moduleNode("201", "resource", pdf, 'data-resource-id="111"') + moduleNode("201", "resource", pdf, 'data-resource-id="222"')));
    expect(result.observations).toEqual([]); reason(result, "parent_conflict");
    expect(result.review.every(item => !item.candidate)).toBe(true);
  });
  it("AC4 returns exact safe external path/query/fragment and performs no effects", () => {
    const href = "https://lectures.example/lectures/week-1.pdf?id=42&page=2&lang=en&v=abc123#part-2";
    const envelope = input(course(moduleNode("201", "url", href, "", "")));
    const before = envelope.document.documentElement.outerHTML;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    const logSpy = vi.spyOn(console, "log");
    const result = collectMoodleMaterials(Object.freeze([Object.freeze(envelope)]), Object.freeze(["101"]), time);
    expect(result.observations[0]!.destinationUrl).toBe(href);
    expect(fetchSpy).not.toHaveBeenCalled(); expect(openSpy).not.toHaveBeenCalled(); expect(setSpy).not.toHaveBeenCalled(); expect(logSpy).not.toHaveBeenCalled();
    expect(envelope.document.documentElement.outerHTML).toBe(before);
    result.observations[0]!.references[0]!.sourceUrl = "changed";
    result.observations[0]!.title = { kind: "known", value: "mutated" };
    expect(collectMoodleMaterials([envelope], ["101"], time).observations[0]!.title).toEqual({ kind: "known", value: "Fictional lecture" });
    expect(JSON.stringify(result.review)).not.toContain("mutated");
  });
  it.each([
    "https://example.org/access_token/private-sentinel", "https://example.org/lecture?token=private-sentinel", "https://user:private-sentinel@example.org/lecture",
    "https://example.org/lecture?id=secret-sentinel", "https://example.org/a.b.c", "https://example.org/abcdefghijklmnopqrstuvwxyz123456",
    "https://example.org/lecture?lang=secret", "https://example.org/lecture?ID=42", "https://example.org/lecture?id=1&id=2", "https://example.org/lecture?id=1&",
    "https://example.org/lecture?", "https://example.org/lecture#", "https://example.org/lecture#auth", "https://example.org/notes%2Fprivate-sentinel",
    "https://example.org/./private-sentinel", "https://example.org/a/../private-sentinel", "https://example.org//private-sentinel", "https://example.org:443/private-sentinel",
    "https://EXAMPLE.org/private-sentinel", "https://example.org:/private-sentinel", "http://example.org/private-sentinel", "https://example.org/lecture?%69d=42",
    "https://example.org/lecture?v=https://private-sentinel.example", "https://example.org/lecture#secret-sentinel", "https://example.org/private-sentinel%ZZ",
  ])("fixed reasons reject bounded unsafe external URL %s", href => {
    // 'private-sentinel' itself contains a privacy word only when paired with
    // unsafe syntax; ensure no rejected href appears in ANY returned structure.
    const result = collect(course(moduleNode("201", "url", href, "", "")));
    expect(result.observations[0]!).not.toHaveProperty("destinationUrl");
    expect(JSON.stringify(result)).not.toContain(href); reason(result, "unsafe_external_url");
  });
  it.each(["https://example.org/", "https://example.org/lecture/", "https://example.org/watch?v=abc123", "https://127.0.0.1/notes?page=2", "https://[::1]/notes#part-2", "https://example.org/notes?id=.#.."])("preserves accepted bounded external example %s", href => {
    expect(one(course(moduleNode("201", "url", href, "", ""))).destinationUrl).toBe(href);
  });
  it.each(["Week%201.pdf", "%D0%9B%D0%B5%D0%BA%D1%86%D0%B8%D1%8F%201.pdf", "%D0%A1%D0%BB%D0%B0%D0%B9%D0%B4%D1%8B%202.pptx"])("preserves canonical Unicode/space filename paths precisely %s", filename => {
    const resource = `/pluginfile.php/700/mod_resource/content/1/${filename}`;
    expect(one(course(moduleNode("201", "resource", resource))).destinationUrl).toBe(origin + resource);
    const external = `https://example.org/lectures/${filename}?id=42#part-2`;
    expect(one(course(moduleNode("201", "url", external, "", ""))).destinationUrl).toBe(external);
    const child = `/pluginfile.php/701/mod_folder/content/2/${filename}`;
    const result = collect(folder(entry("401", "file", "", child)), "/mod/folder/view.php?id=301");
    expect(result.observations[1]!.destinationUrl).toBe(origin + child);
  });
  it.each(["%2E%2E", "a%2Fb.pdf", "a%5Cb.pdf", "a%252Fb.pdf", "a%00b.pdf", "a%20token.pdf", "a%3Atoken.pdf", "%C0%AF.pdf", "%ED%A0%80.pdf", "%D0%9b.pdf", "a%ZZ.pdf", "a%2Epdf", "%E2%80%8B.pdf"])("rejects ambiguous/secret filename segment in all destinations %s", filename => {
    const resource = `/pluginfile.php/700/mod_resource/content/1/${filename}`;
    const result = collect(course(moduleNode("201", "resource", resource)));
    expect(result.observations[0]!).not.toHaveProperty("destinationUrl"); reason(result, "unsafe_url"); expect(JSON.stringify(result)).not.toContain(resource);
    const external = `https://example.org/${filename}`;
    const externalResult = collect(course(moduleNode("201", "url", external, "", "")));
    expect(externalResult.observations[0]!).not.toHaveProperty("destinationUrl"); reason(externalResult, "unsafe_external_url"); expect(JSON.stringify(externalResult)).not.toContain(external);
  });
  it.each([pptxMime.toUpperCase(), docxMime + ";x=secret", docxMime + ".private", "application/vnd.openxmlformats-officedocument.presentationml.presentationx"])("does not widen trusted Office MIME exemption %s", mime => {
    const result = collect(course(moduleNode("201", "resource", pdf, "", mime)));
    expect(result.observations[0]!.mimeType).toEqual({ kind: "unknown" }); expect(result.observations[0]!.fileType).toEqual({ kind: "unknown" });
    reason(result, "invalid_mime"); expect(JSON.stringify(result)).not.toContain(mime);
  });
  it.each(["https://example.org/?token=private-sentinel-secret", "See javascript:private-sentinel-secret", "data:private-sentinel-secret", "FILE:private-sentinel-secret", "mailto:private-sentinel-secret", "//example.org/private-sentinel-secret", "/course/view.php?token=private-sentinel-secret", "/mod/url/view.php?token=private-sentinel-secret", "/pluginfile.php/private-sentinel-secret"])("suppresses URL-shaped labels in all output collections %s", text => {
    const result = collect(course(moduleNode("201", "resource", pdf, "", "", text), text));
    expect(result.observations[0]!).toMatchObject({ title: { kind: "unknown" }, section: { kind: "unknown" } });
    reason(result, "unsafe_label"); expect(JSON.stringify(result)).not.toContain("private-sentinel-secret");
    const nested = collect(folder(entry("401", "file", "", folderFile, "", text)).replace("Week 2", text), "/mod/folder/view.php?id=301");
    expect(nested.observations[1]!).toMatchObject({ title: { kind: "unknown" }, section: { kind: "unknown" } });
    expect(JSON.stringify(nested)).not.toContain("private-sentinel-secret");
  });
  it.each([
    "/pluginfile.php/700/mod_resource/content/1/../secret.pdf", "/pluginfile.php/700/mod_resource/content/1/%2e%2e/secret.pdf",
    "/pluginfile.php/700/mod_resource/content/1/file%2Fsecret.pdf", "/pluginfile.php/700/mod_resource/content/1/file.pdf?token=secret",
    "/pluginfile.php/700/mod_resource/content/1/file.pdf?forcedownload=1&forcedownload=1", "/pluginfile.php/700/mod_resource/content/0/file.pdf",
    "/pluginfile.php/0700/mod_resource/content/1/file.pdf", "/pluginfile.php/700/mod_folder/content/1/file.pdf", "/pluginfile.php/700/mod_resource/content/1/file.pdf#part",
    "/pluginfile.php/700/mod_resource/content/1/access_token.pdf", "//moodle.sdu.edu.kz/pluginfile.php/700/mod_resource/content/1/file.pdf",
    "https://moodle.sdu.edu.kz:443/pluginfile.php/700/mod_resource/content/1/file.pdf", "/pluginfile.php/700/mod_resource/content/1/file.pdf/",
  ])("rejects unsafe pluginfile destination without reflection %s", href => {
    const result = collect(course(moduleNode("201", "resource", href)));
    expect(result.observations[0]!).not.toHaveProperty("destinationUrl"); expect(JSON.stringify(result)).not.toContain(href); reason(result, "unsafe_url");
  });
  it.each(["application/pdf; secret=private-sentinel", "Application/PDF", "application/private-sentinel-secret", "application/a.b.c", "", "text/plain "])("rejects malformed or private MIME without reflecting it %s", mime => {
    const html = course(moduleNode().replace('type="application/pdf"', `type="${mime}"`));
    const result = collect(html); expect(result.observations[0]!.mimeType).toEqual({ kind: "unknown" }); reason(result, "invalid_mime");
    if (mime) expect(JSON.stringify(result)).not.toContain(mime);
  });
  it("AC5 actual access outcomes survive even invalid batch arguments", () => {
    for (const [html, overrides, status] of [[login, {}, "signed_out"], [denied, { httpStatus: 403 }, "forbidden"], [course().replace(account, ""), {}, "unknown"]] as const) {
      const result = collectMoodleMaterials([input(html, "/mod/folder/view.php?id=301", overrides)], ["bad"], "private-sentinel-secret");
      expect(result.pages[0]!.access.status).toBe(status); expect(result.observations).toEqual([]); expect(result.pages[0]!.coverage).toBe("none");
      reason(result, "access_error"); expect(JSON.stringify(result)).not.toContain("private-sentinel-secret");
    }
  });
  it("retains denied folders among successful pages with partial aggregate supplied coverage", () => {
    const result = collectMoodleMaterials([input(course()), input(denied, "/mod/folder/view.php?id=301", { httpStatus: 403 })], ["101"], time);
    expect(result.observations).toHaveLength(1); expect(result.pages.map(page => page.coverage)).toEqual(["complete", "none"]); expect(result.coverage).toBe("partial");
  });
  it.each(["resource", "folder", "login", "denied"])("fact-only #4 %s fixture is never a truth lookup", name => {
    const raw = readFileSync(resolve(process.cwd(), `../tests/fixtures/moodle/${name}.html`), "utf8");
    const result = collect(raw, `/mod/${name === "folder" ? "folder" : "resource"}/view.php?id=201`);
    expect(result.observations).toEqual([]); expect(result.coverage).toBe("none");
  });
  it.each(["2026-10-26T12:30Z", "2026-10-26T12:30:00.1Z", "2026-10-26T12:30:00+05:00"])("preserves validated observation precision %s", value => {
    expect(collectMoodleMaterials([input()], ["101"], value).observations[0]!.observedAt).toBe(value);
  });
  it.each([undefined, null, 123, "", "2026-10-26", "2026-02-30T10:00Z", "2026-10-26T12:30"])("rejects invalid time %s", value => {
    const result = collectMoodleMaterials([input()], ["101"], value as string); expect(result.observations).toEqual([]); reason(result, "invalid_observed_at");
  });
  it.each([undefined, null, [101]!, ["01"], ["0"], ["101", "bad"]])("rejects invalid selected source identities %s", value => {
    const result = collectMoodleMaterials([input()], value as string[], time); expect(result.observations).toEqual([]); reason(result, "invalid_selection");
  });
  it("requires selected trusted course and matching route/course/module identity", () => {
    reason(collectMoodleMaterials([input()], [], time), "unselected_course");
    reason(collectMoodleMaterials([input()], ["local-course-id"], time), "invalid_selection");
    expect(collect(course().replace('id=101"', 'id=102"')).observations).toEqual([]);
    expect(collect(course().replace('/view.php?id=201"', '/view.php?id=202"')).observations).toEqual([]);
    expect(collect(activity("", "resource", "999"), "/mod/resource/view.php?id=201").observations).toEqual([]);
    const mismatch = collectMoodleMaterials([input(course(), "/course/view.php?id=101", { requestedUrl: origin + "/course/view.php?id=102" })], ["101"], time);
    expect(mismatch.observations).toEqual([]); reason(mismatch, "unsafe_url");
  });
  it.each(["0", "01", "-1", "1.0", "1e3", "private-sentinel-secret"])("does not coerce source IDs %s", value => {
    const badModule = collect(course(moduleNode(value)));
    expect(badModule.observations).toEqual([]); reason(badModule, "missing_identity");
    const badInstance = collect(course(moduleNode("201", "resource", pdf, `data-resource-id="${value}"`)));
    expect(badInstance.observations).toEqual([]); reason(badInstance, "missing_identity");
    const badChild = collect(folder(entry(value)), "/mod/folder/view.php?id=301");
    expect(badChild.observations).toHaveLength(1); reason(badChild, "missing_identity");
    if (value.includes("private")) for (const result of [badModule, badInstance, badChild]) expect(JSON.stringify(result)).not.toContain(value);
  });
  it.each(["?id=101&id=101", "?%69d=101", "?id=101&", "?id=101&sesskey=secret", "?id=01", "?id=0", "?id=101#x"])("rejects noncanonical source course query %s", query => {
    const result = collect(course(), "/course/view.php" + query); expect(result.observations).toEqual([]); reason(result, "unsafe_url");
  });
  it.each([origin + "/course/./view.php?id=101", origin + "/x/../course/view.php?id=101", origin + "/course/%76iew.php?id=101", "https://moodle.sdu.edu.kz:443/course/view.php?id=101", "https://MOODLE.sdu.edu.kz/course/view.php?id=101"])("rejects normalized source URL aliases %s", finalUrl => {
    const result = collectMoodleMaterials([input(course(), "/course/view.php?id=101", { finalUrl, requestedUrl: finalUrl })], ["101"], time);
    expect(result.observations).toEqual([]); expect(result.coverage).toBe("none"); expect(JSON.stringify(result)).not.toContain(finalUrl);
  });
  it("rejects malformed DNS labels without returning their URLs", () => {
    const href = `https://${"a".repeat(64)}.example/lecture`;
    const result = collect(course(moduleNode("201", "url", href, "", "")));
    expect(result.observations[0]!).not.toHaveProperty("destinationUrl"); reason(result, "unsafe_external_url"); expect(JSON.stringify(result)).not.toContain(href);
  });
  it("reports empty, conflicting, paginated and truncated lists explicitly", () => {
    expect(collect(course('<span data-role="materials-empty"></span>')).coverage).toBe("complete");
    reason(collect(course("")), "empty_unconfirmed");
    reason(collect(course(moduleNode() + '<span data-role="materials-empty"></span>')), "empty_conflict");
    const result = collect(course(moduleNode() + '<nav data-region="material-pagination"><button>Next</button></nav>', "Week 1", "data-truncated"));
    reason(result, "pagination_pending"); reason(result, "incomplete_list");
    expect(result.pages[0]!).toMatchObject({ candidateCount: 1, paginationPending: true, coverage: "partial" });
    reason(collect(folder(""), "/mod/folder/view.php?id=301"), "empty_unconfirmed");
    reason(collect(folder(entry(), "data-incomplete"), "/mod/folder/view.php?id=301"), "incomplete_list");
  });
  it("QA regression: natural confirmed-empty folder is complete without invented file metadata", () => {
    const result = collect(folder('<span data-role="folder-empty"></span>'), "/mod/folder/view.php?id=301");
    expect(result.coverage).toBe("complete"); expect(result.pages[0]!.coverage).toBe("complete"); expect(result.diagnostics).toEqual([]);
    expect(result.observations[0]!).toMatchObject({ kind: "folder", fileType: { kind: "unknown" }, mimeType: { kind: "unknown" }, listingScope: "supplied_listing_only", listingCoverage: "complete", references: [{ listingScope: "supplied_listing_only", listingCoverage: "complete" }] });
    expect(result.observations[0]!).not.toHaveProperty("destinationUrl");
  });
  it("course folder inventory is complete while unfetched contents remain reference-only", () => {
    const result = collect(course(moduleNode("301", "folder", "", "", "", "Fictional folder")));
    expect(result.coverage).toBe("complete"); expect(result.diagnostics).toEqual([]);
    expect(result.observations[0]!).toMatchObject({ listingScope: "reference_only", listingCoverage: "none", fileType: { kind: "unknown" }, mimeType: { kind: "unknown" }, references: [{ listingScope: "reference_only", listingCoverage: "none" }] });
  });
  it("uninspected nested folder is not an inspected empty listing", () => {
    const result = collect(folder(entry("501", "folder", "", "", "")), "/mod/folder/view.php?id=301");
    expect(result.observations[0]!).toMatchObject({ listingScope: "supplied_listing_only", listingCoverage: "partial" });
    expect(result.observations[1]!).toMatchObject({ listingScope: "reference_only", listingCoverage: "none" });
    reason(result, "folder_contents_uninspected"); expect(result.diagnostics.map(item => item.reason)).not.toContain("missing_metadata");
  });
  it("scopes nested empty markers to their own list and retains complete ancestors", () => {
    const result = collect(folder(entry("501", "folder", '<span data-role="folder-empty"></span>', "", "") + entry("502", "folder", entry(), "", "")), "/mod/folder/view.php?id=301");
    expect(result.coverage).toBe("complete"); expect(result.diagnostics).toEqual([]);
    expect(result.observations.filter(item => item.kind === "folder").map(item => item.listingCoverage)).toEqual(["complete", "complete", "complete"]);
    expect(result.observations.find(item => item.sourceFileId === "401")!.parentResourceKey).toBe(result.observations.find(item => item.sourceFolderId === "502")!.resourceKey);
  });
  it.each([
    ['<ul></ul>', "empty_unconfirmed"],
    ['<ul><span data-role="folder-empty"></span><span data-role="folder-empty"></span></ul>', "empty_unconfirmed"],
    ['<ul data-truncated><span data-role="folder-empty"></span></ul>', "incomplete_list"],
    ['<ul><span data-role="folder-empty"></span><nav data-region="material-pagination"><button>Next</button></nav></ul>', "pagination_pending"],
    [`<ul>${entry().replace('data-file-id="401"', 'data-file-id="bad"')}</ul>`, "missing_identity"],
    [`<ul><span data-role="folder-empty"></span>${entry()}</ul>`, "empty_conflict"],
  ])("local nested listing errors affect its ancestors and preserve a healthy sibling: %s", (list, code) => {
    const broken = entry("501", "folder", "", "", "").replace("</li>", list + "</li>");
    const healthy = entry("502", "folder", '<span data-role="folder-empty"></span>', "", "");
    const result = collect(folder(broken + healthy), "/mod/folder/view.php?id=301");
    expect(result.coverage).toBe("partial"); reason(result, code);
    expect(result.observations[0]!.listingCoverage).toBe("partial");
    expect(result.observations.find(item => item.sourceFolderId === "501")!.listingCoverage).toBe("partial");
    expect(result.observations.find(item => item.sourceFolderId === "502")!.listingCoverage).toBe("complete");
    expect(result.pages[0]!.paginationPending).toBe(code === "pagination_pending");
  });
  it("global incomplete and pagination evidence affects all inspected nested listings", () => {
    const nested = entry("501", "folder", '<span data-role="folder-empty"></span>', "", "") + entry("502", "folder", '<span data-role="folder-empty"></span>', "", "");
    const html = folder(nested).replace('<main ', '<main data-incomplete ').replace('</main>', '<nav data-region="material-pagination"><a href="/mod/folder/view.php?id=301">Next</a></nav></main>');
    const result = collect(html, "/mod/folder/view.php?id=301");
    expect(result.observations.map(item => item.listingCoverage)).toEqual(["partial", "partial", "partial"]);
    reason(result, "incomplete_list"); reason(result, "pagination_pending");
  });
  it("folder applicability does not hide missing labels or unsafe explicitly supplied metadata", () => {
    const empty = folder('<span data-role="folder-empty"></span>');
    const absentSection = collect(empty.replace('<span data-role="material-section">Week 2</span>', ""), "/mod/folder/view.php?id=301");
    reason(absentSection, "missing_metadata"); expect(absentSection.observations[0]!.listingCoverage).toBe("partial");
    const absentTitle = collect(course(moduleNode("301", "folder", "", "", "", "")));
    reason(absentTitle, "missing_metadata"); expect(absentTitle.observations[0]!.title).toEqual({ kind: "unknown" });
    const unsafe = collect(empty.replace('</main>', '<a data-role="destination" href="https://example.org/?token=private-sentinel-secret" type="application/secret">Open</a></main>'), "/mod/folder/view.php?id=301");
    reason(unsafe, "unsafe_external_url"); reason(unsafe, "invalid_mime"); expect(unsafe.observations[0]!.listingCoverage).toBe("partial"); expect(JSON.stringify(unsafe)).not.toContain("private-sentinel-secret");
    const conflict = collect(empty.replace('<main ', '<main data-file-type="pdf" ').replace('</main>', '<a data-role="destination" href="/mod/folder/view.php?id=301" type="video/mp4">Open</a></main>'), "/mod/folder/view.php?id=301");
    reason(conflict, "type_conflict"); expect(conflict.observations[0]!.listingCoverage).toBe("partial");
  });
  it.each([false, true])("folder reference and separately inspected listing merge proof without field conflict, reversed=%s", reverse => {
    const reference = input(course(moduleNode("301", "folder", "", "", "", "Fictional folder"), "Week 2"));
    const inspected = input(folder('<span data-role="folder-empty"></span>'), "/mod/folder/view.php?id=301");
    const result = collectMoodleMaterials(reverse ? [inspected, reference] : [reference, inspected], ["101"], time);
    expect(result.coverage).toBe("complete"); expect(result.diagnostics).toEqual([]); expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!).toMatchObject({ listingScope: "supplied_listing_only", listingCoverage: "complete" });
    expect(result.observations[0]!.references.map(item => [item.location, item.listingScope, item.listingCoverage]).sort()).toEqual([
      ["activity.material", "supplied_listing_only", "complete"], ["course.material", "reference_only", "none"],
    ]);
  });
  it.each([false, true])("partial inspected proof is sticky and later reference-only proof cannot override it, reversed=%s", reverse => {
    const good = input(folder('<span data-role="folder-empty"></span>'), "/mod/folder/view.php?id=301");
    const incomplete = input(folder('<span data-role="folder-empty"></span>', "data-truncated"), "/mod/folder/view.php?id=301");
    const reference = input(course(moduleNode("301", "folder", "", "", "", "Fictional folder"), "Week 2"));
    const result = collectMoodleMaterials(reverse ? [incomplete, good, reference] : [reference, good, incomplete], ["101"], time);
    expect(result.observations[0]!.listingCoverage).toBe("partial"); expect(result.coverage).toBe("partial");
    expect(result.observations[0]!.references.map(item => item.listingCoverage).sort()).toEqual(["complete", "none", "partial"]);
    expect(result.diagnostics.map(item => item.reason)).not.toContain("field_conflict");
  });
  it("identical repeated inspected folder proof deduplicates without inventing conflicts", () => {
    const page = input(folder('<span data-role="folder-empty"></span>'), "/mod/folder/view.php?id=301");
    const result = collectMoodleMaterials([page, page], ["101"], time);
    expect(result.coverage).toBe("complete"); expect(result.observations[0]!.references).toHaveLength(1); expect(result.diagnostics).toEqual([]);
  });
  it("duplicate applicable field conflicts also lower inspected ancestor proof", () => {
    const first = input(folder(entry()), "/mod/folder/view.php?id=301");
    const second = input(folder(entry("401", "file", "", folderFile, 'data-file-type="pptx"', "Changed title")), "/mod/folder/view.php?id=301");
    const result = collectMoodleMaterials([first, second], ["101"], time);
    reason(result, "field_conflict"); expect(result.coverage).toBe("partial");
    expect(result.observations[0]!.listingCoverage).toBe("partial");
    expect(result.observations[0]!.references.map(reference => reference.listingCoverage)).toEqual(["complete", "partial"]);
    expect(result.observations.find(item => item.sourceFileId === "401")!.title).toEqual({ kind: "unknown" });
  });
  it.each([
    course(moduleNode().replace('data-course-module-id="201"', 'data-course-module-id="0"')),
    course(moduleNode().replace('data-resource-id="1"', 'data-resource-id="bad"')).replace('<h2>Week 1</h2>', '<h2>A</h2><h2>B</h2>'),
    course(moduleNode() + '<article data-region="material"></article>'),
    course(moduleNode().replace('</article>', moduleNode("202") + '</article>')),
    course().replace('</main>', '<h1>Duplicate</h1></main>'),
    course().replace(courseLink, courseLink + courseLink),
    course(moduleNode().replace('</article>', '<a data-role="material-link" href="/mod/resource/view.php?id=201">duplicate</a></article>')),
  ])("reports malformed candidates/structure rather than silently ignoring them", html => {
    const result = collect(html); expect(result.coverage).not.toBe("complete"); expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it("excludes conflicting parent associations and their descendants across pages", () => {
    const first = input(folder(entry("501", "folder", entry("401"), "", "")), "/mod/folder/view.php?id=301");
    const second = input(folder(entry("502", "folder", entry("501", "folder", entry("402"), "", ""), "", "")), "/mod/folder/view.php?id=301");
    const result = collectMoodleMaterials([first, second], ["101"], time);
    expect(result.observations.map(item => item.sourceFolderId ?? item.sourceFileId ?? "root")).toEqual(["root", "502"]);
    reason(result, "parent_conflict"); expect(result.coverage).toBe("partial");
    expect(result.review.filter(item => item.candidate).every(item => item.candidate?.sourceFolderId !== "501" && item.candidate?.sourceFileId !== "401" && item.candidate?.sourceFileId !== "402")).toBe(true);
  });
  it.each([
    entry("501", "folder", entry("501", "folder", entry("401"), "", ""), "", ""),
    entry("501", "folder", entry("401"), "", "").replace('data-folder-id="501"', 'data-folder-id="0"'),
    entry().replace('</li>', '<ul><li data-region="folder-entry" data-entry-kind="file" data-file-id="402"><a data-role="entry-link" href="'+folderFile+'">bad parent</a></li></ul></li>'),
    `<div>${entry()}</div>`,
    entry("501", "folder", entry("401"), "", "").replace('</li>', '</li><ul></ul>'),
  ])("reports malformed/cyclic/orphan nested entries without flattening", entries => {
    const result = collect(folder(entries), "/mod/folder/view.php?id=301"); expect(result.coverage).toBe("partial");
    expect(result.diagnostics.some(item => ["malformed_candidate", "missing_identity", "parent_conflict"].includes(item.reason))).toBe(true);
  });
  it("rejects malformed runtime input without reflecting unexpected exceptions", () => {
    expect(collectMoodleMaterials([null as never], ["101"], time).pages[0]!.access.status).toBe("unknown");
    expect(collectMoodleMaterials(null as never, ["101"], time).coverage).toBe("none");
    const bad = input(); Object.defineProperty(bad.document, "querySelectorAll", { value() { throw new Error("private-sentinel-secret"); } });
    expect(JSON.stringify(collectMoodleMaterials([bad], ["101"], time))).not.toContain("private-sentinel-secret");
  });
});
