// #136: the hosted extension build's injected tailnet origin. Placeholder origin only.
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backendOrigin } from "../extension/build";

const ORIGIN = "https://example-vm.example-tailnet.ts.net";

describe("#136 hosted backend origin", () => {
  it("accepts only https://<machine>.<tailnet>.ts.net; unset or empty is the local build", () => {
    expect(backendOrigin(undefined)).toBeUndefined();
    expect(backendOrigin("")).toBeUndefined();
    expect(backendOrigin(ORIGIN)).toBe(ORIGIN);
    for (const bad of [
      "http://example-vm.example-tailnet.ts.net", `${ORIGIN}/`, `${ORIGIN}/api`, `${ORIGIN}?q=1`, `${ORIGIN}#f`,
      `${ORIGIN}:443`, "https://user@example-vm.example-tailnet.ts.net", "https://Example-VM.example-tailnet.ts.net",
      ` ${ORIGIN}`, `${ORIGIN} `, `${ORIGIN}\n`, "https://example-tailnet.ts.net", "https://a.b.c.ts.net",
      "https://example-vm.example-tailnet.ts.net.evil.example", "https://example-vm.example-tailnet.ts.netx",
      "https://-vm.example-tailnet.ts.net", "https://127.0.0.1", "javascript:alert(1)",
    ]) expect(() => backendOrigin(bad), bad).toThrow(/MOODLE_HELPER_BACKEND_ORIGIN/);
  });

  it.each([
    [{ MOODLE_HELPER_BACKEND_ORIGIN: `${ORIGIN}/` }],
    [{ MOODLE_HELPER_BACKEND_ORIGIN: ORIGIN, MOODLE_HELPER_DASHBOARD_URL: "http://127.0.0.1:5173/" }],
  ])("an invalid hosted value fails the build before dist is touched (%o)", async (env) => {
    const dist = fileURLToPath(new URL("../extension/dist/popup.js", import.meta.url));
    const before = await stat(dist).then((s) => s.mtimeMs, () => undefined);
    const result = spawnSync("bun", [fileURLToPath(new URL("../extension/build.ts", import.meta.url))], {
      env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000,
    });
    expect(result.status).not.toBe(0);
    expect(await stat(dist).then((s) => s.mtimeMs, () => undefined)).toBe(before);
  });
});

describe("#136 hosted build off the tailnet", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it("uses the injected origin and shows the backend-unavailable message", async () => {
    vi.stubGlobal("__MOODLE_HELPER_BACKEND_ORIGIN__", ORIGIN);
    vi.resetModules();
    const { BACKEND, createWorker, trustedSender } = await import("../extension/src/dashboard-bridge");
    const { APPROVED_ORIGINS, errors } = await import("../shared/src/bridge");
    expect(BACKEND).toBe(ORIGIN);
    expect(APPROVED_ORIGINS).toEqual([ORIGIN]);
    const sender = { id: "extension", frameId: 0, tab: { id: 3 }, url: `${ORIGIN}/`, documentId: "doc-1" };
    expect(trustedSender(sender, "extension")).toBe(true);
    expect(trustedSender({ ...sender, url: "http://localhost:5173/" }, "extension")).toBe(false);
    // Off the tailnet the name does not resolve: every fetch rejects.
    const fetcher = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const handler = createWorker({ runtimeId: "extension", grant: async () => true, fetcher });
    const reply: any = await handler({ source: "moodle-helper-web", type: "request", version: "1", clientId: "client",
      requestId: "hello", operation: "hello", payload: {} } as any, sender);
    expect(reply?.error).toEqual({ code: "BACKEND_UNAVAILABLE", message: "Connect this device to Tailscale, then reconnect." });
    expect(errors.BACKEND_UNAVAILABLE).not.toContain("127.0.0.1:8000");
    expect(fetcher.mock.calls.every(([url]: any) => String(url).startsWith(`${ORIGIN}/`))).toBe(true);
    expect(fetcher).toHaveBeenCalled();
  });
});
