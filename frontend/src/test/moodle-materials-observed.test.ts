/** #83 AC3/AC5: the material collector on the observed SDU course page. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MoodleAccessInput } from "../../../extension/src/moodle-access";
import { collectObservedMoodleMaterials } from "../../../extension/src/moodle-materials";
import { materialRefreshResult } from "../../../extension/src/page-refresh";
import { validSchema } from "../../../shared/src/bridge";
import { RawMaterialObservation } from "../domain/types";

const origin = "https://moodle.sdu.edu.kz";
const observedAt = "2028-03-05T10:00:00.000Z";
const dir = resolve(__dirname, "../../../tests/fixtures/moodle/observed");
const read = (name: string) => readFileSync(resolve(dir, name), "utf8");
const coursePage = read("course-page.html"),
  guest = read("course-page-guest-folder.html");
const courseUrl = (id: string) => `${origin}/course/view.php?id=${id}`;
const key = (...parts: string[]) => JSON.stringify([origin, ...parts]);
const known = (value: string) => ({ kind: "known", value });
const unknown = { kind: "unknown" };

function input(
  html: string,
  url = courseUrl("9001"),
  overrides: Partial<MoodleAccessInput> = {},
): MoodleAccessInput {
  return {
    document: new DOMParser().parseFromString(html, "text/html"),
    requestedUrl: url,
    finalUrl: url,
    httpStatus: 200,
    networkFailure: false,
    contentType: "text/html; charset=utf-8",
    ...overrides,
  };
}
type Material = {
  kind: "material";
  observations: Record<string, unknown>[];
  diagnostics: { reason: string; recordIndex?: number }[];
  coverage: string;
};

describe("observed/ course-page materials (#83 AC3)", () => {
  it("lists the PDF/PPTX resources, the URL and page modules and no assignment, quiz or forum card", () => {
    const result = materialRefreshResult(input(coursePage), ["9001"], observedAt);
    expect(validSchema("CollectorResult", result)).toBe(true);
    const r = result as Material;
    expect(r.observations.map((o) => o["sourceCourseModuleId"])).toEqual([
      "990104",
      "990105",
      "990106",
      "990107",
    ]);
    const reference = (module: string, cmid: string) => ({
      sourcePageUrl: courseUrl("9001"),
      sourceUrl: `${origin}/mod/${module}/view.php?id=${cmid}`,
      destinationUrl: `${origin}/mod/${module}/view.php?id=${cmid}`,
      observedAt,
      location: "course.material",
    });
    expect(r.observations[0]).toEqual({
      ...reference("resource", "990104"),
      sourceCourseId: "9001",
      sourceCourseModuleId: "990104",
      sourceModuleType: "resource",
      resourceKey: key("9001", "resource", "module", "990104"),
      kind: "file",
      title: known("Fictional Reading Pack"),
      section: known("70002"),
      fileType: known("pdf"),
      mimeType: unknown,
      references: [reference("resource", "990104")],
    });
    expect(r.observations[1]).toMatchObject({
      kind: "file",
      sourceModuleType: "resource",
      title: known("Fictional Lecture Slides"),
      section: known("70002"),
      fileType: known("pptx"),
      mimeType: unknown,
      destinationUrl: `${origin}/mod/resource/view.php?id=990105`,
    });
    expect(r.observations[2]).toMatchObject({
      kind: "link",
      sourceModuleType: "url",
      title: known("Fictional Reference Link"),
      section: known("70002"),
      fileType: known("link"),
      mimeType: unknown,
    });
    // #83 contract: a page module is a link-kind material with unknown file and MIME type and no destination.
    const pageRef = {
      sourcePageUrl: courseUrl("9001"),
      sourceUrl: `${origin}/mod/page/view.php?id=990107`,
      observedAt,
      location: "course.material",
    };
    expect(r.observations[3]).toEqual({
      ...pageRef,
      sourceCourseId: "9001",
      sourceCourseModuleId: "990107",
      sourceModuleType: "page",
      resourceKey: key("9001", "page", "module", "990107"),
      kind: "link",
      title: known("Fictional Course Notes"),
      section: known("70002"),
      fileType: unknown,
      mimeType: unknown,
      references: [pageRef],
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.coverage).toBe("complete");
    // Zod and the shared OpenAPI inventory both accept the page record; the existing kinds still round-trip unchanged.
    for (const o of r.observations) expect(RawMaterialObservation.parse(o)).toEqual(o);
    expect(
      RawMaterialObservation.safeParse({ ...r.observations[3], sourceModuleType: "lesson" })
        .success,
    ).toBe(false);
    const text = JSON.stringify(result);
    for (const cmid of ["990101", "990102", "990103", "990108", "990109"])
      expect(text).not.toContain(cmid);
    // Reference only: no pluginfile URL, file name or access claim.
    expect(text).not.toMatch(/pluginfile|\.pdf|\.pptx|accessible/);
  });

  it("checks the observed course access and the selection", () => {
    const other = collectObservedMoodleMaterials(input(coursePage), ["9002"], observedAt);
    expect(other).toMatchObject({ status: "error", reason: "unselected_course" });
    const login = collectObservedMoodleMaterials(
      input(read("login-page.html")),
      ["9001"],
      observedAt,
    );
    expect([login.status, login.access.status]).toEqual(["error", "signed_out"]);
    const mismatch = collectObservedMoodleMaterials(
      input(coursePage, courseUrl("9002")),
      ["9002"],
      observedAt,
    );
    expect([mismatch.status, mismatch.access.status]).toEqual(["error", "unknown"]);
    expect(
      materialRefreshResult(
        input(coursePage.replace("format-topics", "format-weeks")),
        ["9001"],
        observedAt,
      ),
    ).toEqual({ kind: "failed", reasons: ["access_error"] });
  });

  it("lists the guest course folder as uninspected, with no children guessed", () => {
    const result = materialRefreshResult(input(guest, courseUrl("9101")), ["9101"], observedAt);
    expect(validSchema("CollectorResult", result)).toBe(true);
    expect(result).toMatchObject({
      kind: "material",
      coverage: "partial",
      diagnostics: [{ pageIndex: 0, recordIndex: 0, reason: "folder_contents_uninspected" }],
      observations: [
        {
          sourceCourseModuleId: "991001",
          sourceModuleType: "folder",
          kind: "folder",
          title: known("Fictional Shared Folder"),
          section: known("71001"),
          fileType: unknown,
          mimeType: unknown,
          listingScope: "reference_only",
          listingCoverage: "none",
        },
      ],
    });
    expect((result as Material).observations).toHaveLength(1);
    expect((result as Material).observations[0]).not.toHaveProperty("destinationUrl");
  });

  it("does not treat the folder page as a confirmed empty folder", () => {
    const folderUrl = `${origin}/mod/folder/view.php?id=991001`;
    expect(
      materialRefreshResult(input(read("folder-empty.html"), folderUrl), ["9101"], observedAt),
    ).toEqual({ kind: "failed", reasons: ["access_error"] });
  });

  it("does not guess a type from another badge and leaves the section unknown without data-sectionid", () => {
    // #85: DOCX now maps to docx (UNVERIFIED badge); EPUB is still an unmapped badge.
    const html = coursePage.replace(">PPTX<", ">EPUB<").replace(' data-sectionid="70002"', "");
    const r = materialRefreshResult(input(html), ["9001"], observedAt) as Material;
    expect(r.observations[1]).toMatchObject({
      sourceCourseModuleId: "990105",
      fileType: unknown,
      section: unknown,
    });
    expect(r.observations[0]).toMatchObject({ fileType: known("pdf"), section: unknown });
  });
});

describe("observed/ material unobserved variants (#83 AC5)", () => {
  it("a folder with child files stays uninspected and no child is reported", () => {
    const html = guest.replace(
      /<\/a>\s*<\/li>/,
      '</a><ul><li><a data-href="/pluginfile.php/1/mod_folder/content/0/notes.pdf">notes.pdf</a></li></ul></li>',
    );
    expect(html).toContain("notes.pdf");
    const r = materialRefreshResult(
      input(html, courseUrl("9101")),
      ["9101"],
      observedAt,
    ) as Material;
    expect(r.observations).toHaveLength(1);
    expect(r.diagnostics.map((d) => d.reason)).toEqual(["folder_contents_uninspected"]);
    expect(JSON.stringify(r)).not.toMatch(/notes|pluginfile/);
  });
  it("RU/KK interfaces give unsupported_structure", () => {
    for (const html of [
      coursePage.replace("lang-en", "lang-ru"),
      coursePage.replace('lang="en"', 'lang="kk"').replace("lang-en", "lang-kk"),
    ])
      expect(materialRefreshResult(input(html), ["9001"], observedAt)).toEqual({
        kind: "failed",
        reasons: ["unsupported_structure"],
      });
  });
});
