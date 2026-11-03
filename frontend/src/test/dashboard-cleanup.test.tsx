import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { lastFullSyncAt, shellNotice, syncSummaryLine } from "@/domain/live-sync";
import { formatDate, friendlyDay, friendlyInstant, friendlyRange } from "@/domain/dates";
import { shortMappingReason } from "@/domain/deadline-display";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Details, SubmissionBadge } from "@/components/mh/bits";
import { AssessmentRow } from "@/components/mh/AssessmentRow";
import { Route as SettingsRoute } from "@/routes/settings";
import { Overview } from "@/routes/index";
import { viewAll } from "@/domain/assessments";
import type { Snapshot } from "@/domain/types";

/** #87 pass A: shell, Overview, Deadlines chip and the shared friendly date formatter. */
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
  },
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
  BridgeClient: class {
    connect = mocks.connect;
    currentMockRun = vi.fn(async () => ({ courseIds: [] }));
    dispose = vi.fn();
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, hash }: { children: React.ReactNode; to: string; hash?: string }) => (
    <a href={hash ? `${to}#${hash}` : to}>{children}</a>
  ),
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const REAL = { state: "disconnected", message: "Real dataset.", extensionDetected: false } as const;
const Settings = SettingsRoute.options.component as ComponentType;

function snapshot(): Snapshot {
  const s = buildDemoSnapshot();
  s.changes = [];
  s.settings.reminders = { enabled: false, hoursBefore: 24, busyWeek: false };
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter.aiAvailability.mockResolvedValue({
    available: false,
    reason: "No provider configured",
  });
  mocks.adapter.connection.mockResolvedValue(REAL);
  mocks.connect.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("shared friendly formatter (#87 guideline 6, AC6)", () => {
  it("formats instants in the configured timezone, adding the year only outside the current one", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(friendlyInstant("2026-11-04T09:05:00Z", "Asia/Almaty", now)).toBe("4 Nov, 14:05");
    expect(friendlyInstant("2025-11-04T09:05:00Z", "Asia/Almaty", now)).toBe("4 Nov 2025, 14:05");
    expect(friendlyInstant("2026-11-04T09:05:00Z", "Not/AZone", now)).toBe("4 Nov, 09:05");
    expect(friendlyInstant("garbage", "UTC", now)).toBe("Date unavailable");
    expect(friendlyDay("2026-11-04", "UTC", now)).toBe("4 Nov");
    expect(friendlyDay("2027-01-10", "UTC", now)).toBe("10 Jan 2027");
    expect(friendlyRange("2026-03-09", "2026-03-15", "UTC", now)).toBe("9–15 Mar");
    expect(friendlyRange("2026-02-28", "2026-03-06", "UTC", now)).toBe("28 Feb – 6 Mar");
    expect(formatDate({ kind: "date", date: "2026-11-04" }, "UTC")).toMatch(
      /^4 Nov( 2026)? \(no time\)$/,
    );
  });

  it("shortens unresolved week reasons to one sentence (D2)", () => {
    expect(
      shortMappingReason(
        "Teaching calendar is not configured; legacy semester fields are not a verified map.",
      ),
    ).toBe("Teaching calendar not set.");
    expect(
      shortMappingReason(
        "The source day has no unique resolved teaching range; institutional numbering or an uncovered interval needs review.",
      ),
    ).toBe("The source day has no unique resolved teaching range.");
  });
});

describe("shell and sync helpers (S1, O1)", () => {
  it("shows one short banner line per dataset", () => {
    expect(shellNotice({ state: "demo", message: "x", extensionDetected: false })).toBe(
      "Demo data — nothing is read from Moodle.",
    );
    expect(shellNotice({ ...REAL })).toBe("Extension not connected. Saved data is shown.");
    expect(shellNotice({ ...REAL, extensionDetected: true, liveSync: true })).toBe(
      "Connected to Moodle Helper. Sync reads your selected courses.",
    );
    expect(shellNotice(null)).toBe("Loading…");
  });

  it("summarises the selected courses' sync entries in one line", () => {
    const ok = { status: "ok", coverage: "full", lastSuccessAt: "2028-03-05T10:00:00Z" };
    expect(
      syncSummaryLine(
        ["a", "b"],
        [
          { courseId: "a", ...ok },
          { courseId: "b", status: "ok", coverage: "partial" },
        ],
      ),
    ).toBe("1 of 2 courses fully scanned");
    expect(
      syncSummaryLine(
        ["a", "b"],
        [
          { courseId: "a", ...ok },
          { courseId: "b", status: "syncing", coverage: "none" },
        ],
      ),
    ).toBe("Sync running…");
    expect(syncSummaryLine(["a"], [{ courseId: "a", status: "failed", coverage: "full" }])).toBe(
      "Last sync failed for 1 course",
    );
    expect(
      lastFullSyncAt(
        ["a", "b"],
        [
          { courseId: "a", ...ok },
          { courseId: "b", ...ok, lastSuccessAt: "2028-03-05T09:00:00Z" },
        ],
      ),
    ).toBe(Date.parse("2028-03-05T09:00:00Z"));
    expect(lastFullSyncAt(["a", "b"], [{ courseId: "a", ...ok }])).toBeUndefined();
  });
});

describe("Details disclosure (guideline 4)", () => {
  it("is closed by default and opens from the keyboard-reachable summary", () => {
    render(
      <Details>
        <p>Inner text</p>
      </Details>,
    );
    const summary = screen.getByText("Details");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")!.open).toBe(false);
    fireEvent.click(summary);
    expect(summary.closest("details")!.open).toBe(true);
  });
});

