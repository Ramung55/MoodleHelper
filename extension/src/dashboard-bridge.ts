import {
  approved,
  closed,
  fits,
  idValid,
  normalized,
  rejection,
  requestError,
  route,
  success,
  validReply,
  validResult,
  type Request,
  type Reply,
} from "../../shared/src/bridge";

export const BACKEND = "http://127.0.0.1:8000";
export type Sender = {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  documentId?: string;
  tab?: { id?: number; url?: string };
};
export type Runtime = {
  id: string;
  lastError?: unknown;
  onMessage: {
    addListener: (
      f: (
        message: any,
        sender: Sender,
        reply: (r: Reply) => void,
      ) => boolean | undefined,
    ) => void;
  };
  sendMessage?: (message: unknown, callback: (r: unknown) => void) => void;
};
function origin(url: unknown): string | null {
  try {
    const u = new URL(String(url));
    return u.protocol === "http:" &&
      !u.username &&
      !u.password &&
      approved(u.origin)
      ? u.origin
      : null;
  } catch {
    return null;
  }
}
export function trustedSender(sender: Sender, runtimeId: string): boolean {
  const o = origin(sender.url);
  return (
    sender.id === runtimeId &&
    sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) &&
    sender.tab!.id! >= 0 &&
    !!o &&
    (sender.origin === undefined || sender.origin === o) &&
    (sender.tab?.url === undefined || origin(sender.tab.url) === o)
  );
}
/** Internal worker only. No external listener, cookies, Moodle fetch or caller-selected target. */
export function createWorker(options: {
  runtimeId: string;
  fetcher?: typeof fetch;
  grant: () => Promise<boolean>;
  now?: () => number;
  uuid?: () => string;
  timeout?: number;
}) {
  const fetcher = options.fetcher || fetch;
  const now = options.now || Date.now;
  const uuid = options.uuid || (() => crypto.randomUUID());
  const generation = uuid();
  const sessions = new Map<
    string,
    {
      owner: string;
      clientId: string;
      binding: string;
      lastUsed: number;
      inFlight: number;
    }
  >();
  const dedup = new Map<
    string,
    {
      at: number;
      signature: string;
      owner: string;
      clientId: string;
      pending: boolean;
      reply: Promise<Reply>;
    }
  >();
  async function fetchJson(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeout ?? 10000,
    );
    try {
      const response = await fetcher(BACKEND + path, {
        ...init,
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 409) {
        if (path === "/api/reconciliation/pairs" || path === "/api/reconciliation/decisions" || path === "/api/syllabus-revisions/preview" || path === "/api/syllabus-revisions/confirm") {
          // The binding middleware uses this fixed response when the backend
          // restarted. Other 409s on these routes are review conflicts.
          const text = await response.text();
          let bindingChanged = false;
          if (new TextEncoder().encode(text).length <= 1024 * 1024) {
            try { const value = JSON.parse(text); bindingChanged = closed(value, ["message"]) && value.message === "Backend context changed. Reconnect."; } catch { /* fail closed */ }
          }
          if (!bindingChanged) throw "REVIEW_CONFLICT";
        }
        sessions.clear();
        throw "RECONNECT_REQUIRED";
      }
      if (response.status === 422) throw "VALIDATION";
      if (response.status === 503 && path === '/api/sync') {
        try {
          const text = await response.text();
          if (new TextEncoder().encode(text).length <= 1024 * 1024) {
            const value = JSON.parse(text);
            if (closed(value, ['message']) && value.message === 'Live course sync is unavailable until Moodle access is verified.')
              throw 'SYNC_UNAVAILABLE';
          }
        } catch (error) {
          if (error === 'SYNC_UNAVAILABLE') throw error;
        }
        throw 'BACKEND_UNAVAILABLE';
      }
      if (!response.ok) throw "BACKEND_UNAVAILABLE";
      const text = await response.text();
      if (new TextEncoder().encode(text).length > 1024 * 1024)
        throw "TOO_LARGE";
      try {
        return JSON.parse(text);
      } catch {
        throw "INVALID_RESPONSE";
      }
    } catch (e) {
      if (controller.signal.aborted) throw "TIMEOUT";
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  async function execute(r: Request, owner: string): Promise<Reply> {
    try {
      if (r.operation === "hello") {
        let binding: string;
        try {
          const context = await fetchJson("/api/bridge-context");
          if (
            !closed(context, ["version", "binding"]) ||
            context.version !== "1" ||
            typeof context.binding !== "string" ||
            !/^[0-9a-f]{32}$/.test(context.binding)
          )
            throw "INVALID_RESPONSE";
          binding = context.binding;
        } catch (e) {
          return rejection(
            r,
            typeof e === "string" &&
              ["INVALID_RESPONSE", "TOO_LARGE", "TIMEOUT"].includes(e)
              ? (e as any)
              : "BACKEND_UNAVAILABLE",
          );
        }
        // Reconnect retires this page's previous session, without replaying work.
        for (const [id, session] of sessions)
          if (session.owner === owner && session.clientId === r.clientId)
            sessions.delete(id);
        if (sessions.size >= 128) return rejection(r, "BUSY");
        const sessionId = uuid();
        sessions.set(sessionId, {
          owner,
          clientId: r.clientId,
          binding,
          lastUsed: now(),
          inFlight: 0,
        });
        return success(r, {
          version: "1",
          workerGeneration: generation,
          sessionId,
          backend: "ready",
          localRepository: "ready",
          moodleCollection: "unavailable",
        });
      }
      const session = sessions.get(r.sessionId!);
      if (
        !session ||
        session.owner !== owner ||
        session.clientId !== r.clientId
      )
        return rejection(r, "RECONNECT_REQUIRED");
      const target = route(r);
      session.inFlight++;
      session.lastUsed = now();
      let result: unknown;
      try {
        result = await fetchJson(target.path, {
          method: target.method,
          headers: {
            Accept: "application/json",
            "X-Moodle-Helper-Bridge-Binding": session.binding,
            ...(target.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(target.body === undefined
            ? {}
            : { body: JSON.stringify(target.body) }),
        });
      } finally {
        session.inFlight--;
        session.lastUsed = now();
      }
      if (!validResult(r.operation, result))
        return rejection(r, "INVALID_RESPONSE");
      const reply = success(r, result);
      return fits(reply) ? reply : rejection(r, "TOO_LARGE");
    } catch (e) {
      return rejection(
        r,
        typeof e === "string" &&
          [
            "VALIDATION",
            "RECONNECT_REQUIRED",
            "TIMEOUT",
            "INVALID_RESPONSE",
            "TOO_LARGE",
            "SYNC_UNAVAILABLE",
            "REVIEW_CONFLICT",
          ].includes(e)
          ? (e as any)
          : "BACKEND_UNAVAILABLE",
      );
    }
  }
  return async function handle(
    message: unknown,
    sender: Sender,
  ): Promise<Reply | null> {
    if (!trustedSender(sender, options.runtimeId)) return null;
    if (
      !message ||
      typeof message !== "object" ||
      !idValid((message as Request).clientId) ||
      !idValid((message as Request).requestId)
    )
      return null;
    const r = message as Request;
    const invalid = requestError(r);
    if (invalid) return rejection(r, invalid);
    if (typeof sender.documentId !== "string" || !sender.documentId.trim())
      return rejection(r, "RECONNECT_REQUIRED");
    try {
      if (!(await options.grant())) return rejection(r, "PERMISSION_DENIED");
    } catch {
      return rejection(r, "PERMISSION_DENIED");
    }
    const owner = JSON.stringify([
      sender.tab!.id,
      sender.frameId,
      sender.documentId,
    ]);
    // No page-provided release command or active eviction. Inactive sessions have
    // a bounded idle lease; a stale client must explicitly reconnect, never replay.
    for (const [id, session] of sessions)
      if (!session.inFlight && now() - session.lastUsed >= 60000)
        sessions.delete(id);
    // Validate session ownership before dedup: replacement documents cannot borrow cached data.
    if (r.operation !== "hello") {
      const session = sessions.get(r.sessionId!);
      if (
        !session ||
        session.owner !== owner ||
        session.clientId !== r.clientId
      )
        return rejection(r, "RECONNECT_REQUIRED");
    }
    for (const [key, item] of dedup)
      if (!item.pending && now() - item.at >= 60000) dedup.delete(key);
    const key = JSON.stringify([owner, r.clientId, r.requestId]);
    const signature = normalized([r.operation, r.payload, r.sessionId]);
    const old = dedup.get(key);
    if (old)
      return old.signature === signature
        ? old.reply
        : rejection(r, "DUPLICATE_CONFLICT");
    if (
      [...dedup.values()].filter(
        (item) =>
          item.pending && item.owner === owner && item.clientId === r.clientId,
      ).length >= 32
    )
      return rejection(r, "BUSY");
    if (dedup.size >= 128) return rejection(r, "BUSY");
    const entry = {
      at: now(),
      signature,
      owner,
      clientId: r.clientId,
      pending: true,
      reply: Promise.resolve(null as any as Reply),
    };
    // Reserve synchronously before beginning any asynchronous mutation.
    dedup.set(key, entry);
    entry.reply = execute(r, owner).finally(() => {
      entry.pending = false;
      entry.at = now();
    });
    return entry.reply;
  };
}
export function installWorker(chromeApi: {
  runtime: Runtime;
  permissions: {
    contains: (
      p: { origins: string[] },
      cb: (allowed: boolean) => void,
    ) => void;
  };
}) {
  const handler = createWorker({
    runtimeId: chromeApi.runtime.id,
    grant: () =>
      new Promise((resolve) =>
        chromeApi.permissions.contains(
          { origins: [BACKEND + "/*"] },
          (allowed) => resolve(!chromeApi.runtime.lastError && allowed),
        ),
      ),
  });
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!trustedSender(sender, chromeApi.runtime.id)) return;
    void handler(message, sender).then((reply) => {
      if (reply) sendResponse(reply);
    });
    return true;
  });
}
/** Isolated content world; only same-window top-frame traffic reaches internal runtime. */
export function installRelay(win: Window, runtime: Runtime): () => void {
  if (win.top !== win || !approved(win.location.origin)) return () => {};
  const listener = (e: MessageEvent) => {
    if (
      e.source !== win ||
      e.origin !== win.location.origin ||
      !approved(e.origin)
    )
      return;
    const r = e.data as Request;
    if (
      !r ||
      r.source !== "moodle-helper-web" ||
      r.type !== "request" ||
      !idValid(r.clientId) ||
      !idValid(r.requestId)
    )
      return;
    const invalid = requestError(r);
    if (invalid) {
      win.postMessage(rejection(r, invalid), win.location.origin);
      return;
    }
    try {
      runtime.sendMessage!(r, (response) => {
        const reply = runtime.lastError
          ? rejection(r, "RECONNECT_REQUIRED")
          : validReply(response, r)
            ? response
            : rejection(r, "INVALID_RESPONSE");
        win.postMessage(reply, win.location.origin);
      });
    } catch {
      win.postMessage(rejection(r, "RECONNECT_REQUIRED"), win.location.origin);
    }
  };
  win.addEventListener("message", listener);
  return () => win.removeEventListener("message", listener);
}
