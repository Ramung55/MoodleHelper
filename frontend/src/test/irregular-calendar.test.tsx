import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { TeachingCalendarSettings } from "@/components/mh/TeachingCalendarSettings";
import { mapTeachingDate, mapTeachingWeek, teachingCalendarError, teachingRanges } from "@/domain/teaching-weeks";
import { viewAssessment } from "@/domain/assessments";
import { weeklyLoad } from "@/domain/workload";
import { TeachingCalendar, type Snapshot } from "@/domain/types";
import { assessment, workloadFixture } from "./workload-fixture";
const base = { startDate: "2027-01-04", endDate: "2027-02-28", timezone: "UTC", excludedWeekStarts: [] };
const holiday = { startDate: "2027-01-13", endDate: "2027-01-13", numbering: "preserve" as const };
const override = { week: 2, startDate: "2027-01-11", endDate: "2027-01-16" };
const state = vi.hoisted(() => ({ adapter: { load: vi.fn(), connection: vi.fn(), updateSettings: vi.fn() } }));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({ detectExtension: async () => false }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let saved: Snapshot;
beforeEach(() => {
  vi.clearAllMocks(); saved = workloadFixture().snap; delete saved.reconciliation;
  saved.settings.teachingCalendar = base;
  saved.assessments = [assessment("week-source", "exam", { kind: "week", week: 2 }), assessment("date-source", "quiz", { kind: "date", date: "2027-01-16" })];
  saved.overlays = []; saved.changes = [];
  state.adapter.load.mockImplementation(async () => structuredClone(saved));
  state.adapter.connection.mockResolvedValue({ state: "demo", message: "Fixture", extensionDetected: false });
  state.adapter.updateSettings.mockImplementation(async patch => { saved = { ...saved, settings: { ...saved.settings, ...patch } }; return structuredClone(saved); });
});
afterEach(cleanup);
function Harness() {
  const { snap, weeks, unallocatedSummary } = useApp(); if (!snap) return <p>Loading</p>;
  return <><TeachingCalendarSettings /><output data-testid="load">{JSON.stringify({ weeks: weeks.map(({week,total,weighted}) => ({week,total,weighted})), unallocatedSummary })}</output></>;
}
const mount = () => render(<AppProvider><Harness /></AppProvider>);
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
it("preserves partial holidays, propagates uncertainty, and overrides only explicit named ranges", () => {
  const preserve = { ...base, partialBreaks: [holiday] };
  expect(mapTeachingWeek(2, preserve)).toMatchObject({ start: "2027-01-11", end: "2027-01-17", holidays: [holiday] });
  expect(mapTeachingWeek(3, preserve)).toMatchObject({ start: "2027-01-18", end: "2027-01-24" });
  const unknown = { ...base, partialBreaks: [{ ...holiday, numbering: "unresolved" as const }] };
  expect(teachingRanges(unknown).map(range => range.resolved)).toEqual([true, false, false, false, false, false, false, false]);
  const explicit = { ...unknown, weekOverrides: [override] };
  expect(mapTeachingWeek(2, explicit)).toMatchObject({ start: "2027-01-11", end: "2027-01-16", override: true });
  expect(mapTeachingWeek(3, explicit).resolved).toBe(false);
  expect(mapTeachingDate({ kind: "date", date: "2027-01-17" }, explicit).resolved).toBe(false);
  expect(mapTeachingDate({ kind: "exact", iso: "2027-01-16T23:59:00Z", tz: "UTC" }, explicit)).toMatchObject({ week: 2, resolved: true });
  const established = { ...preserve, weekOverrides: [override, { week: 30, startDate: "2027-01-17", endDate: "2027-01-17" }] };
  expect(teachingCalendarError(established)).toBeNull();
  expect(mapTeachingWeek(30, established)).toMatchObject({ start: "2027-01-17", end: "2027-01-17" });
  expect(mapTeachingWeek(29, established).resolved).toBe(false);
});
it("rejects complete-map conflicts independent of array order, including inclusive endpoints", () => {
  for (const extra of [
    { partialBreaks: null }, { weekOverrides: null }, { partialBreaks: [{ ...holiday, numbering: undefined }] },
    { partialBreaks: [{ ...holiday, endDate: "2027-01-19" }] }, { partialBreaks: [holiday, holiday] },
    { weekOverrides: [override, override] }, { weekOverrides: [{ ...override, endDate: "2027-01-10" }] },
    { weekOverrides: [{ ...override, startDate: "2027-01-17", endDate: "2027-01-20" }] },
    { weekOverrides: [{ ...override, endDate: "2027-01-18" }] }, { weekOverrides: [{ ...override, startDate: "2026-12-31" }] },
    { excludedWeekStarts: ["2027-01-11"], weekOverrides: [override] },
  ]) expect(TeachingCalendar.safeParse({ ...base, ...extra }).success).toBe(false);
  const overrides = [{ ...override, startDate: "2027-01-17", endDate: "2027-01-20" }, { week: 3, startDate: "2027-01-21", endDate: "2027-01-24" }];
  expect(teachingCalendarError({ ...base, weekOverrides: overrides })).toBeNull();
  expect(teachingRanges({ ...base, weekOverrides: overrides })).toEqual(teachingRanges({ ...base, weekOverrides: [...overrides].reverse() }));
});
it("recalculates actual workload range coverage without rewriting source weeks or wording", () => {
  const before = structuredClone(saved.assessments);
  const calculate = (calendar: typeof base & Partial<TeachingCalendar>) => weeklyLoad(saved.assessments.map(item => viewAssessment(item, undefined, { ...saved.settings, teachingCalendar: calendar })), { ...saved.settings, teachingCalendar: calendar });
  const unknown = { ...base, partialBreaks: [{ ...holiday, numbering: "unresolved" as const }] };
  expect(calculate(unknown).unallocatedSummary).toEqual({ total: 2, outstanding: 2, weighted: 4 });
  expect(calculate({ ...unknown, weekOverrides: [override] }).weeks.find(week => week.week === 2)).toMatchObject({ total: 2, outstanding: 2, weighted: 4 });
  const shortened = calculate({ ...unknown, weekOverrides: [{ ...override, endDate: "2027-01-15" }] });
  expect(shortened.weeks.find(week => week.week === 2)).toMatchObject({ total: 1, weighted: 3 });
  expect(shortened.unallocatedSummary).toEqual({ total: 1, outstanding: 1, weighted: 1 });
  expect(saved.assessments).toEqual(before);
});
it("edits explicit policies and overrides, previews unresolved weeks, and updates saved workload only on success", async () => {
  mount(); await screen.findByText("Add partial holiday");
  fireEvent.click(screen.getByText("Add partial holiday"));
  edit("Holiday 1 start", "2027-01-13"); edit("Holiday 1 end", "2027-01-13");
  expect(screen.getByLabelText("Holiday 1 numbering")).toHaveValue("unresolved");
  let row = screen.getAllByRole("row").find(row => row.textContent?.includes("Week 2"))!;
  expect(within(row).getAllByText("Unresolved")).toHaveLength(2);
  edit("Holiday 1 numbering", "preserve");
  row = screen.getAllByRole("row").find(row => row.textContent?.includes("Week 3"))!;
  expect(row).toHaveTextContent("2027-01-18");
  fireEvent.click(screen.getByText("Add week override"));
  edit("Override 1 week", "2"); edit("Override 1 start", "2027-01-11"); edit("Override 1 end", "2027-01-16");
  const original = structuredClone(saved.assessments);
  fireEvent.click(screen.getByText("Save teaching calendar"));
  await waitFor(() => expect(saved.settings.teachingCalendar?.weekOverrides).toEqual([override]));
  expect(screen.getByTestId("load")).toHaveTextContent('"week":2,"total":2,"weighted":4');
  edit("Override 1 end", "2027-01-15");
  expect(screen.getByTestId("load")).toHaveTextContent('"week":2,"total":2,"weighted":4');
  fireEvent.click(screen.getByText("Save teaching calendar"));
  await waitFor(() => expect(screen.getByTestId("load")).toHaveTextContent('"week":2,"total":1,"weighted":3'));
  expect(saved.assessments).toEqual(original);
});
it("rejects overlapping/reversed/outside draft ranges without writes and retains failed draft/previous map", async () => {
  saved.settings.teachingCalendar = { ...base, weekOverrides: [override] };
  mount(); await screen.findByLabelText("Override 1 start");
  const previous = structuredClone(saved.settings.teachingCalendar);
  for (const [start, end] of [["2027-01-17", "2027-01-20"], ["2027-01-16", "2027-01-11"], ["2027-01-11", "2027-03-01"]]) {
    edit("Override 1 start", start); edit("Override 1 end", end);
    fireEvent.click(screen.getByText("Save teaching calendar"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(state.adapter.updateSettings).not.toHaveBeenCalled(); expect(saved.settings.teachingCalendar).toEqual(previous);
  }
  edit("Override 1 start", "2027-01-11"); edit("Override 1 end", "2027-01-15");
  state.adapter.updateSettings.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByText("Save teaching calendar"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("draft is retained"));
  expect(screen.getByLabelText("Override 1 end")).toHaveValue("2027-01-15");
  expect(saved.settings.teachingCalendar).toEqual(previous);
  fireEvent.click(screen.getByText("Cancel calendar draft"));
  expect(screen.getByLabelText("Override 1 end")).toHaveValue("2027-01-16");
});
