import { QueryClient } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "@/routeTree.gen";
import { shellPreview } from "@/lib/shell-preview";
import { buildDemoSnapshot } from "@/services/fixtures";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn(), load: vi.fn(), connection: vi.fn(), aiAvailability: vi.fn(), saveAlerts: vi.fn(), detect: vi.fn() }));
vi.mock("@/services", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/services/extension-adapter", async (importOriginal) => ({ ...(await importOriginal<typeof import('@/services/extension-adapter')>()), detectExtension: mocks.detect }));
// Replace only Start's HTML document wrapper: jsdom does not load external
// stylesheets. Actual root wiring, shell/provider and route components render.
Object.assign(routeTree.options, { shellComponent: ({ children }: { children: ReactNode }) => <>{children}</> });
const routes = [["/", "Overview"], ["/deadlines", "Deadlines"], ["/syllabus", "Syllabus review"], ["/materials", "Materials"], ["/settings", "Settings"]] as const;
const snapshot = buildDemoSnapshot();
snapshot.changes = [];
snapshot.settings.reminders.enabled = false;
function mount(url: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }), context: { queryClient: new QueryClient() }, defaultPendingMinMs: 0 });
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdapter.mockReturnValue({ kind: "demo", storage: "backend", load: mocks.load, connection: mocks.connection, aiAvailability: mocks.aiAvailability, saveAlerts: mocks.saveAlerts });
  mocks.load.mockResolvedValue(structuredClone(snapshot));
  mocks.connection.mockResolvedValue({ state: "demo", message: "HTTP backend", extensionDetected: false });
  mocks.detect.mockResolvedValue(false);
  mocks.aiAvailability.mockResolvedValue({ available: false, reason: "No provider configured" });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("real router dashboard shell", () => {
  for (const [path, title] of routes) for (const state of ["loading", "empty", "error"] as const) {
    it(`${path} renders explicit ${state} without initializing services or storage`, async () => {
      const storageRead = vi.spyOn(Storage.prototype, "getItem");
      const storageWrite = vi.spyOn(Storage.prototype, "setItem");
      const network = vi.spyOn(globalThis, "fetch");
      const extensionMessage = vi.spyOn(window, "postMessage");
      mount(`${path}?shellState=${state}`);
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      const nav = screen.getByRole("navigation", { name: "Main" });
      expect(within(nav).getAllByRole("link")).toHaveLength(7);
      expect(within(nav).getAllByRole("link", { current: "page" })).toHaveLength(1);
      expect(within(nav).getByRole("link", { name: title })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("button", { name: "Exit preview" })).toBeInTheDocument();
      if (state === "loading") expect(screen.getByRole("status", { name: `Loading ${title}` })).toHaveAttribute("aria-busy", "true");
      if (state === "empty") expect(screen.getByText(/No data is present/)).toBeInTheDocument();
      if (state === "error") {
        expect(screen.getByRole("alert")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText(/No data is present/)).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(title);
        expect(within(nav).getByRole("link", { name: title })).toHaveAttribute("aria-current", "page");
      }
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(mocks.detect).not.toHaveBeenCalled();
      expect(mocks.aiAvailability).not.toHaveBeenCalled();
      expect(mocks.saveAlerts).not.toHaveBeenCalled();
      expect(storageRead).not.toHaveBeenCalled();
      expect(storageWrite).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(extensionMessage).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  }
  it("preserves preview during navigation, manages focus and expanded state, and exits into HTTP mode", async () => {
    const router = mount("/deadlines?shellState=error");
    await screen.findByRole("heading", { name: "Deadlines", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Toggle navigation" }));
    expect(screen.getByRole("button", { name: "Toggle navigation" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings", level: 1 });
    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.search).toEqual({ shellState: "error" });
    expect(screen.getByRole("main")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Toggle navigation" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/No data is present/);
    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.search).toEqual({ shellState: "empty" });
    screen.getByRole("button", { name: "Exit preview" }).focus();
    fireEvent.click(screen.getByRole("link", { name: "Skip to content" }));
    expect(screen.getByRole("main")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Exit preview" }));
    await screen.findByText("Tracked courses");
    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.search).toEqual({});
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.aiAvailability).toHaveBeenCalledTimes(1);
  });
  for (const [path, title] of routes) it(`${path} preserves actual normal page actions and heading`, async () => {
    mount(path);
    await waitFor(() => expect(mocks.load).toHaveBeenCalled());
    await screen.findByRole("heading", { name: title, level: 1 });
    await waitFor(() => expect(screen.queryByRole("status", { name: `Loading ${title}` })).not.toBeInTheDocument());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: new RegExp(`^${title}`) })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Exit preview" })).not.toBeInTheDocument();
  });
  it("retries actual failed initialization repeatedly and clears errors only after successful recovery", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Backend unavailable")).mockRejectedValueOnce(new Error("Still unavailable")).mockResolvedValueOnce(structuredClone(snapshot));
    const router = mount("/deadlines");
    await screen.findByText("Backend unavailable");
    expect(screen.getByRole("heading", { name: "Deadlines", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Still unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Personal event" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Still unavailable")).not.toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(3);
    expect(router.state.location.pathname).toBe("/deadlines");
  });
  for (const value of [undefined, "invalid", "EMPTY", "", ["empty"]]) it(`does not select preview for ${JSON.stringify(value)}`, () => {
    expect(shellPreview(value)).toBeUndefined();
  });
  it("production ignores every valid preview state", () => {
    for (const state of ["loading", "empty", "error"]) expect(shellPreview(state, false)).toBeUndefined();
  });
  for (const [path, title] of routes) for (const state of ["loading", "empty", "error"]) it(`production ${path}?shellState=${state} mounts the real provider`, async () => {
    vi.stubEnv("DEV", false);
    mocks.load.mockRejectedValueOnce(new Error("Real production backend unavailable"));
    mount(`${path}?shellState=${state}`);
    await screen.findByText("Real production backend unavailable");
    expect(screen.getByRole("heading", { name: title, level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exit preview" })).not.toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
  for (const state of ["loading", "empty", "error"]) it(`keeps ${state} preview while navigating every required section`, async () => {
    const router = mount(`/?shellState=${state}`);
    await screen.findByRole("heading", { name: "Overview", level: 1 });
    for (const [path, title] of routes) {
      fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: title }));
      await screen.findByRole("heading", { name: title, level: 1 });
      expect(router.state.location.pathname).toBe(path);
      expect(router.state.location.search).toEqual({ shellState: state });
      expect(within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link", { current: "page" })).toHaveLength(1);
    }
    expect(mocks.getAdapter).not.toHaveBeenCalled();
  });
  for (const [path, title] of [["/planner", "Weekly planner"], ["/alerts", "Alerts"]] as const) it(`preserves integrated ${title}`, async () => {
    mount(path);
    await screen.findByRole("heading", { name: title, level: 1 });
    await waitFor(() => expect(screen.queryByRole("status", { name: `Loading ${title}` })).not.toBeInTheDocument());
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: new RegExp(`^${title}`) })).toHaveAttribute("aria-current", "page");
  });
  it("an invalid query uses the normal provider and shows a real failure", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Actual HTTP failure"));
    mount("/materials?shellState=invalid");
    await screen.findByText("Actual HTTP failure");
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Exit preview" })).not.toBeInTheDocument();
  });
});
