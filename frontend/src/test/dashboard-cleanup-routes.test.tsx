import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";
import type { useApp } from "@/lib/app-store";
import { buildDemoSnapshot } from "@/services/fixtures";
import { viewAll } from "@/domain/assessments";
import { Overview } from "@/routes/index";
import { DeadlineList } from "@/routes/deadlines";
import { Route as PlannerRoute } from "@/routes/planner";
import { Materials } from "@/routes/materials";
import { Route as AlertsRoute } from "@/routes/alerts";
import { Syllabus } from "@/routes/syllabus";
import { Route as SettingsRoute } from "@/routes/settings";
import { Route as SetupRoute } from "@/routes/setup";
import { AssessmentSheet } from "@/components/mh/AssessmentSheet";

const state = vi.hoisted(() => ({ app: {} as ReturnType<typeof useApp> }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/services/local-documents", async (original) => ({
  ...(await original<typeof import("@/services/local-documents")>()),
  currentDataset: vi.fn(async () => undefined),
}));

function visibleText(root: HTMLElement) {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details:not([open])").forEach((d) =>
    Array.from(d.children).forEach((c) => {
      if (c.tagName !== "SUMMARY") c.remove();
    }),
  );
  return clone.textContent ?? "";
}
for (const dataset of ["demo", "real"] as const) {
  it(`deadline sheet has no technical data in its default ${dataset} view`, async () => {
    const snap = datasetSnapshot(dataset);
    state.app = {
      snap,
      views: viewAll(snap.assessments, snap.overlays, snap.settings, snap),
      conn: { state: dataset === "demo" ? "demo" : "connected" },
      run: vi.fn(),
    } as unknown as ReturnType<typeof useApp>;
    render(<AssessmentSheet id={snap.assessments[0]!.id} onClose={() => {}} />);
    await waitFor(() => {
      const text = visibleText(document.body);
      for (const pattern of forbidden) expect(text.match(pattern)).toBeNull();
      expectNoIds(text, snap);
    });
  });
}
const forbidden = [
  /\bpartial\b(?! holidays?| holiday)|\b(?:visited_activity_only|reference_only)\b|(?<!not )\bverified\b/,
  /\b(?:record|request|location|paragraph|course|job)[-_]id\s*[:=]/i,
  /[0-9a-f]{64}/,
  /\d{4}-\d{2}-\d{2}T\d{2}:/,
  /\bbytes\b/i,
  /policy-\d/,
  /visited_activity_only|reference_only|mode groq/,
];
function datasetSnapshot(dataset: "demo" | "real") {
  const snap = buildDemoSnapshot();
  if (dataset === "real") {
    snap.documents = snap.documents.map((document) => ({ ...document, mocked: false }));
    snap.sync = snap.sync.map((entry) => ({ ...entry, coverage: "partial" as const }));
  }
  return snap;
}
function expectNoIds(text: string, snap: ReturnType<typeof buildDemoSnapshot>) {
  const ids = [...snap.courses, ...snap.assessments, ...snap.documents, ...snap.alerts]
    .map((item) => item.id)
    .filter((id) => id.length >= 6);
  for (const id of ids) expect(text).not.toContain(id);
}
const routes = [
  ["Overview", Overview],
  ["Deadlines", () => <DeadlineList search={{}} set={() => {}} />],
  ["Planner", PlannerRoute.options.component],
  ["Syllabus", Syllabus],
  ["Materials", Materials],
  ["Alerts", AlertsRoute.options.component],
  ["Settings", SettingsRoute.options.component],
  ["Setup", SetupRoute.options.component],
] as const;
afterEach(cleanup);
for (const dataset of ["demo", "real"] as const)
  for (const [name, Component] of routes) {
    it(`${name} has no technical data in its default ${dataset} view`, async () => {
      const snap = datasetSnapshot(dataset);
      state.app = {
        snap,
        weeks: [],
        unallocated: [],
        discovery: { available: false, pending: false },
        views: viewAll(snap.assessments, snap.overlays, snap.settings, snap),
        conn: {
          state: dataset === "demo" ? "demo" : "connected",
          message: "Connected",
          extensionDetected: false,
        },
        detecting: false,
        adapter: {
          kind: dataset === "demo" ? "demo" : "http",
          storage: "backend",
          reminderPlan: vi.fn(async () => {
            throw new Error("offline");
          }),
          aiAvailability: vi.fn(async () => ({ available: false })),
          collectionMode: vi.fn(async () => "unavailable"),
        },
        run: vi.fn(),
        setSnap: vi.fn(),
        retryLoad: vi.fn(),
        error: null,
      } as unknown as ReturnType<typeof useApp>;
      const RouteComponent = Component as ComponentType;
      const { container } = render(<RouteComponent />);
      await waitFor(() => {
        const text = visibleText(container);
        for (const pattern of forbidden) expect(text.match(pattern)).toBeNull();
        expectNoIds(text, snap);
      });
    });
  }
