import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "@/lib/app-store";
import { ReconciliationReview } from "@/components/mh/ReconciliationReview";
import { buildDemoSnapshot } from "@/services/fixtures";
import type { Snapshot } from "@/domain/types";

const state = vi.hoisted(() => ({ adapter: { storage: "backend", load: vi.fn(), connection: vi.fn(), decideReconciliation: vi.fn(), proposeReconciliation: vi.fn(), saveAlerts: vi.fn() }, error: vi.fn() }));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({ detectExtension: async () => false }));
vi.mock("sonner", () => ({ toast: { error: state.error, success: vi.fn(), warning: vi.fn() } }));

let saved: Snapshot;
const mount = () => render(<AppProvider><ReconciliationReview /></AppProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  saved = buildDemoSnapshot();
  saved.settings.reminders.enabled = false;
  saved.settings.reminders.busyWeek = false;
  saved.changes = [];
  saved.assessments = [
    { id: "m", courseId: "c-csc", title: "Invented Moodle assignment", type: "assignment", personal: false,
      sources: [{ source: "moodle", date: { kind: "date", date: "2026-11-03" }, observedAt: "2026-10-27T10:00:00Z" }], firstObservedAt: "2026-10-27T10:00:00Z", lastObservedAt: "2026-10-27T10:00:00Z" },
    { id: "s", courseId: "c-csc", title: "Invented syllabus assignment", type: "assignment", personal: false,
      sources: [{ source: "syllabus", date: { kind: "week", week: 8 }, observedAt: "2026-10-27T10:00:00Z" }], firstObservedAt: "2026-10-27T10:00:00Z", lastObservedAt: "2026-10-27T10:00:00Z" },
  ];
  saved.overlays = [
    { assessmentId: "m", hidden: false, completed: false, titleOverride: "Moodle title" },
    { assessmentId: "s", hidden: false, completed: false, titleOverride: "Syllabus title" },
  ];
  saved.reconciliation = {
    sources: [{ id: "m-source", kind: "moodle", assessmentId: "m", courseId: "c-csc", recordId: "m-record" }, { id: "s-source", kind: "syllabus", assessmentId: "s", courseId: "c-csc", candidateId: "s-candidate", documentId: "s-document" }],
    pairs: [{ id: "pair", left: "m-source", right: "s-source", fingerprint: "fingerprint", reviewRevision: "revision", status: "pending" }],
    aliases: [{ originalId: "m", canonicalId: "m" }, { originalId: "s", canonicalId: "s" }],
    logicalAssessments: saved.assessments, logicalOverlays: saved.overlays, overlayEdits: [],
  };
  state.adapter.load.mockImplementation(async () => structuredClone(saved));
  state.adapter.connection.mockResolvedValue({ state: "demo", message: "Invented fixture", extensionDetected: false });
  state.adapter.decideReconciliation.mockImplementation(async (_id, _fingerprint, _revision, kind) => {
    saved.reconciliation!.pairs[0].status = kind === "confirm" ? "confirmed" : "rejected";
    return structuredClone(saved);
  });
  state.adapter.proposeReconciliation.mockImplementation(async () => structuredClone(saved));
  state.adapter.saveAlerts.mockImplementation(async () => structuredClone(saved));
});
afterEach(cleanup);

describe("match review controls with invented data", () => {
  it("shows the same latest evidence used for reconciliation, including microseconds and ties", async () => {
    const moodle = saved.assessments[0];
    moodle.sources = [
      { source: "moodle", date: { kind: "date", date: "2026-11-01" }, observedAt: "2026-10-27T10:00:00.123001Z" },
      { source: "moodle", date: { kind: "date", date: "2026-11-03" }, observedAt: "2026-10-27T10:00:00.123002Z" },
      { source: "moodle", date: { kind: "date", date: "2026-11-04" }, observedAt: "2026-10-27T10:00:00.123002Z" },
    ];
    mount();
    expect(await screen.findByText(/Moodle: Invented Moodle assignment/, { selector: "p" })).toHaveTextContent("4 Nov");
  });
  it("orders far-future and legacy offset timestamps like the backend", async () => {
    saved.assessments[0].sources = [
      { source: "moodle", date: { kind: "date", date: "2026-11-01" }, observedAt: "0001-01-01T00:00:00Z" },
      { source: "moodle", date: { kind: "date", date: "2026-11-03" }, observedAt: "9999-12-31T22:59:59.999998Z" },
      { source: "moodle", date: { kind: "date", date: "2026-11-04" }, observedAt: "99991231 235959.999999+0100" },
    ];
    mount();
    expect(await screen.findByText(/Moodle: Invented Moodle assignment/, { selector: "p" })).toHaveTextContent("4 Nov");
  });
  it("shows both sources and requires a choice for conflicting personal titles before confirming", async () => {
    mount();
    expect(await screen.findByText(/Moodle: Invented Moodle assignment/, { selector: "p" })).toHaveTextContent("CSS 215");
    expect(screen.getByText(/Syllabus: Invented syllabus assignment/)).toHaveTextContent("Week 8");
    expect(screen.getByRole("button", { name: "Confirm match" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Choose display title"), { target: { value: "s-source" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm match" }));
    await waitFor(() => expect(state.adapter.decideReconciliation).toHaveBeenCalledWith("pair", "fingerprint", "revision", "confirm", { titleOverride: "s-source" }));
    expect(await screen.findByText(/1 confirmed, 0 rejected/)).toBeVisible();
  });

  it("rejects the pair separately and exposes a failed save without losing the pending card", async () => {
    state.adapter.decideReconciliation.mockRejectedValueOnce(new Error("Database locked; retry."));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reject match" }));
    await waitFor(() => expect(state.error).toHaveBeenCalledWith("Database locked; retry."));
    expect(screen.getByText("Possible match — review both originals")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reject match" }));
    await waitFor(() => expect(state.adapter.decideReconciliation).toHaveBeenLastCalledWith("pair", "fingerprint", "revision", "reject", {}));
    expect(await screen.findByText(/0 confirmed, 1 rejected/)).toBeVisible();
  });

  it("submits an explicit pair of existing compatible sources for review", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Moodle source"), { target: { value: "m-source" } });
    fireEvent.change(screen.getByLabelText("Syllabus source"), { target: { value: "s-source" } });
    fireEvent.click(screen.getByRole("button", { name: "Review selected pair" }));
    await waitFor(() => expect(state.adapter.proposeReconciliation).toHaveBeenCalledWith("m-source", "s-source"));
  });
});
