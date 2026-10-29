import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OCR_LIMITS, ocrQuality, runOcr, type OcrDependencies } from "@/services/ocr-pdf";
const text = { text: "Exam 29 October 2026", confidence: 95, blocks: [] };
function setup() {
  const close = vi.fn(async () => {}), render = vi.fn(async () => ({ bytes: new Uint8Array([1]), width: 100, height: 100 })), terminate = vi.fn();
  const engine = { ready: Promise.resolve(), terminate, recognize: vi.fn(async () => text) };
  const dependencies: OcrDependencies = { open: vi.fn(async () => ({ pageCount: 100, render, close })), engine: vi.fn(() => engine) };
  return { dependencies, render, close, engine, terminate };
}
beforeEach(() => vi.useRealTimers()); afterEach(() => vi.useRealTimers());
describe("bounded selected-page OCR", () => {
  it("renders only selected original pages in sorted order and reports counts/provenance", async () => {
    const mock = setup(), progress = vi.fn();
    const result = await runOcr(new Blob(), [7, 2], "eng+rus", DEFAULT_OCR_LIMITS, new AbortController().signal, progress, mock.dependencies);
    expect(mock.render.mock.calls.map((call) => call[0])).toEqual([2, 7]);
    expect(result).toMatchObject({ selectedPages: [2, 7], status: "complete", complete: true, engine: "tesseract.js-7.0.0", dpi: 120 });
    expect(result.pages.map((page) => page.page)).toEqual([2, 7]); expect(mock.dependencies.engine).toHaveBeenCalledOnce();
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ completed: 2, failed: 0, remaining: 0 });
    expect(mock.terminate).toHaveBeenCalledOnce(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it.each([[], [0], [1, 1], [1.5], Array.from({ length: 21 }, (_, i) => i + 1)].map((selection) => [selection]))("rejects invalid/over-limit selection %j before opening or rendering", async (selection) => {
    const mock = setup(); await expect(runOcr(new Blob(), selection, "eng", DEFAULT_OCR_LIMITS, new AbortController().signal, vi.fn(), mock.dependencies)).rejects.toThrow(/Select unique/);
    expect(mock.dependencies.open).not.toHaveBeenCalled();
  });
  it("refuses out-of-range pages and invalid resource configuration", async () => {
    const mock = setup(); await expect(runOcr(new Blob(), [101], "eng", DEFAULT_OCR_LIMITS, new AbortController().signal, vi.fn(), mock.dependencies)).rejects.toThrow(/outside this PDF/);
    await expect(runOcr(new Blob(), [1], "eng", { ...DEFAULT_OCR_LIMITS, maxPixels: 9_000_000 }, new AbortController().signal, vi.fn(), mock.dependencies)).rejects.toThrow(/limits are invalid/);
  });
  it("cancels mid-recognition, terminates worker and keeps partial pages explicitly incomplete", async () => {
    const mock = setup(), controller = new AbortController();
    mock.engine.recognize.mockResolvedValueOnce(text).mockImplementationOnce(() => new Promise(() => {}));
    const work = runOcr(new Blob(), [1, 2, 3], "eng", DEFAULT_OCR_LIMITS, controller.signal, vi.fn(), mock.dependencies);
    await vi.waitFor(() => expect(mock.engine.recognize).toHaveBeenCalledTimes(2)); controller.abort();
    const result = await work; expect(result).toMatchObject({ status: "cancelled", complete: false }); expect(result.pages.map((page) => page.page)).toEqual([1]);
    expect(mock.terminate).toHaveBeenCalled(); expect(mock.render).toHaveBeenCalledTimes(2);
  });
  it("cancels mid-render and never starts the OCR worker", async () => {
    const mock = setup(), controller = new AbortController(); mock.render.mockImplementation(() => new Promise(() => {}));
    const work = runOcr(new Blob(), [1], "eng", DEFAULT_OCR_LIMITS, controller.signal, vi.fn(), mock.dependencies);
    await vi.waitFor(() => expect(mock.render).toHaveBeenCalled()); controller.abort();
    expect((await work).status).toBe("cancelled"); expect(mock.dependencies.engine).not.toHaveBeenCalled(); expect(mock.close).toHaveBeenCalled();
  });
  it("times out rendering/recognition and reports failures and remaining without false completion", async () => {
    vi.useFakeTimers(); const mock = setup(); mock.engine.recognize.mockImplementationOnce(() => new Promise(() => {}));
    const work = runOcr(new Blob(), [1, 2], "eng", { ...DEFAULT_OCR_LIMITS, millisecondsPerPage: 1000 }, new AbortController().signal, vi.fn(), mock.dependencies);
    await vi.advanceTimersByTimeAsync(1001); const result = await work;
    expect(result).toMatchObject({ complete: false, status: "incomplete" }); expect(result.pages[0]).toMatchObject({ status: "failed", error: expect.stringContaining("timed out") });
    expect(result.pages[1]!.status).toBe("recognized"); expect(mock.terminate).toHaveBeenCalled();
  });
  it("marks empty/poor confidence as review-needed and rejects oversized output", () => {
    expect(ocrQuality({ text: "", confidence: 0 }, 4, 100, 100, 1000)).toMatchObject({ page: 4, status: "review_needed" });
    expect(ocrQuality({ text: "unreadable??", confidence: 30 }, 4, 100, 100, 1000).status).toBe("review_needed");
    expect(() => ocrQuality({ text: "a".repeat(1001), confidence: 99 }, 1, 100, 100, 1000)).toThrow(/limits/);
  });
});
