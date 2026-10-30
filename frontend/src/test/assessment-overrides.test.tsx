import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssessmentSheet, dirtyOverlayPatch, importedDateError } from "@/components/mh/AssessmentSheet";
import { buildDemoSnapshot } from "@/services/fixtures";
import { viewAll } from "@/domain/assessments";
import { eligibleAlerts } from "@/domain/alerts";
import { DemoAdapter } from "@/services/demo-adapter";
import type { Overlay } from "@/domain/types";

const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));

function setup(overlay?: Partial<Overlay>) {
  const snap = buildDemoSnapshot();
  snap.settings.timezone = "Asia/Almaty";
  const a = snap.assessments.find((x) => !x.personal)!;
  snap.overlays = snap.overlays.filter((o) => o.assessmentId !== a.id);
  if (overlay) snap.overlays.push({ assessmentId: a.id, hidden: false, completed: false, ...overlay });
  const api = { updateOverlay: vi.fn(), deletePersonalEvent: vi.fn() };
  state.app = { snap, api, run: vi.fn(async (fn) => { await fn(api); return true; }), views: viewAll(snap.assessments, snap.overlays, snap.settings, snap) };
  return { snap, a, api };
}

beforeEach(() => setup());
afterEach(cleanup);

describe("imported assessment overrides (#53)", () => {
  it("builds a dirty-field patch so unrelated saves never resend the date", () => {
    const saved = { titleOverride: "Mine", dateOverride: { kind: "week" as const, week: 5 } };
    expect(dirtyOverlayPatch(saved, "Mine", saved.dateOverride)).toEqual({});
    expect(dirtyOverlayPatch(saved, "Other", { kind: "week", week: 5 })).toEqual({ titleOverride: "Other" });
    expect(dirtyOverlayPatch(saved, "", undefined)).toEqual({ titleOverride: null, dateOverride: null });
    expect(dirtyOverlayPatch(undefined, "  ", { kind: "date", date: "2026-11-02" })).toEqual({ dateOverride: { kind: "date", date: "2026-11-02" } });
  });

  it("validates imported dates strictly while allowing Use source and an explicit no-date choice", () => {
    expect(importedDateError(undefined)).toBeNull();
    expect(importedDateError({ kind: "unknown" })).toBeNull();
    expect(importedDateError({ kind: "date", date: "2027-02-29" })).toBeTruthy();
    expect(importedDateError({ kind: "week", week: 2.5 })).toBeTruthy();
    expect(importedDateError({ kind: "exact", iso: "2026-11-01T10:00:00Z", tz: "Not/AZone" })).toBeTruthy();
    expect(importedDateError({ kind: "exact", iso: "2026-11-01T10:00:00Z", tz: "UTC" })).toBeNull();
  });

  it("shows original source values, review conflict, and sends only changed fields", async () => {
    const { a, api } = setup({ titleOverride: "My label", dateOverride: { kind: "week", week: 14 }, overrideBase: { kind: "week", week: 1 } });
    render(<AssessmentSheet id={a.id} onClose={vi.fn()} />);
    expect(screen.getByText("Source title").nextSibling).toHaveTextContent(a.title);
    expect(screen.getByText("Needs review")).toBeVisible();
    expect(screen.getByText(/previous baseline/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide item" }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenCalledWith(a.id, { hidden: true }));
    api.updateOverlay.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(api.updateOverlay).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenCalledWith(a.id, { titleOverride: "Renamed" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset date" }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenLastCalledWith(a.id, { dateOverride: null }));
    fireEvent.click(screen.getByRole("button", { name: "Reset title" }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenLastCalledWith(a.id, { titleOverride: null }));
  });

  it("rejects invalid imported dates without a request and keeps failures visible", async () => {
    const { a, api } = setup();
    render(<AssessmentSheet id={a.id} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Date form"), { target: { value: "week" } });
    fireEvent.change(screen.getByLabelText("Week"), { target: { value: "31" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Enter a whole teaching week from 1 to 30.")).toBeVisible();
    expect(api.updateOverlay).not.toHaveBeenCalled();
    state.app.run.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Hide item" }));
    await screen.findByText(/The item was not hidden/);
    expect(screen.getByRole("button", { name: "Hide item" })).toBeEnabled();
  });

  it("offers an explicit no-date personal choice labelled as such", () => {
    const { a } = setup({ dateOverride: { kind: "unknown" }, overrideBase: { kind: "unknown" } });
    render(<AssessmentSheet id={a.id} onClose={vi.fn()} />);
    expect(screen.getAllByText(/No date \(your choice\)/).length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: "No date" })).toBeInTheDocument();
  });

  it("does not create new reminders for hidden items, including source-change notices", () => {
    const { snap, a } = setup({ hidden: true });
    const views = viewAll(snap.assessments, snap.overlays, snap.settings, snap);
    const change = { id: "chg-hidden", assessmentId: a.id, from: { kind: "week" as const, week: 1 }, to: { kind: "week" as const, week: 2 }, detectedAt: "2026-10-30T00:00:00Z" };
    const alerts = eligibleAlerts(views, [], [change as any], { ...snap.settings, reminders: { ...snap.settings.reminders, enabled: true } }, Date.now(), []);
    expect(alerts.filter((x) => x.assessmentId === a.id)).toEqual([]);
  });

  it("demo adapter: unrelated patch retains baseline, reset clears only the date pair, restore keeps one record", async () => {
    const adapter = new DemoAdapter();
    let snap = await adapter.load();
    const a = snap.assessments.find((x) => !x.personal)!;
    snap = await adapter.updateOverlay(a.id, { titleOverride: "Mine", dateOverride: { kind: "week", week: 9 } });
    const base = snap.overlays.find((o) => o.assessmentId === a.id)!.overrideBase;
    snap = await adapter.updateOverlay(a.id, { hidden: true });
    expect(snap.overlays.find((o) => o.assessmentId === a.id)!.overrideBase).toEqual(base);
    snap = await adapter.updateOverlay(a.id, { dateOverride: null });
    snap = await adapter.updateOverlay(a.id, { hidden: false });
    const overlays = snap.overlays.filter((o) => o.assessmentId === a.id);
    expect(overlays).toEqual([{ assessmentId: a.id, titleOverride: "Mine", hidden: false, completed: false }]);
    expect(snap.assessments.filter((x) => x.id === a.id)).toHaveLength(1);
  });
});
