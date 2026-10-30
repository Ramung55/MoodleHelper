import { QueryClient } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "@/routeTree.gen";
import { Alert, type Snapshot } from "@/domain/types";
import { alertDestination, deliveryLabel, describeAssertion, DELIVERY_DISABLED_TEXT } from "@/domain/alerts";
import { workloadFixture } from "./workload-fixture";

const mocks = vi.hoisted(() => ({ load: vi.fn(), connection: vi.fn(), updateAlerts: vi.fn(), saveAlerts: vi.fn() }));
vi.mock("@/services", () => ({ getAdapter: () => ({ kind: "extension", storage: "backend", load: mocks.load, connection: mocks.connection, aiAvailability: async () => ({ available: false, reason: "none" }), saveAlerts: mocks.saveAlerts, updateAlerts: mocks.updateAlerts }) }));
vi.mock("@/services/extension-adapter", async (orig) => ({ ...(await orig<typeof import("@/services/extension-adapter")>()), detectExtension: async () => false }));
Object.assign(routeTree.options, { shellComponent: ({ children }: { children: ReactNode }) => <>{children}</> });
const mount = (url: string) => render(<RouterProvider router={createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }), context: { queryClient: new QueryClient() }, defaultPendingMinMs: 0 })} />);

const base = { createdAt: "2027-01-05T09:00:00Z", read: false } as const;
const change: Alert = { ...base, id: "al-change-c1", kind: "change", message: "Essay changed", assessmentId: "x", deliveryKey: "change:c1",
  context: { destination: "assessment", reason: "source_change", assessmentId: "x", change: { changeId: "c1", sourceId: "s1", detectedAt: "2027-01-05T09:00:00Z", sourceObservedAt: "2027-01-05T08:00:00Z", from: { kind: "exact", iso: "2027-01-10T18:00:00Z", tz: "UTC" }, to: { kind: "removed" } } },
  delivery: { channel: "os", state: "denied", errorCode: "permission_denied", updatedAt: "2027-01-05T09:00:00Z" } };
const week: Alert = { ...base, id: "al-w", kind: "busy_week", message: "Teaching week 3 looks busy.", deliveryKey: "rk-w", context: { destination: "week", reason: "busy_week", week: 3 }, delivery: { channel: "os", state: "issued", attemptId: "a", updatedAt: "x" } };
const legacy: Alert = { ...base, id: "old", kind: "sync", message: "Legacy alert", deliveryKey: "old", read: true };

describe("alert wording and destinations", () => {
  it("keeps precision for exact, date-only, week-only, unknown and removed", () => {
    expect(describeAssertion({ kind: "exact", iso: "2027-01-10T18:00:00Z", tz: "UTC" })).toBe("2027-01-10 18:00 UTC");
    expect(describeAssertion({ kind: "exact", iso: "2027-01-10T18:00:00Z", tz: "Asia/Almaty" })).toMatch(/^2027-01-1[01] \d\d:00 Asia\/Almaty$/);
    expect(describeAssertion({ kind: "date", date: "2027-01-10" })).toBe("2027-01-10 (date only, no time given)");
    expect(describeAssertion({ kind: "week", week: 4 })).toBe("teaching week 4 (week only)");
    expect(describeAssertion({ kind: "unknown" })).toBe("unknown date");
    expect(describeAssertion({ kind: "removed" })).toBe("deadline removed");
  });
  it("maps only closed destinations, canonicalising assessment ids; legacy falls back safely", () => {
    expect(alertDestination(change, (id) => "canon-" + id)).toEqual({ to: "/deadlines", id: "canon-x" });
    expect(alertDestination(week, (id) => id)).toEqual({ to: "/planner" });
    expect(alertDestination(legacy, (id) => id)).toEqual({ to: "/alerts" });
    expect(alertDestination({ ...change, context: { destination: "alerts", reason: "catch_up" } }, (id) => id)).toEqual({ to: "/alerts" });
  });
  it("never claims OS display for a pending or uncertain attempt", () => {
    expect(deliveryLabel(change)).toBe(DELIVERY_DISABLED_TEXT);
    expect(deliveryLabel(week)).toBe("Browser notification outcome unknown");
    expect(deliveryLabel({ ...week, delivery: { channel: "os", state: "pending", updatedAt: "x" } })).toMatch(/pending/);
    expect(deliveryLabel(legacy)).toBeNull();
    expect(Alert.safeParse(legacy).success).toBe(true);
  });
});

describe("alerts route", () => {
  let snap: Snapshot;
  beforeEach(() => {
    snap = workloadFixture().snap; snap.changes = []; snap.alerts = [change, week, legacy];
    mocks.load.mockImplementation(async () => structuredClone(snap));
    mocks.connection.mockResolvedValue({ state: "connected", message: "x", extensionDetected: true });
    mocks.updateAlerts.mockImplementation(async () => structuredClone(snap));
    mocks.saveAlerts.mockReset();
  });
  afterEach(cleanup);
  it("shows denied guidance, old/new evidence and uses narrow mark-read/delete instead of whole-array saves", async () => {
    mount("/alerts");
    expect(await screen.findByText(/Browser notifications disabled; alerts remain here\. Allow notifications/)).toBeInTheDocument();
    expect(screen.getByText(/Previous: 2027-01-10 18:00 UTC · New: deadline removed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open planner" })).toHaveAttribute("href", "/planner");
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(mocks.updateAlerts).toHaveBeenCalledWith(["al-change-c1", "al-w"], "read"));
    fireEvent.click(screen.getByRole("button", { name: "Delete alert: Legacy alert" }));
    await waitFor(() => expect(mocks.updateAlerts).toHaveBeenCalledWith(["old"], "delete"));
    expect(mocks.saveAlerts).not.toHaveBeenCalled();
  });
});
