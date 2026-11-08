import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { datasetLine, extensionLine } from "@/domain/live-sync";
import { friendlyInstant, friendlyRange } from "@/domain/dates";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Route as SettingsRoute } from "@/routes/settings";
import { Onboarding } from "@/components/mh/Onboarding";
import type { ExtensionStatus } from "@/domain/onboarding";
import type { Snapshot } from "@/domain/types";

/** #87 pass B: Settings (T1–T6) and Setup (U1–U3). */
const mocks = vi.hoisted(() => ({
  adapter: {
    kind: "demo",
    storage: "backend",
    load: vi.fn(),
    connection: vi.fn(),
    collectionMode: vi.fn(),
    syncAll: vi.fn(),
    aiAvailability: vi.fn(),
    saveAlerts: vi.fn(),
    reminderPlan: vi.fn(),
  },
  detect: vi.fn(),
  connect: vi.fn(),
  current: vi.fn(),
}));
vi.mock("@/services", () => ({ getAdapter: () => mocks.adapter }));
vi.mock("@/services/extension-adapter", () => ({
  detectExtension: () => mocks.detect(),
  syncAllThroughExtension: vi.fn(),
  discoverSduCourses: vi.fn(),
  checkSduSignIn: vi.fn(async () => ({ signal: null })),
  BridgeClient: class {
    connect = mocks.connect;
    currentMockRun = mocks.current;
    dispose = vi.fn();
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const REAL = {
  state: "disconnected",
  message: "Real dataset. Chrome extension not connected; saved data is shown.",
  extensionDetected: false,
} as const;
const Settings = SettingsRoute.options.component as ComponentType;

/** AC1 helper: the rendered text outside every closed <details> (its summary still counts). */
function defaultViewText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details:not([open])").forEach((d) => {
    Array.from(d.children).forEach((child) => {
      if (child.tagName !== "SUMMARY") child.remove();
    });
  });
  return clone.textContent ?? "";
}
const INTERNALS = [
  /[0-9a-f]{64}/,
  /\d{4}-\d{2}-\d{2}T\d{2}:/,
  /\bbytes\b/,
  /policy-\d/,
  /visited_activity_only|reference_only|mode groq/,
  /\bpartial coverage\b/,
  /· ok /,
  /chrome:\/\//,
  /127\.0\.0\.1|localhost:/,
  /SQLite/,
  /State:/,
];

function snapshot(): Snapshot {
  const s = buildDemoSnapshot();
  s.settings.reminders = { enabled: false, hoursBefore: 24, busyWeek: false };
  return s;
}

function SettingsProbe() {
  const { snap } = useApp();
  return snap ? <Settings /> : <p>waiting</p>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter.aiAvailability.mockResolvedValue({
    available: false,
    reason: "No AI gateway or provider policy is configured.",
  });
  mocks.adapter.connection.mockResolvedValue(REAL);
  mocks.adapter.reminderPlan.mockRejectedValue(new Error("offline"));
  mocks.detect.mockResolvedValue(false);
  mocks.connect.mockResolvedValue({});
  mocks.current.mockResolvedValue({ courseIds: [] });
});
afterEach(cleanup);

describe("status lines (T1)", () => {
  it("say the dataset and the extension state in plain words", () => {
    expect(datasetLine({ state: "demo", message: "", extensionDetected: false })).toBe("Demo data");
    expect(datasetLine({ ...REAL })).toBe("Connected · Your data");
    expect(extensionLine({ ...REAL })).toBe("Extension not connected.");
    expect(extensionLine({ ...REAL, extensionDetected: true })).toBe(
      "Extension connected. Moodle sync isn't available yet.",
    );
    expect(extensionLine({ ...REAL, extensionDetected: true, liveSync: true })).toBe(
      "Extension connected. Sync reads your selected courses.",
    );
  });
});

