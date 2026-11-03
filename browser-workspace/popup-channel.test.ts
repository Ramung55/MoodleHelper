// #86: the popup-only worker channel (D2, AC8) and the Open dashboard build target (D3, AC4).
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { installWorker, type Sender } from "../extension/src/dashboard-bridge";
import { dashboardUrl, PAGES_DASHBOARD } from "../extension/build";
import { errors, SIGN_IN_PROBE } from "../shared/src/bridge";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const POPUP = `chrome-extension://${ID}/popup.html`;
const BINDING = "b".repeat(32);
const snapshot = {
  courses: [], assessments: [], overlays: [], materials: [], documents: [], candidates: [], sync: [], changes: [], alerts: [],
  settings: {
    trackedCourseIds: [], semesterStart: "2026-10-26", semesterWeeks: 16, timezone: "UTC",
    weights: { exam: 3, assignment: 2, quiz: 1, other: 1 }, thresholds: { maxOutstanding: 3, maxWeighted: 6 },
    reminders: { enabled: false, hoursBefore: 24, busyWeek: false }, ai: { enabled: false, consentGiven: false },
  },
};

function harness(sync: () => Response = () => new Response(JSON.stringify(snapshot), { status: 200 })) {
  let listener: any;
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; calls.push({ path, init });
    if (path === "/api/bridge-context") return new Response(JSON.stringify({ version: "1", binding: BINDING }), { status: 200 });
    if (path === "/api/sync") return sync();
    return new Response("{}", { status: 404 });
  });
  const onSyncStarted = vi.fn();
  const checkMoodleSignIn = vi.fn(async () => ({ signal: { state: "signed_in" as const, ...SIGN_IN_PROBE }, checkedAt: "2028-03-05T10:00:00Z" }));
  installWorker({
    runtime: { id: ID, getURL: (p: string) => `chrome-extension://${ID}/${p}`, onMessage: { addListener: (f: any) => { listener = f; } } },
    permissions: { contains: (_p, cb) => cb(true) },
  }, { fetcher: fetcher as unknown as typeof fetch, onSyncStarted, checkMoodleSignIn });
  async function send(message: unknown, sender: Sender) {
    const replies: unknown[] = [];
    const async = listener(message, sender, (reply: unknown) => replies.push(reply));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { async, replies };
  }
  return { send, calls, onSyncStarted, checkMoodleSignIn };
}
const popupSender: Sender = { id: ID, url: POPUP, origin: `chrome-extension://${ID}` };

