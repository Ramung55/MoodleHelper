import { expect, it } from "vitest";
import { DemoAdapter, type KV } from "@/services/demo-adapter";

it("persists and restores collected URL suggestions in demo storage", async () => {
  const data = new Map<string,string>();
  const kv: KV = { get: (key) => data.get(key) ?? null, set: (key, value) => { data.set(key, value); }, remove: (key) => { data.delete(key); } };
  const adapter = new DemoAdapter(kv, 0); const snapshot = await adapter.load();
  const ref = { sourcePageUrl: "https://moodle.sdu.edu.kz/course/view.php?id=101", sourceUrl: "https://moodle.sdu.edu.kz/mod/url/view.php?id=204", observedAt: "2026-10-25T12:00:00Z", location: "course.material" as const };
  const observation = { ...ref, sourceCourseId: "101", sourceCourseModuleId: "204", sourceModuleType: "url" as const, resourceKey: "url-key", kind: "link" as const, title: { kind: "known" as const, value: "Syllabus" }, section: { kind: "unknown" as const }, fileType: { kind: "known" as const, value: "link" as const }, mimeType: { kind: "unknown" as const }, references: [ref] };
  await adapter.replaceAll({ ...snapshot, collection: { records: [{ id: "url-id", courseId: snapshot.courses[0]!.id, kind: "material", firstObservedAt: ref.observedAt, lastObservedAt: ref.observedAt, observations: [observation] }], reviews: [], refreshes: [] } });
  expect((await adapter.setSyllabusSuggestionDismissal("url-id", true)).dismissedSyllabusSuggestions).toEqual(["url-id"]);
  const reopened = new DemoAdapter(kv, 0); expect((await reopened.load()).dismissedSyllabusSuggestions).toEqual(["url-id"]);
  expect((await reopened.setSyllabusSuggestionDismissal("url-id", false)).dismissedSyllabusSuggestions).toEqual([]);
  await expect(reopened.setSyllabusSuggestionDismissal("missing", true)).rejects.toThrow("no longer available");
});
