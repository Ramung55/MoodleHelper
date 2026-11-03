import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import type { Snapshot } from "@/domain/types";
import type { ExtensionStatus } from "@/domain/onboarding";

/** #87 QA (AC7): Setup's Start initial sync and the shell wait for the app-wide extension check. */
const state = vi.hoisted(() => ({
  adapter: {} as any,
  finish: (_: boolean) => undefined as void,
  bridge: { connect: vi.fn(), currentMockRun: vi.fn(), startMockRun: vi.fn(), cancelMockRun: vi.fn() },
}));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({
  detectExtension: () => new Promise<boolean>((resolve) => { state.finish = resolve; }),
  checkSduSignIn: vi.fn(async () => { throw new Error("not used"); }),
  BridgeClient: class { connect = state.bridge.connect; currentMockRun = state.bridge.currentMockRun; startMockRun = state.bridge.startMockRun; cancelMockRun = state.bridge.cancelMockRun; dispose() {} },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ to, children, className }: any) => <a href={to} className={className}>{children}</a>,
  Outlet: () => null,
  useLocation: () => ({ pathname: "/setup" }),
  useNavigate: () => vi.fn(),
}));

const { AppProvider } = await import("@/lib/app-store");
const { Onboarding } = await import("@/components/mh/Onboarding");
const { AppShell } = await import("@/components/mh/AppShell");

const ready: ExtensionStatus = { kind: "ready", moodleCollection: "unavailable" };
const signedIn = { signal: { state: "signed_in", source: "sdu_session_probe", context: "my_courses" }, checkedAt: "2028-03-05T10:00:00.000Z" };
let saved: Snapshot;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  saved = buildDemoSnapshot();
  saved.settings.trackedCourseIds = ["c-csc", "c-math"];
  saved.settings.teachingCalendar = undefined;
  saved.settings.reminders.enabled = false;
  saved.settings.reminders.busyWeek = false;
  saved.changes = [];
  saved.alerts = [];
  saved.sync = ["c-csc", "c-math"].map((courseId) => ({ courseId, status: "never", coverage: "none", progress: 0 })) as any;
  state.bridge.connect.mockRejectedValue(new Error("no bridge"));
  state.adapter = {
    kind: "demo", storage: "backend",
    load: vi.fn(async () => structuredClone(saved)),
    connection: vi.fn(async () => ({ state: "connected", message: "Real dataset", extensionDetected: true })),
    collectionMode: vi.fn(async () => "verified"),
    setTrackedCourses: vi.fn(), updateSettings: vi.fn(), saveAlerts: vi.fn(),
    syncAll: vi.fn(async () => structuredClone(saved)),
    aiAvailability: vi.fn(async () => ({ available: false, reason: "No provider is configured." })),
    restoreContext: vi.fn(async () => ({ datasetId: "11111111-1111-4111-8111-111111111111", epoch: 1, revision: 1 })),
    checkMoodleSignIn: vi.fn(async () => signedIn),
  };
});
afterEach(cleanup);

it("Start initial sync is disabled as Checking… until extension detection finishes, and a click sends nothing", async () => {
  render(<AppProvider><Onboarding probe={async () => ready} moodleAccess={null} /></AppProvider>);
  expect(await screen.findByRole("heading", { name: "Initial sync" })).toBeVisible();
  const button = await screen.findByRole("button", { name: "Checking…" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(state.adapter.syncAll).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => state.finish(false));
  await waitFor(() => expect(screen.getByRole("button", { name: "Start initial sync" })).toBeEnabled());
});

it("the shell shows a neutral checking state, never 'Extension not connected', while detection runs", async () => {
  render(<AppProvider><AppShell /></AppProvider>);
  expect(await screen.findByText("Checking for the extension…")).toBeInTheDocument();
  expect(screen.getByText("Checking extension…")).toBeInTheDocument();
  expect(screen.queryByText(/Extension not connected/)).toBeNull();
  await act(async () => state.finish(false));
  await waitFor(() => expect(screen.getAllByText(/Extension not connected/).length).toBeGreaterThan(0));
});