describe("Overview with the real dataset (AC4, AC6, AC7)", () => {
  function Probe() {
    const { snap } = useApp();
    return snap ? (
      <>
        <Overview />
        <Settings />
      </>
    ) : (
      <p>waiting</p>
    );
  }

  it("renders saved data before extension detection; Sync all is disabled as Checking… and sends nothing", async () => {
    const s = snapshot();
    mocks.adapter.load.mockResolvedValue(s);
    let finish!: (detected: boolean) => void;
    mocks.detect.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Checking…" });
    expect(buttons.length).toBe(2); // Overview and Settings
    for (const button of buttons) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(mocks.adapter.syncAll).not.toHaveBeenCalled();
    expect(mocks.bridgeSync).not.toHaveBeenCalled();
    await act(async () => finish(false));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Sync all courses" })).toHaveLength(2),
    );
  });

  it("shows a dash, the calendar link and an Overdue count when the calendar is not set", async () => {
    const s = snapshot();
    delete s.settings.teachingCalendar;
    const a = s.assessments.find((x) => x.id === "a4")!; // outstanding: Moodle "not submitted"
    a.sources = a.sources.map((src) => ({
      ...src,
      date: { kind: "exact", iso: "2020-01-01T10:00:00Z", tz: "UTC" },
    }));
    s.overlays = s.overlays.filter((o) => o.assessmentId !== a.id);
    mocks.adapter.load.mockResolvedValue(s);
    mocks.detect.mockResolvedValue(false);
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
    const outstanding = (await screen.findByText("Outstanding this week")).closest("a")!;
    expect(within(outstanding).getByText("—")).toBeInTheDocument();
    expect(outstanding).toHaveTextContent("Set your teaching calendar to count weeks.");
    expect(outstanding).toHaveAttribute("href", "/settings#teaching-calendar");
    expect(screen.getByText("Busy weeks ahead").closest("a")).toHaveTextContent("—");
    expect(screen.getByRole("link", { name: "Set calendar" })).toHaveAttribute(
      "href",
      "/settings#teaching-calendar",
    );
    const overdue = screen.getByText("Overdue").closest("a")!;
    expect(overdue).toHaveAttribute("href", "/deadlines");
    expect(Number(within(overdue).getByText(/^\d+$/).textContent)).toBeGreaterThanOrEqual(1);
    expect(document.getElementById("teaching-calendar")).not.toBeNull();
  });

  it("shows the last full sync in the configured timezone; the #21 lines sit under a closed Details", async () => {
    const s = snapshot();
    s.settings.timezone = "Asia/Almaty";
    s.sync = s.settings.trackedCourseIds.map((courseId) => ({
      courseId,
      status: "ok",
      coverage: "full",
      progress: 100,
      lastSuccessAt: "2026-11-04T09:05:00Z",
    }));
    mocks.adapter.load.mockResolvedValue(s);
    mocks.detect.mockResolvedValue(false);
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
    const card = await screen.findByRole("region", { name: "Last full sync" });
    expect(
      within(card).getByText(friendlyInstant("2026-11-04T09:05:00Z", "Asia/Almaty")),
    ).toBeInTheDocument();
    expect(friendlyInstant("2026-11-04T09:05:00Z", "Asia/Almaty")).toMatch(
      /^4 Nov( 2026)?, 14:05$/,
    );
    expect(card).toHaveTextContent(
      `${s.settings.trackedCourseIds.length} of ${s.settings.trackedCourseIds.length} courses fully scanned`,
    );
    expect(card.querySelector("details")!.open).toBe(false);
    expect(card.querySelector("details")).toHaveTextContent(/^Details.*Successful full sync: /);
    // O4: no mock panel on Overview in the real dataset; Settings → Details has it.
    expect(screen.getAllByRole("region", { name: "Mock scan progress" })).toHaveLength(1);
    expect(screen.getByText("Demo: mock scan progress").closest("details")!.open).toBe(false);
  });
});

describe("Deadlines submission chip (D1, AC5)", () => {
  it("shows no chip without an observed submission and keeps the unknown label when observed", () => {
    const { container } = render(<SubmissionBadge status={undefined} />);
    expect(container).toBeEmptyDOMElement();
    render(<SubmissionBadge status="unknown" />);
    expect(screen.getByText("Moodle: Status unknown")).toBeInTheDocument();
  });

  it("renders a row without 'No Moodle status' and a one-sentence unresolved-week reason", async () => {
    const s = snapshot();
    mocks.adapter.load.mockResolvedValue(s);
    mocks.detect.mockResolvedValue(false);
    const views = viewAll(s.assessments, s.overlays, s.settings, s);
    const plain = views.find((v) => v.a.id === "a7")!; // week-only syllabus item, no observed submission
    function Rows() {
      const { snap } = useApp();
      return snap ? <AssessmentRow v={plain} onOpen={() => undefined} /> : null;
    }
    render(
      <AppProvider>
        <Rows />
      </AppProvider>,
    );
    const row = await screen.findByRole("button", { name: /Midterm exam/ });
    expect(row).not.toHaveTextContent("No Moodle status");
    expect(row).not.toHaveTextContent(/Moodle: /);
    expect(row).toHaveTextContent("Teaching calendar not set.");
  });
});
