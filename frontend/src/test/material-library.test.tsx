import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import { buildMaterialLibrary, filterLibrary, normalizeSearch } from "@/domain/material-library";
import { Materials } from "@/routes/materials";
import { NormalizedMaterialRecord as RecordSchema, type NormalizedMaterialRecord, type PageRefreshReceipt, type RawMaterialObservation, type Snapshot } from "@/domain/types";

const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

// Labeled SYNTHETIC collected fixtures (#17 shape); not live SDU evidence.
const O = "https://moodle.sdu.edu.kz";
const T = "2026-10-25T12:00:00Z";
function obs(p: Partial<RawMaterialObservation> & { cm: string }): RawMaterialObservation {
  const { cm, ...rest } = p;
  const type = rest.sourceModuleType ?? "resource";
  return {
    sourcePageUrl: `${O}/course/view.php?id=101`, sourceUrl: `${O}/mod/${type}/view.php?id=${cm}`, observedAt: T, location: "course.material",
    sourceCourseId: "101", sourceCourseModuleId: cm, sourceModuleType: type, resourceKey: `k${cm}`, kind: "file",
    title: { kind: "unknown" }, section: { kind: "unknown" }, fileType: { kind: "unknown" }, mimeType: { kind: "unknown" }, references: [], ...rest,
  };
}
const known = (value: string) => ({ kind: "known" as const, value });
function rec(id: string, ...observations: RawMaterialObservation[]): NormalizedMaterialRecord {
  return RecordSchema.parse({ id, courseId: "c-csc", kind: "material", firstObservedAt: T, lastObservedAt: T, observations });
}
function receipt(p: Partial<PageRefreshReceipt>): PageRefreshReceipt {
  return { visitId: "v", pageUrl: `${O}/course/view.php?id=101`, observedAt: "2026-10-26T08:00:00Z", collector: "material", sourceCourseIds: ["101"], outcome: "ok", coverage: "complete", scope: "supplied_pages_only", reasons: [], evidenceMode: "synthetic", pages: [], ...p };
}
function snap(records: NormalizedMaterialRecord[], mutate?: (s: Snapshot) => void): Snapshot {
  const s = buildDemoSnapshot();
  s.collection = { records, reviews: [], refreshes: [] };
  mutate?.(s);
  return s;
}
function mount(s: Snapshot, extra: Record<string, unknown> = {}) {
  const adapter = { downloadMaterial: vi.fn(async () => ({ snapshot: s, message: "Downloads are not supported yet." })), importDocument: vi.fn() };
  state.app = { snap: s, adapter, setSnap: vi.fn(), error: null, retryLoad: vi.fn(), ...extra };
  render(<Materials />);
  return adapter;
}

const lecture = rec("r-pdf", obs({ cm: "201", title: known("Лекция 1 Ёлка"), section: known("Week 1"), fileType: known("pdf"), mimeType: known("application/pdf"), destinationUrl: `${O}/pluginfile.php/7/mod_resource/content/1/lecture.pdf`, sourceContextId: "7" }));
const slides = rec("r-pptx", obs({ cm: "202", title: known("Slides PPTX"), section: known("Week 1"), fileType: known("pptx") }));
const external = rec("r-link", obs({ cm: "203", sourceModuleType: "url", kind: "link", title: known("Recorded lecture"), fileType: known("link"), destinationUrl: "https://video.example/lecture?id=5" }));
const folder = rec("r-folder", obs({ cm: "204", sourceModuleType: "folder", kind: "folder", resourceKey: "kf", title: known("Lab files"), section: known("Labs"), listingScope: "reference_only", listingCoverage: "none" }));
const child = rec("r-child", obs({ cm: "204", sourceModuleType: "folder", location: "folder.entry", resourceKey: "kf/a", parentResourceKey: "kf", sourceContextId: "9", title: known("lab1.pdf"), section: known("Labs"), fileType: known("pdf"), destinationUrl: `${O}/pluginfile.php/9/mod_folder/content/1/lab1.pdf` }));
const orphan = rec("r-orphan", obs({ cm: "205", sourceModuleType: "folder", resourceKey: "kz/a", parentResourceKey: "missing", title: known("orphan.pdf"), fileType: known("pdf") }));
const untitled = rec("r-unknown", obs({ cm: "206" }));
const other = rec("r-other", obs({ cm: "207", title: known("Misc"), fileType: known("other") }));

