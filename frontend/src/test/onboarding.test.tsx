import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import type { Snapshot } from "@/domain/types";
import { BridgeError } from "../../../shared/src/bridge";
import { classifyHandshake, deriveSteps, emptyHint, hintKey, moodleSignIn, parseHint, resumeStep, type ExtensionStatus } from "@/domain/onboarding";

// Mocked journey fixtures only: they exercise assembly, never a live Moodle producer.
const state = vi.hoisted(() => ({
  adapter: {} as any,
  bridge: { connect: vi.fn(), currentMockRun: vi.fn(), startMockRun: vi.fn(), cancelMockRun: vi.fn() },
}));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({
  detectExtension: async () => false,
  BridgeClient: class { connect = state.bridge.connect; currentMockRun = state.bridge.currentMockRun; startMockRun = state.bridge.startMockRun; cancelMockRun = state.bridge.cancelMockRun; dispose() {} },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<object>()), Link: ({ to, children, className }: any) => <a href={to} className={className}>{children}</a> }));

const { AppProvider } = await import("@/lib/app-store");
const { Onboarding, probeExtension } = await import("@/components/mh/Onboarding");

let saved: Snapshot;
let context: { datasetId: string; epoch: number; revision: number };
const ready: ExtensionStatus = { kind: "ready", moodleCollection: "unavailable" };
const missing = async (): Promise<ExtensionStatus> => classifyHandshake({ ok: false, error: new BridgeError("MISSING_EXTENSION") });
const mount = (probe: () => Promise<ExtensionStatus> = missing, moodleAccess: any = null) =>
  render(<AppProvider><Onboarding probe={probe} moodleAccess={moodleAccess} /></AppProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  saved = buildDemoSnapshot();
  saved.settings.trackedCourseIds = [];
  saved.settings.teachingCalendar = undefined;
  saved.settings.reminders.enabled = false;
  saved.settings.reminders.busyWeek = false;
  saved.changes = [];
  saved.alerts = [];
  context = { datasetId: "11111111-1111-4111-8111-111111111111", epoch: 1, revision: 1 };
  state.bridge.connect.mockRejectedValue(new BridgeError("MISSING_EXTENSION"));
  state.adapter = {
    kind: "demo", storage: "backend",
    load: vi.fn(async () => structuredClone(saved)),
    connection: vi.fn(async () => ({ state: "demo", message: "Fixture", extensionDetected: false })),
    setTrackedCourses: vi.fn(async (ids: string[]) => { saved.settings.trackedCourseIds = [...ids]; return structuredClone(saved); }),
    updateSettings: vi.fn(async (patch: any) => { saved.settings = { ...saved.settings, ...patch }; return structuredClone(saved); }),
    syncAll: vi.fn(), saveAlerts: vi.fn(),
    aiAvailability: vi.fn(async () => ({ available: false, reason: "No provider is configured." })),
    restoreContext: vi.fn(async () => ({ ...context })),
  };
});
afterEach(cleanup);

