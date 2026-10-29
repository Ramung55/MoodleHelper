import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TeachingCalendarSettings } from "@/components/mh/TeachingCalendarSettings";
import { mapTeachingDate, mapTeachingWeek, parseTeachingWeek, teachingCalendarError, teachingSlots } from "@/domain/teaching-weeks";
import { detectMentionUnits } from "@/domain/assessment-mentions";
import { buildDemoSnapshot } from "@/services/fixtures";
import { TeachingCalendar } from "@/domain/types";
const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
afterEach(cleanup);
const calendar = { startDate: "2027-01-04", endDate: "2027-02-28", timezone: "Asia/Qyzylorda", excludedWeekStarts: ["2027-01-18"] };
it("maps anchored slots and pauses breaks without changing week precision", () => {
  expect(mapTeachingWeek(6, calendar)).toMatchObject({ start: "2027-02-15", end: "2027-02-21", week: 6 });
  expect(mapTeachingWeek(3, calendar)).toMatchObject({ start: "2027-01-25" });
  expect(teachingSlots(calendar).find(s => s.start === "2027-01-18")?.week).toBeNull();
  expect(mapTeachingDate({ kind: "date", date: "2027-01-18" }, calendar)).toMatchObject({ resolved: false });
  expect(mapTeachingWeek(8, calendar).resolved).toBe(false);
  expect(mapTeachingWeek(6).resolved).toBe(false);
  expect(mapTeachingWeek(0, calendar).resolved).toBe(false);
  expect(mapTeachingDate({ kind: "exact", iso: "2027-01-17T20:00:00Z", tz: "UTC" }, calendar).resolved).toBe(false);
  expect(mapTeachingDate({ kind: "exact", iso: "2027-01-17T18:59:00Z", tz: "UTC" }, calendar)).toMatchObject({ resolved: true, week: 2 });
});
it("validates the whole optional group with a shared finite zone boundary", () => {
  for (const zone of ["UTC", "Asia/Almaty", "Asia/Qyzylorda", "Asia/Katmandu", "America/New_York"]) expect(teachingCalendarError({ ...calendar, timezone: zone })).toBeNull();
  for (const patch of [{ startDate: "2027-02-29" }, { excludedWeekStarts: ["2027-01-19"] }, { excludedWeekStarts: ["2027-01-18", "2027-01-18"] }, { timezone: "XYZ" }]) expect(TeachingCalendar.safeParse({ ...calendar, ...patch }).success).toBe(false);
});
it("maps actual bilingual detector evidence and retains identity and raw wording", async () => {
  for (const text of ["Exam Week 6", "Экзамен неделя 6"]) {
    const mentions = await detectMentionUnits({ datasetId: "d", courseId: "c", digest: "hash" }, [{ text, location: { kind: "pdf_row", page: 1, items: [] } }], new AbortController().signal);
    const mention = mentions[0]!; const parsed = parseTeachingWeek(mention, calendar);
    expect(parsed.parentId).toBe(mention.id); expect(parsed.rawText).toBe(text);
    expect(parsed.value).toEqual({ kind: "week", week: 6 });
    expect(parsed.mapping).toMatchObject({ start: "2027-02-15", end: "2027-02-21" });
    expect(parseTeachingWeek(mention, { ...calendar, excludedWeekStarts: [] }).mapping).toMatchObject({ start: "2027-02-08" });
    expect(parseTeachingWeek({ ...mention, rawScheduleText: text + "–7" }, calendar).mapping.resolved).toBe(false);
    expect(parseTeachingWeek({ ...mention, rawScheduleText: text + " Week 7" }, calendar).mapping.resolved).toBe(false);
  }
});
it("previews every draft slot, preserves failed edits, and cancels without writes", async () => {
  const snap = buildDemoSnapshot(); snap.settings.teachingCalendar = calendar;
  const updateSettings = vi.fn(); state.app = { snap, run: vi.fn(async fn => { await fn({ updateSettings }); return false; }) };
  render(<TeachingCalendarSettings />);
  const rows = screen.getAllByRole("row");
  expect(within(rows.find(r => r.textContent?.includes("2027-01-25"))!).getByText("Week 3")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Excluded full-week start dates"), { target: { value: "" } });
  expect(updateSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Save teaching calendar"));
  expect(await screen.findByRole("alert")).toHaveTextContent("draft is retained");
  expect(screen.getByLabelText("Excluded full-week start dates")).toHaveValue("");
  expect(snap.settings.teachingCalendar).toEqual(calendar);
  fireEvent.click(screen.getByText("Cancel calendar draft"));
  expect(screen.getByLabelText("Excluded full-week start dates")).toHaveValue("2027-01-18");
  expect(updateSettings).toHaveBeenCalledTimes(1);
});
