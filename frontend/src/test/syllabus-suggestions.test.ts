import { describe, expect, it } from "vitest";
import { rankSyllabusSuggestions } from "@/domain/syllabus-suggestions";
import type { Snapshot, NormalizedMaterialRecord } from "@/domain/types";

const ref = { sourcePageUrl: "https://moodle.sdu.edu.kz/course/view.php?id=101", sourceUrl: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=201", observedAt: "2026-10-25T12:00:00Z", location: "course.material" as const };
function record(id: string, title: string, type: "pdf" | "docx" | "other" | "unknown"): NormalizedMaterialRecord {
  return { id, courseId: "canonical", kind: "material", firstObservedAt: ref.observedAt, lastObservedAt: ref.observedAt, observations: [{ ...ref, sourceCourseId: "101", sourceCourseModuleId: "201", sourceModuleType: "resource", resourceKey: id, kind: "file", title: title ? { kind: "known", value: title } : { kind: "unknown" }, section: { kind: "unknown" }, fileType: type === "unknown" ? { kind: "unknown" } : { kind: "known", value: type }, mimeType: { kind: "unknown" }, references: [ref, ref] }] };
}
const snapshot = (...records: NormalizedMaterialRecord[]) => ({ collection: { records, reviews: [], refreshes: [] } }) as unknown as Snapshot;
describe("syllabus suggestions", () => {
  it("ranks normalized English and Russian titles, preserves known other and stable distinct identities", () => {
    const rows = rankSyllabusSuggestions(snapshot(record("a", "Lecture", "pdf"), record("b", "СИЛЛАБУС", "docx"), record("c", "Syllabus", "pdf"), record("d", "Syllabus", "other"), record("e", "", "unknown")));
    expect(rows.slice(0, 2).map((r) => r.id).sort()).toEqual(["b", "c"]);
    expect(rows.find((r) => r.id === "d")?.type).toBe("other");
    expect(rows.find((r) => r.id === "e")).toMatchObject({ title: "Unknown title", uncertain: true });
  });
  it("keeps folders out, child identity separate, flags conflicts and refuses unsafe links and labels", () => {
    const child = record("child", "Syllabus", "pdf"); child.observations[0]!.parentResourceKey = "folder";
    const folder = record("folder", "Syllabus", "pdf"); folder.observations[0]!.kind = "folder";
    const conflict = record("conflict", "Syllabus", "pdf"); conflict.observations.push({ ...conflict.observations[0]!, title: { kind: "known", value: "Lecture" }, fileType: { kind: "known", value: "other" } });
    const unsafe = record("unsafe", "<script>token=secret</script>", "unknown"); unsafe.observations[0]!.sourceUrl += "&sesskey=secret"; unsafe.observations[0]!.references = [];
    const conflictingLinks = record("links", "Syllabus", "pdf"); conflictingLinks.observations[0]!.references = [{ ...ref, sourceUrl: ref.sourceUrl + "&sesskey=secret" }];
    const rows = rankSyllabusSuggestions(snapshot(child, folder, conflict, unsafe, conflictingLinks, child));
    expect(rows.map((r) => r.id).sort()).toEqual(["child", "conflict", "links", "unsafe"]);
    expect(rows.find((r) => r.id === "child")?.link).toBeUndefined();
    expect(rows.find((r) => r.id === "links")?.link).toBeUndefined();
    expect(rows.find((r) => r.id === "conflict")).toMatchObject({ uncertain: true, type: "conflicting types" });
    expect(rows.find((r) => r.id === "unsafe")).toMatchObject({ title: "Unknown title", uncertain: true, link: undefined });
  });
});
