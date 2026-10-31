/**
 * Fixture harness helpers (#47). Everything here is synthetic and local:
 * - a FastAPI backend on 127.0.0.1:8000 using a fresh TEMP SQLite file in a
 *   harness-owned run directory (never data/moodle-helper.sqlite3), demo dataset;
 * - the real built unpacked extension (extension/dist) in a fresh Chromium profile;
 * - a browser-level resolver block plus request audit for any non-local traffic.
 * Cleanup kills only the process IDs spawned here and removes only verified
 * run directories below browser-workspace/e2e/.run.
 */
import { chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "../..");
export const DASHBOARD = "http://127.0.0.1:5173";
export const BACKEND = "http://127.0.0.1:8000";
export const EXTENSION_DIST = path.join(ROOT, "extension", "dist");
const RUN_ROOT = path.join(__dirname, ".run");

/** Fresh harness-owned directory for one spec file. */
export function runDirectory(name: string): string {
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(RUN_ROOT, `${name}-`));
}

/** Removes a directory only after verifying it is a direct child of .run. */
export function removeRunDirectory(dir: string) {
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(RUN_ROOT)) throw new Error(`Refusing to remove ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Isolated backend process bound to one TEMP SQLite file. Restartable on the same file. */
export class FixtureBackend {
  private child: ChildProcess | undefined;
  readonly database: string;
  log = "";
  constructor(readonly dir: string) {
    this.database = path.join(dir, "e2e-fixture.sqlite3");
  }
  async start() {
    if (await portOpen(8000)) throw new Error("Port 8000 is already in use; stop that server first (the harness never reuses it).");
    const env = {
      ...process.env,
      MOODLE_HELPER_DATABASE_URL: `sqlite:///${this.database.replace(/\\/g, "/")}`,
      MOODLE_HELPER_DATASET: "demo",
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(ROOT, ".uv-cache"),
    };
    for (const key of ["MOODLE_HELPER_MOODLE_ORIGIN", "MOODLE_HELPER_PROFILE_LABEL", "MOODLE_HELPER_STABLE_USER_ID"]) delete env[key];
    // Resolve the project's uv-managed interpreter once, then run uvicorn as one
    // directly owned process so cleanup can terminate exactly that PID.
    const resolved = spawnSync("uv", ["run", "python", "-c", "import sys;print(sys.executable)"], { cwd: ROOT, env, encoding: "utf8" });
    const python = resolved.stdout.trim();
    if (resolved.status !== 0 || !python) throw new Error(`uv could not resolve the project interpreter:\n${resolved.stderr}`);
    this.child = spawn(python, ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child.stdout?.on("data", (d) => { this.log += d; });
    this.child.stderr?.on("data", (d) => { this.log += d; });
    await until(async () => {
      if (this.child?.exitCode !== null) throw new Error(`Backend exited early:\n${this.log}`);
      try { return (await fetch(`${BACKEND}/api/snapshot`)).ok; } catch { return false; }
    }, 60_000, "fixture backend");
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid || child.exitCode !== null) return;
    // Only the spawned process tree (uv -> python) is terminated.
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
    await until(async () => !(await portOpen(8000)), 20_000, "backend shutdown");
  }
}

const LOCAL = /^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|chrome-extension:\/\/|chrome:\/\/|data:|blob:|about:)/;

export type ExtensionSession = {
  context: BrowserContext;
  extensionId: string;
  worker: () => Worker;
  unexpected: string[];
  /** Lovable design web-font requests, aborted locally (never reach the network). */
  blockedDesignAssets: string[];
  close: () => Promise<void>;
};

/**
 * Real unpacked extension in a dedicated persistent Chromium profile.
 * `fixtureRoutes` may fulfill named HTTPS fixture pages locally (no network).
 */
