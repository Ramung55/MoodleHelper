import { QueryClient } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "@/routeTree.gen";
import type { Snapshot } from "@/domain/types";
import { busyReasons, draftFrom, validateDraft, WORKLOAD_DEFAULTS } from "@/domain/weekly-overview";
import { buildDemoSnapshot } from "@/services/fixtures";
import { workloadFixture } from "./workload-fixture";

const mocks = vi.hoisted(() => ({ load: vi.fn(), connection: vi.fn() }));
vi.mock("@/services", () => ({ getAdapter: () => ({ kind: "demo", storage: "backend", load: mocks.load, connection: mocks.connection, aiAvailability: async () => ({ available: false, reason: "none" }), saveAlerts: vi.fn(async (s: Snapshot) => s) }) }));
vi.mock("@/services/extension-adapter", async (orig) => ({ ...(await orig<typeof import("@/services/extension-adapter")>()), detectExtension: async () => false }));
Object.assign(routeTree.options, { shellComponent: ({ children }: { children: ReactNode }) => <>{children}</> });
let snap: Snapshot;
const mount = (url: string) => render(<RouterProvider router={createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }), context: { queryClient: new QueryClient() }, defaultPendingMinMs: 0 })} />);
beforeEach(() => { snap = workloadFixture().snap; snap.changes = []; mocks.load.mockImplementation(async () => structuredClone(snap)); mocks.connection.mockResolvedValue({ state: "demo", message: "x", extensionDetected: false }); });
afterEach(cleanup);

describe("busy rule", () => {
  const t = { maxOutstanding: 5, maxWeighted: 10 };
  it("is strictly above either threshold", () => {
    expect(busyReasons({ outstanding: 5, weighted: 10 }, t)).toEqual([]);
    expect(busyReasons({ outstanding: 4, weighted: 9 }, t)).toEqual([]);
    expect(busyReasons({ outstanding: 6, weighted: 0 }, t)).toEqual(["6 outstanding is above the threshold of 5"]);
    expect(busyReasons({ outstanding: 0, weighted: 11 }, t)).toEqual(["weighted estimate 11 is above the threshold of 10"]);
    expect(busyReasons({ outstanding: 6, weighted: 11 }, t)).toHaveLength(2);
    expect(busyReasons({ outstanding: 0, weighted: 0 }, { maxOutstanding: 0, maxWeighted: 0 })).toEqual([]);
  });
});
describe("draft validation", () => {
  it("never coerces blank/invalid and accepts fractional zero weights", () => {
    const d = draftFrom(WORKLOAD_DEFAULTS);
    expect(validateDraft({ ...d, quiz: "" }).errors.quiz).toBe("Required.");
    expect(validateDraft({ ...d, quiz: "abc" }).errors.quiz).toBe("Enter a finite number.");
    expect(validateDraft({ ...d, quiz: "Infinity" }).errors.quiz).toBe("Enter a finite number.");
    expect(validateDraft({ ...d, maxOutstanding: "1.5" }).errors.maxOutstanding).toBe("Must be a whole number.");
    expect(validateDraft({ ...d, exam: "0", quiz: "0.25", maxWeighted: "2.5" }).value).toEqual({ weights: { exam: 0, assignment: 2, quiz: 0.25, other: 0 }, thresholds: { maxOutstanding: 5, maxWeighted: 2.5 } });
  });
});
describe("planner route", () => {
  it("shows interval, canonical totals, contributor reasons and links, empty weeks and unallocated reasons", async () => {
    mount("/planner");
    const week1 = await screen.findByRole("region", { name: /^Week 1/ });
    expect(week1).toHaveTextContent("2027-01-04 – 2027-01-10");
    expect(within(week1).getByText("Weighted estimate")).toBeInTheDocument();
    expect(week1).toHaveTextContent("Counted in total only: submitted in Moodle");
    expect(week1).toHaveTextContent('Moodle status "draft" takes precedence');
    const links = within(week1).getAllByRole("link").filter((l) => l.getAttribute("href")?.includes("id="));
    expect(links.length).toBeGreaterThan(0);
    expect(within(week1).queryByText(/j-hidden/)).toBeNull();
    const empty = screen.getAllByText("No assessments this week.");
    expect(empty.length).toBeGreaterThan(0);
    const un = screen.getByRole("region", { name: "Unallocated" });
    expect(un).toHaveTextContent("Reason: Unknown date");
    expect(un).toHaveTextContent("Precision: unknown date");
    expect(un).toHaveTextContent("weighted estimate");
  });
  it("warns with numeric reason text when above a threshold", async () => {
    snap.settings.thresholds = { maxOutstanding: 0, maxWeighted: 100 };
    mount("/planner");
    const week1 = await screen.findByRole("region", { name: /^Week 1/ });
    expect(week1).toHaveTextContent(/Busy week warning: \d+ outstanding is above the threshold of 0/);
  });
  it("says the calendar is not configured instead of fabricating weeks", async () => {
    snap = buildDemoSnapshot(); snap.changes = []; snap.settings.reminders.enabled = false; delete snap.settings.teachingCalendar;
    mount("/planner");
    expect(await screen.findByText(/Teaching calendar not configured/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Configure the teaching calendar in Settings/ })).toHaveAttribute("href", "/settings");
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Week \d/ })).toBeNull());
  });
});
