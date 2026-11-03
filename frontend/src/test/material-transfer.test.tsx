import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import { Materials } from "@/routes/materials";
import { BUSY_TEXT, transferLabel, type MaterialTransfer } from "@/domain/material-transfer";
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
    expect(transferLabel(base({ state: "failed", reason: "sign_in_required" })).text).toContain("Sign in to SDU Moodle in Chrome");
    expect(transferLabel(base({ state: "failed", reason: "sign_in_required" })).text).toContain("Nothing was saved");
    expect(transferLabel(base({ state: "cancelled", reason: "cancelled_by_user" })).text).toContain("Nothing is available offline");
    expect(transferLabel(base({ state: "interrupted", reason: "page_closed" })).canRetry).toBe(true);
  });
  it("#41 pilot texts: sign-in, not a file and busy; the old combined redirect text is gone", () => {
    expect(transferLabel(base({ state: "failed", reason: "sign_in_required" })).text)
      .toBe("Download failed. Moodle returned a login page instead of the file. Sign in to SDU Moodle in Chrome, then retry. Nothing was saved.");
    expect(transferLabel(base({ state: "failed", reason: "not_a_file" })).text)
      .toBe("Download failed. This resource opens as a Moodle page, not a file. Open it in Moodle.");
    // 429/503: the record stays failed/network and carries networkDetail "busy" (#41 QA fix 2).
    expect(BUSY_TEXT).toBe("Moodle is busy. Try again later. Nothing was saved.");
    expect(transferLabel(base({ state: "failed", reason: "network", networkDetail: "busy" })).text)
      .toBe("Download failed. Moodle is busy. Try again later. Nothing was saved.");
    // Any other network failure (no detail) keeps the generic network text.
    expect(transferLabel(base({ state: "failed", reason: "network" })).text)
      .toBe("Download failed. Moodle could not be reached, or sent the request to another site. Nothing was saved.");
    expect(transferLabel(base({ state: "failed", reason: "network" })).text).not.toContain("Moodle is busy");
    const reasons = ["sign_in_required", "forbidden", "not_found", "network", "unsupported_type", "too_large", "timeout", "not_a_file", "download_interrupted", "page_closed", "outcome_unknown"] as const;
    for (const reason of reasons) {
      for (const state of ["failed", "interrupted"] as const) {
        const l = transferLabel(base({ state, reason }));
        expect(l.text).not.toMatch(/unreachable or redirected|redirected the request|often an expired login/);
        expect(l.text).not.toMatch(/available offline|Download record/);
        expect(l.canRetry).toBe(true);
      }
    }
    expect(transferLabel(base({ state: "failed", reason: "timeout" })).text).not.toContain("60 seconds");
  });
  it("#85 unsupported_type names the allowed types", () => {
    expect(transferLabel(base({ state: "failed", reason: "unsupported_type" })).text)
      .toBe("Download failed. Moodle did not return a valid PDF, DOCX or PPTX file of the listed type. Nothing was saved.");
  });
});

function snap(fileType: "pdf" | "docx" | "pptx" | "other" = "pdf"): Snapshot {
  const s = buildDemoSnapshot();
  s.collection = { records: [], reviews: [], refreshes: [] };
  s.materials = [{ id: "m-pdf", courseId: s.settings.trackedCourseIds[0]!, section: "Week 1", title: "Lecture 1", fileType, url: "https://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/lecture-1.pdf", accessible: true, stale: false, lastCheckedAt: "2026-10-30T09:00:00Z", syllabusSuggestion: false }];
  return s;
}
function mount(adapter: Record<string, unknown>, fileType: "pdf" | "docx" | "pptx" | "other" = "pdf") {
  state.app = { snap: snap(fileType), adapter: { downloadMaterial: vi.fn(), ...adapter }, setSnap: vi.fn(), error: null, retryLoad: vi.fn() };
  render(<Materials />);
}