describe("material library projection (#40)", () => {
  it("projects collected records with explicit unknowns, kinds and raw facts untouched", () => {
    const s = snap([lecture, slides, external, folder, child, orphan, untitled, other]);
    const before = JSON.stringify(s.collection);
    const items = buildMaterialLibrary(s);
    expect(JSON.stringify(s.collection)).toBe(before);
    const by = (id: string) => items.find((i) => i.recordId === id)!;
    expect(by("r-unknown")).toMatchObject({ type: "unknown", titleKnown: false, section: null, mimeType: null, access: "not_verified" });
    expect(by("r-other").type).toBe("other");
    expect(by("r-folder")).toMatchObject({ type: "folder", kind: "folder", children: ["collected:r-child"], listing: { scope: "reference_only", coverage: "none" } });
    expect(by("r-child")).toMatchObject({ breadcrumb: ["Lab files"], parentUnavailable: false, destination: { href: `${O}/pluginfile.php/9/mod_folder/content/1/lab1.pdf`, external: false } });
    expect(by("r-orphan")).toMatchObject({ parentUnavailable: true, breadcrumb: [] });
    expect(by("r-link").destination).toEqual({ href: "https://video.example/lecture?id=5", external: true });
    expect(by("r-link").source.href).toBe(`${O}/mod/url/view.php?id=203`);
    // legacy materials still included for tracked courses, with no duplicate IDs
    expect(items.filter((i) => i.provenance === "legacy").length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.recordId)).size).toBe(items.length);
    expect(Object.keys(by("r-pdf"))).not.toContain("size");
  });

  it("keeps identities separate, uses latest valid observation and flags conflicts", () => {
    const a = obs({ cm: "301", title: known("Old"), observedAt: "2026-10-01T00:00:00Z" });
    const b = obs({ cm: "301", title: known("New A"), observedAt: "2026-10-20T00:00:00Z" });
    const c = obs({ cm: "301", title: known("New B"), observedAt: "2026-10-20T00:00:00Z" });
    const bad = obs({ cm: "302", title: known("Bad time"), observedAt: "not-a-date" });
    const same1 = rec("same-1", obs({ cm: "303", title: known("Same title") }));
    const same2 = rec("same-2", obs({ cm: "304", title: known("Same title") }));
    const items = buildMaterialLibrary(snap([rec("multi", a, b, c), rec("bad", bad), same1, same2]));
    const multi = items.find((i) => i.recordId === "multi")!;
    expect(multi.title).toBe("New A");
    expect(multi.warnings.join()).toMatch(/disagree/);
    expect(items.find((i) => i.recordId === "bad")).toMatchObject({ lastObservedAt: null });
    expect(items.filter((i) => i.title === "Same title")).toHaveLength(2);
  });

  it("bounds cycles and never attaches folders across courses or untracked courses", () => {
    const x = rec("x", obs({ cm: "401", sourceModuleType: "folder", kind: "folder", resourceKey: "a", parentResourceKey: "b" }));
    const y = rec("y", obs({ cm: "401", sourceModuleType: "folder", kind: "folder", resourceKey: "b", parentResourceKey: "a" }));
    const cross = rec("cross", obs({ cm: "402", sourceCourseId: "999", resourceKey: "kf/z", parentResourceKey: "kf", title: known("other course child") }));
    const untracked = { ...rec("u", obs({ cm: "403", title: known("Untracked") })), courseId: "not-a-course" };
    const items = buildMaterialLibrary(snap([x, y, folder, cross, untracked]));
    expect(items.filter((i) => ["x", "y"].includes(i.recordId)).every((i) => i.parentUnavailable)).toBe(true);
    expect(items.find((i) => i.recordId === "cross")!.parentUnavailable).toBe(true);
    expect(items.find((i) => i.recordId === "u")).toBeUndefined();
  });

  it("refuses unsafe source/destination/legacy links without echoing them", () => {
    const evil = rec("evil", obs({ cm: "501", sourceUrl: `${O}/mod/resource/view.php?id=501&sesskey=SECRET`, destinationUrl: "javascript:SECRET2", title: known("Evil") }));
    const wrongCtx = rec("ctx", obs({ cm: "502", sourceContextId: "1", destinationUrl: `${O}/pluginfile.php/2/mod_resource/content/1/a.pdf`, title: known("Ctx") }));
    const tokenExt = rec("tok", obs({ cm: "503", sourceModuleType: "url", kind: "link", destinationUrl: "https://ext.example/x?token=SECRET3", title: known("Tok") }));
    const s = snap([evil, wrongCtx, tokenExt], (s) => { s.materials[0]!.url = "https://user:SECRET4@evil.example/"; });
    const items = buildMaterialLibrary(s);
    expect(items.find((i) => i.recordId === "evil")).toMatchObject({ source: { href: null }, destination: { href: null } });
    expect(items.find((i) => i.recordId === "ctx")!.destination!.href).toBeNull();
    expect(items.find((i) => i.recordId === "tok")!.destination!.href).toBeNull();
    expect(items.find((i) => i.recordId === s.materials[0]!.id)!.source.href).toBeNull();
    mount(s);
    expect(document.body.innerHTML).not.toMatch(/SECRET/);
    expect(document.querySelectorAll("a[href^='javascript']")).toHaveLength(0);
    expect(screen.getAllByText("Moodle link unavailable").length).toBeGreaterThan(0);
  });

  it("searches English/Russian titles with Unicode normalization and combined filters", () => {
    expect(normalizeSearch("  ЛЕКЦИЯ 1 Ёлка ")).toBe("лекция 1 елка");
    const items = buildMaterialLibrary(snap([lecture, slides, folder, untitled]));
    expect(filterLibrary(items, { q: "елка", type: "" }).map((i) => i.recordId)).toEqual(["r-pdf"]);
    expect(filterLibrary(items, { q: "лекция", type: "pptx" })).toHaveLength(0);
    expect(filterLibrary(items, { q: "", type: "folder" }).map((i) => i.recordId)).toEqual(["r-folder"]);
    expect(filterLibrary(items, { q: "", type: "unknown" }).map((i) => i.recordId)).toEqual(["r-unknown"]);
    expect(filterLibrary(items, { q: "untitled", type: "" })).toHaveLength(0);
  });
});