describe("onboarding coordinator logic", () => {
  it("separates missing, incompatible, unavailable, backend-unavailable and ready handshakes", () => {
    expect(classifyHandshake({ ok: false, error: new BridgeError("MISSING_EXTENSION") }).kind).toBe("missing");
    expect(classifyHandshake({ ok: false, error: new BridgeError("UNSUPPORTED_VERSION") }).kind).toBe("incompatible");
    expect(classifyHandshake({ ok: false, error: new BridgeError("RECONNECT_REQUIRED") }).kind).toBe("incompatible");
    expect(classifyHandshake({ ok: false, error: new BridgeError("PERMISSION_DENIED") }).kind).toBe("unavailable");
    expect(classifyHandshake({ ok: false, error: new BridgeError("BACKEND_UNAVAILABLE") }).kind).toBe("backend_unavailable");
    expect(classifyHandshake({ ok: true, hello: { backend: "unavailable", localRepository: "ready", moodleCollection: "unavailable" } }).kind).toBe("backend_unavailable");
    expect(classifyHandshake({ ok: true, hello: { backend: "ready", localRepository: "ready", moodleCollection: "unavailable" } })).toEqual(ready);
  });
  it("uses the real BridgeClient handshake for probing", async () => {
    state.bridge.connect.mockResolvedValueOnce({ backend: "ready", localRepository: "ready", moodleCollection: "unavailable" });
    expect(await probeExtension()).toEqual(ready);
  });
  it("only claims signed out from a trusted signal with provenance", () => {
    expect(moodleSignIn(null).kind).toBe("unverified");
    expect(moodleSignIn(null).message).toBe("Moodle sign-in status not verified; open Moodle/check connection.");
    expect(moodleSignIn({ state: "signed_out", source: "", context: "" }).kind).toBe("unverified");
    expect(moodleSignIn({ state: "signed_out", source: "access-normalizer", context: "dashboard" }).kind).toBe("signed_out");
  });
  it("derives completion from data, so a stale hint cannot claim success", () => {
    const snap = buildDemoSnapshot(); snap.settings.trackedCourseIds = []; snap.settings.teachingCalendar = undefined;
    const hint = parseHint(JSON.stringify({ version: 1, visitedStepIds: ["courses", "bogus"], choices: { courses: "skipped", sync: "skipped", calendar: "acknowledged" } }));
    expect(hint.visitedStepIds).toEqual(["courses"]);
    const states = deriveSteps({ snap, extension: ready, liveSync: "unavailable", hint });
    expect(states).toMatchObject({ connection: "done", courses: "todo", sync: "choice", calendar: "todo" });
    expect(resumeStep(states)).toBe("courses");
    expect(deriveSteps({ snap, extension: ready, liveSync: "unavailable", hint: emptyHint() }).sync).toBe("blocked");
    expect(parseHint("{not json")).toEqual(emptyHint());
    expect(hintKey({ datasetId: "d", epoch: 2 })).not.toBe(hintKey({ datasetId: "d", epoch: 3 }));
  });
});