describe("#41 explicit download control", () => {
  it("repeated clicks during an active transfer do not start duplicates", async () => {
    let resolve!: (v: unknown) => void;
    const start = vi.fn(() => new Promise((r) => { resolve = r; }));
    mount({ startMaterialDownload: start, listMaterialDownloads: vi.fn(async () => ({ transfers: [] })), cancelMaterialDownload: vi.fn() });
    const button = await screen.findByRole("button", { name: "Download file" });
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
    fireEvent.click(await screen.findByRole("button", { name: "Download file" }));
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
  it("a repeated click answered with the active transfer says it is already in progress", async () => {
    const { toast } = await import("sonner");
    const start = vi.fn(async () => ({ supported: true, message: "This download is already in progress.", transfer: base({ state: "validating" }) }));
    mount({ startMaterialDownload: start, listMaterialDownloads: vi.fn(async () => ({ transfers: [] })), cancelMaterialDownload: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: "Download file" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("This download is already in progress."));
    expect(await screen.findByRole("button", { name: "Downloading…" })).toBeDisabled();
  });
  it("shows the not-a-file, network and sign-in outcomes in the materials view", async () => {
    for (const [reason, text] of [["not_a_file", "opens as a Moodle page, not a file"], ["network", "Moodle could not be reached, or sent the request to another site."], ["sign_in_required", "Sign in to SDU Moodle in Chrome, then retry."]] as const) {
      mount({ startMaterialDownload: vi.fn(), listMaterialDownloads: vi.fn(async () => ({ transfers: [base({ state: "failed", reason })] })), cancelMaterialDownload: vi.fn() });
      expect((await screen.findByTestId("transfer-status")).textContent).toContain(text);
      expect(screen.getByRole("button", { name: "Download again" })).toBeEnabled();
      cleanup();
    }
  });
  it("shows the busy text for a busy network record and the generic text otherwise", async () => {
    for (const [record, text, not] of [
      [base({ state: "failed", reason: "network", networkDetail: "busy" }), "Download failed. Moodle is busy. Try again later. Nothing was saved.", "could not be reached"],
      [base({ state: "failed", reason: "network" }), "Download failed. Moodle could not be reached, or sent the request to another site. Nothing was saved.", "Moodle is busy"],
    ] as const) {
      mount({ startMaterialDownload: vi.fn(), listMaterialDownloads: vi.fn(async () => ({ transfers: [record] })), cancelMaterialDownload: vi.fn() });
      const status = await screen.findByTestId("transfer-status");
      expect(status.textContent).toContain(text);
      expect(status.textContent).not.toContain(not);
      expect(status.textContent).not.toMatch(/Download record|available offline/);
      expect(screen.getByRole("button", { name: "Download again" })).toBeEnabled();
      cleanup();
    }
  });
  it.each(["docx", "pptx"] as const)("#85 a %s file gets the same one-click Download file control", async (fileType) => {
    const start = vi.fn(async () => ({ supported: true, message: "Download queued.", transfer: base({}) }));
    mount({ startMaterialDownload: start, listMaterialDownloads: vi.fn(async () => ({ transfers: [] })), cancelMaterialDownload: vi.fn() }, fileType);
    const button = await screen.findByRole("button", { name: "Download file" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith("ds-1", "m-pdf", expect.any(String));
    expect(await screen.findByRole("button", { name: "Downloading…" })).toBeDisabled();
  });
  it("#85 another file type is never offered a download", async () => {
    const list = vi.fn(async () => ({ transfers: [] }));
    mount({ startMaterialDownload: vi.fn(), listMaterialDownloads: list, cancelMaterialDownload: vi.fn() }, "other");
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Download file" })).toBeNull();
  });
  it("#85 a failed unsupported_type record shows the allowed-types text", async () => {
    mount({ startMaterialDownload: vi.fn(), listMaterialDownloads: vi.fn(async () => ({ transfers: [base({ state: "failed", reason: "unsupported_type" })] })), cancelMaterialDownload: vi.fn() }, "pptx");
    expect((await screen.findByTestId("transfer-status")).textContent).toContain("Moodle did not return a valid PDF, DOCX or PPTX file of the listed type. Nothing was saved.");
    expect(screen.getByRole("button", { name: "Download again" })).toBeEnabled();
  });
  it("demo/HTTP adapters keep the legacy capability message path", () => {
    mount({});
    expect(screen.queryByRole("button", { name: "Download file" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });
});

/**
 * #41 QA fix 2: the records below are exactly what the transfer page reports and the backend stores
 * (browser-workspace/material-transfer-lease.test.ts; tests/test_material_downloads.py round trip).
 */
describe("#41 busy outcome in the materials view (AC1 limits, Frontend constraint)", () => {
  const show = async (record: MaterialTransfer) => {
    mount({ startMaterialDownload: vi.fn(), listMaterialDownloads: vi.fn(async () => ({ transfers: [record] })), cancelMaterialDownload: vi.fn() });
    return (await screen.findByTestId("transfer-status")).textContent ?? "";
  };
  it.each([429, 503])("%i on the file (failed/network, networkDetail busy): the busy text", async () => {
    const shown = await show(base({ state: "failed", reason: "network", networkDetail: "busy" }));
    expect(shown).toContain("Moodle is busy. Try again later. Nothing was saved.");
    expect(shown).not.toContain("could not be reached");
    expect(shown).not.toMatch(/Download record|available offline/);
  });
  it("a generic network error (failed/network, no detail): the generic network text", async () => {
    const shown = await show(base({ state: "failed", reason: "network" }));
    expect(shown).toContain("Moodle could not be reached, or sent the request to another site. Nothing was saved.");
    expect(shown).not.toContain("Moodle is busy");
  });
});
