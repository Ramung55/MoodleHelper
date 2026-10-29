// @vitest-environment jsdom
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpAdapter } from "@/services/http-adapter";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "@/lib/app-store";
import { TrackedCourses } from "@/routes/settings";
import { collectMoodleCourses } from "../../../extension/src/moodle-courses";
import { card, list, page } from "./moodle-courses-fixtures";
import { makeBackup, previewRestore } from "@/domain/backup";
import { AddEvent } from "@/routes/deadlines";
import { AssessmentSheet } from "@/components/mh/AssessmentSheet";

// Only the service locator/extension handshake are injected; all data operations
// below use production HttpAdapter, FastAPI and a real file SQLite database.
vi.mock("@/services", () => ({ getAdapter: () => api }));
vi.mock("@/services/extension-adapter", () => ({ detectExtension: async () => false }));
function SelectionHarness() {
  const { snap } = useApp();
  return snap ? createElement(TrackedCourses) : createElement("p", null, "Loading");
}
const openSelection = () => render(createElement(AppProvider, { children: createElement(SelectionHarness) }));

let child: ChildProcess;
let api: HttpAdapter;
let base: string;
let root: string;
let python: string;
let port: number;
let temporaryDirectory: string;
let databasePath: string;

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
  });
}

async function startServer() {
  // Isolate both storage and identity from the developer's configured process.
  const env = { ...process.env, MOODLE_HELPER_DATABASE_URL: `sqlite:///${databasePath.replaceAll("\\", "/")}`, MOODLE_HELPER_DATASET: "demo" };
  for (const key of ["MOODLE_HELPER_MOODLE_ORIGIN", "MOODLE_HELPER_PROFILE_LABEL", "MOODLE_HELPER_STABLE_USER_ID"]) delete env[key];
  child = spawn(python, ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, env, windowsHide: true, stdio: "pipe" });
  let log = "";
  child.stdout?.on("data", (chunk) => { log += String(chunk); });
  child.stderr?.on("data", (chunk) => { log += String(chunk); });
  child.on("error", (error) => { log += error.message; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/docs`)).ok) {
        api = new HttpAdapter(base);
        return;
      }
    } catch { /* wait for the actual server to bind */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`FastAPI integration process failed to start: ${log}`);
}

beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No local test port available");
  port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  root = path.resolve(import.meta.dirname, "../../..");
  python = process.platform === "win32" ? path.join(root, ".venv/Scripts/python.exe") : path.join(root, ".venv/bin/python");
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "moodle-helper-http-"));
  databasePath = path.join(temporaryDirectory, "http.sqlite3");
  base = `http://127.0.0.1:${port}`;
  await startServer();
}, 25_000);

