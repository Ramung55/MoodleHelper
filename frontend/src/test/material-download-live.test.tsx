import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Materials } from "@/routes/materials";
import type { MaterialTransfer } from "@/domain/material-transfer";
import { NormalizedMaterialRecord as RecordSchema, type NormalizedMaterialRecord, type RawMaterialObservation, type Snapshot } from "@/domain/types";

/**
 * #41 owner live check: on the real dataset after a live Sync all, the Materials page (default HTTP
 * adapter) offered no download control on the scanned PDF resource. The HTTP adapter has no transfer
 * operations; with live sync the page now carries them through the extension bridge.
 */
const state = vi.hoisted(() => ({ app: {} as any, bridge: null as any, opened: 0 }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/services/local-documents", () => ({ currentDataset: vi.fn(async () => "ds-1") }));
vi.mock("@/services/extension-adapter", async (orig) => ({
  ...(await orig<typeof import("@/services/extension-adapter")>()),
  bridgeMaterialDownloads: () => { state.opened++; return state.bridge; },
}));
afterEach(() => { cleanup(); state.opened = 0; });

// Labeled SYNTHETIC records in the shape the live scan stores (course-page resource, view.php?id=<cmid>).
const O = "https://moodle.sdu.edu.kz";
const T = "2026-11-02T10:00:00Z";
const known = <V extends string>(value: V) => ({ kind: "known" as const, value });
function scanned(id: string, cm: string, title: string, fileType?: "pdf"): NormalizedMaterialRecord {
  const o: RawMaterialObservation = {
    sourcePageUrl: `${O}/course/view.php?id=7001`, sourceUrl: `${O}/mod/resource/view.php?id=${cm}`, observedAt: T, location: "course.material",
    sourceCourseId: "7001", sourceCourseModuleId: cm, sourceModuleType: "resource", resourceKey: `k${cm}`, kind: "file",
    title: known(title), section: { kind: "unknown" }, fileType: fileType ? known(fileType) : { kind: "unknown" }, mimeType: { kind: "unknown" },
    destinationUrl: `${O}/mod/resource/view.php?id=${cm}`, references: [],
  };
  return RecordSchema.parse({ id, courseId: "c-csc", kind: "material", firstObservedAt: T, lastObservedAt: T, observations: [o] });
}
function snap(): Snapshot {
  const s = buildDemoSnapshot();
  s.materials = []; // A scan never writes the legacy list.
  s.collection = { records: [scanned("r-pdf", "990104", "Scanned PDF", "pdf"), scanned("r-unknown", "990105", "Scanned unknown")], reviews: [], refreshes: [] };
  return s;
}
const queued: MaterialTransfer = { transferId: "t-1", generation: 0, materialId: "r-pdf", state: "queued", cancelRequested: false, createdAt: T, updatedAt: T };
/** The default HTTP adapter: no transfer operations of its own. */
const httpAdapter = () => ({ kind: "http", storage: "backend", downloadMaterial: vi.fn() });
const row = (title: string) => screen.getAllByTestId("material-row").find((r) => r.textContent?.includes(title))!;

describe("#41 live check: scanned PDF resource gets the download control", () => {
  it("scanned record -> Download file offered -> one bridged start -> queued transfer shown", async () => {
    const start = vi.fn(async () => ({ supported: true, message: "Download queued.", transfer: queued }));
    const list = vi.fn(async () => ({ transfers: [] as MaterialTransfer[] }));
    state.bridge = { startMaterialDownload: start, listMaterialDownloads: list, materialDownload: vi.fn(), cancelMaterialDownload: vi.fn() };
    state.app = { snap: snap(), adapter: httpAdapter(), conn: { state: "connected", message: "", extensionDetected: true, liveSync: true }, setSnap: vi.fn(), error: null, retryLoad: vi.fn() };
    render(<Materials />);
    const button = within(row("Scanned PDF")).getByRole("button", { name: "Download file" });
    // #85: an unknown-type resource is never offered a download; the response type cannot be guessed.
    expect(within(row("Scanned unknown")).queryByRole("button", { name: /Download/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Download file" })).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith("ds-1", "r-pdf", expect.any(String));
    expect((await screen.findByTestId("transfer-status")).textContent).toContain("Queued — the transfer tab will open");
    expect(state.opened).toBe(1); // One stable bridged downloads API for the page.
  });
  it("without live sync the HTTP adapter offers no transfer control (backend would answer source_unavailable)", () => {
    state.app = { snap: snap(), adapter: httpAdapter(), conn: { state: "connected", message: "", extensionDetected: true }, setSnap: vi.fn(), error: null, retryLoad: vi.fn() };
    render(<Materials />);
    expect(screen.queryByRole("button", { name: "Download file" })).toBeNull();
    expect(state.opened).toBe(0);
  });
});

describe("#41 bridgeMaterialDownloads", () => {
  it("each operation uses one fresh bridge session, disposed afterwards", async () => {
    const { bridgeMaterialDownloads } = await vi.importActual<typeof import("@/services/extension-adapter")>("@/services/extension-adapter");
    const log: string[] = [];
    const client = {
      connect: vi.fn(async () => { log.push("connect"); }),
      dispose: vi.fn(() => { log.push("dispose"); }),
      startMaterialDownload: vi.fn(async (...a: unknown[]) => { log.push(`start:${a.join(",")}`); return { supported: true, message: "Download queued.", transfer: queued }; }),
      listMaterialDownloads: vi.fn(async () => { log.push("list"); return { transfers: [queued] }; }),
      cancelMaterialDownload: vi.fn(async () => { log.push("cancel"); throw new Error("RECONNECT_REQUIRED"); }),
    };
    const api = bridgeMaterialDownloads(() => client as any);
    expect((await api.startMaterialDownload("ds-1", "r-pdf", "k1")).transfer).toEqual(queued);
    expect((await api.listMaterialDownloads()).transfers).toEqual([queued]);
    await expect(api.cancelMaterialDownload("t-1")).rejects.toThrow("RECONNECT_REQUIRED");
    expect(log).toEqual(["connect", "start:ds-1,r-pdf,k1", "dispose", "connect", "list", "dispose", "connect", "cancel", "dispose"]);
  });
});
