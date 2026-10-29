import { expect, it } from "vitest";
import { isOutstanding, viewAssessment } from "@/domain/assessments";
import { OVERFLOW_ERROR, WEIGHT_ERROR, weeklyLoad, weightsError } from "@/domain/workload";
import type { SubmissionStatus } from "@/domain/types";
import { assessment, workloadFixture } from "./workload-fixture";

it("produces the documented fixed raw/outstanding/weighted totals without mutating evidence", () => {
  const { snap, views } = workloadFixture(), before = structuredClone({ snap, views });
  const result = weeklyLoad(views, snap.settings, snap);
  expect(result.weeks.map(({ week, total, outstanding, weighted }) => ({ week, total, outstanding, weighted }))).toEqual([
    { week: 1, total: 7, outstanding: 5, weighted: 7 }, { week: 2, total: 2, outstanding: 2, weighted: 3 }, { week: 3, total: 1, outstanding: 1, weighted: 1 },
    ...[4, 5, 6, 7].map(week => ({ week, total: 0, outstanding: 0, weighted: 0 })),
  ]);
  expect(result.unallocatedSummary).toEqual({ total: 5, outstanding: 3, weighted: 7 });
  const all = [...result.weeks.flatMap(week => week.items), ...result.unallocated];
  expect(all.filter(view => view.a.id === "h-merged")).toHaveLength(1);
  expect(all.some(view => /h-moodle|h-syllabus|j-hidden/.test(view.a.id))).toBe(false);
  expect(result.weeks[2].items[0]).toMatchObject({ date: { kind: "week", week: 3 }, sourceDate: { kind: "week", week: 1 } });
  expect(result.unallocated.every(view => !view.teachingMapping.resolved)).toBe(true);
  expect({ snap, views }).toEqual(before);
});
it.each(["submitted", "draft", "not_submitted", "reopened", "unknown", undefined] as (SubmissionStatus | undefined)[])("applies source/completion/hidden precedence for %s", status => {
  const { snap } = workloadFixture();
  const item = assessment("test", "assignment", { kind: "week", week: 1 }, status);
  for (const completed of [false, true]) {
    const overlay = { assessmentId: item.id, hidden: false, completed };
    const actionable = status === "draft" || status === "not_submitted" || status === "reopened";
    const expected = actionable || status !== "submitted" && !completed;
    expect(isOutstanding(item, overlay)).toBe(expected);
    const view = viewAssessment(item, overlay, snap.settings);
    expect(view.completed).toBe(completed); expect(view.needsAttention).toBe(actionable);
    expect(weeklyLoad([view], snap.settings).weeks[0]).toMatchObject({ total: 1, outstanding: expected ? 1 : 0, weighted: expected ? 2 : 0 });
    const hidden = viewAssessment(item, { ...overlay, hidden: true }, snap.settings);
    expect(weeklyLoad([hidden], snap.settings).weeks[0]).toMatchObject({ total: 0, outstanding: 0, weighted: 0 });
  }
});
it("recomputes input flags/dates and handles absent/invalid calendar and precision safely", () => {
  const { snap, views } = workloadFixture();
  const stale = { ...views[0], week: 7, outstanding: false, hidden: true };
  expect(weeklyLoad([stale], snap.settings).weeks[0]).toMatchObject({ total: 1, outstanding: 1, weighted: 3 });
  for (const teachingCalendar of [undefined, { ...snap.settings.teachingCalendar!, endDate: "invalid" }]) {
    const result = weeklyLoad(views, { ...snap.settings, teachingCalendar }, snap);
    expect(result.weeks).toEqual([]); expect(result.unallocatedSummary).toEqual({ total: 15, outstanding: 11, weighted: 18 });
  }
  for (const date of [{ kind: "date", date: "2027-02-29" }, { kind: "exact", iso: "garbage", tz: "UTC" }, { kind: "unknown" }, { kind: "week", week: 0 }]) {
    const view = viewAssessment(assessment("bad", "quiz", date as any), undefined, snap.settings);
    expect(weeklyLoad([view], snap.settings).unallocatedSummary).toEqual({ total: 1, outstanding: 1, weighted: 1 });
  }
});
it("deduplicates identical IDs, refuses conflicting IDs and never merges equal titles", () => {
  const { snap } = workloadFixture();
  const first = viewAssessment(assessment("same", "quiz", { kind: "week", week: 1 }), undefined, snap.settings);
  expect(weeklyLoad([first, structuredClone(first)], snap.settings).weeks[0].total).toBe(1);
  const other = viewAssessment({ ...first.a, id: "other" }, undefined, snap.settings);
  expect(weeklyLoad([first, other], snap.settings).weeks[0].total).toBe(2);
  const conflict = viewAssessment({ ...first.a, type: "exam" }, undefined, snap.settings);
  for (const input of [[first, conflict], [conflict, first]]) expect(() => weeklyLoad(input, snap.settings)).toThrow("Conflicting records");
  snap.reconciliation!.logicalAssessments.push({ ...snap.reconciliation!.logicalAssessments[0], type: "other" });
  expect(() => weeklyLoad([], snap.settings, snap)).toThrow("Conflicting canonical projection");
});
it("personal events use absent-source completion rules even if legacy data contains a submission field", () => {
  const { snap } = workloadFixture();
  for (const status of ["draft", "not_submitted", "reopened", "submitted"] as const) {
    const item = { ...assessment("personal", "other", { kind: "week", week: 1 }, status), personal: true };
    for (const completed of [false, true]) {
      const view = viewAssessment(item, { assessmentId: item.id, hidden: false, completed }, snap.settings);
      expect(view.outstanding).toBe(!completed); expect(view.needsAttention).toBe(false);
    }
  }
});
it("recalculates fractions/zero and yields identical totals and ordering under permutation", () => {
  const { snap, views } = workloadFixture();
  snap.settings.weights = { exam: 0.1, assignment: 0.2, quiz: 0.3, other: 0 };
  const result = weeklyLoad(views, snap.settings, snap);
  expect(result.weeks[0].weighted).toBeCloseTo(0.9);
  for (const input of [[...views].reverse(), [...views.slice(6), ...views.slice(0, 6)], [...views].sort((a, b) => b.a.id.localeCompare(a.a.id))]) expect(weeklyLoad(input, snap.settings, snap)).toEqual(result);
  snap.settings.weights = { exam: 0, assignment: 0, quiz: 0, other: 0 };
  expect(weeklyLoad(views, snap.settings, snap).weeks[0]).toMatchObject({ total: 7, outstanding: 5, weighted: 0 });
});
it("rejects invalid complete weights and overflow before exposing misleading totals", () => {
  const { snap, views } = workloadFixture();
  for (const weights of [undefined, {}, { exam: 3, assignment: 2, quiz: 1 }, ...[-1, NaN, Infinity, "3", null].map(exam => ({ ...snap.settings.weights, exam }))]) {
    expect(weightsError(weights)).toBe(WEIGHT_ERROR);
    expect(() => weeklyLoad(views, { ...snap.settings, weights } as any)).toThrow(WEIGHT_ERROR);
  }
  const huge = { ...snap.settings, weights: { exam: Number.MAX_VALUE, assignment: Number.MAX_VALUE, quiz: Number.MAX_VALUE, other: 0 } };
  expect(() => weeklyLoad(views, huge, snap)).toThrow(OVERFLOW_ERROR);
});
