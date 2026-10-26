import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/lib/app-store";
import { TrackedCourses } from "@/routes/settings";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Snapshot } from "@/domain/types";
import { makeBackup, previewRestore } from "@/domain/backup";

const state = vi.hoisted(() => ({ adapter: { load: vi.fn(), connection: vi.fn(), setTrackedCourses: vi.fn(), ingestCourseDiscovery: vi.fn() } }));
vi.mock("@/services", () => ({ getAdapter: () => state.adapter }));
vi.mock("@/services/extension-adapter", () => ({ detectExtension: async () => false }));
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
