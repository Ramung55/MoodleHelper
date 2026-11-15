// #138: the dashboard served from the tailnet origin approves its own origin by shape (placeholders only).
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { bridgeMessage, isTailnetOrigin } from "@/services/api-base";
import { BridgeClient } from "@/services/extension-adapter";
import { classifyHandshake } from "@/domain/onboarding";
import { BridgeGuidance } from "@/routes/settings";
import { approved, BridgeError, errors, success, type Request } from "../../../shared/src/bridge";

const TAILNET = "https://example-vm.example-tailnet.ts.net";
afterEach(() => vi.unstubAllGlobals());

it("accepts only https <machine>.<tailnet>.ts.net origins", () => {
  expect(isTailnetOrigin(TAILNET)).toBe(true);
  for (const o of [
    "http://example-vm.example-tailnet.ts.net",
    "https://a.example-vm.example-tailnet.ts.net",
    "https://example-tailnet.ts.net",
    "https://example-vm.example-tailnet.ts.net.evil.example",
    "https://example-vm.example-tailnet.ts.net:8443",
    "https://Example-vm.example-tailnet.ts.net",
    "http://127.0.0.1:5173",
    "https://ramung55.github.io",
    "",
    undefined,
  ])
    expect(isTailnetOrigin(o)).toBe(false);
  // The shared list the extension uses stays unchanged.
  expect(approved(TAILNET)).toBe(false);
  expect(approved("http://localhost:5173")).toBe(true);
});

class WindowShim {
  top: WindowShim = this;
  listeners = new Set<(e: unknown) => void>();
  messages: Request[] = [];
  constructor(public location: { origin: string }) {}
  addEventListener(_n: string, f: (e: unknown) => void) {
    this.listeners.add(f);
  }
  removeEventListener(_n: string, f: (e: unknown) => void) {
    this.listeners.delete(f);
  }
  emit(data: unknown, origin = this.location.origin) {
    for (const f of this.listeners) f({ data, origin, source: this });
  }
  postMessage(data: Request) {
    this.messages.push(structuredClone(data));
  }
}

it("the adapter connects on a tailnet origin and still rejects an unapproved one", async () => {
  const win = new WindowShim({ origin: TAILNET });
  const client = new BridgeClient(win as unknown as Window);
  const connecting = client.connect();
  win.emit(
    success(win.messages.at(-1)!, {
      version: "1",
      workerGeneration: "generation",
      sessionId: "session",
      backend: "ready",
      localRepository: "ready",
      moodleCollection: "unavailable",
    }),
  );
  await expect(connecting).resolves.toMatchObject({ sessionId: "session" });
  client.dispose();

  const evil = new WindowShim({ origin: "https://example-vm.example-tailnet.ts.net.evil.example" });
  const denied = new BridgeClient(evil as unknown as Window);
  await expect(denied.connect()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(evil.messages).toHaveLength(0);
  denied.dispose();
});

it("texts switch to Tailscale wording only on the tailnet origin", () => {
  expect(bridgeMessage("BACKEND_UNAVAILABLE", "http://127.0.0.1:5173")).toBe(
    errors.BACKEND_UNAVAILABLE,
  );
  expect(bridgeMessage("TIMEOUT", TAILNET)).toBe(errors.TIMEOUT);
  vi.stubGlobal("location", { origin: TAILNET });
  expect(
    classifyHandshake({ ok: false, error: new BridgeError("BACKEND_UNAVAILABLE") }),
  ).toMatchObject({ message: "Connect this device to Tailscale, then reconnect." });
  render(<BridgeGuidance />);
  expect(screen.getByText(/connect this device to\s+Tailscale/)).toBeInTheDocument();
  expect(screen.queryByText(/127\.0\.0\.1:8000/)).toBeNull();
});