describe("onboarding journey (mocked fixtures)", () => {
  it("shows missing extension guidance, unverified Moodle sign-in and a safe login link without credential fields", async () => {
    mount();
    expect(await screen.findByText(/Extension missing\./)).toBeVisible();
    expect(screen.getByText(/Load unpacked/)).toBeVisible();
    expect(screen.getByText(/not verified; open Moodle\/check connection/)).toBeVisible();
    expect(screen.queryByText(/logged out|signed out/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Open SDU Moodle sign-in" })).toHaveAttribute("href", "https://moodle.sdu.edu.kz/login/index.php");
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByRole("link", { name: "Go to dashboard" })).toBeVisible();
  });
  it("shows signed out only from a trusted signal", async () => {
    mount(async () => ready, { state: "signed_out", source: "access-normalizer", context: "dashboard" });
    fireEvent.click(await screen.findByRole("button", { name: /Extension & Moodle connection/ }));
    expect(await screen.findByText(/Moodle reported you are signed out/)).toBeVisible();
  });
  it("continues locally past a missing extension, then resumes at course review keeping the saved selection", async () => {
    const first = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue locally" }));
    expect(await screen.findByRole("heading", { name: "Choose tracked courses" })).toBeVisible();
    const box = screen.getAllByRole("checkbox")[0]!;
    fireEvent.click(box);
    await waitFor(() => expect(state.adapter.setTrackedCourses).toHaveBeenCalledTimes(1));
    first.unmount();
    mount();
    // Reopen: connection skipped, courses saved, sync blocked (live unavailable) → calendar.
    expect(await screen.findByRole("heading", { name: "Semester calendar" })).toBeVisible();
    expect(saved.settings.trackedCourseIds).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Choose tracked courses/ }));
    expect(screen.getAllByRole("checkbox").filter((b) => (b as HTMLInputElement).checked)).toHaveLength(1);
    expect(state.adapter.updateSettings).not.toHaveBeenCalled();
  });
  it("keeps the previous selection and offers retry when saving fails", async () => {
    window.localStorage.setItem(hintKey(context), JSON.stringify({ version: 1, visitedStepIds: [], choices: { connection: "skipped" } }));
    state.adapter.setTrackedCourses.mockRejectedValueOnce(new Error("Backend down."));
    mount();
    expect(await screen.findByRole("heading", { name: "Choose tracked courses" })).toBeVisible();
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(await screen.findByRole("button", { name: "Retry course selection" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Choose tracked courses" })).toBeVisible();
    expect(saved.settings.trackedCourseIds).toEqual([]);
  });
  it("shows the exact unavailable sync reason, never starts a demo sync and keeps the step unfinished", async () => {
    saved.settings.trackedCourseIds = [saved.courses[0]!.id];
    window.localStorage.setItem(hintKey(context), JSON.stringify({ version: 1, visitedStepIds: [], choices: {} }));
    mount(async () => ready);
    fireEvent.click(await screen.findByRole("button", { name: /Initial sync/ }));
    expect(await screen.findByText(/Live course sync is unavailable until Moodle access is verified\./)).toBeVisible();
    expect(screen.getByText(/Demonstration only: mock scan/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Initial sync/ })).toHaveTextContent("Unavailable");
    expect(state.adapter.syncAll).not.toHaveBeenCalled();
    expect(state.bridge.startMockRun).not.toHaveBeenCalled();
  });
  it("records declined notifications as a choice and moves on without blocking", async () => {
    saved.settings.trackedCourseIds = [saved.courses[0]!.id];
    saved.settings.teachingCalendar = { startDate: "2027-01-04", endDate: "2027-02-28", timezone: "Asia/Qyzylorda", excludedWeekStarts: [] };
    const requestPermission = vi.fn();
    (globalThis as any).Notification = { requestPermission, permission: "default" };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue locally" }));
    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "No notifications" }));
    expect(await screen.findByRole("heading", { name: "Local storage & optional AI" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Notifications/ })).toHaveTextContent("Skipped / chosen");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(hintKey(context))!).choices.notifications).toBe("declined");
  });
  it("explains local storage and AI separately; AI stays off and nothing is sent", async () => {
    window.localStorage.setItem(hintKey(context), JSON.stringify({ version: 1, visitedStepIds: [], choices: {} }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Local storage & optional AI/ }));
    expect(await screen.findByText(/External AI unavailable; no text is sent\./)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Local storage" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Optional external AI" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I understand" }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(hintKey(context))!).choices.privacy).toBe("acknowledged"));
    expect(state.adapter.updateSettings).not.toHaveBeenCalled();
    expect(saved.settings.ai.enabled).toBe(false);
  });
  it("does not carry setup hints across a lifecycle epoch change (erase/restore)", async () => {
    window.localStorage.setItem(hintKey(context), JSON.stringify({ version: 1, visitedStepIds: [], choices: { connection: "skipped" } }));
    context = { ...context, epoch: 2 };
    mount();
    expect(await screen.findByRole("heading", { name: "Extension & Moodle connection" })).toBeVisible();
  });
  it("discards a stale hint write when the epoch changed after it started", async () => {
    mount();
    const button = await screen.findByRole("button", { name: "Continue locally" });
    await waitFor(() => expect(state.adapter.restoreContext).toHaveBeenCalled());
    context = { ...context, epoch: 5 };
    fireEvent.click(button);
    await waitFor(() => expect(state.adapter.restoreContext.mock.calls.length).toBeGreaterThan(1));
    expect(window.localStorage.getItem(hintKey({ ...context, epoch: 1 }))).toBeNull();
    expect(window.localStorage.getItem(hintKey(context))).toBeNull();
  });
  it("treats nonempty existing data as optional setup without overwriting it", async () => {
    saved.settings.trackedCourseIds = saved.courses.slice(0, 2).map((c) => c.id);
    mount();
    expect(await screen.findByText(/Optional setup\. Your saved data is kept/)).toBeVisible();
    expect(state.adapter.setTrackedCourses).not.toHaveBeenCalled();
    expect(state.adapter.updateSettings).not.toHaveBeenCalled();
  });
});
