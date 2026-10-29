import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ read: vi.fn(), context: vi.fn(), run: vi.fn() }));
vi.mock("@/services/local-documents", () => ({ readLocalDocument: mock.read, currentDataset: mock.context }));
vi.mock("@/services/ocr-pdf", async (original) => ({ ...await original<typeof import("@/services/ocr-pdf")>(), runOcr: mock.run }));
import { LocalOcr } from "@/components/mh/LocalOcr";
const association = { datasetId: "dataset", courseId: "course", digest: "sha256", name: "scan.pdf", size: 100, source: "Local", createdAt: "now" };
const partial = { selectedPages: [1,3], pages: [{ page: 1, width: 100, height: 100, text: "Exam", confidence: 92, regions: [], status: "recognized" }], complete: false, status: "cancelled", language: "eng+rus", dpi: 120, engine: "tesseract.js-7.0.0" };
beforeEach(() => { vi.clearAllMocks(); mock.read.mockResolvedValue(new Blob(["pdf"])); mock.context.mockResolvedValue("dataset"); mock.run.mockResolvedValue(partial); });
afterEach(cleanup);
it("requires explicit selected pages and shows configurable defaults, original evidence and incomplete cancellation", async () => {
  const inspect = vi.fn(async () => {}); render(<LocalOcr document={association} onInspect={inspect} />);
  fireEvent.click(screen.getByText("OCR selected scanned PDF pages"));
  expect(mock.read).not.toHaveBeenCalled(); expect(screen.getByLabelText("OCR Pages/job")).toHaveValue(20); expect(screen.getByLabelText("OCR Render DPI")).toHaveValue(120);
  expect(screen.getByLabelText("OCR Milliseconds/page")).toHaveValue(60000);
  fireEvent.click(screen.getByText("Start selected-page OCR")); expect(screen.getByText(/Enter selected original page/)).toBeVisible(); expect(mock.read).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("OCR original pages"), { target: { value: "1, 3" } });
  fireEvent.click(screen.getByText("Start selected-page OCR"));
  expect(await screen.findByText("OCR cancelled. Partial results are incomplete.")).toBeVisible();
  expect(mock.run).toHaveBeenCalledWith(expect.any(Blob), [1,3], "eng+rus", expect.objectContaining({ maxPages: 20, dpi: 120, millisecondsPerPage: 60000 }), expect.any(AbortSignal), expect.any(Function));
  expect(screen.getByText(/scan.pdf · original page 1 · recognized · incomplete job/)).toBeVisible();
  fireEvent.click(screen.getByText("Inspect OCR original page 1")); expect(inspect).toHaveBeenCalledWith(1);
});
it("aborts active OCR and suppresses late progress after cancellation or unmount", async () => {
  let finish!: (value: unknown) => void;
  mock.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<LocalOcr document={association} onInspect={vi.fn()} />); fireEvent.click(screen.getByText("OCR selected scanned PDF pages"));
  fireEvent.change(screen.getByLabelText("OCR original pages"), { target: { value: "1,3" } }); fireEvent.click(screen.getByText("Start selected-page OCR"));
  await waitFor(() => expect(mock.run).toHaveBeenCalledOnce()); const signal = mock.run.mock.calls[0]![4] as AbortSignal;
  fireEvent.click(screen.getByText("Cancel OCR")); expect(signal.aborted).toBe(true);
  act(() => mock.run.mock.calls[0]![5]({ total: 2, completed: 2, failed: 0, remaining: 0, pages: [{ ...partial.pages[0], text: "late private result" }] }));
  expect(screen.queryByText("late private result")).not.toBeInTheDocument();
  view.unmount(); await act(async () => finish(partial)); expect(screen.queryByText("Exam")).not.toBeInTheDocument();
});
it("fails closed when the dataset changes before publication", async () => {
  mock.context.mockResolvedValue("other-dataset"); render(<LocalOcr document={association} onInspect={vi.fn()} />); fireEvent.click(screen.getByText("OCR selected scanned PDF pages"));
  fireEvent.change(screen.getByLabelText("OCR original pages"), { target: { value: "1" } }); fireEvent.click(screen.getByText("Start selected-page OCR"));
  expect(await screen.findByText(/The dataset changed/)).toBeVisible(); expect(screen.queryByText("Exam")).not.toBeInTheDocument();
});
