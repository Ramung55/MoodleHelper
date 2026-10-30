import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { WorkloadWeights } from "@/components/mh/WorkloadWeights";
import type { Snapshot } from "@/domain/types";
import { workloadFixture } from "./workload-fixture";
const state = vi.hoisted(() => ({ adapter: { load: vi.fn(), connection: vi.fn(), updateSettings: vi.fn() } }));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({ detectExtension: async () => false }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let saved: Snapshot;
function Harness() {
  const { snap, weeks, unallocatedSummary, workloadError } = useApp();
  if (!snap) return <p>Loading</p>;
  return <><WorkloadWeights /><output data-testid="totals">{workloadError ? "Unavailable: " + workloadError : JSON.stringify({ week1: weeks[0] && { total: weeks[0].total, outstanding: weeks[0].outstanding, weighted: weeks[0].weighted }, unallocatedSummary })}</output></>;
}
beforeEach(() => {
  vi.clearAllMocks(); saved = workloadFixture().snap;
  state.adapter.load.mockImplementation(async () => structuredClone(saved));
  state.adapter.connection.mockResolvedValue({ state: "demo", message: "Fixture", extensionDetected: false });
  state.adapter.updateSettings.mockImplementation(async patch => { saved = { ...saved, settings: { ...saved.settings, ...patch } }; return structuredClone(saved); });
});
afterEach(cleanup);
const mount = () => render(<AppProvider><Harness /></AppProvider>);
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save workload" }));
it("rejects blank, negative and invalid input with field errors and no writes, then saves fractional/zero weights", async () => {
  mount(); const exam = await screen.findByLabelText("exam");
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7');
  for (const [value, message] of [["-1", "Must be zero or more."], ["", "Required."]]) {
    fireEvent.change(exam, { target: { value } }); save();
    expect(screen.getByText(message)).toBeInTheDocument(); expect(exam).toHaveAttribute("aria-invalid", "true");
    expect(state.adapter.updateSettings).not.toHaveBeenCalled();
    expect(saved.settings.weights.exam).toBe(3);
    expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7');
  }
  fireEvent.change(exam, { target: { value: "0.5" } });
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7');
  save();
  await waitFor(() => expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":4.5'));
  expect(saved.settings.weights).toEqual({ exam: 0.5, assignment: 2, quiz: 1, other: 0 });
  expect(state.adapter.updateSettings).toHaveBeenLastCalledWith({ weights: { exam: 0.5, assignment: 2, quiz: 1, other: 0 }, thresholds: { maxOutstanding: 5, maxWeighted: 10 } });
  fireEvent.change(exam, { target: { value: "0" } }); save();
  await waitFor(() => expect(saved.settings.weights.exam).toBe(0));
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":4');
});
it("validates thresholds: integer outstanding, nonnegative weighted", async () => {
  mount(); const mo = await screen.findByLabelText("Warn above outstanding"), mw = screen.getByLabelText("Warn above weighted");
  fireEvent.change(mo, { target: { value: "2.5" } }); fireEvent.change(mw, { target: { value: "-0.1" } }); save();
  expect(screen.getByText("Must be a whole number.")).toBeInTheDocument(); expect(screen.getByText("Must be zero or more.")).toBeInTheDocument();
  expect(state.adapter.updateSettings).not.toHaveBeenCalled();
  fireEvent.change(mo, { target: { value: "0" } }); fireEvent.change(mw, { target: { value: "7.5" } }); save();
  await waitFor(() => expect(saved.settings.thresholds).toEqual({ maxOutstanding: 0, maxWeighted: 7.5 }));
});
it("cancel discards only the draft", async () => {
  mount(); const exam = await screen.findByLabelText("exam");
  fireEvent.change(exam, { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(exam).toHaveValue(3); expect(state.adapter.updateSettings).not.toHaveBeenCalled();
});
it("retains failed draft and prior saved workload while guarding pending saves", async () => {
  let reject!: (error: Error) => void;
  state.adapter.updateSettings.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  mount(); const exam = await screen.findByLabelText("exam");
  fireEvent.change(exam, { target: { value: "0.5" } }); save();
  await waitFor(() => expect(exam).toBeDisabled());
  save();
  expect(state.adapter.updateSettings).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("offline")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Previous values and workload remain active");
  expect(exam).toHaveValue(0.5); expect(saved.settings.weights.exam).toBe(3);
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7');
});
it("reports invalid legacy saved configuration without crashing or publishing a zero workload", async () => {
  saved.settings.weights.exam = -1;
  mount();
  expect(await screen.findByTestId("totals")).toHaveTextContent("Unavailable: Workload weights");
  expect(screen.getByTestId("totals")).not.toHaveTextContent('"weighted":0');
  const exam = await screen.findByLabelText("exam");
  fireEvent.change(exam, { target: { value: "3" } }); save();
  await waitFor(() => expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7'));
});
it("rejects an overflowing proposed aggregate before saving or replacing prior totals", async () => {
  saved.reconciliation!.logicalAssessments.find(item => item.id === "d-submitted")!.submission!.status = "draft";
  mount(); const exam = await screen.findByLabelText("exam");
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":10');
  fireEvent.change(exam, { target: { value: String(Number.MAX_VALUE) } }); save();
  expect(screen.getByRole("alert")).toHaveTextContent("exceeds the supported numeric range");
  expect(state.adapter.updateSettings).not.toHaveBeenCalled(); expect(saved.settings.weights.exam).toBe(3);
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":10');
});
