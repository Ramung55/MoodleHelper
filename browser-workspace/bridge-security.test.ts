import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  createWorker,
  installRelay,
  installWorker,
  trustedSender,
  type Sender,
} from "../extension/src/dashboard-bridge";
import { BridgeClient } from "../frontend/src/services/extension-adapter";
import {
  catalog,
  errors,
  requestError,
  route,
  success,
  validReply,
  validResult,
  type Request,
} from "../shared/src/bridge";

// Explicit browser API/window test shim, not installed-Chrome evidence.
class WindowShim {
  location = { origin: "http://localhost:5173" };
  top: any = this;
  listeners = new Set<any>();
  messages: any[] = [];
  addEventListener(_n: string, f: any) {
    this.listeners.add(f);
  }
  removeEventListener(_n: string, f: any) {
    this.listeners.delete(f);
  }
  emit(data: any, origin = this.location.origin, source: any = this) {
    for (const f of this.listeners) f({ data, origin, source });
  }
  postMessage(data: any, _target: string) {
    this.messages.push(structuredClone(data));
    queueMicrotask(() => this.emit(data));
  }
}
const sender: Sender = {
  id: "extension",
  frameId: 0,
  tab: { id: 3 },
  url: "http://localhost:5173/",
  documentId: "doc-1",
};
const hello = (requestId = "hello"): Request => ({
  source: "moodle-helper-web",
  type: "request",
  version: "1",
  clientId: "client",
  requestId,
  operation: "hello",
  payload: {},
});
const request = (
  sessionId: string,
  operation: any = "load",
  payload: any = {},
  requestId = "request",
): Request => ({ ...hello(requestId), sessionId, operation, payload });
const connection = {
  state: "demo",
  message: "Local",
  extensionDetected: false,
};
const snapshot = {
  courses: [],
  assessments: [],
  overlays: [],
  materials: [],
  documents: [],
  candidates: [],
  sync: [],
  changes: [],
  alerts: [],
  settings: {
    trackedCourseIds: [],
    semesterStart: "2026-10-26",
    semesterWeeks: 16,
    timezone: "UTC",
    weights: { exam: 3, assignment: 2, quiz: 1, other: 1 },
    thresholds: { maxOutstanding: 3, maxWeighted: 6 },
    reminders: { enabled: false, hoursBefore: 24, busyWeek: false },
    ai: { enabled: false, consentGiven: false },
  },
};
function harness(fetcher?: any, now?: () => number) {
  const fetch = vi.fn(
    fetcher ||
      (async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("bridge-context")
              ? { version: "1", binding: "a".repeat(32) }
              : snapshot,
          ),
          {
            headers: {
              "Set-Cookie": "cookie-sentinel",
              "X-Private": "token-sentinel",
            },
          },
        )),
  );
  const grant = vi.fn(async () => true);
  const handler = createWorker({
    runtimeId: "extension",
    grant,
    fetcher: fetch,
    now,
  });
  return {
    handler,
    fetch,
    grant,
    connect: async () => {
      const r = await handler(hello(), sender);
      expect(r?.ok).toBe(true);
      return r!.result.sessionId as string;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("closed bridge trust and schemas", () => {
  it.each([
    { id: "other" },
    { frameId: 1 },
    { tab: undefined },
    { tab: { id: -1 } },
    { tab: { id: 1.5 } },
    { url: undefined },
    { url: "data:text/html,x" },
    { url: "https://localhost:5173/" },
    { url: "http://localhost:8080/" },
    { url: "http://user:pass@localhost:5173/" },
    { url: "http://evil.test/" },
    { origin: "null" },
    { origin: "http://127.0.0.1:5173" },
    { tab: { id: 3, url: "http://127.0.0.1:5173/" } },
  ])("ignores untrusted browser sender %j without fetch", async (change) => {
    const h = harness();
    expect(await h.handler(hello(), { ...sender, ...change })).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("accepts absent tab.url/origin and consistent supplied values; document metadata fails closed", async () => {
    expect(trustedSender(sender, "extension")).toBe(true);
    expect(
      trustedSender(
        {
          ...sender,
          origin: "http://localhost:5173",
          tab: { id: 3, url: "http://localhost:5173/settings" },
        },
        "extension",
      ),
    ).toBe(true);
    const h = harness();
    expect(
      (await h.handler(hello(), { ...sender, documentId: undefined }))?.error
        ?.code,
    ).toBe("RECONNECT_REQUIRED");
    expect(h.fetch).not.toHaveBeenCalled();
    const session = await h.connect();
    const calls = h.fetch.mock.calls.length;
    expect(
      (
        await h.handler(request(session), {
          ...sender,
          documentId: "replacement",
        })
      )?.error?.code,
    ).toBe("RECONNECT_REQUIRED");
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(
      (await h.handler(request(session), { ...sender, tab: { id: 4 } }))?.error
        ?.code,
    ).toBe("RECONNECT_REQUIRED");
  });
  it.each([
    { version: "2" },
    { operation: "fetch" },
    { operation: { toString: "bad" } },
    { url: "https://moodle.sdu.edu.kz" },
    { headers: { Cookie: "cookie-sentinel" } },
    { namespace: ["other"] },
    { payload: { url: "https://evil.test" } },
  ])("rejects envelope injection %j before fetch", async (change) => {
    const h = harness();
    const session = await h.connect();
    const n = h.fetch.mock.calls.length;
    const r = await h.handler({ ...request(session), ...change }, sender);
    expect(r?.ok).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(n);
  });
  it("rejects nested extras, wrong unions, dates, ranges and DTO response additions", async () => {
    const h = harness();
    const session = await h.connect();
    for (const payload of [
      {
        ...snapshot,
        settings: {
          ...snapshot.settings,
          ai: { ...snapshot.settings.ai, password: "password-sentinel" },
        },
      },
      { ...snapshot, settings: { ...snapshot.settings, semesterWeeks: 31 } },
    ])
      expect(
        (await h.handler(request(session, "replaceAll", payload), sender))
          ?.error?.code,
      ).toBe("VALIDATION");
    expect(
      requestError(
        request(session, "updateOverlay", {
          id: "a",
          body: { dateOverride: { kind: "unknown", iso: "private" } },
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      requestError(
        request(session, "updateOverlay", {
          id: "a",
          body: { titleOverride: null, dateOverride: null, overrideBase: null },
        }),
      ),
    ).toBeNull();
    expect(
      requestError(
        request(session, "review", {
          id: "k",
          body: { kind: "confirm", title: "extra" },
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      requestError(
        request(session, "ingestCourseDiscovery", {
          observations: [
            {
              sourceCourseId: "1",
              sourceUrl: "x",
              title: { kind: "unknown", value: "extra" },
              termIndicators: { kind: "unknown" },
            },
          ],
        }),
      ),
    ).toBe("VALIDATION");
    expect(validResult("load", snapshot)).toBe(true);
    expect(
      validResult("load", {
        ...snapshot,
        headers: { cookie: "cookie-sentinel" },
      }),
    ).toBe(false);
    expect(
      validResult("connection", { ...connection, token: "token-sentinel" }),
    ).toBe(false);
    for (const bad of [
      { kind: "week", week: 0 },
      { kind: "exact", iso: "x", tz: "UTC", html: "raw" },
    ])
      expect(
        requestError(
          request(session, "addPersonalEvent", {
            courseId: "c",
            title: "t",
            type: "other",
            date: bad,
          }),
        ),
      ).toBe("VALIDATION");
  });
  it("uses fixed methods/paths and encodes opaque selectors; dots cannot normalize a target", () => {
    for (const id of [".", ".."])
      expect(
        requestError(request("session", "deletePersonalEvent", { id })),
      ).toBe("VALIDATION");
    for (const id of ["a/b?x=y#z", "%2e%2e", "https://evil.test/a"]) {
      const r = request("session", "updateOverlay", {
        id,
        body: { completed: true },
      });
      expect(requestError(r)).toBeNull();
      expect(route(r)).toEqual({
        method: "PATCH",
        path: `/api/assessments/${encodeURIComponent(id)}/overlay`,
        body: { completed: true },
      });
    }
  });
  it("rejects oversize before fetch and private success/error bodies never cross", async () => {
    const h = harness();
    const session = await h.connect();
    const count = h.fetch.mock.calls.length;
    expect(
      (
        await h.handler(
          request(session, "updateSettings", {
            timezone: "x".repeat(1024 * 1024),
          }),
          sender,
        )
      )?.error?.code,
    ).toBe("TOO_LARGE");
    expect(h.fetch).toHaveBeenCalledTimes(count);
    for (const response of [
      () => new Response("<html>cookie-sentinel</html>"),
      () =>
        new Response(
          JSON.stringify({
            ...snapshot,
            headers: { Cookie: "cookie-sentinel" },
          }),
        ),
      () => new Response("private-exception-token-sentinel", { status: 500 }),
      () => {
        throw Error("private-exception-password-sentinel");
      },
    ]) {
      const bad = harness(async (url: string) =>
        url.endsWith("bridge-context")
          ? new Response(
              JSON.stringify({ version: "1", binding: "a".repeat(32) }),
            )
          : response(),
      );
      const s = await bad.connect();
      const result = await bad.handler(request(s), sender);
      expect(result?.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(
        /sentinel|private-exception|<html>|Cookie/,
      );
    }
  });
  it("only maps the exact safe sync 503 envelope to fixed unavailable guidance", async () => {
    for (const [payload, expected] of [
      [{message: errors.SYNC_UNAVAILABLE}, 'SYNC_UNAVAILABLE'],
      [{message: 'private-exception-token-sentinel'}, 'BACKEND_UNAVAILABLE'],
      [{message: errors.SYNC_UNAVAILABLE, extra: 'private-exception-token-sentinel'}, 'BACKEND_UNAVAILABLE'],
    ] as const) {
      const h = harness(async (url:string) => url.endsWith('bridge-context')
        ? new Response(JSON.stringify({version:'1',binding:'a'.repeat(32)}))
        : new Response(JSON.stringify(payload), {status:503}));
      const session = await h.connect();
      const reply = await h.handler(request(session, 'syncAll'), sender);
      expect(reply?.error?.code).toBe(expected);
      expect(JSON.stringify(reply)).not.toContain('private-exception-token-sentinel');
    }
  });
  it("requests redirect:error, credentials:omit, and maps redirect failures to fixed error", async () => {
    const h = harness(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      if (!url.endsWith("bridge-context"))
        throw TypeError("redirect private-exception");
      return new Response(
        JSON.stringify({ version: "1", binding: "a".repeat(32) }),
      );
    });
    const s = await h.connect();
    expect((await h.handler(request(s), sender))?.error).toEqual({
      code: "BACKEND_UNAVAILABLE",
      message: errors.BACKEND_UNAVAILABLE,
    });
  });
});

describe("dedup and lifecycle", () => {
  it("enforces 32 in-flight requests per page even when a page bypasses the client", async () => {
    const releases: ((r: Response) => void)[] = [];
    const h = harness(async (url: string) =>
      url.endsWith("bridge-context")
        ? new Response(
            JSON.stringify({ version: "1", binding: "a".repeat(32) }),
          )
        : new Promise<Response>((resolve) => releases.push(resolve)),
    );
    const s = await h.connect();
    const jobs = Array.from({ length: 32 }, (_, n) =>
      h.handler(request(s, "load", {}, `pending-${n}`), sender),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      (await h.handler(request(s, "load", {}, "overflow"), sender))?.error
        ?.code,
    ).toBe("BUSY");
    expect(releases).toHaveLength(32);
    for (const resolve of releases)
      resolve(new Response(JSON.stringify(snapshot)));
    await Promise.all(jobs);
  });
  it("deduplicates in-flight and final writes; normalized payload and conflict are explicit", async () => {
    let release: (r: Response) => void = () => {};
    let time = 0;
    const h = harness(
      async (url: string) =>
        url.endsWith("bridge-context")
          ? new Response(
              JSON.stringify({ version: "1", binding: "a".repeat(32) }),
            )
          : new Promise<Response>((resolve) => (release = resolve)),
      () => time,
    );
    const s = await h.connect();
    const r = request(s, "updateSettings", {
      semesterWeeks: 17,
      timezone: "UTC",
    });
    const a = h.handler(r, sender);
    await Promise.resolve();
    await Promise.resolve();
    const b = h.handler(
      { ...r, payload: { timezone: "UTC", semesterWeeks: 17 } },
      sender,
    );
    await Promise.resolve();
    time = 61000;
    expect(
      (await h.handler({ ...r, payload: { semesterWeeks: 18 } }, sender))?.error
        ?.code,
    ).toBe("DUPLICATE_CONFLICT");
    expect(h.fetch).toHaveBeenCalledTimes(2);
    release(new Response(JSON.stringify(snapshot)));
    expect(await a).toEqual(await b);
    expect(await h.handler(r, sender)).toEqual(await a);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it("retains active writes at capacity, expires only settled entries and separates documents", async () => {
    let time = 0;
    const h = harness(undefined, () => time);
    let s = await h.connect();
    for (let n = 0; n < 127; n++)
      expect(
        (await h.handler(request(s, "load", {}, `r-${n}`), sender))?.ok,
      ).toBe(true);
    expect(
      (await h.handler(request(s, "load", {}, "overflow"), sender))?.error
        ?.code,
    ).toBe("BUSY");
    time = 60001;
    s = await h.connect();
    expect((await h.handler(request(s, "load", {}, "new"), sender))?.ok).toBe(
      true,
    );
    expect(
      (
        await h.handler(request(s, "load", {}, "new"), {
          ...sender,
          documentId: "new-doc",
        })
      )?.error?.code,
    ).toBe("RECONNECT_REQUIRED");
  });
  it("denied/revoked grants cause no fetch even for cached results", async () => {
    const h = harness();
    const s = await h.connect();
    await h.handler(request(s), sender);
    const count = h.fetch.mock.calls.length;
    h.grant.mockResolvedValue(false);
    expect((await h.handler(request(s), sender))?.error?.code).toBe(
      "PERMISSION_DENIED",
    );
    expect(h.fetch).toHaveBeenCalledTimes(count);
  });
  it("reclaims abandoned document/client idle leases without evicting active writes", async () => {
    let time = 0;
    let release: (r: Response) => void = () => {};
    const h = harness(
      async (url: string) =>
        url.endsWith("bridge-context")
          ? new Response(
              JSON.stringify({ version: "1", binding: "a".repeat(32) }),
            )
          : new Promise<Response>((resolve) => (release = resolve)),
      () => time,
    );
    const active = await h.connect();
    const write = h.handler(request(active, "deleteLocalData"), sender);
    await Promise.resolve();
    await Promise.resolve();
    // Settings checks/dispose and navigation both abandon sessions. Fresh IDs
    // cannot consume memory forever; active writes retain their lease and dedup.
    for (let n = 0; n < 126; n++)
      expect(
        (
          await h.handler(
            { ...hello(`hello-${n}`), clientId: `client-${n}` },
            { ...sender, documentId: `doc-${n}` },
          )
        )?.ok,
      ).toBe(true);
    expect(
      (await h.handler({ ...hello("full"), clientId: "new-client" }, sender))
        ?.error?.code,
    ).toBe("BUSY");
    time = 60001;
    expect(
      (await h.handler({ ...hello("fresh"), clientId: "new-client" }, sender))
        ?.ok,
    ).toBe(true);
    const duplicate = h.handler(request(active, "deleteLocalData"), sender);
    await Promise.resolve();
    expect(
      h.fetch.mock.calls.filter(
        ([url]) => !String(url).endsWith("bridge-context"),
      ),
    ).toHaveLength(1);
    release(new Response(JSON.stringify(snapshot)));
    expect(await duplicate).toEqual(await write);
    time = 120002;
    expect(
      (await h.handler(request(active, "load", {}, "stale-session"), sender))
        ?.error?.code,
    ).toBe("RECONNECT_REQUIRED");
    expect(
      (await h.handler({ ...hello("later"), clientId: "later-client" }, sender))
        ?.ok,
    ).toBe(true);
  });
  it("backend deadlines abort and do not expose exceptions", async () => {
    vi.useFakeTimers();
    const h = harness(async (url: string, init: RequestInit) =>
      url.endsWith("bridge-context")
        ? new Response(
            JSON.stringify({ version: "1", binding: "a".repeat(32) }),
          )
        : new Promise((_r, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(Error("private-exception")),
            ),
          ),
    );
    const s = await h.connect();
    const pending = h.handler(request(s), sender);
    await vi.advanceTimersByTimeAsync(10001);
    expect((await pending)?.error).toEqual({
      code: "TIMEOUT",
      message: errors.TIMEOUT,
    });
  });
});

describe("relay and page correlation through labeled window shim", () => {
  it("ignores foreign windows/origins/top frames; no external listener is registered", async () => {
    const win = new WindowShim();
    const sendMessage = vi.fn();
    const runtime = {
      id: "extension",
      onMessage: { addListener: vi.fn() },
      sendMessage,
    };
    const remove = installRelay(win as any, runtime);
    win.emit(hello(), "http://evil.test");
    win.emit(hello(), win.location.origin, {});
    expect(sendMessage).not.toHaveBeenCalled();
    win.top = {};
    const other = new WindowShim();
    other.top = {};
    installRelay(other as any, runtime);
    other.emit(hello());
    expect(sendMessage).not.toHaveBeenCalled();
    remove();
    const listener = vi.fn();
    installWorker({
      runtime: { id: "extension", onMessage: { addListener: listener } },
      permissions: { contains: (_p, cb) => cb(false) },
    });
    expect(listener).toHaveBeenCalledOnce();
    const callback = vi.fn();
    expect(listener.mock.calls[0][0](hello(), sender, callback)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
  });
  it("missing extension, 32 pending bound, timeout and late reply handling preserve explicit outcomes", async () => {
    vi.useFakeTimers();
    const win = new WindowShim();
    const client = new BridgeClient(win as any);
    const missing = client.connect();
    const missingCheck = expect(missing).rejects.toMatchObject({
      code: "MISSING_EXTENSION",
    });
    await vi.advanceTimersByTimeAsync(801);
    await missingCheck;
    const connecting = client.connect();
    const helloRequest = win.messages.at(-1);
    win.emit(
      success(helloRequest, {
        version: "1",
        workerGeneration: "generation",
        sessionId: "session",
        backend: "ready",
        localRepository: "ready",
        moodleCollection: "unavailable",
      }),
    );
    await connecting;
    const jobs = Array.from({ length: 32 }, () => client.load());
    const checks = jobs.map((job) => expect(job).rejects.toBeInstanceOf(Error));
    await expect(client.load()).rejects.toMatchObject({ code: "BUSY" });
    const old = win.messages.at(-1);
    win.emit({ ...success(old, snapshot), requestId: "unsolicited" });
    win.emit({ ...success(old, snapshot), clientId: "other" });
    expect((client as any).pending.size).toBe(32);
    await vi.advanceTimersByTimeAsync(10001);
    await Promise.all(checks);
    expect((client as any).pending.size).toBe(0);
    win.emit(success(old, snapshot));
    await expect(client.load()).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
    });
    client.dispose();
    expect(win.listeners.size).toBe(0);
  });
  it("matching malformed responses fail closed; reconnect invalidates pending writes", async () => {
    const win = new WindowShim();
    const client = new BridgeClient(win as any);
    const connect = client.connect();
    win.emit(
      success(win.messages.at(-1), {
        version: "1",
        workerGeneration: "generation",
        sessionId: "session",
        backend: "ready",
        localRepository: "ready",
        moodleCollection: "unavailable",
      }),
    );
    await connect;
    const load = client.load();
    const loadCheck = expect(load).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    win.emit(
      success(win.messages.at(-1), { ...snapshot, token: "token-sentinel" }),
    );
    await loadCheck;
    const write = client.deleteLocalData();
    const writeCheck = expect(write).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
    });
    const reconnect = client.connect();
    win.emit(
      success(win.messages.at(-1), {
        version: "1",
        workerGeneration: "new",
        sessionId: "new-session",
        backend: "ready",
        localRepository: "ready",
        moodleCollection: "unavailable",
      }),
    );
    await reconnect;
    await writeCheck;
    client.dispose();
  });
  it("relay maps runtime reload/private errors to public fixed reconnect guidance", async () => {
    const win = new WindowShim();
    const runtime: any = {
      id: "extension",
      onMessage: { addListener: () => {} },
      lastError: { message: "private-exception-password-sentinel" },
      sendMessage: (_r: any, cb: any) => cb(null),
    };
    const remove = installRelay(win as any, runtime);
    win.emit(hello());
    await Promise.resolve();
    const reply = win.messages.at(-1);
    expect(reply.error).toEqual({
      code: "RECONNECT_REQUIRED",
      message: errors.RECONNECT_REQUIRED,
    });
    remove();
  });
});
