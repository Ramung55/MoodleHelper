import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
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
    // Waits for the hide save to finish: "Save changes" is disabled while it is pending (#70).
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    api.updateOverlay.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(api.updateOverlay).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenCalledWith(a.id, { titleOverride: "Renamed" }));
    // Waits for the title save to finish: "Reset date" is disabled while it is pending (#70).
    await waitFor(() => expect(screen.getByRole("button", { name: "Reset date" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reset date" }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenLastCalledWith(a.id, { dateOverride: null }));
    // Waits for the date reset to finish: "Reset title" is disabled while it is pending (#70).
    await waitFor(() => expect(screen.getByRole("button", { name: "Reset title" })).toBeEnabled());
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

describe("AssessmentSheet keeps an early edit when it seeds from the snapshot (#68)", () => {
  const exactA = { kind: "exact" as const, iso: "2026-11-20T05:00:00.000Z", tz: "Asia/Almaty" };
  const exactB = { kind: "exact" as const, iso: "2026-11-25T07:00:00.000Z", tz: "Asia/Almaty" };
  /** Two imported assessments with saved title and exact-date overrides, so both fields are seeded on open and on switch. */
  function setupTwo() {
    const snap = buildDemoSnapshot();
    snap.settings.timezone = "Asia/Almaty";
    const imported = snap.assessments.filter((x) => !x.personal);
    const a = imported[0]!;
    const b = imported[1]!;
    snap.overlays = snap.overlays.filter((o) => o.assessmentId !== a.id && o.assessmentId !== b.id);
    snap.overlays.push({
      assessmentId: a.id,
      hidden: false,
      completed: false,
      titleOverride: "A label",
      dateOverride: exactA,
    });
    snap.overlays.push({
      assessmentId: b.id,
      hidden: false,
      completed: false,
      titleOverride: "B label",
      dateOverride: exactB,
    });
    const api = { updateOverlay: vi.fn(), deletePersonalEvent: vi.fn() };
    state.app = {
      snap,
      api,
      run: vi.fn(async (fn) => {
        await fn(api);
        return true;
      }),
      views: viewAll(snap.assessments, snap.overlays, snap.settings, snap),
    };
    return { a, b, api };
  }
  const titleField = () => screen.getByLabelText("Display title");
  const dateField = () => screen.getByLabelText("Date and time");
  const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  /**
   * Types into a field in the layout phase of the commit that switches the sheet to `id`: after the sheet's new inputs
   * are in the DOM, before that commit's passive effects (the old seeding effect) flush. Raw DOM dispatch, not
   * act-wrapped fireEvent, so React handles it like a real user event inside that window (same technique as #66).
   */
  function EditOnCommit({
    id,
    selector,
    value,
  }: {
    id: string | null;
    selector: string;
    value: string;
  }) {
    useLayoutEffect(() => {
      if (!value) return;
      const input = document.querySelector<HTMLInputElement>(selector);
      if (!input) throw new Error(`${selector} is not rendered when the sheet switches to ${id}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  }
  function Harness({
    id,
    selector = "#ttl",
    value = "",
  }: {
    id: string | null;
    selector?: string;
    value?: string;
  }) {
    return (
      <>
        <AssessmentSheet id={id} onClose={vi.fn()} />
        <EditOnCommit id={id} selector={selector} value={value} />
      </>
    );
  }

  it("keeps a Display title edit made before the seeding effect runs, and saves it", async () => {
    const { a, b, api } = setupTwo();
    const { rerender } = render(<Harness id={a.id} />);
    expect(titleField()).toHaveValue("A label");
    rerender(<Harness id={b.id} value="Typed early" />);
    expect(titleField()).toHaveValue("Typed early");
    expect(dateField()).toHaveValue("2026-11-25T12:00");
    save();
    await waitFor(() =>
      expect(api.updateOverlay).toHaveBeenCalledExactlyOnceWith(b.id, {
        titleOverride: "Typed early",
      }),
    );
  });

  it("keeps a Date and time edit made before the seeding effect runs, and saves it", async () => {
    const { a, b, api } = setupTwo();
    const { rerender } = render(<Harness id={a.id} />);
    expect(dateField()).toHaveValue("2026-11-20T10:00");
    rerender(
      <Harness id={b.id} selector='input[aria-label="Date and time"]' value="2026-12-01T09:30" />,
    );
    expect(dateField()).toHaveValue("2026-12-01T09:30");
    expect(titleField()).toHaveValue("B label");
    save();
    await waitFor(() =>
      expect(api.updateOverlay).toHaveBeenCalledExactlyOnceWith(b.id, {
        dateOverride: { kind: "exact", iso: "2026-12-01T04:30:00.000Z", tz: "Asia/Almaty" },
      }),
    );
  });

  it("opens with the assessment's current title and date", () => {
    const { a } = setupTwo();
    const { rerender } = render(<Harness id={null} />);
    expect(screen.queryByLabelText("Display title")).not.toBeInTheDocument();
    rerender(<Harness id={a.id} />);
    expect(titleField()).toHaveValue("A label");
    expect(dateField()).toHaveValue("2026-11-20T10:00");
  });

  it("switches to the new assessment's values without carrying over the previous draft", () => {
    const { a, b, api } = setupTwo();
    const { rerender } = render(<Harness id={a.id} />);
    fireEvent.change(titleField(), { target: { value: "Unsaved A draft" } });
    fireEvent.change(dateField(), { target: { value: "2026-12-24T08:00" } });
    rerender(<Harness id={b.id} />);
    expect(titleField()).toHaveValue("B label");
    expect(dateField()).toHaveValue("2026-11-25T12:00");
    rerender(<Harness id={a.id} />);
    expect(titleField()).toHaveValue("A label");
    expect(dateField()).toHaveValue("2026-11-20T10:00");
    expect(api.updateOverlay).not.toHaveBeenCalled();
  });

  it("keeps an immediate edit across snapshot refreshes until it is saved, and drops it on close", async () => {
    const { a, api } = setupTwo();
    const { rerender } = render(<Harness id={a.id} />);
    fireEvent.change(titleField(), { target: { value: "Immediate" } });
    fireEvent.change(dateField(), { target: { value: "2026-12-02T11:15" } });
    // A snapshot refresh for the same assessment (new views array, new view objects) must not reseed the draft.
    state.app = {
      ...state.app,
      views: viewAll(
        state.app.snap.assessments,
        state.app.snap.overlays,
        state.app.snap.settings,
        state.app.snap,
      ),
    };
    rerender(<Harness id={a.id} />);
    expect(titleField()).toHaveValue("Immediate");
    expect(dateField()).toHaveValue("2026-12-02T11:15");
    save();
    await waitFor(() =>
      expect(api.updateOverlay).toHaveBeenCalledExactlyOnceWith(a.id, {
        titleOverride: "Immediate",
        dateOverride: { kind: "exact", iso: "2026-12-02T06:15:00.000Z", tz: "Asia/Almaty" },
      }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    expect(titleField()).toHaveValue("Immediate");
    // An unsaved edit is dropped on close: reopening shows the saved values again.
    fireEvent.change(titleField(), { target: { value: "Never saved" } });
    rerender(<Harness id={null} />);
    rerender(<Harness id={a.id} />);
    expect(titleField()).toHaveValue("A label");
    expect(dateField()).toHaveValue("2026-11-20T10:00");
  });
});
