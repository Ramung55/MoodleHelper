// Shared lifecycle for tests that spawn a real uvicorn backend (and SQLite lock helpers).
// Every wait here is bounded so a slow or stuck process fails clearly instead of hanging the run.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

/** Longest a single backend start may poll for `/docs` before failing with the start-up log. */
export const BACKEND_START_WAIT_MS = 20_000;
/** Longest a polite stop (stdin close / kill) may take before the process is force killed. */
export const PROCESS_STOP_WAIT_MS = 5_000;
/** Longest the force kill may take to produce an `exit` event before stopping reports an error. */
export const PROCESS_FORCE_KILL_WAIT_MS = 5_000;
/** Worst case for one bounded stop (polite wait plus force kill wait). */
export const PROCESS_STOP_BUDGET_MS = PROCESS_STOP_WAIT_MS + PROCESS_FORCE_KILL_WAIT_MS;
/** Worst case for one `stop` followed by `start` of the real backend. */
export const BACKEND_RESTART_BUDGET_MS = PROCESS_STOP_BUDGET_MS + BACKEND_START_WAIT_MS;
/** Hook budget for a `beforeAll` that starts the backend once: a full start-up wait plus setup headroom. */
export const BACKEND_START_HOOK_TIMEOUT_MS = BACKEND_START_WAIT_MS + 10_000;
/** Hook budget for an `afterAll` that stops the backend and removes its temporary folder. */
export const BACKEND_STOP_HOOK_TIMEOUT_MS = PROCESS_STOP_BUDGET_MS + 10_000;

/**
 * Per-test timeout for a test that restarts the real backend `restarts` times: the test's own
 * work budget plus a full worst-case stop and start-up wait per restart, so a slow but successful
 * restart under parallel suite load can never surface as a test timeout.
 */
export function realBackendTimeout(restarts: number, workMs = 15_000): number {
  return workMs + restarts * BACKEND_RESTART_BUDGET_MS;
}

export const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
export const venvPython = path.join(repositoryRoot, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");

export async function freeLocalPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("No local test port available");
  return address.port;
}

export function hasExited(target: ChildProcess): boolean {
  return target.exitCode !== null || target.signalCode !== null;
}

function forceKill(target: ChildProcess) {
  if (target.pid === undefined) return;
  // taskkill /T /F also removes any grandchild the Windows launcher may have created.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(target.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else target.kill("SIGKILL");
}

function exitWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([exited.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Stops a spawned process: `request` asks politely (default `kill()`), then after
 * PROCESS_STOP_WAIT_MS the process tree is force killed. Never waits longer than PROCESS_STOP_BUDGET_MS.
 */
export async function stopProcess(target: ChildProcess | undefined, request: (target: ChildProcess) => void = (p) => { p.kill(); }): Promise<void> {
  if (!target || target.pid === undefined || hasExited(target)) return;
  const exited = new Promise<void>((resolve) => target.once("exit", () => resolve()));
  try { request(target); } catch { /* fall through to the force kill */ }
  if (await exitWithin(exited, PROCESS_STOP_WAIT_MS)) return;
  forceKill(target);
  if (await exitWithin(exited, PROCESS_FORCE_KILL_WAIT_MS)) return;
  throw new Error(`Test process ${target.pid} did not exit after a force kill`);
}

/** Closes a SQLite lock helper's stdin so it rolls back, with the same bounded force-kill fallback. */
export function releaseLockHelper(locker: ChildProcess | undefined): Promise<void> {
  return stopProcess(locker, (p) => { p.stdin?.end(); });
}

export type RealBackend = { process: ChildProcess; base: string };

/**
 * Spawns `python -m uvicorn <app>` on a fresh free port and waits up to BACKEND_START_WAIT_MS for
 * `/docs`. On failure the process is stopped and the error carries the captured start-up log.
 */
export async function startRealBackend(app: string, env: NodeJS.ProcessEnv): Promise<RealBackend> {
  const port = await freeLocalPort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(venvPython, ["-m", "uvicorn", app, "--host", "127.0.0.1", "--port", String(port)], { cwd: repositoryRoot, env, windowsHide: true, stdio: "pipe" });
  let log = "";
  child.stdout?.on("data", (chunk) => { log += String(chunk); });
  child.stderr?.on("data", (chunk) => { log += String(chunk); });
  child.on("error", (error) => { log += error.message; });
  const deadline = Date.now() + BACKEND_START_WAIT_MS;
  while (Date.now() < deadline && !hasExited(child)) {
    try {
      const response = await fetch(`${base}/docs`, { signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))) });
      // Only accept the answer while our own process is alive, so a foreign listener cannot pass.
      if (response.ok && !hasExited(child)) return { process: child, base };
    } catch { /* wait for the actual server to bind */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const reason = hasExited(child) ? `exited (${child.exitCode ?? child.signalCode})` : `not ready after ${BACKEND_START_WAIT_MS}ms`;
  await stopProcess(child).catch(() => {});
  throw new Error(`FastAPI integration process failed to start: ${reason}: ${log}`);
}
