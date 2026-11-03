import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import type { Snapshot } from "@/domain/types";
import { BridgeError, errors } from "../../../shared/src/bridge";
import { classifyHandshake, deriveSteps, emptyHint, hintKey, moodleSignIn, parseHint, resumeStep, type ExtensionStatus } from "@/domain/onboarding";

// Mocked journey fixtures only: they exercise assembly, never a live Moodle producer.
const state = vi.hoisted(() => ({
  adapter: {} as any,
  bridge: { connect: vi.fn(), currentMockRun: vi.fn(), startMockRun: vi.fn(), cancelMockRun: vi.fn() },
}));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({
  detectExtension: async () => false,
  checkSduSignIn: vi.fn(async () => { throw new Error("The fresh-bridge probe is not used in these tests."); }),
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
    checkMoodleSignIn: vi.fn(async () => ({ signal: null, checkedAt: "2028-03-05T10:00:00.000Z" })),
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

describe("#46 AC1 sign-in probe (mocked bridge)", () => {
  const signedOut = { state: "signed_out", source: "sdu_session_probe", context: "my_courses" } as const;
  const signedIn = { state: "signed_in", source: "sdu_session_probe", context: "my_courses" } as const;
  const real = () => { state.adapter.connection = vi.fn(async () => ({ state: "connected", message: "Real dataset", extensionDetected: true })); };
  const reply = (signal: unknown) => ({ signal, checkedAt: "2028-03-05T10:00:00.000Z" });

  it("probes once when the sign-in step is shown and once per Check again; re-renders and step changes do not probe", async () => {
    real();
    state.adapter.checkMoodleSignIn.mockResolvedValue(reply(null));
    mount(async () => ready);
    expect(await screen.findByRole("heading", { name: "Extension & Moodle connection" })).toBeVisible();
    await waitFor(() => expect(state.adapter.checkMoodleSignIn).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Moodle sign-in status not verified; open Moodle/check connection.", { exact: false })).toBeVisible();
    expect(screen.queryByText(/signed out/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Choose tracked courses/ }));
    fireEvent.click(screen.getByRole("button", { name: /Extension & Moodle connection/ }));
    await screen.findByRole("button", { name: "Check again" });
    expect(state.adapter.checkMoodleSignIn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(state.adapter.checkMoodleSignIn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
    expect(state.adapter.checkMoodleSignIn).toHaveBeenCalledTimes(2);
  });

  it("never probes in the demo dataset or with the extension not ready", async () => {
    const demo = mount(async () => ready);
    fireEvent.click(await screen.findByRole("button", { name: /Extension & Moodle connection/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
    expect(screen.getByText(/not verified; open Moodle\/check connection/)).toBeVisible();
    demo.unmount();
    real();
    mount(missing);
    expect(await screen.findByText(/Extension missing\./)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText(/Extension missing\./);
    expect(state.adapter.checkMoodleSignIn).not.toHaveBeenCalled();
  });

  it("signed out shows the fixed login link and no credential fields", async () => {
    real();
    state.adapter.checkMoodleSignIn.mockResolvedValue(reply(signedOut));
    mount(async () => ready);
    expect(await screen.findByText(/Moodle reported you are signed out/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open SDU Moodle sign-in" })).toHaveAttribute("href", "https://moodle.sdu.edu.kz/login/index.php");
    expect(document.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: /Extension & Moodle connection/ })).toHaveTextContent("Not finished");
    expect(screen.getByRole("button", { name: "Continue locally" })).toBeVisible();
  });

  it("signed in completes the step; a failed probe keeps 'not verified'", async () => {
    real();
    state.adapter.checkMoodleSignIn.mockResolvedValueOnce(reply(signedIn)).mockRejectedValueOnce(new BridgeError("TIMEOUT"));
    mount(async () => ready);
    await waitFor(() => expect(screen.getByRole("button", { name: /Extension & Moodle connection/ })).toHaveTextContent("Done"));
    fireEvent.click(screen.getByRole("button", { name: /Extension & Moodle connection/ }));
    expect(await screen.findByText(/Moodle access confirmed/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open SDU Moodle sign-in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/Moodle sign-in status not verified; open Moodle\/check connection\./)).toBeVisible();
    expect(screen.queryByText(/signed out/i)).toBeNull();
  });

  it("the install text links the pilot guide _docs/pilot-49.md", async () => {
    mount();
    const link = await screen.findByRole("link", { name: "_docs/pilot-49.md" });
    expect(link.getAttribute("href")).toMatch(/_docs\/pilot-49\.md$/);
    expect(screen.queryByText(/README/)).toBeNull();
  });
});

describe("#46 AC2 initial sync step (mocked adapter)", () => {
  const signedIn = { signal: { state: "signed_in", source: "sdu_session_probe", context: "my_courses" }, checkedAt: "2028-03-05T10:00:00.000Z" };
  const at = "2028-03-05T10:05:00.000Z";
  const entry = (courseId: string, fields: Record<string, unknown>) => ({ courseId, status: "never", coverage: "none", progress: 0, ...fields });
  let starts = 0;
  /** Real dataset, extension ready and signed in, two selected courses never synced: the setup resumes at the sync step. */
  const real = () => {
    state.adapter.connection = vi.fn(async () => ({ state: "connected", message: "Real dataset", extensionDetected: true }));
    state.adapter.checkMoodleSignIn.mockResolvedValue(signedIn);
    saved.settings.trackedCourseIds = ["c-csc", "c-math"];
    saved.sync = [entry("c-csc", {}), entry("c-math", {})] as any;
    starts = 0;
    state.adapter.syncAll = vi.fn(async (onProgress: (s: Snapshot) => void) => {
      starts++;
      saved.sync = saved.settings.trackedCourseIds.map((id) => entry(id, { status: "syncing" })) as any;
      const s = structuredClone(saved); onProgress(s); return s;
    });
  };
  const open = async () => {
    const view = mount(async () => ready);
    expect(await screen.findByRole("heading", { name: "Initial sync" })).toBeVisible();
    return view;
  };
  const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

  it("mounting or remounting sends no sync; one click sends one; a double click sends one; the run's progress is shown", async () => {
    real();
    const first = await open();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeVisible();
    first.unmount();
    await open();
    expect(starts).toBe(0);
    const start = screen.getByRole("button", { name: "Start initial sync" });
    fireEvent.click(start); fireEvent.click(start);
    expect(await screen.findByText("A sync is running. Its progress is shown below.")).toBeVisible();
    expect(starts).toBe(1);
    expect(screen.getByText(/CSS 215: syncing… 0%/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("AC4: reopening during an active run resumes at the sync step, reads the run and sends no start", async () => {
    real();
    saved.sync = [entry("c-csc", { status: "syncing", progress: 40 }), entry("c-math", { status: "syncing" })] as any;
    const first = await open();
    expect(screen.getByText(/CSS 215: syncing… 40%/)).toBeVisible();
    first.unmount();
    await open();
    expect(screen.getByText("A sync is running. Its progress is shown below.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).toBeNull();
    expect(starts).toBe(0);
    expect(saved.settings.trackedCourseIds).toEqual(["c-csc", "c-math"]);
  });

  it("the 409 'already running' shows the running sync; other 409s are shown as they are", async () => {
    real();
    state.adapter.syncAll.mockRejectedValueOnce(fail(errors.SYNC_ALREADY_RUNNING, 409)).mockRejectedValueOnce(fail(errors.SYNC_UNLINKED_COURSE, 409));
    const view = await open();
    // The running run is read back from the local Snapshot.
    state.adapter.load.mockImplementationOnce(async () => { const s = structuredClone(saved); s.sync = [entry("c-csc", { status: "syncing", progress: 10 }), entry("c-math", { status: "syncing" })] as any; return s; });
    fireEvent.click(screen.getByRole("button", { name: "Start initial sync" }));
    expect(await screen.findByText("A sync is running. Its progress is shown below.")).toBeVisible();
    expect(await screen.findByText(/CSS 215: syncing… 10%/)).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Start initial sync" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(errors.SYNC_UNLINKED_COURSE);
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeEnabled();
  });

  it("a 503 shows the exact reason and the step stays unfinished", async () => {
    real();
    state.adapter.syncAll.mockRejectedValueOnce(fail(errors.SYNC_UNAVAILABLE, 503));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Start initial sync" }));
    expect(await screen.findByText(`Initial sync unavailable: ${errors.SYNC_UNAVAILABLE} This step stays unfinished. Previously saved data remains visible.`)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).toBeNull();
    expect(screen.getByRole("button", { name: /Initial sync/ })).not.toHaveTextContent("Done");
  });

  it("progress follows the sync entries: partial coverage is never full, a signed-out job asks to sign in, a failed course keeps the others", async () => {
    real();
    saved.settings.trackedCourseIds = ["c-csc", "c-math", "c-phy"];
    saved.sync = [
      entry("c-csc", { status: "partial", coverage: "partial", progress: 100, lastSuccessAt: at }),
      entry("c-math", { status: "failed", progress: 100, error: "Sign in to SDU Moodle to continue.", lastAttemptAt: at }),
      entry("c-phy", { status: "failed", progress: 100, error: "Moodle could not be read for this course. Earlier data was kept.", lastAttemptAt: at }),
    ] as any;
    await open();
    expect(screen.getByText(/CSS 215: completed with partial coverage/)).toBeVisible();
    expect(screen.getByText(/MAT 102: failed: Sign in to SDU Moodle to continue\./)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open SDU Moodle sign-in" })).toHaveAttribute("href", "https://moodle.sdu.edu.kz/login/index.php");
    expect(screen.getByText(/PHY 201: failed: Moodle could not be read for this course\./)).toBeVisible();
    expect(screen.getByText("No successful full sync yet.")).toBeVisible();
    expect(screen.queryByText(/completed \(full coverage\)/)).toBeNull();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeVisible();
    expect(starts).toBe(0);
  });

  it("the step is done when every selected course has a completed entry (ok, or partial still labelled partial)", async () => {
    real();
    saved.sync = [
      entry("c-csc", { status: "ok", coverage: "full", progress: 100, lastSuccessAt: at }),
      entry("c-math", { status: "partial", coverage: "partial", progress: 100, lastSuccessAt: at }),
    ] as any;
    mount(async () => ready);
    await waitFor(() => expect(screen.getByRole("button", { name: /Initial sync/ })).toHaveTextContent("Done"));
    fireEvent.click(screen.getByRole("button", { name: /Initial sync/ }));
    expect(await screen.findByText(/CSS 215: completed \(full coverage\)/)).toBeVisible();
    expect(screen.getByText(/MAT 102: completed with partial coverage/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).toBeNull();
  });

  it("demo dataset: the unavailable text, no Start button and no sync", async () => {
    saved.settings.trackedCourseIds = [saved.courses[0]!.id];
    mount(async () => ready);
    fireEvent.click(await screen.findByRole("button", { name: /Initial sync/ }));
    expect(screen.getByText(/Live course sync is unavailable until Moodle access is verified\./)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).toBeNull();
    expect(state.adapter.syncAll).not.toHaveBeenCalled();
  });
});

// #46 step 9: Setup step 4 must fit a ~400 px viewport. jsdom has no layout engine
// (every getBoundingClientRect is 0), so it cannot measure overflow. These assertions
// guard the classes that fixed the live overflow; the 400 px measurement itself was
// done in a real browser (0 of 16 controls past the edge, scrollWidth 400).
describe("#46 step 9 narrow layout guards (class-level; jsdom cannot measure)", () => {
  const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);
  it("keeps the step column shrinkable and the calendar form free of min-content blowouts", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Semester calendar/ }));
    expect(await screen.findByRole("heading", { name: "Semester calendar" })).toBeVisible();
    const step = document.querySelector('section[aria-labelledby="setup-step"]')!;
    const grid = step.parentElement!;
    // Narrow: one shrinkable column; wide: the existing 16rem sidebar with a minmax(0,…) content track.
    expect(classes(grid)).toEqual(expect.arrayContaining(["grid", "grid-cols-1", "lg:grid-cols-[16rem_minmax(0,1fr)]"]));
    expect(classes(grid)).not.toContain("lg:grid-cols-[16rem_1fr]");
    expect(classes(step)).toContain("min-w-0");
    const calendar = screen.getByTestId("teaching-calendar");
    expect(classes(calendar)).toContain("min-w-0");
    // A fieldset defaults to min-inline-size: min-content, which let the timezone <select> widen the page.
    expect(classes(calendar.querySelector("fieldset"))).toContain("min-w-0");
    const start = screen.getByLabelText("Inclusive calendar start");
    expect(classes(start.closest("label")!.parentElement)).toEqual(expect.arrayContaining(["grid-cols-1", "sm:grid-cols-2"]));
    expect(classes(screen.getByLabelText("Calendar timezone"))).toEqual(expect.arrayContaining(["w-full", "min-w-0", "max-w-full"]));
    fireEvent.click(screen.getByRole("button", { name: "Add partial holiday" }));
    fireEvent.click(screen.getByRole("button", { name: "Add week override" }));
    for (const label of ["Holiday 1 start", "Override 1 start"]) {
      const row = screen.getByLabelText(label).closest("label")!.parentElement!;
      expect(classes(row)).toEqual(expect.arrayContaining(["min-w-0", "grid-cols-1", "sm:grid-cols-4"]));
    }
    expect(classes(screen.getByLabelText("Holiday 1 numbering"))).toEqual(expect.arrayContaining(["min-w-0", "max-w-full"]));
    expect(classes(screen.getByRole("button", { name: "Save teaching calendar" }).parentElement)).toContain("flex-wrap");
  });
});
