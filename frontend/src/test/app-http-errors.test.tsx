import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { useState, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Route as SettingsRoute } from "@/routes/settings";
import { HttpAdapter } from "@/services/http-adapter";

const mocks = vi.hoisted(() => ({
  adapter: { load: vi.fn(), connection: vi.fn(), updateSettings: vi.fn(), syncAll: vi.fn(), resetDemo: vi.fn(), aiAvailability: vi.fn(), saveAlerts: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/services", () => ({ getAdapter: () => mocks.adapter }));
vi.mock("@/services/extension-adapter", () => ({ detectExtension: async () => false }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const data = buildDemoSnapshot();
data.changes = [];
data.settings.reminders = { enabled: false, hoursBefore: 24, busyWeek: false };

function Probe() {
  const state = useApp();
  const [result, setResult] = useState<boolean | null>(null);
  return <>
    <div data-testid="snapshot">{state.snap?.settings.semesterWeeks ?? "none"}</div>
    <div data-testid="load-error">{state.error}</div>
    <div data-testid="sync-state">{state.syncing ? "pending" : "idle"}</div>
    <div data-testid="result">{String(result)}</div>
    <button onClick={async () => { setResult(await state.run((a) => a.updateSettings({ semesterWeeks: 17 }))); }}>Save</button>
    <button onClick={() => void state.syncAll()}>Sync</button>
    {state.snap && <Settings />}
  </>;
}
const Settings = SettingsRoute.options.component as ComponentType;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter.load.mockResolvedValue(structuredClone(data));
  mocks.adapter.connection.mockResolvedValue({ state: "demo", message: "Local backend", extensionDetected: false });
  mocks.adapter.aiAvailability.mockResolvedValue({ available: false, reason: "No provider configured" });
  mocks.adapter.saveAlerts.mockResolvedValue(structuredClone(data));
});
afterEach(cleanup);

describe("HTTP-backed UI failures", () => {
  it("displays the storage 503 envelope and retains the last successful dashboard data", async () => {
    const message = "Database is locked. Stop other writers and retry. No save was confirmed.";
    const http = new HttpAdapter("", async (url) => new Response(JSON.stringify(String(url).endsWith("/api/bridge-context") ? { version: "1", binding: "b-test" } : { message }), { status: String(url).endsWith("/api/bridge-context") ? 200 : 503, headers: { "Content-Type": "application/json" } }));
    mocks.adapter.updateSettings.mockImplementationOnce(() => http.updateSettings({ semesterWeeks: 17 }));
    render(<AppProvider><Probe /></AppProvider>);
    await screen.findByText("Tracked courses");
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("false"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent(String(data.settings.semesterWeeks));
    expect(mocks.toast.error).toHaveBeenCalledWith(message);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("shows load failures without substituting fixture data", async () => {
    mocks.adapter.load.mockRejectedValueOnce(new Error("Backend unavailable"));
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(screen.getByTestId("load-error")).toHaveTextContent("Backend unavailable"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent("none");
  });

  it("keeps the last successful snapshot and returns false on failed actions", async () => {
    mocks.adapter.updateSettings.mockRejectedValueOnce(new Error("Save rejected"));
    render(<AppProvider><Probe /></AppProvider>);
    await screen.findByText("Tracked courses");
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("false"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent(String(data.settings.semesterWeeks));
    expect(mocks.toast.error).toHaveBeenCalledWith("Save rejected");
  });

  it("clears sync pending state after a network error", async () => {
    mocks.adapter.syncAll.mockRejectedValueOnce(new Error("Sync unreachable"));
    render(<AppProvider><Probe /></AppProvider>);
    await screen.findByText("Tracked courses");
    fireEvent.click(screen.getByText("Sync"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Sync unreachable"));
    expect(screen.getByTestId("sync-state")).toHaveTextContent("idle");
    expect(screen.getByTestId("snapshot")).toHaveTextContent(String(data.settings.semesterWeeks));
  });

  it("shows unavailable live sync without a success toast or changed snapshot", async () => {
    mocks.adapter.syncAll.mockRejectedValueOnce(new Error("Live course sync is unavailable until Moodle access is verified."));
    render(<AppProvider><Probe /></AppProvider>);
    await screen.findByText("Tracked courses");
    fireEvent.click(screen.getByText("Sync"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Live course sync is unavailable until Moodle access is verified."));
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-state")).toHaveTextContent("idle");
    expect(screen.getByTestId("snapshot")).toHaveTextContent(String(data.settings.semesterWeeks));
  });

  it("never shows reset success after the backend rejected it", async () => {
    mocks.adapter.resetDemo.mockRejectedValueOnce(new Error("Reset rejected"));
    render(<AppProvider><Probe /></AppProvider>);
    fireEvent.click(await screen.findByText("Reset demo"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Reset rejected"));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("handles AI availability failures without leaving a checking state", async () => {
    mocks.adapter.aiAvailability.mockRejectedValueOnce(new Error("Availability unreachable"));
    render(<AppProvider><Probe /></AppProvider>);
    expect(await screen.findByText("Availability unreachable")).toBeVisible();
    expect(mocks.toast.error).toHaveBeenCalledWith("Availability unreachable");
  });
});
