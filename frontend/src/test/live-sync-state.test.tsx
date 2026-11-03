import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { EXTENSION_MESSAGES, connectionWithExtension, syncAllLabel } from "@/domain/live-sync";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Route as SettingsRoute, BridgeConnection } from "@/routes/settings";
import { Overview } from "@/routes/index";

/** #46 owner Chrome check: the dashboard reports live sync availability and routes real Sync all through the bridge. */
const mocks = vi.hoisted(() => ({
  adapter: { kind: "demo", storage: "backend", load: vi.fn(), connection: vi.fn(), collectionMode: vi.fn(), syncAll: vi.fn(), aiAvailability: vi.fn(), saveAlerts: vi.fn() },
  detect: vi.fn(),
  bridgeSync: vi.fn(),
  connect: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/services", () => ({ getAdapter: () => mocks.adapter }));
vi.mock("@/services/extension-adapter", () => ({
  detectExtension: () => mocks.detect(),
  syncAllThroughExtension: (onProgress: unknown) => mocks.bridgeSync(onProgress),
  discoverSduCourses: vi.fn(),
  BridgeClient: class { connect = mocks.connect; dispose = vi.fn(); },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const REAL = { state: "disconnected", message: "Real dataset. Sync all scans the selected courses read-only.", extensionDetected: false } as const;
const DEMO = { state: "demo", message: "Local fictional demo data.", extensionDetected: false } as const;
const data = buildDemoSnapshot();
data.changes = [];
data.settings.reminders = { enabled: false, hoursBefore: 24, busyWeek: false };
const Settings = SettingsRoute.options.component as ComponentType;

function Probe() {
  const { conn, snap, syncAll } = useApp();
  return <>
    <div data-testid="message">{conn?.message ?? "loading"}</div>
    <div data-testid="live">{String(!!conn?.liveSync)}</div>
    {snap && <button onClick={() => void syncAll()}>Probe sync</button>}
    {snap && <Overview />}
    {snap && <Settings />}
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter.load.mockResolvedValue(structuredClone(data));
  mocks.adapter.aiAvailability.mockResolvedValue({ available: false, reason: "No provider configured" });
  mocks.adapter.saveAlerts.mockResolvedValue(structuredClone(data));
  mocks.adapter.syncAll.mockResolvedValue(structuredClone(data));
  mocks.bridgeSync.mockResolvedValue(structuredClone(data));
});
afterEach(cleanup);

describe("live sync state (#46)", () => {
  it("derives the connection only from dataset, extension and the handshake's collection state", () => {
    expect(connectionWithExtension({ ...REAL }, false, "verified")).toEqual(REAL);
    expect(connectionWithExtension({ ...REAL }, true, "verified")).toEqual({ ...REAL, extensionDetected: true, liveSync: true, message: EXTENSION_MESSAGES.live });
    expect(connectionWithExtension({ ...REAL }, true, "synthetic")).toEqual({ ...REAL, extensionDetected: true });
    expect(connectionWithExtension({ ...REAL }, true)).toEqual({ ...REAL, extensionDetected: true });
    // Demo stays demo whatever the backend mode.
    expect(connectionWithExtension({ ...DEMO }, true, "verified")).toEqual({ ...DEMO, extensionDetected: true, message: EXTENSION_MESSAGES.demo });
    expect(syncAllLabel(null)).toBe("Sync all courses (demo)");
    expect(syncAllLabel({ ...DEMO })).toBe("Sync all courses (demo)");
    expect(syncAllLabel({ ...REAL })).toBe("Sync all courses");
  });

  it("real dataset with live collection ready: no demo wording, and Sync all goes through the bridge", async () => {
    mocks.adapter.connection.mockResolvedValue({ ...REAL });
    mocks.adapter.collectionMode.mockResolvedValue("verified");
    mocks.detect.mockResolvedValue(true);
    render(<AppProvider><Probe /></AppProvider>);
    await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent("true"));
    expect(screen.getByTestId("message")).toHaveTextContent(EXTENSION_MESSAGES.live);
    expect(screen.queryByText(/not implemented|Still showing demo data|\(demo\)/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Sync all courses$/ })).toHaveLength(2);
    fireEvent.click(screen.getByText("Probe sync"));
    await waitFor(() => expect(mocks.bridgeSync).toHaveBeenCalledOnce());
    expect(mocks.adapter.syncAll).not.toHaveBeenCalled();
  });

  it("real dataset without the verified mode keeps the backend message and the HTTP Sync all", async () => {
    mocks.adapter.connection.mockResolvedValue({ ...REAL });
    mocks.adapter.collectionMode.mockRejectedValue(new Error("Backend unavailable"));
    mocks.detect.mockResolvedValue(true);
    render(<AppProvider><Probe /></AppProvider>);
    await screen.findByText("Probe sync");
    await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent(REAL.message));
    expect(screen.getByTestId("live")).toHaveTextContent("false");
    fireEvent.click(screen.getByText("Probe sync"));
    await waitFor(() => expect(mocks.adapter.syncAll).toHaveBeenCalledOnce());
    expect(mocks.bridgeSync).not.toHaveBeenCalled();
  });

  it("real dataset without the extension never asks for the collection mode", async () => {
    mocks.adapter.connection.mockResolvedValue({ ...REAL });
    mocks.detect.mockResolvedValue(false);
    render(<AppProvider><Probe /></AppProvider>);
    await screen.findByText("Probe sync");
    expect(screen.getByTestId("live")).toHaveTextContent("false");
    expect(mocks.adapter.collectionMode).not.toHaveBeenCalled();
  });

  it("demo dataset with the extension keeps the demo label and the HTTP demo sync", async () => {
    mocks.adapter.connection.mockResolvedValue({ ...DEMO });
    mocks.adapter.collectionMode.mockResolvedValue("verified");
    mocks.detect.mockResolvedValue(true);
    render(<AppProvider><Probe /></AppProvider>);
    await screen.findByText("Probe sync");
    await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent(EXTENSION_MESSAGES.demo));
    expect(screen.getAllByRole("button", { name: "Sync all courses (demo)" })).toHaveLength(2);
    fireEvent.click(screen.getByText("Probe sync"));
    await waitFor(() => expect(mocks.adapter.syncAll).toHaveBeenCalledOnce());
    expect(mocks.bridgeSync).not.toHaveBeenCalled();
    expect(mocks.adapter.collectionMode).not.toHaveBeenCalled();
  });

  it("Settings bridge check says the Moodle collection is ready when live sync is available", async () => {
    mocks.connect.mockResolvedValue({ backend: "ready", localRepository: "ready", moodleCollection: "unavailable" });
    render(<BridgeConnection liveSync />);
    fireEvent.click(screen.getByRole("button", { name: "Check / reconnect extension" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moodle collection is ready"));
    expect(screen.getByRole("status")).not.toHaveTextContent("unavailable");
  });
});