describe("#86 popup worker channel", () => {
  it("accepts this extension's popup: one POST /api/sync with the binding and one onSyncStarted", async () => {
    const h = harness();
    const { async, replies } = await h.send({ source: "moodle-helper-popup", operation: "syncAll" }, popupSender);
    expect(async).toBe(true);
    expect(h.calls.map((c) => `${c.init?.method ?? "GET"} ${c.path}`)).toEqual(["GET /api/bridge-context", "POST /api/sync"]);
    expect((h.calls[1]!.init!.headers as Record<string, string>)["X-Moodle-Helper-Bridge-Binding"]).toBe(BINDING);
    expect(h.calls[1]!.init!.credentials).toBe("omit");
    expect(h.onSyncStarted).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true });
  });

  it("maps the fixed 409 and 503 like the dashboard and does not wake the scan worker", async () => {
    for (const [body, status, code] of [
      [{ message: errors.SYNC_ALREADY_RUNNING }, 409, "SYNC_ALREADY_RUNNING"],
      [{ message: errors.SYNC_NO_COURSES }, 409, "SYNC_NO_COURSES"],
      [{ message: "Backend context changed. Reconnect." }, 409, "RECONNECT_REQUIRED"],
      [{ message: errors.SYNC_UNAVAILABLE }, 503, "SYNC_UNAVAILABLE"],
    ] as const) {
      const h = harness(() => new Response(JSON.stringify(body), { status }));
      const { replies } = await h.send({ source: "moodle-helper-popup", operation: "syncAll" }, popupSender);
      expect(replies).toEqual([{ ok: false, error: { code, message: errors[code] } }]);
      expect(h.onSyncStarted).not.toHaveBeenCalled();
    }
  });

  it("runs the #46 probe for checkMoodleSignIn without a backend sync", async () => {
    const h = harness();
    const { replies } = await h.send({ source: "moodle-helper-popup", operation: "checkMoodleSignIn" }, { id: ID, url: POPUP + "#x" });
    expect(h.checkMoodleSignIn).toHaveBeenCalledTimes(1);
    expect(replies).toEqual([{ ok: true, result: { signal: { state: "signed_in", ...SIGN_IN_PROBE }, checkedAt: "2028-03-05T10:00:00Z" } }]);
    expect(h.calls.some((c) => c.path === "/api/sync")).toBe(false);
  });

  it("AC8: tabs, content scripts, dashboard pages, other extensions, other pages and other operations get no reply and cause no fetch", async () => {
    const message = { source: "moodle-helper-popup", operation: "syncAll" };
    const rejected: [unknown, Sender][] = [
      [message, { ...popupSender, tab: { id: 3, url: POPUP } }],
      [message, { id: ID, url: "https://moodle.sdu.edu.kz/my/", frameId: 0, tab: { id: 4 } }],
      [message, { id: ID, url: "https://ramung55.github.io/MoodleHelper/", origin: "https://ramung55.github.io", frameId: 0, documentId: "d", tab: { id: 5 } }],
      [message, { id: "other-extension", url: `chrome-extension://other-extension/popup.html` }],
      [message, { id: ID, url: `chrome-extension://${ID}/transfer.html` }],
      [message, { id: ID, url: `chrome-extension://${ID}/popup.html.evil` }],
      [message, { id: ID, url: POPUP, origin: "https://ramung55.github.io" }],
      [message, { id: ID }],
      [{ source: "moodle-helper-popup", operation: "discoverCourses" }, popupSender],
      [{ source: "moodle-helper-popup", operation: "syncAll", extra: 1 }, popupSender],
      [{ source: "moodle-helper-web", operation: "syncAll" }, popupSender],
      [null, popupSender],
    ];
    for (const [m, sender] of rejected) {
      const h = harness();
      // A dashboard tab still reaches the unchanged dashboard channel, which drops this message.
      const { replies } = await h.send(m, sender);
      expect(replies, JSON.stringify(sender)).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.onSyncStarted).not.toHaveBeenCalled();
      expect(h.checkMoodleSignIn).not.toHaveBeenCalled();
    }
  });
});

describe("#86 Open dashboard build target", () => {
  it("defaults to Pages and accepts only the approved local dev URLs", () => {
    expect(dashboardUrl(undefined)).toBe("https://ramung55.github.io/MoodleHelper/");
    expect(dashboardUrl("")).toBe(PAGES_DASHBOARD);
    expect(dashboardUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    expect(dashboardUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    for (const bad of ["https://evil.example/", "http://127.0.0.1:5173", "http://127.0.0.1:5174/", "https://ramung55.github.io/", "javascript:alert(1)"])
      expect(() => dashboardUrl(bad)).toThrow(/MOODLE_HELPER_DASHBOARD_URL/);
  });

  it("an unapproved value fails the build before dist is touched", async () => {
    const dist = fileURLToPath(new URL("../extension/dist/popup.js", import.meta.url));
    const before = await stat(dist).then((s) => s.mtimeMs, () => undefined);
    const result = spawnSync("bun", [fileURLToPath(new URL("../extension/build.ts", import.meta.url))], {
      env: { ...process.env, MOODLE_HELPER_DASHBOARD_URL: "https://evil.example/" }, encoding: "utf8", timeout: 60000,
    });
    expect(result.status).not.toBe(0);
    expect(await stat(dist).then((s) => s.mtimeMs, () => undefined)).toBe(before);
  });

  it("the default build ships the Pages dashboard URL in the popup", async () => {
    const popup = await readFile(new URL("../extension/dist/popup.js", import.meta.url), "utf8");
    expect(popup).toContain("https://ramung55.github.io/MoodleHelper/");
    expect(popup).not.toContain("127.0.0.1:5173");
  });
});
