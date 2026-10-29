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
it("rejects negative and missing input without writes or changed totals, then recalculates fractional/zero weights", async () => {
  mount(); const exam = await screen.findByLabelText("exam");
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7');
  for (const value of ["-1", ""]) {
    fireEvent.change(exam, { target: { value } });
    expect(screen.getByRole("alert")).toHaveTextContent("finite, nonnegative");
    expect(state.adapter.updateSettings).not.toHaveBeenCalled();
    expect(saved.settings.weights.exam).toBe(3);
    expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7');
  }
  fireEvent.change(exam, { target: { value: "0.5" } });
  await waitFor(() => expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":4.5'));
  expect(saved.settings.weights).toEqual({ exam: 0.5, assignment: 2, quiz: 1, other: 0 });
  fireEvent.change(exam, { target: { value: "0" } });
  await waitFor(() => expect(saved.settings.weights.exam).toBe(0));
  expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":4');
});
it("retains failed draft and prior saved workload while guarding pending changes", async () => {
  let reject!: (error: Error) => void;
  state.adapter.updateSettings.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  mount(); const exam = await screen.findByLabelText("exam");
  fireEvent.change(exam, { target: { value: "0.5" } });
  expect(exam).toBeDisabled();
  fireEvent.change(exam, { target: { value: "1" } });
  await waitFor(() => expect(state.adapter.updateSettings).toHaveBeenCalledTimes(1));
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
  fireEvent.change(exam, { target: { value: "3" } });
  await waitFor(() => expect(screen.getByTestId("totals")).toHaveTextContent('"weighted":7'));
});
