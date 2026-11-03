import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ getDocument: vi.fn(), page: {} as any, destroy: vi.fn(async () => {}) }));
vi.mock("pdfjs-dist", () => ({ getDocument: mock.getDocument, GlobalWorkerOptions: {}, VerbosityLevel: { ERRORS: 0 } }));
import { DEFAULT_OCR_LIMITS, openOcrPdf } from "@/services/ocr-pdf";
beforeEach(() => { vi.clearAllMocks(); mock.page = { getViewport: () => ({ width: 10000, height: 10000 }), cleanup: vi.fn(), render: vi.fn() }; mock.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 20, getPage: vi.fn(async () => mock.page) }), destroy: mock.destroy }); });
afterEach(() => vi.restoreAllMocks());
const file = { size: 1, arrayBuffer: async () => new ArrayBuffer(1) } as Blob;
it("checks pixel/side bounds before allocating a canvas and reads only the selected page", async () => {
  const allocate = vi.spyOn(document, "createElement");
  const pdf = await openOcrPdf(file, new AbortController().signal);
  await expect(pdf.render(7, DEFAULT_OCR_LIMITS, new AbortController().signal)).rejects.toThrow(/pixel\/canvas limit/);
  expect(allocate).not.toHaveBeenCalled(); expect(mock.page.render).not.toHaveBeenCalled(); await pdf.close(); expect(mock.destroy).toHaveBeenCalled();
});
it("cancels native render task and releases canvas on abort", async () => {
  mock.page.getViewport = () => ({ width: 100, height: 100 });
  const cancel = vi.fn(); mock.page.render.mockReturnValue({ promise: new Promise(() => {}), cancel });
  const canvas = { width: 0, height: 0, getContext: () => ({}) };
  vi.spyOn(document, "createElement").mockReturnValue(canvas as any);
  const pdf = await openOcrPdf(file, new AbortController().signal), controller = new AbortController();
  const rendering = pdf.render(2, DEFAULT_OCR_LIMITS, controller.signal);
  await vi.waitFor(() => expect(mock.page.render).toHaveBeenCalled()); controller.abort();
  await expect(rendering).rejects.toMatchObject({ name: "AbortError" }); expect(cancel).toHaveBeenCalled(); expect(canvas.width).toBe(0); await pdf.close();
});
