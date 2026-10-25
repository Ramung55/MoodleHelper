// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpAdapter } from "@/services/http-adapter";

let child: ChildProcess;
let api: HttpAdapter;
let base: string;

beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No local test port available");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const root = path.resolve(import.meta.dirname, "../../..");
  const python = process.platform === "win32" ? path.join(root, ".venv/Scripts/python.exe") : path.join(root, ".venv/bin/python");
  child = spawn(python, ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: "pipe" });
  let log = "";
  child.stdout?.on("data", (chunk) => { log += String(chunk); });
  child.stderr?.on("data", (chunk) => { log += String(chunk); });
  child.on("error", (error) => { log += error.message; });
  base = `http://127.0.0.1:${port}`;
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
}, 25_000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
  });
});

describe("actual FastAPI HTTP integration", () => {
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
