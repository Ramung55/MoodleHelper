import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { buildDemoSnapshot } from "@/services/fixtures";
import { onLocalInvalidation } from "@/services/local-erase";
import { Route as SettingsRoute } from "@/routes/settings";
import { Overview } from "@/routes/index";

/** #128: a tab open before Sync all started elsewhere shows the sync and its result without a reload. */
const mocks = vi.hoisted(() => ({
  adapter: {
    kind: "http",
    storage: "backend",
    load: vi.fn(),
    connection: vi.fn(),
    collectionMode: vi.fn(),
    syncAll: vi.fn(),
    aiAvailability: vi.fn(),
    saveAlerts: vi.fn(),
  },
  detect: vi.fn(),
  bridgeSync: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/services", () => ({ getAdapter: () => mocks.adapter }));
vi.mock("@/services/extension-adapter", () => ({
  detectExtension: () => mocks.detect(),
  syncAllThroughExtension: (onProgress: unknown) => mocks.bridgeSync(onProgress),
  discoverSduCourses: vi.fn(),
  BridgeClient: class {
    connect = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const REAL = {
  state: "disconnected",
  message: "Real dataset. Sync all scans the selected courses read-only.",
  extensionDetected: false,
} as const;
const DEMO = { state: "demo", message: "Local fictional demo data.", extensionDetected: false };
const base = buildDemoSnapshot();
base.changes = [];
base.settings.reminders = { enabled: false, hoursBefore: 24, busyWeek: false };
const Settings = SettingsRoute.options.component as ComponentType;

const state = (status: string, coverage: string) => {
  const s = structuredClone(base);
  s.settings.trackedCourseIds = ["c-csc", "c-math"];
  s.sync = ["c-csc", "c-math"].map((courseId) => ({
    courseId,
    status,
    coverage,
    progress: status === "syncing" ? 0 : 100,
    ...(coverage === "full" ? { lastSuccessAt: "2028-03-05T10:00:00Z" } : {}),
  })) as typeof s.sync;
  return s;
};
const IDLE = state("ok", "full");
const RUNNING = state("syncing", "none");
const FAILED = state("failed", "none");
let backend = IDLE;
let visibility: DocumentVisibilityState = "visible";

function Page({ page }: { page: "overview" | "settings" }) {
  const { snap, syncAll } = useApp();
  if (!snap) return <p>loading</p>;
  return (
    <>
      <button onClick={() => void syncAll()}>Start sync</button>
      {page === "overview" ? <Overview /> : <Settings />}
    </>
  );
}
const tab = (id: string, page: "overview" | "settings") => (
  <div data-testid={id}>
    <AppProvider>
      <Page page={page} />
    </AppProvider>
  </div>
);
const A = () => within(screen.getByTestId("A"));
const B = () => within(screen.getByTestId("B"));
const loads = () => mocks.adapter.load.mock.calls.length;
async function twoTabs(a: "overview" | "settings", b: "overview" | "settings") {
  render(
    <>
      {tab("A", a)}
      {tab("B", b)}
    </>,
  );
  await waitFor(() => expect(loads()).toBe(2));
  await A().findByText("Start sync");
  await B().findByText("Start sync");
}
async function renderOne(conn: object = REAL) {
  mocks.adapter.connection.mockResolvedValue({ ...conn });
  render(tab("A", "overview"));
  await A().findByText("Start sync");
  await waitFor(() => expect(loads()).toBe(1));
}
const returnToTab = () => {
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
};
const settle = () => act(() => new Promise((r) => setTimeout(r, 200)));

beforeEach(() => {
  vi.clearAllMocks();
  backend = IDLE;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  mocks.adapter.load.mockImplementation(async () => structuredClone(backend));
  mocks.adapter.connection.mockResolvedValue({ ...REAL });
  mocks.adapter.collectionMode.mockResolvedValue("verified");
  mocks.adapter.aiAvailability.mockResolvedValue({ available: false, reason: "none" });
  mocks.adapter.saveAlerts.mockResolvedValue(structuredClone(base));
  mocks.detect.mockResolvedValue(false);
  const start = async () => {
    backend = RUNNING;
    return structuredClone(RUNNING);
  };
  mocks.adapter.syncAll.mockImplementation(start);
  mocks.bridgeSync.mockImplementation(start);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("cross-tab sync freshness (#128)", () => {
  it.each([
    ["overview", "settings", "2 of 2 courses fully scanned"],
    ["settings", "overview", "2 of 2 courses fully scanned"],
    ["overview", "overview", "2 of 2 courses fully scanned"],
  ] as const)(
    "tab A (%s) follows a Sync all started in tab B (%s) without a reload",
    async (a, b, done) => {
      await twoTabs(a, b);
      expect(A().getByText(done)).toBeInTheDocument();
      fireEvent.click(B().getByText("Start sync"));
      await waitFor(() => expect(A().getByText("Sync running…")).toBeInTheDocument());
      backend = IDLE;
      // The #124 chain (2 s after each answer) clears it.
      await waitFor(() => expect(A().queryByText("Sync running…")).toBeNull(), { timeout: 5000 });
      expect(A().getByText(done)).toBeInTheDocument();
    },
    10000,
  );

  it("a Sync all through the extension path also notifies other tabs", async () => {
    mocks.detect.mockResolvedValue(true);
    await twoTabs("overview", "settings");
    await waitFor(() =>
      expect(B().getByRole("button", { name: /^Sync all courses$/ })).toBeEnabled(),
    );
    fireEvent.click(B().getByText("Start sync"));
    await waitFor(() => expect(mocks.bridgeSync).toHaveBeenCalledOnce());
    expect(mocks.adapter.syncAll).not.toHaveBeenCalled();
    await waitFor(() => expect(A().getByText("Sync running…")).toBeInTheDocument());
  });

  it("a sync that has already failed everywhere shows the failure in tab A on both pages", async () => {
    mocks.adapter.syncAll.mockImplementation(async () => {
      backend = FAILED;
      return structuredClone(RUNNING);
    });
    await twoTabs("settings", "overview");
    fireEvent.click(B().getByText("Start sync"));
    await waitFor(() =>
      expect(A().getByText(/2 courses failed to sync\. Details/)).toBeInTheDocument(),
    );
    expect(A().queryByText("Sync running…")).toBeNull();
    cleanup();
    backend = IDLE;
    mocks.adapter.load.mockClear();
    await twoTabs("overview", "settings");
    fireEvent.click(B().getByText("Start sync"));
    await waitFor(() =>
      expect(A().getByText("Last sync failed for 2 courses")).toBeInTheDocument(),
    );
  });

  it("returning to the tab re-reads once per burst, then the #124 chain clears Sync running", async () => {
    await renderOne();
    backend = RUNNING; // started by the popup: no message reaches this tab
    returnToTab();
    await waitFor(() => expect(A().getByText("Sync running…")).toBeInTheDocument());
    expect(loads()).toBe(2);
    backend = IDLE;
    await waitFor(() => expect(A().queryByText("Sync running…")).toBeNull(), { timeout: 5000 });
    expect(A().getByText("2 of 2 courses fully scanned")).toBeInTheDocument();
  }, 10000);

  it("a hidden tab makes no reads, and shows the right state once it becomes visible", async () => {
    await renderOne();
    visibility = "hidden";
    backend = RUNNING;
    returnToTab();
    const other = new BroadcastChannel("moodle-helper-sync");
    other.postMessage({ type: "sync-started" });
    await settle();
    expect(loads()).toBe(1);
    backend = FAILED;
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(A().getByText("Last sync failed for 2 courses")).toBeInTheDocument(),
    );
    expect(loads()).toBe(2);
    other.close();
  });

  it("an idle visible tab makes no Snapshot request over 60 s", async () => {
    await renderOne();
    vi.useFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(loads()).toBe(1);
  });

  it("the demo dataset never re-reads and never sends the sync message", async () => {
    const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    await renderOne(DEMO);
    backend = RUNNING;
    returnToTab();
    const other = new BroadcastChannel("moodle-helper-sync");
    other.postMessage({ type: "sync-started" });
    fireEvent.click(A().getByText("Start sync"));
    await waitFor(() => expect(mocks.adapter.syncAll).toHaveBeenCalledOnce());
    await settle();
    expect(loads()).toBe(1);
    expect(post).toHaveBeenCalledTimes(1); // only the test's own message
    other.close();
    post.mockRestore();
  });

  it("re-reads go through the mutation queue: none starts before this tab's Sync all returns", async () => {
    let finish!: (s: typeof RUNNING) => void;
    mocks.adapter.syncAll.mockImplementation(() => new Promise((r) => (finish = r)));
    await renderOne();
    fireEvent.click(A().getByText("Start sync"));
    await waitFor(() => expect(mocks.adapter.syncAll).toHaveBeenCalledOnce());
    returnToTab();
    await settle();
    expect(loads()).toBe(1);
    backend = IDLE;
    finish(structuredClone(RUNNING));
    await waitFor(() => expect(loads()).toBe(2));
    // The queued re-read answered after the mutation, so the newer backend state wins.
    await waitFor(() => expect(A().queryByText("Sync running…")).toBeNull());
  });

  it("the sync message never triggers the #56 erase reload, and erase messages still do", async () => {
    const invalidated = vi.fn();
    const stop = onLocalInvalidation(invalidated);
    await twoTabs("overview", "settings");
    fireEvent.click(B().getByText("Start sync"));
    await waitFor(() => expect(A().getByText("Sync running…")).toBeInTheDocument());
    expect(invalidated).not.toHaveBeenCalled();
    const lifecycle = new BroadcastChannel("moodle-helper-lifecycle");
    lifecycle.postMessage({ type: "erased" });
    await waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
    lifecycle.close();
    stop();
  });
});