afterAll(async () => {
  await stopServer();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("actual FastAPI HTTP integration", () => {
  it("persists an explicit teaching calendar across restart and restores the legacy snapshot", async () => {
    const original = await api.load();
    const calendar = { startDate: "2027-01-04", endDate: "2027-02-28", timezone: "Asia/Qyzylorda", excludedWeekStarts: ["2027-01-18"], partialBreaks: [{ startDate: "2027-01-13", endDate: "2027-01-13", numbering: "preserve" as const }], weekOverrides: [{ week: 2, startDate: "2027-01-11", endDate: "2027-01-16" }] };
    try {
      const saved = await api.updateSettings({ teachingCalendar: calendar });
      expect(saved.settings.teachingCalendar).toEqual(calendar);
      expect(saved.assessments).toEqual(original.assessments);
      expect(saved.overlays).toEqual(original.overlays);
      await stopServer(); await startServer();
      expect((await api.load()).settings.teachingCalendar).toEqual(calendar);
    } finally { await api.replaceAll(original); }
    expect((await api.load()).settings.teachingCalendar).toEqual(original.settings.teachingCalendar);
  });
  it("creates, edits, reopens, syncs and deletes a personal event without merging an imported title", async () => {
    const original = await api.load();
    let id: string | undefined;
    try {
      await api.updateSettings({ reminders: { enabled: false, hoursBefore: 24, busyWeek: false }, timezone: "Asia/Almaty" });
      const imported = original.assessments.find((a) => !a.personal)!;
      function Create() { const { snap } = useApp(); return snap ? createElement(AddEvent, { open: true, onClose: () => {} }) : createElement("p", null, "Loading"); }
      const create = render(createElement(AppProvider, { children: createElement(Create) }));
      fireEvent.change(await screen.findByLabelText("Title"), { target: { value: imported.title } });
      fireEvent.change(screen.getByLabelText("Course"), { target: { value: imported.courseId } });
      fireEvent.change(screen.getByLabelText("Date form"), { target: { value: "exact" } });
      fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: "2026-10-29T15:30" } });
      fireEvent.click(screen.getByRole("button", { name: "Add event" }));
      await waitFor(async () => {
        const saved = await api.load(); id = saved.assessments.find((a) => a.personal && a.title === imported.title)?.id;
        expect(id).toBeTruthy();
      });
      create.unmount(); cleanup();
      function Detail() { const { snap } = useApp(); return snap ? createElement(AssessmentSheet, { id: id!, onClose: () => {} }) : createElement("p", null, "Loading"); }
      let detail = render(createElement(AppProvider, { children: createElement(Detail) }));
      expect(await screen.findByLabelText("Display title")).toHaveValue(imported.title);
      expect(screen.getByLabelText("Date and time")).toHaveValue("2026-10-29T15:30");
      fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Edited personal event" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(async () => expect((await api.load()).overlays.find((o) => o.assessmentId === id)?.titleOverride).toBe("Edited personal event"));
      detail.unmount(); cleanup(); await stopServer(); await startServer();
      const synced = await api.syncAll(() => {});
      expect(synced.assessments.find((a) => a.id === id)?.sources[0]).toMatchObject({ source: "personal", date: { kind: "exact", iso: "2026-10-29T10:30:00.000Z", tz: "Asia/Almaty" } });
      expect(synced.assessments.find((a) => a.id === imported.id)).toEqual(imported);
      expect(synced.assessments.filter((a) => a.title === imported.title)).toHaveLength(2);
      detail = render(createElement(AppProvider, { children: createElement(Detail) }));
      expect(await screen.findByLabelText("Display title")).toHaveValue("Edited personal event");
      fireEvent.click(screen.getByRole("button", { name: "Delete event" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect((await api.load()).assessments.some((a) => a.id === id)).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Delete event" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
      await waitFor(async () => expect((await api.load()).assessments.some((a) => a.id === id)).toBe(false));
      expect((await api.load()).assessments.find((a) => a.id === imported.id)).toEqual(imported);
      detail.unmount(); cleanup();
    } finally { cleanup(); await api.replaceAll(original); }
  });
  it("saves actual Settings choices, ingests real parser observations, refreshes and reopens across process restart", async () => {
    const original = await api.load();
    try {
      await api.updateSettings({ reminders: { enabled: false, hoursBefore: 24, busyWeek: false } });
      await api.saveAlerts([]);
      const largeId = "90071992547409931234567890123456789";
      const parsed = collectMoodleCourses([page(list(card(largeId, "Полное название курса", ["Осень 2026", "Term B"]) + card("42", "Same title") + card("43", "Same title")))]);
      expect(parsed.observations).toHaveLength(3);
      const ingested = await api.ingestCourseDiscovery(parsed.observations);
      const course = ingested.courses.find((c) => c.discovery?.sourceCourseId === largeId)!;
      const exclude = ingested.courses.find((c) => ingested.settings.trackedCourseIds.includes(c.id))!;
      expect(course.discovery?.sourceCourseId).toBe(largeId);
      expect(ingested.courses.filter((c) => c.name === "Same title")).toHaveLength(2);
      expect(ingested.settings.trackedCourseIds).not.toContain(course.id);
      expect(await api.ingestCourseDiscovery(parsed.observations)).toEqual(ingested);
      let view = openSelection();
      fireEvent.click(await screen.findByRole("checkbox", { name: "Track Полное название курса" }));
      await waitFor(() => expect(screen.getByRole("checkbox", { name: "Track Полное название курса" })).toBeChecked());
      fireEvent.click(screen.getByRole("checkbox", { name: `Track ${exclude.name}` }));
      await waitFor(() => expect(screen.getByRole("checkbox", { name: `Track ${exclude.name}` })).not.toBeChecked());
      const selected = (await api.load()).settings.trackedCourseIds;
      view.unmount();
      const refresh = collectMoodleCourses([page(list(card(largeId, "Changed full title", ["Весна 2027", "Term C"]) + card("99", "", [])), { finalUrl: "https://moodle.sdu.edu.kz/my/" })]);
      const refreshed = await api.ingestCourseDiscovery(refresh.observations);
      expect(refreshed.settings.trackedCourseIds).toEqual(selected);
      expect(refreshed.courses.find((c) => c.discovery?.sourceCourseId === "99")?.discovery).toMatchObject({ title: { kind: "unknown" }, termIndicators: { kind: "unknown" }, currentTermStatus: "unknown" });
      expect(refreshed.courses.find((c) => c.id === course.id)).toMatchObject({ code: course.code, color: course.color });
      expect(await api.ingestCourseDiscovery([])).toEqual(refreshed);
      for (const key of ["assessments", "overlays", "materials", "documents", "candidates", "sync", "changes"] as const) expect(refreshed[key]).toEqual(ingested[key]);
      const preview = previewRestore(JSON.stringify(makeBackup(refreshed)), refreshed);
      expect(preview.ok && preview.backup.data).toEqual(refreshed);
      expect(await api.replaceAll(refreshed)).toEqual(refreshed);
      await stopServer();
      await startServer();
      expect(await new HttpAdapter(base).load()).toEqual(refreshed);
      view = openSelection();
      expect(await screen.findByRole("checkbox", { name: "Track Changed full title" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: `Track ${exclude.name}` })).not.toBeChecked();
      expect(screen.getByText("Весна 2027")).toBeVisible();
      expect(screen.getByText("Term C")).toBeVisible();
      expect(screen.getByRole("checkbox", { name: "Track Title unavailable" })).not.toBeChecked();
      // Exercise saved-empty through actual UI, one confirmed request at a time.
      while (screen.getAllByRole("checkbox").some((input) => (input as HTMLInputElement).checked)) {
        const checkbox = screen.getAllByRole("checkbox").find((input) => (input as HTMLInputElement).checked)!;
        fireEvent.click(checkbox);
        await waitFor(() => expect(checkbox).not.toBeChecked());
      }
      expect(screen.getByText("No courses selected. No courses will be synced.")).toBeVisible();
      view.unmount();
      const emptySelection = await api.load();
      expect(await api.syncAll(() => {})).toEqual(emptySelection);
      await stopServer();
      await startServer();
      expect((await api.load()).settings.trackedCourseIds).toEqual([]);
      view = openSelection();
      await screen.findByText("No courses selected. No courses will be synced.");
      view.unmount();
    } finally {
      cleanup();
      await api.replaceAll(original);
    }
  }, 50_000);

  it("rolls back an actual locked-file Settings save, reopens confirmed choices, and retries the failed intended selection", async () => {
    const original = await api.load();
    let locker: ChildProcess | undefined;
    async function unlock() {
      if (!locker || locker.exitCode !== null) return;
      const stopped = new Promise<void>((resolve) => locker!.once("exit", () => resolve()));
      locker.stdin?.end();
      await stopped;
    }
    try {
      await api.updateSettings({ reminders: { enabled: false, hoursBefore: 24, busyWeek: false } });
      await api.saveAlerts([]);
      const before = await api.load();
      let view = openSelection();
      const target = before.courses[0];
      const confirmed = before.settings.trackedCourseIds.includes(target.id);
      const checkbox = await screen.findByRole("checkbox", { name: `Track ${target.name}` });
      // BEGIN IMMEDIATE permits independent readers while blocking writers.
      locker = spawn(python, ["-u", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); print('locked',flush=True); sys.stdin.read(); c.rollback(); c.close()", databasePath], { cwd: root, windowsHide: true, stdio: "pipe" });
      await new Promise<void>((resolve, reject) => { locker!.stdout?.once("data", () => resolve()); locker!.once("error", reject); });
      fireEvent.click(checkbox);
      await waitFor(() => expect(checkbox).toBeDisabled());
      expect((checkbox as HTMLInputElement).checked).toBe(confirmed);
      const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
      expect(alert).toHaveTextContent("Database is locked");
      expect((checkbox as HTMLInputElement).checked).toBe(confirmed);
      expect(await new HttpAdapter(base).load()).toEqual(before);
      // A second provider opens the previous saved values before retry.
      view.unmount();
      view = openSelection();
      expect(((await screen.findByRole("checkbox", { name: `Track ${target.name}` })) as HTMLInputElement).checked).toBe(confirmed);
      await unlock();
      view.unmount();
      // Reproduce the failure and keep this provider mounted for intended Retry.
      view = openSelection();
      await screen.findByRole("checkbox", { name: `Track ${target.name}` });
      locker = spawn(python, ["-u", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); print('locked',flush=True); sys.stdin.read(); c.rollback(); c.close()", databasePath], { cwd: root, windowsHide: true, stdio: "pipe" });
      await new Promise<void>((resolve, reject) => { locker!.stdout?.once("data", () => resolve()); locker!.once("error", reject); });
      fireEvent.click(screen.getByRole("checkbox", { name: `Track ${target.name}` }));
      await screen.findByRole("alert", {}, { timeout: 5000 });
      await unlock();
      fireEvent.click(screen.getByText("Retry course selection"));
      await waitFor(() => expect((screen.getByRole("checkbox", { name: `Track ${target.name}` }) as HTMLInputElement).checked).toBe(!confirmed));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      const committed = await api.load();
      expect(committed.settings.trackedCourseIds.includes(target.id)).toBe(!confirmed);
      expect({ ...committed, settings: before.settings }).toEqual(before);
      view.unmount();
      await stopServer();
      await startServer();
      expect(await api.load()).toEqual(committed);
    } finally {
      cleanup();
      await unlock();
      await api.replaceAll(original);
    }
  }, 30_000);

  it("persists complete edited state across actual backend stop/start against the same file", async () => {
    const original = await api.load();
    const created = await api.addPersonalEvent({ title: "Survives process restart / Пример", courseId: "c-csc", type: "other", date: { kind: "date", date: "2028-02-29" } });
    const id = created.assessments.at(-1)!.id;
    await api.updateOverlay(id, { titleOverride: "Edited before restart", dateOverride: { kind: "week", week: 10 }, hidden: true, completed: true });
    await api.updateSettings({ semesterWeeks: 17 });
    const imported = await api.importDocument("c-csc", "restart.pdf", () => {});
    await api.review(imported.snapshot.candidates.at(-1)!.id, { kind: "confirm" });
    const beforeStop = await api.load();
    const previousPid = child.pid;
    await stopServer();
    await startServer();
    expect(child.pid).not.toBe(previousPid);
    expect(await api.load()).toEqual(beforeStop);
    expect((await api.load()).overlays.find((o) => o.assessmentId === id)?.titleOverride).toBe("Edited before restart");
    await api.replaceAll(original);
    const deleted = await api.deleteLocalData();
    await stopServer();
    await startServer();
    expect(await api.load()).toEqual(deleted);
    expect((await api.load()).courses).toEqual([]);
    await api.replaceAll(original);
  }, 50_000);

  it("shows an actual locked-database failure through HttpAdapter and preserves the last commit", async () => {
    const original = await api.load();
    const locker = spawn(python, ["-u", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN EXCLUSIVE'); print('locked',flush=True); sys.stdin.read(); c.rollback(); c.close()", databasePath], { cwd: root, windowsHide: true, stdio: "pipe" });
    try {
      await new Promise<void>((resolve, reject) => {
        locker.stdout?.once("data", () => resolve());
        locker.once("error", reject);
        locker.once("exit", (code) => { if (code) reject(new Error(`Lock helper exited ${code}`)); });
      });
      await expect(api.updateSettings({ semesterWeeks: 18 })).rejects.toThrow("Database is locked");
    } finally {
      const stopped = new Promise<void>((resolve) => locker.once("exit", () => resolve()));
      locker.stdin?.end();
      await stopped;
    }
    expect(await api.load()).toEqual(original);
  }, 15_000);

  it("round trips encoded identifiers through real routes and preserves missing-id outcomes", async () => {
    const original = await api.load();
    const id = "folder/item %2F? # Пример";
    const restored = await api.addPersonalEvent({ title: "Encoded identifier", courseId: "c-csc", type: "other", date: { kind: "unknown" } });
    restored.assessments.at(-1)!.id = id;
    restored.candidates[0].id = id;
    restored.materials[0] = { ...restored.materials[0], id, accessible: true };
    try {
      await api.replaceAll(restored);
      const patched = await api.updateOverlay(id, { completed: true });
      expect(patched.overlays.find((o) => o.assessmentId === id)?.completed).toBe(true);
      const reviewed = await api.review(id, { kind: "reject" });
      expect(reviewed.candidates.find((c) => c.id === id)?.status).toBe("rejected");
      expect((await api.downloadMaterial(id)).message).toContain("Chrome extension");
      const deleted = await api.deletePersonalEvent(id);
      expect(deleted.assessments.some((a) => a.id === id)).toBe(false);
      expect(deleted.overlays.some((o) => o.assessmentId === id)).toBe(false);
      expect(await api.review("missing/encoded", { kind: "confirm" })).toEqual(deleted);
      expect(await api.deletePersonalEvent("missing/encoded")).toEqual(deleted);
      expect((await api.downloadMaterial("missing/encoded")).snapshot).toEqual(deleted);
    } finally {
      await api.replaceAll(original);
    }
  });

  it("loads server state, mutates personal data/settings, preserves failures and restores/resets", async () => {
    const original = await api.load();
    expect(original.courses.length).toBeGreaterThan(0);
    expect((await api.connection()).message).toContain("fictional");
    expect((await api.setTrackedCourses(["c-csc"])).settings.trackedCourseIds).toEqual(["c-csc"]);
    const created = await api.addPersonalEvent({ title: "HTTP integration event", courseId: "c-csc", type: "other", date: { kind: "week", week: 8 } });
    const id = created.assessments.at(-1)!.id;
    const completed = await api.updateOverlay(id, { completed: true });
    expect(completed.overlays.find((o) => o.assessmentId === id)?.completed).toBe(true);
    expect((await new HttpAdapter(base).load()).assessments.some((a) => a.id === id)).toBe(true);
    await api.updateOverlay(id, { titleOverride: "Temporary", dateOverride: { kind: "week", week: 10 } });
    const retained = await api.updateOverlay(id, { hidden: true });
    expect(retained.overlays.find((o) => o.assessmentId === id)?.titleOverride).toBe("Temporary");
    const cleared = await api.updateOverlay(id, { titleOverride: undefined, dateOverride: undefined });
    expect(cleared.overlays.find((o) => o.assessmentId === id)).toEqual({ assessmentId: id, completed: true, hidden: true });
    expect(cleared.assessments.at(-1)?.sources).toEqual(created.assessments.at(-1)?.sources);
    await api.updateSettings({ semesterWeeks: 16 });
    const beforeFailure = await api.load();
    await expect(api.updateSettings({ semesterWeeks: 99 })).rejects.toThrow("Invalid request");
    expect(await api.load()).toEqual(beforeFailure);
    expect((await api.deletePersonalEvent(id)).assessments.some((a) => a.id === id)).toBe(false);
    expect(await api.replaceAll(original)).toEqual(original);
    const empty = await api.deleteLocalData();
    expect(empty.courses).toEqual([]);
    expect(empty.settings.trackedCourseIds).toEqual([]);
    expect(empty.settings.timezone).toBe(original.settings.timezone);
    expect((await api.resetDemo()).courses.length).toBeGreaterThan(0);
  });

  it("imports/reviews mocked candidates and preserves inline capability failures", async () => {
    const initial = await api.load();
    const unsupported = await api.importDocument("c-csc", "old.doc", () => {});
    expect(unsupported.result.ok).toBe(false);
    expect(unsupported.snapshot).toEqual(initial);
    const callbacks: unknown[] = [];
    const imported = await api.importDocument("c-csc", "new.pdf", (s) => callbacks.push(s));
    expect(imported.result.ok).toBe(true);
    expect(callbacks).toEqual([imported.snapshot]);
    const candidate = imported.snapshot.candidates.at(-1)!;
    const reviewed = await api.review(candidate.id, { kind: "correct", title: "Reviewed assignment", type: "assignment", date: { kind: "week", week: 9 } });
    expect(reviewed.candidates.at(-1)?.status).toBe("corrected");
    expect(reviewed.assessments.at(-1)?.title).toBe("Reviewed assignment");
    expect((await api.downloadMaterial("m1")).supported).toBe(false);
    expect((await api.aiAvailability()).available).toBe(false);
    const alerts = await api.saveAlerts([]);
    expect(alerts.alerts).toEqual([]);
    const syncCallbacks: unknown[] = [];
    const synced = await api.syncAll((s) => syncCallbacks.push(s));
    expect(syncCallbacks).toEqual([synced]);
    expect(synced.sync.find((c) => c.courseId === "c-phy")?.status).toBe("failed");
  });
});

it("selects and dismisses a collected suggestion through the real backend", async () => {
  const { Syllabus } = await import("@/routes/syllabus");
  const original = await api.load();
  const ref = { sourcePageUrl: "https://moodle.sdu.edu.kz/course/view.php?id=101", sourceUrl: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=201", observedAt: "2026-10-25T12:00:00Z", location: "course.material" as const };
  const obs = { ...ref, sourceCourseId: "101", sourceCourseModuleId: "201", sourceModuleType: "resource" as const, resourceKey: "stable-key", kind: "file" as const, title: { kind: "known" as const, value: "Syllabus" }, section: { kind: "unknown" as const }, fileType: { kind: "known" as const, value: "pdf" as const }, mimeType: { kind: "unknown" as const }, references: [ref] };
  const courseId = original.courses[1]!.id;
  await api.replaceAll({ ...original, collection: { records: [{ id: "stable-id", courseId, kind: "material", firstObservedAt: ref.observedAt, lastObservedAt: ref.observedAt, observations: [obs] }], reviews: [], refreshes: [] } });
  const calls: string[] = []; const underlying = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => { calls.push(`${init?.method ?? "GET"} ${String(input)}`); return underlying(input, init); });
  try {
    function Harness() { const { snap } = useApp(); return snap ? createElement(Syllabus) : createElement("p", null, "Loading"); }
    const view = render(createElement(AppProvider, { children: createElement(Harness) }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose local file for this course" }));
    expect(screen.getByLabelText("Course for import")).toHaveValue(courseId);
    expect(screen.getByText(/Selected resource: Syllabus/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => /documents\/import|pluginfile|materials\/.*download/.test(c))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await screen.findByRole("button", { name: "Restore" });
    view.unmount(); cleanup(); await stopServer(); await startServer();
    expect((await api.load()).dismissedSyllabusSuggestions).toEqual(["stable-id"]);
    const again = render(createElement(AppProvider, { children: createElement(Harness) }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByRole("button", { name: "Dismiss" });
    again.unmount(); cleanup();
  } finally { spy.mockRestore(); await api.replaceAll(original); }
});
