// #54: personal completion is independent of Moodle submission status (labeled synthetic statuses).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssessmentSheet } from "@/components/mh/AssessmentSheet";
import { AssessmentRow } from "@/components/mh/AssessmentRow";
import { buildDemoSnapshot } from "@/services/fixtures";
import { isOutstanding, viewAll } from "@/domain/assessments";
import { eligibleAlerts } from "@/domain/alerts";
import type { Assessment, Overlay, SubmissionStatus } from "@/domain/types";

const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
afterEach(cleanup);

function setup(status: SubmissionStatus | undefined, completed: boolean, run?: (fn: any) => Promise<boolean>) {
  const snap = buildDemoSnapshot();
  const a = snap.assessments.find((x) => !x.personal)!;
  a.submission = status ? { status, evidence: "synthetic fixture", observedAt: "2026-10-27T10:00:00Z" } as any : undefined;
  snap.overlays = snap.overlays.filter((o) => o.assessmentId !== a.id);
  snap.overlays.push({ assessmentId: a.id, hidden: false, completed, titleOverride: "Kept title" });
  const api = { updateOverlay: vi.fn() };
  state.app = { snap, api, run: run ?? vi.fn(async (fn) => { await fn(api); return true; }), views: viewAll(snap.assessments, snap.overlays, snap.settings, snap) };
  return { snap, a, api };
}

const ov = (completed: boolean, hidden = false): Overlay => ({ assessmentId: "x", hidden, completed });
const item = (status?: SubmissionStatus, personal = false) => ({ personal, submission: status && { status } } as unknown as Assessment);

describe("status × completion eligibility truth table", () => {
  const cases: [SubmissionStatus | undefined, boolean, boolean][] = [
    ["draft", false, true], ["draft", true, true],
    ["not_submitted", false, true], ["not_submitted", true, true],
    ["reopened", false, true], ["reopened", true, true],
    ["submitted", false, false], ["submitted", true, false],
    ["unknown", false, true], ["unknown", true, false],
    [undefined, false, true], [undefined, true, false],
  ];
  it.each(cases)("source %s, personally done %s → outstanding %s", (status, completed, expected) => {
    expect(isOutstanding(item(status), ov(completed))).toBe(expected);
    expect(isOutstanding(item(status), ov(completed, true))).toBe(false); // hidden excluded
  });
  it("personal events use the absent-source rule even if a status leaks in", () => {
    expect(isOutstanding(item("reopened", true), ov(true))).toBe(false);
    expect(isOutstanding(item(undefined, true), ov(false))).toBe(true);
  });
});

describe("personal completion control", () => {
  it("sends only completed, through the canonical id", async () => {
    const { a, api } = setup(undefined, false);
    render(<AssessmentSheet id={a.id} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /finished this/i }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenCalledWith(a.id, { completed: true }));
  });

  it("is disabled while pending, ignores repeat clicks and keeps the confirmed value with a retry error on failure", async () => {
    let resolve!: (ok: boolean) => void;
    const run = vi.fn(() => new Promise<boolean>((r) => { resolve = r; }));
    const { a } = setup(undefined, false, run);
    render(<AssessmentSheet id={a.id} onClose={() => {}} />);
    const box = screen.getByRole("checkbox", { name: /finished this/i }) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(box);
    expect(run).toHaveBeenCalledTimes(1);
    resolve(false);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Completion was not saved/);
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
  });

  it.each([["draft", /a draft/], ["not_submitted", /not submitted/], ["reopened", /a resubmission request/]] as const)(
    "%s stays visibly actionable while personally done", (status, wording) => {
      const { a } = setup(status, true);
      render(<AssessmentSheet id={a.id} onClose={() => {}} />);
      expect((screen.getByRole("checkbox", { name: /finished this/i }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText(wording, { exact: false })).toBeInTheDocument();
      cleanup();
      const v = state.app.views.find((x: any) => x.a.id === a.id);
      expect(v.needsAttention && v.outstanding && v.completed).toBe(true);
      render(<AssessmentRow v={v} onOpen={() => {}} />);
      expect(screen.getByText("You marked done")).toBeInTheDocument();
      expect(screen.getByText(/^Moodle:/).textContent).not.toMatch(/Done/);
    });

  it("undo makes an absent-status item eligible for reminders again; submitted stays non-outstanding", () => {
    const { snap, a } = setup(undefined, true);
    const due = new Date(Date.now() + 3_600_000).toISOString();
    a.sources = [{ source: "moodle", date: { kind: "exact", iso: due, tz: "UTC" }, observedAt: "2026-10-27T10:00:00Z" } as any];
    const alerts = (completed: boolean) => {
      const overlays = snap.overlays.map((o) => (o.assessmentId === a.id ? { ...o, completed } : o));
      return eligibleAlerts(viewAll(snap.assessments, overlays, snap.settings, snap), [], [], { ...snap.settings, reminders: { ...snap.settings.reminders, enabled: true, hoursBefore: 24 } }, Date.now(), []).filter((x) => x.assessmentId === a.id);
    };
    expect(alerts(true)).toHaveLength(0);
    expect(alerts(false)).toHaveLength(1);
    a.submission = { status: "submitted", observedAt: "2026-10-27T10:00:00Z" } as any;
    expect(alerts(false)).toHaveLength(0);
  });
});
