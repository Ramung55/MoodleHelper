import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Materials } from "@/routes/materials";
import { transferLabel, type MaterialTransfer } from "@/domain/material-transfer";
import type { Snapshot } from "@/domain/types";

const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/services/local-documents", () => ({ currentDataset: vi.fn(async () => "ds-1") }));
afterEach(cleanup);

const base = (p: Partial<MaterialTransfer>): MaterialTransfer => ({ transferId: "t1", generation: 1, materialId: "m-pdf", state: "queued", cancelRequested: false, createdAt: "2026-10-30T10:00:00Z", updatedAt: "2026-10-30T10:00:00Z", ...p });

describe("#41 transfer labels", () => {
  it("download ID alone is not completion and unknown length is indeterminate", () => {
    const l = transferLabel(base({ state: "saving", downloadId: 9 }));
    expect(l.text).toContain("not finished");
    expect(l.progress).toBe("indeterminate");
    expect(transferLabel(base({ state: "validating", bytesReceived: 5, totalBytes: 10 })).progress).toEqual({ value: 5, max: 10 });
  });
  it("historic success is a download record, never guaranteed availability", () => {
    const l = transferLabel(base({ state: "complete", downloadId: 9, completedAt: "2026-10-30T10:01:00Z" }));
    expect(l.text).toMatch(/^Download record/);
    expect(l.text).toContain("may since have been moved or removed");
  });
  it("failure and cancel never claim offline availability; sign-in guidance", () => {
    expect(transferLabel(base({ state: "failed", reason: "sign_in_required" })).text).toContain("Sign in to Moodle");
    expect(transferLabel(base({ state: "failed", reason: "sign_in_required" })).text).toContain("Nothing was saved");
    expect(transferLabel(base({ state: "cancelled", reason: "cancelled_by_user" })).text).toContain("Nothing is available offline");
    expect(transferLabel(base({ state: "interrupted", reason: "page_closed" })).canRetry).toBe(true);
  });
});

function snap(): Snapshot {
  const s = buildDemoSnapshot();
  s.collection = { records: [], reviews: [], refreshes: [] };
  s.materials = [{ id: "m-pdf", courseId: s.settings.trackedCourseIds[0]!, section: "Week 1", title: "Lecture 1", fileType: "pdf", url: "https://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/lecture-1.pdf", accessible: true, stale: false, lastCheckedAt: "2026-10-30T09:00:00Z", syllabusSuggestion: false }];
  return s;
}
function mount(adapter: Record<string, unknown>) {
  state.app = { snap: snap(), adapter: { downloadMaterial: vi.fn(), ...adapter }, setSnap: vi.fn(), error: null, retryLoad: vi.fn() };
  render(<Materials />);
}

describe("#41 explicit download control", () => {
  it("repeated clicks during an active transfer do not start duplicates", async () => {
    let resolve!: (v: unknown) => void;
    const start = vi.fn(() => new Promise((r) => { resolve = r; }));
    mount({ startMaterialDownload: start, listMaterialDownloads: vi.fn(async () => ({ transfers: [] })), cancelMaterialDownload: vi.fn() });
    const button = await screen.findByRole("button", { name: "Download PDF" });
    fireEvent.click(button); fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith("ds-1", "m-pdf", expect.any(String));
    await act(async () => resolve({ supported: true, message: "Download queued.", transfer: base({}) }));
    expect(await screen.findByRole("button", { name: "Downloading…" })).toBeDisabled();
    expect(screen.getByTestId("transfer-status").textContent).toContain("Queued");
  });
  it("unsupported runtime shows honest guidance and no transfer", async () => {
    const { toast } = await import("sonner");
    const start = vi.fn(async () => ({ supported: false, reason: "source_unavailable", message: "Downloads need a verified signed-in Moodle session" }));
    mount({ startMaterialDownload: start, listMaterialDownloads: vi.fn(async () => ({ transfers: [] })), cancelMaterialDownload: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("verified signed-in")));
    expect(screen.queryByTestId("transfer-status")).toBeNull();
  });
  it("shows a historic record and allows cancel on active transfers", async () => {
    const cancel = vi.fn(async () => base({ state: "saving", cancelRequested: true }));
    mount({ startMaterialDownload: vi.fn(), listMaterialDownloads: vi.fn(async () => ({ transfers: [base({ state: "saving", downloadId: 9 })] })), cancelMaterialDownload: cancel });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel download" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("t1"));
    expect(await screen.findByText("Cancelling…")).toBeTruthy();
    cleanup();
    mount({ startMaterialDownload: vi.fn(), listMaterialDownloads: vi.fn(async () => ({ transfers: [base({ state: "complete", downloadId: 9, completedAt: "2026-10-30T10:01:00Z" })] })), cancelMaterialDownload: vi.fn() });
    expect((await screen.findByTestId("transfer-status")).textContent).toContain("Download record");
    expect(screen.getByRole("button", { name: "Download again" })).toBeEnabled();
  });
  it("demo/HTTP adapters keep the legacy capability message path", () => {
    mount({});
    expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });
});