describe("materials route (#40)", () => {
  it("groups by course and section, labels types, folders and access, with safe links only", () => {
    const s = snap([lecture, slides, external, folder, child, untitled]);
    s.collection!.refreshes = [receipt({})];
    const adapter = mount(s);
    expect(screen.getByText(/synthetic collection fixtures/)).toBeTruthy();
    expect(screen.getAllByText("Section unknown").length).toBeGreaterThan(0);
    expect(screen.getByText(/Folder contents not inspected/)).toBeTruthy();
    expect(screen.queryByText(/empty folder/i)).toBeNull();
    expect(screen.getByText("In folder: Lab files")).toBeTruthy();
    expect(screen.getByText(/Untitled file \(title not collected\)/)).toBeTruthy();
    expect(screen.getAllByText("UNKNOWN TYPE").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Access not verified; Moodle login may be required").length).toBeGreaterThan(0);
    const ext = document.querySelector<HTMLAnchorElement>("a[href='https://video.example/lecture?id=5']")!;
    expect(ext.textContent).toBe("Open external link");
    expect(ext.getAttribute("href")).toBe("https://video.example/lecture?id=5");
    expect(ext.getAttribute("rel")).toBe("noopener noreferrer");
    const linkRow = ext.closest("li")!;
    expect(within(linkRow).getByText("Open in Moodle").closest("a")!.getAttribute("href")).toBe(`${O}/mod/url/view.php?id=203`);
    const folderRow = screen.getByText("Lab files", { selector: "span" }).closest("li")!;
    expect(within(folderRow).queryByText("Download")).toBeNull();
    fireEvent.click(ext);
    expect(adapter.downloadMaterial).not.toHaveBeenCalled();
    expect(adapter.importDocument).not.toHaveBeenCalled();
  });

  it("distinguishes no courses, no index, no matches with counts/reset, partial collection and retained-data error", () => {
    mount(snap([], (s) => { s.settings.trackedCourseIds = []; }));
    expect(screen.getByText("No courses selected")).toBeTruthy();
    cleanup();
    mount(snap([], (s) => { s.materials = []; }));
    expect(screen.getByText("No materials indexed yet")).toBeTruthy();
    cleanup();
    const s = snap([lecture], (s) => { s.collection!.refreshes = [receipt({ outcome: "failed", coverage: "partial", reasons: ["access_error"], evidenceMode: "verified" })]; });
    const retry = vi.fn();
    mount(s, { error: "Backend unavailable", retryLoad: retry });
    expect(screen.getByText(/did not complete\. Previously indexed/)).toBeTruthy();
    expect(screen.getByText(/Latest refresh attempt .* did not complete \(access_error\)/)).toBeTruthy();
    expect(screen.getAllByText(/Last observed/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Search titles"), { target: { value: "zzz-nothing" } });
    expect(screen.getByText("No materials match")).toBeTruthy();
    expect(screen.getByText(/Showing 0 of/)).toBeTruthy();
    fireEvent.click(screen.getByText("Reset filters"));
    expect(screen.queryByText("No materials match")).toBeNull();
  });

  it("keeps legacy stale/inaccessible labels and the explicit unsupported Download for legacy files", async () => {
    const s = snap([]);
    const adapter = mount(s);
    expect(screen.getByText(/Not accessible at last check/)).toBeTruthy();
    expect(screen.getAllByText(/Stale: last checked/).length).toBeGreaterThan(0);
    expect(screen.getByText("Open external link").closest("a")!.getAttribute("href")).toBe("https://owl.purdue.edu/");
    fireEvent.click(screen.getAllByText("Download")[0]!);
    expect(adapter.downloadMaterial).toHaveBeenCalledTimes(1);
  });
});
