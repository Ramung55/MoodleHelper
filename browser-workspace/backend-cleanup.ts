/**
 * Bounded stop and cleanup for the uvicorn backends that browser-workspace tests spawn (#98).
 *
 * On Windows, `.venv/Scripts/python.exe` in a uv venv is a launcher that starts the real
 * interpreter as a second process. `child.kill()` ends only the launcher; its `exit` event can
 * fire while the interpreter is still shutting down and holding the test's SQLite files open,
 * so an immediate `rm` fails with EBUSY. Here the whole spawned tree is ended by its PID
 * (`taskkill /T /F`, as in `e2e/harness.ts`), and every wait and retry is bounded.
 *
 * Only the process tree of the given child is ever signalled; nothing is killed by image name.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import net from "node:net";

/** First wait for the child to exit and its port to close (at most 10 s per child). */
export const STOP_TIMEOUT_MS = 5_000;
/** Second wait, after a force kill, before the stop is reported as failed. */
export const FORCE_KILL_TIMEOUT_MS = 5_000;
/** Bounded directory-removal retry: RM_RETRIES * RM_RETRY_DELAY_MS = 4 s (at most 5 s). */
export const RM_RETRIES = 20;
export const RM_RETRY_DELAY_MS = 200;
/** Hook/test budget for one stop (both waits, children stopped in parallel) plus one removal. */
export const CLEANUP_TIMEOUT_MS =
  STOP_TIMEOUT_MS + FORCE_KILL_TIMEOUT_MS + RM_RETRIES * RM_RETRY_DELAY_MS + 2_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    // An unanswered connect is treated as still open, so the caller keeps waiting (bounded).
    socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/** Ends the spawned process tree by PID; returns a note when taskkill itself failed. */
function endTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): string {
  if (process.platform !== "win32") {
    child.kill(signal);
    return "";
  }
  const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  // 128: the process had already ended between the check and taskkill.
  if (result.error) return `taskkill failed: ${result.error.message}`;
  if (result.status !== 0 && result.status !== 128) return `taskkill exited ${result.status}: ${(result.stderr || result.stdout).trim()}`;
  return "";
}

/** Waits until the child has exited and, when given, its port refuses connections. */
async function settled(child: ChildProcess, exit: Promise<void>, port: number | undefined, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  await Promise.race([exit, timeout]);
  clearTimeout(timer);
  if (!exited(child)) return false;
  if (port === undefined) return true;
  while (await portOpen(port)) {
    if (Date.now() >= deadline) return false;
    await pause(50);
  }
  return true;
}

/**
 * Stops a spawned backend. Returns at once when it was never started or has already exited.
 * Otherwise ends its process tree (taskkill /T /F on Windows, SIGTERM elsewhere), waits up to
 * STOP_TIMEOUT_MS for exit and a closed port, force-kills on timeout, waits up to
 * FORCE_KILL_TIMEOUT_MS again, and throws an error naming `label` and the PID if it is still alive.
 */
export async function stopBackend(label: string, child: ChildProcess | undefined, port?: number): Promise<void> {
  if (!child?.pid || exited(child)) return;
  const pid = child.pid;
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const notes = [endTree(child, "SIGTERM")];
  if (await settled(child, exit, port, STOP_TIMEOUT_MS)) return;
  notes.push(endTree(child, "SIGKILL"));
  if (await settled(child, exit, port, FORCE_KILL_TIMEOUT_MS)) return;
  const what = exited(child) ? `exited but port ${port} still accepts connections` : "is still running";
  const detail = notes.filter(Boolean).join("; ");
  throw new Error(`${label}: backend PID ${pid} ${what} after ${STOP_TIMEOUT_MS + FORCE_KILL_TIMEOUT_MS} ms${detail ? ` (${detail})` : ""}`);
}

/** Stops several backends in parallel, so the bound is one stop rather than one per backend. */
export async function stopBackends(label: string, backends: { child?: ChildProcess; port?: number }[]): Promise<void> {
  const results = await Promise.allSettled(backends.map((backend) => stopBackend(label, backend.child, backend.port || undefined)));
  throwAll(results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])), `${label}: several backends did not stop`);
}

const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * `rm(dir, {recursive, force})` with a bounded retry of RM_RETRIES x RM_RETRY_DELAY_MS.
 * The retry is done here because Bun, which runs this suite, ignores `maxRetries`/`retryDelay`.
 * The last error is rethrown.
 */
export async function removeTemporaryDirectory(dir: string | undefined): Promise<void> {
  if (!dir) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= RM_RETRIES || !RETRYABLE.has(code)) throw error;
      await pause(RM_RETRY_DELAY_MS);
    }
  }
}

function throwAll(errors: unknown[], message: string) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${message}: ${errors.map(String).join("; ")}`);
}

/** Runs every cleanup step even when an earlier one fails, then throws what failed. */
export async function cleanUp(label: string, ...steps: (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  throwAll(errors, `${label}: cleanup failed`);
}

/**
 * Runs `body`, then `cleanup`. When `body` failed, its error is the one rethrown: a cleanup
 * error is then printed to stderr instead of replacing the test failure.
 */
export async function withCleanup<T>(label: string, body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (failure) {
    await cleanup().catch((cleanupError: unknown) => {
      console.error(`${label}: cleanup also failed after the test failure`, cleanupError);
    });
    throw failure;
  }
  await cleanup();
  return result;
}
