import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { BridgeClient } from "../frontend/src/services/extension-adapter";
import { JSDOM } from "../frontend/node_modules/jsdom/lib/api.js";
import { installPopup } from "../extension/src/popup";
import {
  createWorker,
  installRelay,
  BACKEND,
  type Sender,
} from "../extension/src/dashboard-bridge";
import {
  catalog,
  requestError,
  route,
  success,
  validReply,
  validResult,
  type Request,
} from "../shared/src/bridge";

// Explicit Chrome API/window SHIM: no installed Chrome or live Moodle is observed.
// Production client + relay + worker use real loopback FastAPI and isolated SQLite.
export class WindowShim {
  location = { origin: "http://127.0.0.1:5173" };
  top: any = this;
  listeners = new Set<(event: any) => void>();
  messages: any[] = [];
  addEventListener(_name: string, listener: any) {
    this.listeners.add(listener);
  }
  removeEventListener(_name: string, listener: any) {
    this.listeners.delete(listener);
  }
  postMessage(data: any, target: string) {
    if (target !== this.location.origin) throw Error("wrong target");
    this.messages.push(structuredClone(data));
    queueMicrotask(() => this.emit(data));
  }
  emit(data: any, origin = this.location.origin, source: any = this) {
    for (const listener of this.listeners) listener({ data, origin, source });
  }
}
const sender: Sender = {
  id: "extension-test",
  frameId: 0,
  tab: { id: 1 },
  documentId: "document-1",
  url: "http://127.0.0.1:5173/settings",
};
let child: ChildProcess, temporaryDirectory: string;
let isolatedBackend: string, isolatedPort: number;
let traffic: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  status: number;
}[] = [];
let worker: ReturnType<typeof createWorker>,
  win: WindowShim,
  client: BridgeClient;
