import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddEvent } from "@/routes/deadlines";
import { AssessmentSheet } from "@/components/mh/AssessmentSheet";
import { DateInput } from "@/components/mh/DateInput";
import { personalDateError, zonedInput, zonedInstant } from "@/domain/personal-event";
import { buildDemoSnapshot } from "@/services/fixtures";
import { viewAll } from "@/domain/assessments";
import type { DateValue } from "@/domain/types";
import { useState } from "react";

const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
beforeEach(() => {
  const snap = buildDemoSnapshot();
  snap.settings.timezone = "Asia/Almaty";
  const api = { addPersonalEvent: vi.fn(), updateOverlay: vi.fn(), deletePersonalEvent: vi.fn() };
  state.app = { snap, api, run: vi.fn(async (fn) => { await fn(api); return true; }), views: [] };
});
afterEach(cleanup);

describe("personal event inputs", () => {
  it("validates calendar precision, integer weeks, zones and nonexistent DST times", () => {
    for (const date of [{ kind: "date", date: "2027-02-29" }, { kind: "week", week: 1.5 }, { kind: "week", week: 31 }, { kind: "unknown" }, { kind: "exact", iso: "2026-03-01T12:00:00Z", tz: "invalid" }] as DateValue[]) expect(personalDateError(date)).toBeTruthy();
    expect(personalDateError({ kind: "date", date: "2028-02-29" })).toBeNull();
    expect(zonedInstant("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(zonedInstant("2026-10-29T15:30", "Asia/Almaty")).toBe("2026-10-29T10:30:00.000Z");
    expect(zonedInput("2026-10-29T10:30:00Z", "Asia/Almaty")).toBe("2026-10-29T15:30");
  });
  it("round trips exact input in the configured zone instead of the browser zone", () => {
    function Harness() { const [date, setDate] = useState<DateValue | undefined>({ kind: "exact", iso: "2026-10-29T10:30:00Z", tz: "Asia/Almaty" }); return <><DateInput value={date} onChange={setDate} personalTimezone="Asia/Almaty" /><output>{JSON.stringify(date)}</output></>; }
    render(<Harness />);
    expect(screen.getByLabelText("Date and time")).toHaveValue("2026-10-29T15:30");
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: "2026-10-29T16:45" } });
    expect(screen.getByRole("status")).toHaveTextContent("2026-10-29T11:45:00.000Z");
  });
  it("shows required field errors, rejects an empty date/course and preserves failed values for retry", async () => {
    state.app.snap.settings.trackedCourseIds = [];
    const close = vi.fn(); render(<AddEvent open onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Add event" }));
    expect(screen.getByText("Enter a title.")).toBeVisible();
    expect(screen.getByText("Choose an available course.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Study" } });
    fireEvent.change(screen.getByLabelText("Course"), { target: { value: state.app.snap.courses[0].id } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add event" }));
    expect(screen.getByText("Enter a real calendar date.")).toBeVisible();
    expect(state.app.api.addPersonalEvent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2028-02-29" } });
    state.app.run.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Add event" }));
    expect(await screen.findByText(/The event was not saved/)).toBeVisible();
    expect(screen.getByLabelText("Title")).toHaveValue("Study"); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add event" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(state.app.api.addPersonalEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "Study", date: { kind: "date", date: "2028-02-29" } }));
  });
  it("guards overlapping creation while saving", async () => {
    let finish!: (ok: boolean) => void;
    state.app.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<AddEvent open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Study" } });
    fireEvent.click(screen.getByRole("button", { name: "Add event" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Saving…" }).closest("form")!);
    expect(state.app.run).toHaveBeenCalledOnce(); finish(false);
    await screen.findByText(/The event was not saved/);
  });
  it("edits through the same identifier, retains failed edits and confirms or cancels deletion", async () => {
    const snap = state.app.snap; const original = snap.assessments[0];
    const personal = { ...original, id: "personal-test", personal: true, sources: [{ source: "personal", date: { kind: "week", week: 4 }, observedAt: original.firstObservedAt }] };
    snap.assessments.push(personal);
    state.app.views = viewAll(snap.assessments, snap.overlays, snap.settings);
    render(<AssessmentSheet id="personal-test" onClose={vi.fn()} />);
    expect(screen.getByText(/personal · Week 4/i)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: " " } });
    fireEvent.change(screen.getByLabelText("Week"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Enter a title.")).toBeVisible();
    expect(screen.getByText("Enter a whole teaching week from 1 to 30.")).toBeVisible();
    expect(state.app.api.updateOverlay).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Week"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Updated" } });
    state.app.run.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Changes were not saved/);
    expect(screen.getByLabelText("Display title")).toHaveValue("Updated");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(state.app.api.updateOverlay).toHaveBeenCalledWith("personal-test", { titleOverride: "Updated", dateOverride: { kind: "week", week: 4 } }));
    fireEvent.click(screen.getByRole("button", { name: "Delete event" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.app.api.deletePersonalEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete event" }));
    state.app.run.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
    await screen.findByText(/The event was not deleted/);
    expect(state.app.api.deletePersonalEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete event" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
    await waitFor(() => expect(state.app.api.deletePersonalEvent).toHaveBeenCalledExactlyOnceWith("personal-test"));
    expect(snap.assessments[0]).toEqual(original);
  });
});
