import { describe, expect, it } from "vitest";
import { reminderError } from "@/components/mh/ReminderSettings";
import { ReminderPlan, Settings } from "@/domain/types";
import { buildDemoSnapshot } from "@/services/fixtures";

describe("#38 reminder settings", () => {
  const base = { enabled: true, hoursBefore: 24, busyWeek: true };
  it("new datasets default to 24h and legacy snapshots without new fields stay valid", () => {
    expect(buildDemoSnapshot().settings.reminders.hoursBefore).toBe(24);
    const legacy = { ...buildDemoSnapshot().settings, reminders: { ...base, hoursBefore: 48 } };
    expect(Settings.parse(legacy).reminders).toEqual({ ...base, hoursBefore: 48 });
  });
  it("bounds new fields and rejects invalid values instead of clamping", () => {
    expect(reminderError(base)).toBeUndefined();
    expect(reminderError({ ...base, hoursBefore: 0 })).toBeUndefined();
    expect(reminderError({ ...base, hoursBefore: 721 })).toMatch(/0–720/);
    expect(reminderError({ ...base, hoursBefore: Number.NaN })).toMatch(/0–720/);
    expect(reminderError({ ...base, busyWeekLeadDays: 31 })).toMatch(/0–30/);
    expect(reminderError({ ...base, dateOnlyLocalTime: "24:00" })).toMatch(/HH:mm/);
    const settings = buildDemoSnapshot().settings;
    expect(() => Settings.parse({ ...settings, reminders: { ...base, busyWeekLocalTime: "9:00" } })).toThrow();
    expect(() => Settings.parse({ ...settings, reminders: { ...base, busyWeekLeadDays: 1.5 } })).toThrow();
  });
  it("parses a backend plan DTO and rejects unknown kinds", () => {
    const plan = { datasetId: "d", generation: "g-1", serverTime: "2027-02-10T12:00:00Z", enabled: true, reasons: [], nextWakeAt: "2027-02-11T18:00:00Z",
      items: [{ id: "rd-1", deliveryKey: "rk-1", kind: "deadline", assessmentId: "a1", precision: "date", status: "scheduled", dueAt: "2027-02-11T04:00:00Z", localTime: "2027-02-11T09:00", timezone: "Asia/Almaty", label: "Reminder for date-only event; deadline time unknown" }] };
    expect(ReminderPlan.parse(plan).items).toHaveLength(1);
    expect(() => ReminderPlan.parse({ ...plan, items: [{ ...plan.items[0], kind: "email" }] })).toThrow();
  });
});