export async function launchWithExtension(dir: string, options: { fixtureRoutes?: Record<string, string> } = {}): Promise<ExtensionSession> {
  if (!fs.existsSync(path.join(EXTENSION_DIST, "manifest.json"))) throw new Error("extension/dist is missing; run `bun run --cwd extension build` (test:e2e does this).");
  const profile = path.join(dir, "profile");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIST}`,
      `--load-extension=${EXTENSION_DIST}`,
      // Hard network boundary: every hostname except local loopback fails to resolve.
      "--lang=en-US",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    ],
  });
  const unexpected: string[] = [], blockedDesignAssets: string[] = [];
  const allowedFixtures = new Set(Object.keys(options.fixtureRoutes ?? {}));
  // The preserved Lovable design links Google Fonts; abort it so the system font
  // fallback is used and nothing leaves the machine. It is recorded, not hidden.
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => { blockedDesignAssets.push(route.request().url()); return route.abort("blockedbyclient"); });
  context.on("request", (request) => {
    const url = request.url();
    if (!LOCAL.test(url) && !allowedFixtures.has(url) && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) unexpected.push(url);
  });
  for (const [url, body] of Object.entries(options.fixtureRoutes ?? {})) {
    await context.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body }));
  }
  let current = context.serviceWorkers().find((w) => w.url().endsWith("/index.js"));
  current ??= await context.waitForEvent("serviceworker", { predicate: (w) => w.url().endsWith("/index.js"), timeout: 20_000 });
  context.on("serviceworker", (w) => { if (w.url().endsWith("/index.js")) current = w; });
  const extensionId = new URL(current.url()).host;
  return {
    context, extensionId, unexpected, blockedDesignAssets,
    worker: () => current!,
    close: async () => { await context.close(); },
  };
}

/**
 * Records worker generations returned to the dashboard by the real bridge
 * handshake (observation only; nothing is modified or injected into replies).
 */
export async function observeBridge(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as any).__e2eWorkerGenerations = seen;
    window.addEventListener("message", (event) => {
      const generation = event.data?.result?.workerGeneration ?? event.data?.reply?.result?.workerGeneration;
      if (typeof generation === "string" && !seen.includes(generation)) seen.push(generation);
      try {
        const text = JSON.stringify(event.data);
        const match = /"workerGeneration":"([^"]+)"/.exec(text);
        if (match && !seen.includes(match[1]!)) seen.push(match[1]!);
      } catch { /* non-JSON message */ }
    });
  });
}
export const workerGenerations = (page: Page) => page.evaluate(() => [...((window as any).__e2eWorkerGenerations ?? [])] as string[]);

/**
 * DevTools ServiceWorker-domain observer for this extension's worker versions.
 * `stop()` performs a genuine MV3 worker suspension and resolves once Chromium
 * reports the worker stopped; `running()` tells whether a version runs now.
 */
export async function watchExtensionWorker(context: BrowserContext, page: Page, extensionId: string) {
  const cdp = await context.newCDPSession(page);
  const statuses: string[] = [];
  const versions = new Map<string, string>();
  cdp.on("ServiceWorker.workerVersionUpdated", (event: any) => {
    for (const version of event.versions) if (version.scriptURL.startsWith(`chrome-extension://${extensionId}/`)) {
      statuses.push(`${version.versionId}:${version.runningStatus}`);
      versions.set(version.versionId, version.runningStatus);
    }
  });
  await cdp.send("ServiceWorker.enable");
  const last = () => statuses.at(-1)?.split(":")[1];
  return {
    statuses, versions,
    running: () => [...versions.values()].includes("running"),
    async stop() {
      await cdp.send("ServiceWorker.stopAllWorkers");
      await expect.poll(last, { message: "extension service worker reported stopped", timeout: 15_000 }).toBe("stopped");
    },
    detach: () => cdp.detach(),
  };
}

/** Stops the extension worker (genuine suspension) and returns the observer, still attached. */
export async function stopExtensionWorker(context: BrowserContext, page: Page, extensionId: string) {
  const watcher = await watchExtensionWorker(context, page, extensionId);
  await watcher.stop();
  return watcher;
}

export function assertNoUnexpectedTraffic(session: ExtensionSession) {
  expect(session.unexpected, "non-local network requests (must be none)").toEqual([]);
}
