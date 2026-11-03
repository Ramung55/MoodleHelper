import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { TrackedCourses } from "@/routes/settings";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Snapshot } from "@/domain/types";
import { makeBackup, previewRestore } from "@/domain/backup";

const state = vi.hoisted(() => ({ adapter: { load: vi.fn(), connection: vi.fn(), setTrackedCourses: vi.fn(), ingestCourseDiscovery: vi.fn() } as { load: Mock; connection: Mock; setTrackedCourses: Mock; ingestCourseDiscovery: Mock; kind?: string; discoverCourses?: Mock },
  extension: { detected: false, discover: vi.fn() } }));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({ detectExtension: async () => state.extension.detected, discoverSduCourses: () => state.extension.discover() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

let saved: Snapshot;
function Harness() {
  const { snap, run } = useApp();
  const [visible, setVisible] = useState(true);
  if (!snap) return <p>Loading</p>;
  return <><button onClick={() => setVisible(!visible)}>Navigate</button>
    <button onClick={() => void run((api) => api.ingestCourseDiscovery([]))}>Refresh source</button>
    {visible && <TrackedCourses />}</>;
}
const mount = () => render(<AppProvider><Harness /></AppProvider>);
beforeEach(() => {
  vi.clearAllMocks();
  state.extension.detected = false;
  delete state.adapter.discoverCourses;
  state.adapter.kind = "demo";
  saved = buildDemoSnapshot();
  saved.settings.reminders.enabled = false;
  saved.settings.reminders.busyWeek = false;
  saved.changes = [];
  saved.courses = [
    { id: "one", code: "A", name: "Full observed title", color: 1, current: false,
      discovery: { sourceCourseId: "1", sourceUrl: "https://moodle.sdu.edu.kz/course/view.php?id=1",
        title: { kind: "known", value: "Full observed title" }, termIndicators: { kind: "known", value: ["Осень 2026", "Term B"] }, currentTermStatus: "unknown" } },
    { id: "two", code: "B", name: "Presentation fallback", color: 2, current: false,
      discovery: { sourceCourseId: "2", sourceUrl: "https://moodle.sdu.edu.kz/course/view.php?id=2",
        title: { kind: "unknown" }, termIndicators: { kind: "unknown" }, currentTermStatus: "unknown" } },
    { id: "legacy", code: "C", name: "Legacy full title", color: 3, current: true },
    { id: "legacy-off", code: "D", name: "Legacy off full title", color: 4, current: false },
  ];
  saved.settings.trackedCourseIds = ["one"];
  state.adapter.load.mockImplementation(async () => structuredClone(saved));
  state.adapter.connection.mockResolvedValue({ state: "demo", message: "Fixture", extensionDetected: false });
  state.adapter.setTrackedCourses.mockImplementation(async (ids: string[]) => {
    saved.settings.trackedCourseIds = [...ids];
    return structuredClone(saved);
  });
});
afterEach(cleanup);

describe("Settings course selection", () => {
  it("shows full titles, every available term, selection, unavailable facts and legacy uncertainty", async () => {
    mount();
    expect(await screen.findByRole("checkbox", { name: "Track Full observed title" })).toBeChecked();
    expect(screen.getByText("Осень 2026")).toBeVisible();
    expect(screen.getByText("Term B")).toBeVisible();
    expect(screen.getByText("Title unavailable")).toBeVisible();
    expect(screen.getAllByText("Term indicators unavailable")).toHaveLength(3);
    expect(screen.getAllByText("Current term uncertain")).toHaveLength(3);
    expect(screen.getByText("Legacy suggestion: current (unverified)")).toBeVisible();
    expect(screen.queryByText("Past course")).not.toBeInTheDocument();
    expect(screen.getByText("Legacy full title")).toBeVisible();
  });

  it("keeps confirmed checkboxes pending, prevents overlap and retains actionable error across navigation, then retries exact intent", async () => {
    let reject!: (error: Error) => void;
    state.adapter.setTrackedCourses.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Track Title unavailable" }));
    await waitFor(() => expect(state.adapter.setTrackedCourses).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("checkbox", { name: "Track Title unavailable" })).not.toBeChecked();
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Track Full observed title" }));
    expect(state.adapter.setTrackedCourses).toHaveBeenCalledTimes(1);
    reject(new Error("Database is locked. Stop other writers and retry."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Course selection was not saved");
    fireEvent.click(screen.getByText("Navigate"));
    fireEvent.click(screen.getByText("Navigate"));
    expect(screen.getByRole("alert")).toHaveTextContent("Database is locked");
    expect(screen.getByRole("checkbox", { name: "Track Title unavailable" })).not.toBeChecked();
    fireEvent.click(screen.getByText("Retry course selection"));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Track Title unavailable" })).toBeChecked());
    expect(state.adapter.setTrackedCourses.mock.calls.map(([ids]) => ids)).toEqual([["one", "two"], ["one", "two"]]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reopens previous saved selection before retry; new intent supersedes failed retry and saved empty stays empty", async () => {
    state.adapter.setTrackedCourses.mockRejectedValueOnce(new Error("Unavailable"));
    const first = mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Track Title unavailable" }));
    await screen.findByRole("alert");
    first.unmount();
    mount();
    expect(await screen.findByRole("checkbox", { name: "Track Title unavailable" })).not.toBeChecked();
    state.adapter.setTrackedCourses.mockRejectedValueOnce(new Error("Unavailable again"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Track Title unavailable" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("checkbox", { name: "Track Full observed title" }));
    expect(await screen.findByText("No courses selected. No courses will be synced.")).toBeVisible();
    expect(screen.queryByText("Retry course selection")).not.toBeInTheDocument();
    cleanup();
    mount();
    await screen.findByText("No courses selected. No courses will be synced.");
    expect(screen.getAllByRole("checkbox").every((input) => !(input as HTMLInputElement).checked)).toBe(true);
  });

  it("serializes refresh/save responses and preserves confirmed choices when a delayed refresh completes", async () => {
    let finish!: (value: Snapshot) => void;
    state.adapter.ingestCourseDiscovery.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await screen.findByRole("checkbox", { name: "Track Title unavailable" });
    fireEvent.click(screen.getByText("Refresh source"));
    await waitFor(() => expect(state.adapter.ingestCourseDiscovery).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "Track Title unavailable" }));
    expect(state.adapter.setTrackedCourses).not.toHaveBeenCalled();
    finish(structuredClone(saved));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Track Title unavailable" })).toBeChecked());
    expect(saved.settings.trackedCourseIds).toEqual(["one", "two"]);
  });

  it("shows an empty-list explanation and round-trips metadata and unknowns through backup", async () => {
    const backup = makeBackup(saved);
    const preview = previewRestore(JSON.stringify(backup), saved);
    expect(preview.ok && preview.backup.data).toEqual(saved);
    expect(Snapshot.parse(saved)).toEqual(saved);
    saved.courses = [];
    saved.settings.trackedCourseIds = [];
    mount();
    expect(await screen.findByText("No discovered courses are available yet.")).toBeVisible();
    expect(screen.getByText("No courses selected. No courses will be synced.")).toBeVisible();
  });
});

describe("#82 Find my SDU courses", () => {
  const discovered = (ids: string[]) => {
    const next = structuredClone(saved);
    for (const [i, id] of ids.entries()) next.courses.push({ id: `moodle-${id}`, code: `Course ${id}`, name: `Fictional Course ${i}`, color: 1, current: false,
      discovery: { sourceCourseId: id, sourceUrl: `https://moodle.sdu.edu.kz/course/view.php?id=${id}`, title: { kind: "known", value: `Fictional Course ${id}` },
        termIndicators: { kind: "known", value: ["In progress"] }, currentTermStatus: "unknown" } });
    return next;
  };
  const real = () => { state.extension.detected = true; state.adapter.connection.mockResolvedValue({ state: "disconnected", message: "Real dataset", extensionDetected: false }); };

  it("is not shown without the extension or in the demo dataset", async () => {
    real(); state.extension.detected = false;
    const first = mount();
    await screen.findByRole("checkbox", { name: "Track Full observed title" });
    expect(screen.queryByRole("button", { name: "Find my SDU courses" })).not.toBeInTheDocument();
    first.unmount();
    state.extension.detected = true;
    state.adapter.connection.mockResolvedValue({ state: "demo", message: "Fixture", extensionDetected: false });
    mount();
    await screen.findByRole("checkbox", { name: "Track Full observed title" });
    expect(screen.queryByRole("button", { name: "Find my SDU courses" })).not.toBeInTheDocument();
  });

  it("finds courses: busy while running, then the status line and new unticked in-progress courses", async () => {
    real();
    let finish!: (value: unknown) => void;
    state.extension.discover.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Find my SDU courses" }));
    const busy = await screen.findByRole("button", { name: "Finding courses…" });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(state.extension.discover).toHaveBeenCalledTimes(1);
    finish({ snapshot: discovered(["9001", "9002", "9003"]), found: 3, coverage: "complete" });
    expect(await screen.findByText("Found 3 in-progress courses on SDU Moodle. Tick the ones to track.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Find my SDU courses" })).toBeEnabled();
    for (const id of ["9001", "9002", "9003"]) {
      const box = screen.getByRole("checkbox", { name: `Track Fictional Course ${id}` });
      expect(box).not.toBeChecked();
      const item = box.closest("li")!;
      expect(item).toHaveTextContent("In progress");
      expect(item).toHaveTextContent("Current term uncertain");
    }
    expect(screen.getByRole("checkbox", { name: "Track Full observed title" })).toBeChecked();
    expect(state.adapter.setTrackedCourses).not.toHaveBeenCalled();
  });

  it("#84: shows the course code and \"Current course\" for in-progress courses, and the fallback otherwise", async () => {
    real();
    // Shapes as POST /api/courses/discovery saves them (tests/test_course_discovery.py).
    const course = (id: string, code: string, status: "current" | "unknown", extra: Record<string, unknown>) => ({
      id: `moodle-${id}`, code, name: `Fictional Course ${id}`, color: 1, current: status === "current",
      discovery: { sourceCourseId: id, sourceUrl: `https://moodle.sdu.edu.kz/course/view.php?id=${id}`, title: { kind: "known", value: `Fictional Course ${id}` },
        termIndicators: { kind: "known", value: ["In progress"] }, ...extra, currentTermStatus: status } }) as (typeof saved.courses)[number];
    const next = structuredClone(saved);
    next.courses.push(
      course("9001", "DEMO101", "current", { code: { kind: "known", value: "DEMO101" }, classification: "inprogress" }),
      course("9002", "DEMO202", "current", { code: { kind: "known", value: "DEMO202" }, classification: "inprogress" }),
      course("9003", "DEMO303", "current", { code: { kind: "known", value: "DEMO303" }, classification: "inprogress" }),
      course("9004", "Course 9004", "current", { code: { kind: "unknown" }, classification: "inprogress" }),
      course("9005", "Course 9005", "unknown", {}));
    state.extension.discover.mockResolvedValue({ snapshot: next, found: 5, coverage: "complete" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Find my SDU courses" }));
    await screen.findByText("Found 5 in-progress courses on SDU Moodle. Tick the ones to track.");
    const row = (id: string) => screen.getByRole("checkbox", { name: `Track Fictional Course ${id}` }).closest("li")!;
    for (const [id, code] of [["9001", "DEMO101"], ["9002", "DEMO202"], ["9003", "DEMO303"]] as const) {
      expect(row(id)).toHaveTextContent(`${code} · Fictional Course ${id}`);
      expect(row(id)).toHaveTextContent("Current course");
      expect(row(id)).not.toHaveTextContent("Current term uncertain");
    }
    expect(row("9004")).toHaveTextContent("Course 9004 · Fictional Course 9004");
    expect(row("9004")).toHaveTextContent("Current course");
    expect(row("9005")).toHaveTextContent("Course 9005 · Fictional Course 9005");
    expect(row("9005")).toHaveTextContent("Current term uncertain");
    expect(document.body).not.toHaveTextContent("redacted");
  });

  it.each([
    [{ found: 96, coverage: "partial" }, "Found 96 in-progress courses on SDU Moodle. The list may be incomplete."],
    [{ found: 0, coverage: "complete" }, "SDU Moodle lists no in-progress courses."],
  ])("shows the status line for %j", async (outcome, line) => {
    real();
    state.extension.discover.mockResolvedValue({ snapshot: structuredClone(saved), ...outcome });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Find my SDU courses" }));
    expect(await screen.findByRole("status")).toHaveTextContent(line);
  });

  it.each(["Sign in to SDU Moodle to continue.", "Could not read your SDU courses. Try again later."])(
    "shows %j as an alert, with no toast and the courses and selection unchanged", async (message) => {
      real();
      const { toast } = await import("sonner");
      state.extension.discover.mockResolvedValue({ message });
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Find my SDU courses" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.getAllByRole("checkbox")).toHaveLength(4);
      expect(screen.getByRole("checkbox", { name: "Track Full observed title" })).toBeChecked();
    });

  it("uses the extension adapter's own discovery when it is the active adapter", async () => {
    state.adapter.kind = "extension";
    state.adapter.discoverCourses = vi.fn().mockResolvedValue({ snapshot: discovered(["9004"]), found: 1, coverage: "complete" });
    state.adapter.connection.mockResolvedValue({ state: "disconnected", message: "Real dataset", extensionDetected: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Find my SDU courses" }));
    expect(await screen.findByRole("checkbox", { name: "Track Fictional Course 9004" })).not.toBeChecked();
    expect(state.extension.discover).not.toHaveBeenCalled();
  });
});
