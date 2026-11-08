// #21 AC2: a real full-sync time comes only from the verified Snapshot sync entries of the real
// dataset, and stays distinct from the latest page refresh and the last failed scan attempt.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { buildDemoSnapshot } from "@/services/fixtures";
import type { Snapshot } from "@/domain/types";
import { installPopup } from "../../../extension/src/popup";
import { syncFreshness } from "../../../shared/src/full-sync";
import { Overview } from "@/routes/index";
import { MockProgress } from "@/components/mh/MockProgress";
import type { ReactNode } from "react";

const mock = vi.hoisted(() => ({ current: vi.fn(), connect: vi.fn(), useApp: vi.fn() }));
vi.mock("@/services/extension-adapter", () => ({
  BridgeClient: class {
    connect = mock.connect;
    currentMockRun = mock.current;
    startMockRun = vi.fn();
    cancelMockRun = vi.fn();
    dispose() {}
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  createFileRoute: () => () => ({}),
}));
vi.mock("@/lib/app-store", () => ({ useApp: mock.useApp }));
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const NONE = "No successful full sync yet.";
// Three different times: full sync (earliest of the two full entries), page refresh, failed attempt.
const FULL_EARLY = "2028-03-05T10:00:00.000000+00:00",
  FULL_LATE = "2028-03-05T11:00:00.000000+00:00";
const PAGE = "2028-03-06T08:00:00Z",
  ATTEMPT = "2028-03-07T09:30:00.123456+00:00";

/** A real-dataset Snapshot with two selected courses. */
function real(sync: Snapshot["sync"]): Snapshot {
  const snapshot = buildDemoSnapshot();
  snapshot.settings.trackedCourseIds = ["c-csc", "c-math"];
  snapshot.settings.timezone = "UTC";
  snapshot.courses[0]!.discovery = {
    sourceCourseId: "9001",
    sourceUrl: "https://moodle.sdu.edu.kz/course/view.php?id=9001",
    title: { kind: "unknown" },
    termIndicators: { kind: "unknown" },
    currentTermStatus: "current",
  };
  snapshot.collection = {
    records: [],
    reviews: [],
    refreshes: [
      {
        visitId: "visit",
        pageUrl: "https://moodle.sdu.edu.kz/course/view.php?id=9001",
        observedAt: PAGE,
        collector: "material",
        sourceCourseIds: ["9001"],
        outcome: "ok",
        coverage: "complete",
        scope: "supplied_pages_only",
        reasons: [],
        evidenceMode: "verified",
        pages: [],
      },
    ],
  };
  snapshot.sync = sync;
  return snapshot;
}
const full = (courseId: string, lastSuccessAt: string, extra: object = {}) => ({
  courseId,
  status: "ok" as const,
  coverage: "full" as const,
  lastSuccessAt,
  progress: 100,
  ...extra,
});
const threeTimes = () =>
  real([
    full("c-csc", FULL_LATE),
    full("c-math", FULL_EARLY, {
      status: "failed",
      lastAttemptAt: ATTEMPT,
      error: "Sign in to SDU Moodle to continue.",
    }),
  ]);

it("demo dataset with full sample entries never shows a real full sync", () => {
  const demo = buildDemoSnapshot();
  demo.settings.trackedCourseIds = ["c-csc", "c-math"];
  const result = syncFreshness(demo, false);
  expect(result.fullSync).toBe(NONE);
  expect(result.value).toBe("Never");
  expect(
    result.courses.every((line) =>
      line.startsWith("Saved course timestamp (sample/demo values are fictional)"),
    ),
  ).toBe(true);
});

it("no full sync for an empty selection, a missing entry, a partial course or an invalid time", () => {
  const empty = real([full("c-csc", FULL_EARLY)]);
  empty.settings.trackedCourseIds = [];
  expect(syncFreshness(empty, true).fullSync).toBe(NONE);
  expect(syncFreshness(real([full("c-csc", FULL_EARLY)]), true).fullSync).toBe(NONE);
  const partial = syncFreshness(
    real([
      full("c-csc", FULL_EARLY),
      { ...full("c-math", FULL_LATE), status: "partial", coverage: "partial" },
    ]),
    true,
  );
  expect(partial.fullSync).toBe(NONE);
  expect(partial.value).toBe("Never");
  expect(partial.courses).toEqual([
    "Last completed scan (partial coverage): Calculus II · 05/03/2028, 11:00:00 (UTC)",
  ]);
  for (const bad of ["2028-02-30T10:00:00Z", "2028-03-05T10:00:00", "not a time"])
    expect(
      syncFreshness(real([full("c-csc", FULL_EARLY), full("c-math", bad)]), true).fullSync,
    ).toBe(NONE);
  const none = real([
    full("c-csc", FULL_EARLY),
    { courseId: "c-math", status: "never", coverage: "none", progress: 0 },
  ]);
  expect(syncFreshness(none, true).fullSync).toBe(NONE);
});

it("all full shows the earliest lastSuccessAt; failed and syncing keep it; never labelled fictional", () => {
  const ok = syncFreshness(real([full("c-csc", FULL_LATE), full("c-math", FULL_EARLY)]), true);
  expect(ok.fullSync).toBe("Successful full sync: 05/03/2028, 10:00:00 (UTC)");
  expect(ok.value).toBe("05/03/2028, 10:00:00 (UTC)");
  expect(ok.courses).toEqual([]);
  const failed = syncFreshness(threeTimes(), true);
  expect(failed.fullSync).toBe("Successful full sync: 05/03/2028, 10:00:00 (UTC)");
  expect(failed.courses).toEqual([
    "Last failed scan attempt: Calculus II · 07/03/2028, 09:30:00 (UTC)",
  ]);
  const syncing = syncFreshness(
    real([
      full("c-csc", FULL_LATE, { status: "syncing", progress: 0 }),
      full("c-math", FULL_EARLY),
    ]),
    true,
  );
  expect(syncing.fullSync).toBe("Successful full sync: 05/03/2028, 10:00:00 (UTC)");
  expect(JSON.stringify([ok, failed, syncing])).not.toMatch(/fictional|sample|Synthetic/);
  // The synthetic example never stands in for real data.
  expect(
    syncFreshness(real([]), true, {
      completedAt: FULL_EARLY,
      courseIds: ["c-csc", "c-math"],
      provenance: "synthetic-example",
    }).fullSync,
  ).toBe(NONE);
});

it("formats in the configured timezone and falls back to UTC", () => {
  const snapshot = real([full("c-csc", FULL_LATE), full("c-math", FULL_EARLY)]);
  snapshot.settings.timezone = "Asia/Tokyo";
  expect(syncFreshness(snapshot, true).fullSync).toBe(
    "Successful full sync: 05/03/2028, 19:00:00 (Asia/Tokyo)",
  );
  snapshot.settings.timezone = "Not/AZone";
  expect(syncFreshness(snapshot, true).fullSync).toBe(
    "Successful full sync: 05/03/2028, 10:00:00 (UTC)",
  );
});

const labels = (text: string, page = true) => {
  expect(text).toContain("Successful full sync: 05/03/2028, 10:00:00 (UTC)");
  if (page) expect(text).toContain(`Latest page refresh: ${PAGE}`);
  expect(text).toContain("Last failed scan attempt: Calculus II · 07/03/2028, 09:30:00 (UTC)");
  expect(text).not.toContain(NONE);
};

it("Overview card and dashboard panel each show full sync, page refresh and failed attempt with their own times", async () => {
  const snapshot = threeTimes();
  mock.useApp.mockReturnValue({
    snap: snapshot,
    conn: { state: "disconnected", message: "Real dataset.", extensionDetected: false },
    views: [],
    weeks: [],
    currentWeek: null,
    syncAll: vi.fn(),
    syncing: false,
  });
  mock.connect.mockResolvedValue({});
  mock.current.mockResolvedValue({ courseIds: snapshot.settings.trackedCourseIds });
  render(<Overview />);
  // #87 O1: the card is titled "Last full sync" with a friendly value; the #21 lines stay verbatim under Details.
  const card = screen.getByRole("region", { name: "Last full sync" });
  expect(within(card).getByText("5 Mar 2028, 10:00")).toBeInTheDocument();
  fireEvent.click(within(card).getByText("Details"));
  expect(card.querySelector("details")!.open).toBe(true);
  labels(card.textContent!);
  // #87 O4: in the real dataset the mock panel is not on Overview; Settings → Details renders the same panel.
  expect(screen.queryByRole("region", { name: "Mock scan progress" })).toBeNull();
  cleanup();
  render(<MockProgress snapshot={snapshot} realData />);
  labels(screen.getByRole("region", { name: "Mock scan progress" }).textContent!);
});

it("Overview without a known real connection treats the data as demo", () => {
  mock.useApp.mockReturnValue({
    snap: threeTimes(),
    conn: { state: "demo", message: "Demo.", extensionDetected: false },
    views: [],
    weeks: [],
    currentWeek: null,
    syncAll: vi.fn(),
    syncing: false,
  });
  mock.connect.mockResolvedValue({});
  mock.current.mockResolvedValue({ courseIds: [] });
  render(<Overview />);
  expect(screen.getAllByText(NONE)).toHaveLength(2);
  expect(screen.queryByText(/Successful full sync:/)).toBeNull();
});

function popup(snapshot: Snapshot, connection: unknown) {
  document.body.innerHTML =
    '<p id="full-sync">No successful full sync yet.</p><div id="status"></div><div id="freshness"></div><button id="start"></button><button id="cancel"></button><button id="reconnect"></button><button id="example-retry"></button>';
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const value =
      path === "/api/bridge-context"
        ? { version: "1", binding: "a".repeat(32) }
        : path === "/api/snapshot"
          ? snapshot
          : path === "/api/connection"
            ? connection
            : { courseIds: snapshot.settings.trackedCourseIds };
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return installPopup(document, fetcher as typeof fetch, localStorage);
}

it("popup shows full sync, page refresh and failed attempt with their own times on real data", async () => {
  const controller = popup(threeTimes(), {
    state: "disconnected",
    message: "Real dataset.",
    extensionDetected: false,
  });
  await waitFor(() =>
    expect(document.querySelector("#full-sync")!.textContent).toBe(
      "Successful full sync: 05/03/2028, 10:00:00 (UTC)",
    ),
  );
  labels(document.body.textContent!);
  controller.dispose();
});

it("popup treats a demo or unreadable connection as demo data", async () => {
  for (const connection of [
    { state: "demo", message: "Demo.", extensionDetected: false },
    { unexpected: true },
  ]) {
    const controller = popup(threeTimes(), connection);
    await waitFor(() =>
      expect(document.querySelector("#freshness")!.textContent).toContain("Latest page refresh"),
    );
    expect(document.querySelector("#full-sync")!.textContent).toBe(NONE);
    expect(document.body.textContent).not.toMatch(/Successful full sync:|Last failed scan attempt/);
    controller.dispose();
  }
});
