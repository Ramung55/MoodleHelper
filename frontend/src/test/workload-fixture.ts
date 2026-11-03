import type { Assessment, DateValue, Overlay, Snapshot, SubmissionStatus } from "@/domain/types";
import { buildDemoSnapshot } from "@/services/fixtures";
import { viewAssessment } from "@/domain/assessments";
export const observedAt = "2027-01-01T00:00:00Z";
export function assessment(id: string, type: Assessment["type"], date: DateValue, status?: SubmissionStatus): Assessment {
  return { id, courseId: "c-csc", title: "Same title deliberately retained", type, personal: false,
    sources: [{ source: "moodle", date, observedAt, excerpt: `Original ${id} wording`, location: `row ${id}` }],
    submission: status ? { status, observedAt } : undefined, firstObservedAt: observedAt, lastObservedAt: observedAt };
}
export function workloadFixture() {
  const snap: Snapshot = buildDemoSnapshot();
  snap.settings.teachingCalendar = { startDate: "2027-01-04", endDate: "2027-02-28", timezone: "Asia/Qyzylorda", excludedWeekStarts: ["2027-01-18"] };
  snap.settings.reminders.enabled = false;
  snap.settings.weights = { exam: 3, assignment: 2, quiz: 1, other: 0 };
  const week = (week: number): DateValue => ({ kind: "week", week });
  const items = [
    assessment("a-draft", "exam", week(1), "draft"),
    assessment("b-not-submitted", "assignment", { kind: "date", date: "2027-01-05" }, "not_submitted"),
    assessment("c-reopened", "quiz", week(1), "reopened"),
    assessment("d-submitted", "exam", week(1), "submitted"),
    assessment("e-personally-done", "assignment", week(1)),
    assessment("f-unknown-status", "quiz", week(1), "unknown"),
    { ...assessment("g-personal", "other", week(1)), personal: true },
    assessment("h-merged", "assignment", { kind: "date", date: "2027-01-11" }),
    assessment("i-moved", "quiz", week(1)),
    assessment("j-hidden", "exam", week(1)),
    assessment("u-undated", "exam", { kind: "unknown" }),
    assessment("v-break", "assignment", { kind: "date", date: "2027-01-18" }),
    assessment("w-outside-submitted", "quiz", { kind: "date", date: "2027-03-01" }, "submitted"),
    assessment("x-week-outside", "assignment", week(8)),
    assessment("y-undated-done", "assignment", { kind: "unknown" }),
    assessment("z-exact", "quiz", { kind: "exact", iso: "2027-01-10T20:00:00Z", tz: "UTC" }),
  ];
  const overlays: Overlay[] = items.map(item => ({ assessmentId: item.id, hidden: item.id === "j-hidden", completed: ["a-draft", "b-not-submitted", "c-reopened", "e-personally-done", "y-undated-done"].includes(item.id), ...(item.id === "i-moved" ? { dateOverride: week(3), overrideBase: week(1) } : {}) }));
  const merged = items.find(item => item.id === "h-merged")!;
  merged.sources.push({ source: "syllabus", date: week(2), observedAt, excerpt: "Original syllabus Week 2", location: "page 2 row 4" });
  const originals = ["h-moodle", "h-syllabus"].map(id => ({ ...structuredClone(merged), id }));
  snap.assessments = [...items, ...originals]; snap.overlays = overlays;
  snap.reconciliation = { sources: [], pairs: [], aliases: originals.map(item => ({ originalId: item.id, canonicalId: merged.id })), logicalAssessments: items, logicalOverlays: overlays, overlayEdits: [] };
  const views = [...items, ...originals, merged].map(item => viewAssessment(item, overlays.find(overlay => overlay.assessmentId === item.id), snap.settings));
  return { snap, views };
}