describe("Settings default view (T1–T6, AC1, AC6)", () => {
  it("shows plain status lines and keeps every internal under a closed Details", async () => {
    const s = snapshot();
    s.settings.timezone = "Asia/Almaty";
    s.sync = s.sync.map((c, i) => ({
      ...c,
      status: i === 0 ? "failed" : "ok",
      coverage: i === 1 ? "partial" : "full",
      lastSuccessAt: "2026-11-04T09:05:00Z",
      ...(i === 0 ? { error: "Sign in to SDU Moodle to continue." } : {}),
    }));
    mocks.adapter.load.mockResolvedValue(s);
    mocks.current.mockResolvedValue({
      courseIds: ["c-csc"],
      run: {
        id: "run1",
        idempotencyKey: "key",
        courseIds: ["c-csc"],
        createdAt: 1,
        status: "running",
        cancelled: false,
        jobs: [{ id: "job1", courseId: "c-csc", state: "running" }],
        progress: { total: 1, pending: 0, running: 1, completed: 0, failed: 0, cancelled: 0 },
      },
    });
    const { container } = render(
      <AppProvider>
        <SettingsProbe />
      </AppProvider>,
    );
    const section = (await screen.findByRole("heading", { name: "Connection & sync" })).closest(
      "section",
    )!;
    expect(section).toHaveTextContent("Connected · Your data");
    expect(within(section).getByRole("status")).toHaveTextContent("Extension not connected.");
    expect(section).toHaveTextContent(/\d+ of \d+ courses? fully scanned/);
    expect(section).toHaveTextContent("1 course failed to sync. Details below.");
    // #20 AC4: the sign-in request stays visible by default.
    expect(within(section).getAllByText(/Sign in to SDU Moodle to continue\./)[0]).toBeVisible();
    expect(
      within(section).getAllByRole("link", { name: "Open SDU Moodle sign-in" })[0],
    ).toBeVisible();
    // Details (closed): bridge guidance, state enum, conn.message, #21 lines and the per-course list with friendly times.
    const details = within(section).getAllByText("Details")[0]!.closest("details")!;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent("Chrome 109");
    expect(details).toHaveTextContent("State: disconnected");
    expect(details).toHaveTextContent(REAL.message);
    expect(details).toHaveTextContent(/Successful full sync: |No successful full sync yet\./);
    expect(details).toHaveTextContent(
      `ok ${friendlyInstant("2026-11-04T09:05:00Z", "Asia/Almaty")}`,
    );
    expect(friendlyInstant("2026-11-04T09:05:00Z", "Asia/Almaty")).toMatch(
      /^4 Nov( 2026)?, 14:05$/,
    );
    expect(within(section).getByText("Demo: mock scan progress").closest("details")).toBe(details);
    fireEvent.click(details.querySelector("summary")!);
    expect(within(section).getByText("Demo: mock scan progress")).toBeVisible();
    expect(await within(section).findByText(/Data Structures: running/)).toBeVisible();
    expect(within(section).getByRole("button", { name: "Cancel mock run" })).toBeVisible();
    fireEvent.click(details.querySelector("summary")!);
    // T3: legacy settings collapsed.
    expect(screen.getByText("Legacy settings").closest("details")!.open).toBe(false);
    // T2, T4, T5, T6: one sentence each.
    expect(
      screen.getByText("Enter your semester's first and last teaching days and any breaks."),
    ).toBeVisible();
    expect(screen.getByText("Notifications show while Chrome is open.")).toBeVisible();
    expect(
      screen.getByText(
        "Off by default. You'll see exactly what is sent before anything leaves your device.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Backups include your records and settings, not documents or downloaded files.",
      ),
    ).toBeVisible();
    expect(document.getElementById("teaching-calendar")).not.toBeNull();
    // AC1: nothing technical outside closed Details.
    const text = defaultViewText(container);
    for (const pattern of INTERNALS) expect(text).not.toMatch(pattern);
  });

  it("shows the saved calendar with friendly dates (AC6, T2) and hides the empty-draft error", async () => {
    const s = snapshot();
    s.settings.teachingCalendar = {
      startDate: "2027-01-04",
      endDate: "2027-02-28",
      timezone: "Asia/Almaty",
      excludedWeekStarts: [],
    };
    mocks.adapter.load.mockResolvedValue(s);
    render(
      <AppProvider>
        <SettingsProbe />
      </AppProvider>,
    );
    expect(
      await screen.findByText(
        `Saved: ${friendlyRange("2027-01-04", "2027-02-28", "Asia/Almaty")}.`,
      ),
    ).toBeVisible();
    cleanup();
    delete s.settings.teachingCalendar;
    render(
      <AppProvider>
        <SettingsProbe />
      </AppProvider>,
    );
    expect(await screen.findByText("Not set yet.")).toBeVisible();
    expect(screen.queryByText(/^Draft: /)).toBeNull();
  });

  it("opens the notification guidance by default when a notification was denied (#39 AC3)", async () => {
    const s = snapshot();
    s.alerts = [{ ...s.alerts[0]!, delivery: { state: "denied" } } as Snapshot["alerts"][number]];
    mocks.adapter.load.mockResolvedValue(s);
    render(
      <AppProvider>
        <SettingsProbe />
      </AppProvider>,
    );
    const guidance = await screen.findByText(/If notifications are blocked, allow them/);
    expect(guidance.closest("details")!.open).toBe(true);
    expect(guidance).toBeVisible();
  });

  it("keeps the notification guidance closed when nothing was denied", async () => {
    const s = snapshot();
    s.alerts = [];
    mocks.adapter.load.mockResolvedValue(s);
    render(
      <AppProvider>
        <SettingsProbe />
      </AppProvider>,
    );
    expect(
      (await screen.findByText(/If notifications are blocked, allow them/)).closest("details")!
        .open,
    ).toBe(false);
  });
});

describe("Setup default view (U1–U3, AC1)", () => {
  const missing = async (): Promise<ExtensionStatus> => ({
    kind: "missing",
    message: "Install the Moodle Helper extension, then reconnect.",
  });

  it("opens How to install while the extension is missing and keeps storage specifics under Details", async () => {
    mocks.adapter.load.mockResolvedValue(snapshot());
    const { container } = render(
      <AppProvider>
        <Onboarding probe={missing} />
      </AppProvider>,
    );
    const install = (await screen.findByText("How to install")).closest("details")!;
    expect(install.open).toBe(true);
    expect(within(install).getByText(/Load unpacked/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Local storage & optional AI/ }));
    expect(
      await screen.findByText("Your data stays on this computer. There is no account."),
    ).toBeVisible();
    const storage = screen.getByText(/local SQLite database/);
    expect(storage).not.toBeVisible();
    expect(storage.closest("details")!.open).toBe(false);
    const text = defaultViewText(container);
    for (const pattern of [/SQLite/, /[0-9a-f]{64}/, /\d{4}-\d{2}-\d{2}T\d{2}:/, /\bbytes\b/])
      expect(text).not.toMatch(pattern);
  });

  it("uses plain course states in the demo sync step", async () => {
    const s = snapshot();
    mocks.adapter.connection.mockResolvedValue({
      state: "demo",
      message: "Demo",
      extensionDetected: false,
    });
    mocks.adapter.load.mockResolvedValue(s);
    render(
      <AppProvider>
        <Onboarding probe={missing} />
      </AppProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Initial sync/ }));
    const step = (await screen.findByRole("heading", { name: "Initial sync" })).closest("section")!;
    expect(step).not.toHaveTextContent("saved status");
    expect(defaultViewText(step)).not.toMatch(/\bok\b|\bpartial\b(?! coverage)/);
  });
});
