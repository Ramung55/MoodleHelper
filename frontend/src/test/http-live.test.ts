// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpAdapter } from "@/services/http-adapter";

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