let allowed = true;
let removeRelay: () => void;
const root = path.resolve(import.meta.dirname, "..");
const python = path.join(
  root,
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python",
);
async function stop() {
  if (child && child.exitCode === null)
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
    });
}
async function start(dataset = "demo") {
  const env = {
    ...process.env,
    MOODLE_HELPER_DATABASE_URL: `sqlite:///${path.join(temporaryDirectory, "bridge.sqlite3").replaceAll("\\", "/")}`,
    MOODLE_HELPER_DATASET: "demo",
    MOODLE_HELPER_BRIDGE_TEST_MODE: path.join(temporaryDirectory, "mode.txt"),
  };
  for (const k of [
    "MOODLE_HELPER_MOODLE_ORIGIN",
    "MOODLE_HELPER_PROFILE_LABEL",
    "MOODLE_HELPER_STABLE_USER_ID",
  ])
    delete env[k];
  if (dataset === "moodle")
    Object.assign(env, {
      MOODLE_HELPER_DATASET: "moodle",
      MOODLE_HELPER_MOODLE_ORIGIN: "https://moodle.sdu.edu.kz",
      MOODLE_HELPER_PROFILE_LABEL: "isolated-profile",
      MOODLE_HELPER_STABLE_USER_ID: "isolated-user",
    });
  child = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "tests.bridge_network_app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(isolatedPort),
    ],
    { cwd: root, env, windowsHide: true, stdio: "pipe" },
  );
  let logs = "";
  child.stderr?.on("data", (d) => (logs += d));
  child.on("error", (e) => (logs += e.message));
  for (let n = 0; n < 400; n++) {
    if (child.exitCode !== null)
      throw Error(`Isolated FastAPI could not start: ${logs}`);
    try {
      if ((await fetch(isolatedBackend + "/docs", {signal: AbortSignal.timeout(1000)})).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`No FastAPI: ${logs}`);
}
function setup() {
  worker = createWorker({
    runtimeId: "extension-test",
    grant: async () => allowed,
    fetcher: async (url, init) => {
      const response = await fetch(String(url).replace(BACKEND, isolatedBackend), init);
      traffic.push({
        url: String(url),
        method: init?.method || "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body as string | undefined,
        status: response.status,
      });
      return response;
    },
  });
  win = new WindowShim();
  removeRelay = installRelay(win as any, {
    id: "extension-test",
    onMessage: { addListener: () => {} },
    sendMessage: (r, cb) => void worker(r, sender).then(cb),
  });
  client = new BridgeClient(win as any);
}
beforeAll(async () => {
  // Keep the production target in the worker while routing test traffic to an
  // isolated ephemeral port, so a running developer backend is never touched.
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  isolatedPort = (listener.address() as {port: number}).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  isolatedBackend = `http://127.0.0.1:${isolatedPort}`;
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "moodle-bridge-"));
  await start();
  setup();
}, 30000);
afterAll(async () => {
  client?.dispose();
  removeRelay?.();
  await stop();
  if (temporaryDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("production bridge through labeled Chrome/window shim and real SQLite network", () => {
  it('coordinates simultaneous dashboard bridge and popup handler starts against SQLite', async () => {
    await client.connect();
    const dom=new JSDOM('<div id="status"></div><div id="freshness"></div><button id="start"></button><button id="cancel"></button><button id="reconnect"></button><button id="example-retry"></button>',{url:'https://extension.test'});
    const doc=dom.window.document;
    const popup=installPopup(doc, ((url:any,init:any)=>fetch(String(url).replace(BACKEND,isolatedBackend),init)) as typeof fetch,dom.window.localStorage);
    const waitFor=async (condition:()=>boolean)=>{for(let n=0;n<100;n++){if(condition()) return; await new Promise(resolve=>setTimeout(resolve,20));} throw Error('popup did not update');};
    try {
      await waitFor(()=>!(doc.getElementById('start') as HTMLButtonElement).disabled);
      const dashboard=client.startMockRun('simultaneous-dashboard');
      (doc.getElementById('start') as HTMLButtonElement).click();
      const run=await dashboard;
      await waitFor(()=>doc.getElementById('status')!.textContent!.includes('Mock run:'));
      const current=await client.currentMockRun();
      expect(current.run.id).toBe(run.id);
      expect(doc.getElementById('status')!.textContent).toContain('pending');
      (doc.getElementById('cancel') as HTMLButtonElement).click();
      await waitFor(()=>doc.getElementById('status')!.textContent!.includes('cancelled'));
      expect((await client.currentMockRun()).run.status).toBe('cancelled');
    } finally {popup.dispose();dom.window.close();}
  }, 30000);
  it("exercises every catalog operation through the real backend", async () => {
    expect((await client.connect()).moodleCollection).toBe("unavailable");
    expect((await client.connection()).state).toBe("demo");
    const original = await client.load();
    expect(original.courses.length).toBeGreaterThan(0);
    // Invalid identities reach the real service and fail closed; they must not
    // be rejected locally because the adapter used an unregistered operation.
    await expect(client.proposeReconciliation("missing-left", "missing-right")).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    await expect(client.decideReconciliation("missing", "fingerprint", "revision", "reject", {})).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    await expect(client.previewSyllabusRevision("missing", "missing")).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    await expect(client.confirmSyllabusRevision({sourceId:"missing",candidateId:"missing",revision:0,fingerprint:"missing"})).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    expect(traffic.some((t) => t.url.endsWith("/reconciliation/pairs") && t.status === 409)).toBe(true);
    expect(traffic.some((t) => t.url.endsWith("/reconciliation/decisions") && t.status === 409)).toBe(true);
    const discovered = await client.ingestCourseDiscovery([
      {
        sourceCourseId: "777",
        sourceUrl: "https://moodle.sdu.edu.kz/course/view.php?id=777",
        title: { kind: "known", value: "Bridge course" },
        termIndicators: { kind: "unknown" },
      },
    ]);
    const course = discovered.courses.find(
      (c) => c.discovery?.sourceCourseId === "777",
    )!;
    expect(course.name).toBe("Bridge course");
    expect(
      (await client.setTrackedCourses([course.id])).settings.trackedCourseIds,
    ).toEqual([course.id]);
    expect(
      (
        await client.updateOverlay("a1", {
          titleOverride: "Bridge override",
          completed: true,
        })
      ).overlays.find((o) => o.assessmentId === "a1")?.titleOverride,
    ).toBe("Bridge override");
    expect(
      (
        await client.updateOverlay("a1", {
          titleOverride: undefined,
          dateOverride: null,
          overrideBase: null,
        })
      ).overlays.find((o) => o.assessmentId === "a1")?.titleOverride,
    ).toBeUndefined();
    const created = await client.addPersonalEvent({
      courseId: course.id,
      title: "Bridge event",
      type: "other",
      date: { kind: "week", week: 2 },
    });
    const id = created.assessments.find((a) => a.title === "Bridge event")!.id;
    expect(
      (await client.deletePersonalEvent(id)).assessments.some(
        (a) => a.id === id,
      ),
    ).toBe(false);
    expect(
      (await client.updateSettings({ semesterWeeks: 19 })).settings
        .semesterWeeks,
    ).toBe(19);
    const imported = await client.importDocument("c-csc", "bridge.pdf", (s) =>
      expect(s.documents.at(-1)?.mocked).toBe(true),
    );
    expect(imported.result.ok).toBe(true);
    const candidate = imported.snapshot.candidates.at(-1)!;
    expect(
      (
        await client.review(candidate.id, {
          kind: "correct",
          title: "Bridge reviewed",
          type: "exam",
          date: { kind: "unknown" },
        })
      ).candidates.at(-1)?.status,
    ).toBe("corrected");
    expect((await client.downloadMaterial("m1")).supported).toBe(false);
    expect((await client.aiAvailability()).available).toBe(false);
    const plan = await client.reminderPlan();
    expect(plan.items.length).toBeLessThanOrEqual(100);
    expect(typeof plan.generation).toBe("string");
    const alerts = [
      {
        id: "bridge-alert",
        kind: "sync" as const,
        message: "Local test",
        deliveryKey: "bridge",
        createdAt: "2026-10-26",
        read: false,
      },
    ];
    expect((await client.saveAlerts(alerts)).alerts).toEqual(alerts);
    expect((await client.updateAlerts(["bridge-alert"], "read")).alerts).toEqual([{ ...alerts[0], read: true }]);
    const sync = await client.syncAll((s) =>
      expect(s.sync.length).toBeGreaterThan(0),
    );
    expect(sync.sync.every((c) => c.status !== "syncing")).toBe(true);
    const ref = { sourcePageUrl: "https://moodle.sdu.edu.kz/course/view.php?id=101", sourceUrl: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=201", observedAt: "2026-10-25T12:00:00Z", location: "course.material" as const };
    const observation = { ...ref, sourceCourseId: "101", sourceCourseModuleId: "201", sourceModuleType: "resource" as const, resourceKey: "bridge-resource", kind: "file" as const, title: { kind: "known" as const, value: "Syllabus" }, section: { kind: "unknown" as const }, fileType: { kind: "known" as const, value: "pdf" as const }, mimeType: { kind: "unknown" as const }, references: [ref] };
    await client.replaceAll({ ...original, collection: { records: [{ id: "bridge-record", courseId: original.courses[0]!.id, kind: "material", firstObservedAt: ref.observedAt, lastObservedAt: ref.observedAt, observations: [observation] }], reviews: [], refreshes: [] } });
    const beforeSuggestion = traffic.length;
    expect((await client.setSyllabusSuggestionDismissal("bridge-record", true)).dismissedSyllabusSuggestions).toEqual(["bridge-record"]);
    expect((await client.load()).dismissedSyllabusSuggestions).toEqual(["bridge-record"]);
    expect((await client.setSyllabusSuggestionDismissal("bridge-record", false)).dismissedSyllabusSuggestions).toEqual([]);
    await expect(client.setSyllabusSuggestionDismissal("missing", true)).rejects.toMatchObject({ code: "VALIDATION" });
    const suggestionTraffic = traffic.slice(beforeSuggestion);
    expect(suggestionTraffic.filter((entry) => entry.url.endsWith("/syllabus-suggestions/dismissal")).map((entry) => entry.status)).toEqual([200, 200, 422]);
    expect(suggestionTraffic.every((entry) => !/pluginfile|documents\/import|materials\/.*download/.test(entry.url))).toBe(true);
    expect(await client.replaceAll(original)).toEqual(original);
    expect((await client.deleteLocalData()).courses).toEqual([]);
    expect((await client.resetDemo()).courses.length).toBeGreaterThan(0);
    const current = await client.currentMockRun();
    expect(current.courseIds.length).toBeGreaterThan(0);
    const mock = await client.startMockRun('bridge-mock-test');
    expect((await client.currentMockRun()).run.id).toBe(mock.id);
    expect((await client.cancelMockRun(mock.id)).status).toBe('cancelled');
    const operations = win.messages
      .filter((m) => m.source === "moodle-helper-web")
      .map((m) => m.operation);
    expect(new Set(operations.filter((o) => o !== "hello"))).toEqual(
      new Set(Object.keys(catalog)),
    );
    for (const t of traffic) {
      expect(t.url.startsWith(BACKEND + "/api/")).toBe(true);
      expect(t.headers.cookie).toBeUndefined();
      expect(t.headers.authorization).toBeUndefined();
      if (!t.url.endsWith("bridge-context"))
        expect(t.headers["x-moodle-helper-bridge-binding"]).toMatch(
          /^[a-f0-9]{32}$/,
        );
    }
    for (const m of win.messages.filter(
      (m) => m.source === "moodle-helper-extension",
    )) {
      expect(JSON.stringify(m)).not.toMatch(
        /Set-Cookie|password-sentinel|token-sentinel|private-exception/,
      );
    }
  });
  it("rejects process restart before a mutation; explicit reconnect and legacy HTTP still work", async () => {
    const before = await client.load();
    await stop();
    await start();
    await expect(
      client.updateSettings({ semesterWeeks: 27 }),
    ).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
    expect(traffic.at(-1)?.status).toBe(409);
    const direct = await (await fetch(isolatedBackend + "/api/snapshot")).json();
    expect(direct).toEqual(before);
    await client.connect();
    expect(await client.load()).toEqual(before);
    const legacy = await fetch(isolatedBackend + "/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ semesterWeeks: 18 }),
    });
    expect(legacy.ok).toBe(true);
    expect((await client.load()).settings.semesterWeeks).toBe(18);
  }, 30000);
  it("revoked grant rejects without fetch; reload loses sessions and never replays a mutation", async () => {
    const count = traffic.length;
    allowed = false;
    await expect(client.load()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(traffic).toHaveLength(count);
    allowed = true;
    await client.connect();
    const old = win.messages.findLast((m) => m.operation === "hello");
    const session = win.messages.findLast((m) => m.ok && m.result?.sessionId)
      .result.sessionId;
    const replacement = createWorker({
      runtimeId: "extension-test",
      grant: async () => true,
    });
    const reply = await replacement(
      {
        ...old,
        operation: "deleteLocalData",
        requestId: "reload-write",
        sessionId: session,
        payload: {},
      },
      sender,
    );
    expect(reply?.error?.code).toBe("RECONNECT_REQUIRED");
  });
  it("inspects hostile real HTTP responses: no redirect follow, raw HTML, private errors or headers reach page", async () => {
    for (const [mode, code] of [
      ["redirect", "BACKEND_UNAVAILABLE"],
      ["html", "INVALID_RESPONSE"],
      ["private-error", "BACKEND_UNAVAILABLE"],
      ["extra", "INVALID_RESPONSE"],
    ]) {
      await writeFile(path.join(temporaryDirectory, "mode.txt"), mode!);
      await expect(client.load()).rejects.toMatchObject({ code });
      const reply = win.messages.findLast(
        (m) => m.source === "moodle-helper-extension",
      );
      expect(JSON.stringify(reply)).not.toMatch(
        /sentinel|private-exception|<html>|headers|cookie/i,
      );
    }
    await writeFile(path.join(temporaryDirectory, "mode.txt"), "");
    await expect(
      access(path.join(temporaryDirectory, "mode.followed")),
    ).rejects.toThrow();
    expect((await client.load()).courses.length).toBeGreaterThan(0);
    // Source-shaped but semantically invalid discovery gets a real backend 422;
    // its private/validation body is replaced with a fixed public error.
    await expect(
      client.ingestCourseDiscovery([
        {
          sourceCourseId: "1",
          sourceUrl: "https://evil.test",
          title: { kind: "unknown" },
          termIndicators: { kind: "unknown" },
        },
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(traffic.at(-1)?.status).toBe(422);
    const beforeIds = await client.load();
    for (const id of [
      "opaque/slash?query=yes#fragment",
      "%2e%2e",
      "http://evil.test/path",
    ]) {
      expect(await client.deletePersonalEvent(id)).toEqual(beforeIds);
      expect(traffic.at(-1)?.url).toBe(
        BACKEND + "/api/personal-events/" + encodeURIComponent(id),
      );
    }
    const beforeRejected = traffic.length;
    await expect(client.deletePersonalEvent("..")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(traffic).toHaveLength(beforeRejected);
  });
  it("binds the configured non-demo partition without browser identity or caller selection", async () => {
    await stop();
    await start("moodle");
    await expect(client.deleteLocalData()).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
    });
    const hello = await client.connect();
    expect(JSON.stringify(hello)).not.toMatch(
      /isolated-profile|isolated-user|sqlite|namespace/,
    );
    expect((await client.load()).courses).toEqual([]);
    const snap = await client.ingestCourseDiscovery([
      {
        sourceCourseId: "9001",
        sourceUrl: "https://moodle.sdu.edu.kz/course/view.php?id=9001",
        title: { kind: "known", value: "Configured partition course" },
        termIndicators: { kind: "unknown" },
      },
    ]);
    expect(snap.courses).toHaveLength(1);
    expect(snap.settings.trackedCourseIds).toEqual([]);
    await client.setTrackedCourses([snap.courses[0]!.id]);
    const beforeSync = await client.load();
    let callbacks = 0;
    await expect(client.syncAll(() => callbacks++)).rejects.toMatchObject({
      code: 'SYNC_UNAVAILABLE', message: 'Live course sync is unavailable until Moodle access is verified.',
    });
    expect(callbacks).toBe(0);
    expect(await client.load()).toEqual(beforeSync);
    await client.updateSettings({ semesterWeeks: 22 });
    await stop();
    await start("moodle");
    await expect(client.load()).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
    });
    await client.connect();
    expect((await client.load()).settings.semesterWeeks).toBe(22);
    await stop();
    await start();
    await client.connect();
    expect((await client.load()).settings.semesterWeeks).toBe(18);
  }, 30000);
});
