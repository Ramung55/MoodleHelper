import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalExtraction } from "@/components/mh/LocalExtraction";
import { webcrypto } from "node:crypto";
import { buildDemoSnapshot } from "@/services/fixtures";
const mock = vi.hoisted(() => ({ read: vi.fn(), context: vi.fn(), extract: vi.fn(), route: vi.fn() }));
vi.mock("@/services/local-documents", () => ({ readLocalDocument: mock.read, currentDataset: mock.context }));
vi.mock("@/services/extract-pdf", () => ({ extractPdf: mock.extract }));
vi.mock("@/services/route-local-syllabus", () => ({ routeLocalProposals: mock.route }));
const association = { datasetId: "dataset", courseId: "course", digest: "digest", name: "source.pdf", size: 10, source: "Local selection", createdAt: "now" };
const pages = [{ page: 2, width: 500, height: 400, status: "text", rows: [{ text: "Задание 1 29 октября", items: [{ text: "Задание 1", page: 2, transform: [12, 0, 0, 12, 40, 290], width: 100, height: 12 }] }] }];
beforeEach(() => {
  vi.resetAllMocks(); mock.read.mockResolvedValue(new Blob(["pdf"])); mock.context.mockResolvedValue("dataset"); mock.extract.mockResolvedValue(pages);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:local-preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("extracts only on explicit action, renders inert page evidence and revokes local original preview", async () => {
  const view = render(<LocalExtraction document={association} />);
  expect(mock.read).not.toHaveBeenCalled(); expect(mock.extract).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Extract text" }));
  expect(await screen.findByText("Задание 1 29 октября")).toBeVisible();
  expect(mock.read).toHaveBeenCalledWith(association, expect.any(AbortSignal));
  fireEvent.click(screen.getByText("Задание 1 29 октября"));
  expect(screen.getByText(/transform \[12, 0, 0, 12, 40, 290\]/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Inspect original page 2" }));
  expect(await screen.findByTitle("Original source.pdf, page 2")).toHaveAttribute("src", "blob:local-preview#page=2");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-preview");
  view.unmount();
});
it.each(["changed", "offline", "missing"])("does not publish evidence with %s source/context", async (failure) => {
  if (failure === "changed") mock.context.mockResolvedValue("other");
  if (failure === "offline") mock.context.mockRejectedValue(new Error("Context unavailable"));
  if (failure === "missing") mock.read.mockRejectedValue(new Error("Original document unavailable. Reselect it."));
  render(<LocalExtraction document={association} />); fireEvent.click(screen.getByText("Extract text"));
  await screen.findByText(/Extraction failed:/);
  expect(screen.queryByText("Задание 1 29 октября")).not.toBeInTheDocument();
  if (failure === "missing") expect(mock.extract).not.toHaveBeenCalled();
});
it("discards late results after cancel and aborts work on unmount", async () => {
  let resolve!: (pages: unknown) => void;
  mock.extract.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = render(<LocalExtraction document={association} />); fireEvent.click(screen.getByText("Extract text"));
  await waitFor(() => expect(mock.extract).toHaveBeenCalledOnce());
  const signal = mock.extract.mock.calls[0]![1] as AbortSignal;
  fireEvent.click(screen.getByText("Cancel extraction")); expect(signal.aborted).toBe(true);
  await act(async () => { resolve(pages); });
  expect(screen.queryByText("Задание 1 29 октября")).not.toBeInTheDocument();
  // A real worker rejects when destroyed; even a misbehaving late resolver is fenced.
  view.unmount();
});
it("aborts a replaced association and permits a new extraction without publishing the old result", async () => {
  let resolve!: (pages: unknown) => void;
  mock.extract.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<LocalExtraction document={association} />); fireEvent.click(screen.getByText("Extract text"));
  await waitFor(() => expect(mock.extract).toHaveBeenCalledOnce());
  const signal = mock.extract.mock.calls[0]![1] as AbortSignal;
  view.rerender(<LocalExtraction document={{ ...association, digest: "replacement" }} />);
  expect(signal.aborted).toBe(true); expect(screen.getByText("Extract text")).toBeEnabled();
  await act(async () => { resolve(pages); });
  expect(screen.queryByText("Задание 1 29 октября")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Extract text"));
  expect(await screen.findByText("Задание 1 29 октября")).toBeVisible();
});
it("clears local evidence when assessment detection finds a changed dataset", async () => {
  render(<LocalExtraction document={association} />); fireEvent.click(screen.getByText("Extract text"));
  await screen.findByText("Задание 1 29 октября");
  mock.context.mockResolvedValue("other-dataset");
  fireEvent.click(screen.getByText("Find assessments"));
  expect(await screen.findByText(/Detection failed: The dataset changed/)).toBeVisible();
  expect(screen.queryByText("Задание 1 29 октября")).not.toBeInTheDocument();
  expect(screen.queryByText("Possible assessments · unconfirmed")).not.toBeInTheDocument();
});
it("shows missing-year uncertainty until explicit semester bounds justify a unique year", async () => {
  vi.stubGlobal("crypto", webcrypto);
  render(<LocalExtraction document={association} />); fireEvent.click(screen.getByText("Extract text"));
  await screen.findByText("Задание 1 29 октября"); fireEvent.click(screen.getByText("Find assessments"));
  await screen.findByText("Possible assessments · unconfirmed");
  fireEvent.click(screen.getByText("Задание 1 · assignment · Unconfirmed"));
  fireEvent.click(screen.getByText("Interpret explicit dates"));
  expect(await screen.findByText(/Missing year; no explicit semester/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Explicit semester start"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("Explicit semester end"), { target: { value: "2026-12-31" } });
  expect(screen.queryByText(/Missing year; no explicit semester/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Interpret explicit dates"));
  expect(await screen.findByText('{"kind":"date","date":"2026-10-29"}')).toBeVisible();
  expect(screen.getByText(/Year inferred from explicit semester/)).toBeVisible();
});
it("does not turn malformed written clock-zone evidence into an exact preview using supplied context", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const text = "Exam due 2027-03-12T14:00, XYZ";
  mock.extract.mockResolvedValue([{ ...pages[0], rows: [{ text, items: [{ ...pages[0]!.rows[0]!.items[0], text }] }] }]);
  render(<LocalExtraction document={association} />); fireEvent.click(screen.getByText("Extract text"));
  await screen.findByText(text); fireEvent.click(screen.getByText("Find assessments"));
  await screen.findByText("Possible assessments · unconfirmed"); fireEvent.click(screen.getByText("Exam · exam · Unconfirmed"));
  fireEvent.change(screen.getByLabelText("Document timezone"), { target: { value: "Asia/Almaty" } });
  fireEvent.click(screen.getByText("Interpret explicit dates"));
  expect(await screen.findByText(/Original date expression: 2027-03-12T14:00, XYZ/)).toBeVisible();
  expect(screen.getByText('{"kind":"unknown"}')).toBeVisible();
  expect(screen.getByText(/complete written expression requires review/)).toBeVisible();
  expect(screen.queryByText(/"kind":"exact"/)).not.toBeInTheDocument();
});
it.each(["cancel", "context-change", "reject", "complete"])("fences mounted local routing outcome: %s", async mode => {
  vi.stubGlobal("crypto", webcrypto);
  const text = "Assignment 1 due 29 October 2027";
  mock.extract.mockResolvedValue([{ ...pages[0], rows: [{ text, items: [{ ...pages[0].rows[0].items[0], text }] }] }]);
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  mock.route.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const publish = vi.fn();
  const commit = vi.fn(async work => { try { const snapshot = await work(); publish(snapshot); return true; } catch { return false; } });
  const mounted = render(<LocalExtraction document={association} commitRoute={commit} />);
  fireEvent.click(screen.getByText("Extract text")); await screen.findByText(text);
  fireEvent.click(screen.getByText("Find assessments")); await screen.findByText("Possible assessments · unconfirmed");
  fireEvent.click(screen.getByText("Interpret explicit dates")); await screen.findByText('{"kind":"date","date":"2027-10-29"}');
  fireEvent.click(screen.getByText("Retain evidence and route proposals")); await waitFor(() => expect(mock.route).toHaveBeenCalledOnce());
  if (mode === "cancel") fireEvent.click(screen.getByText("Cancel routing"));
  if (mode === "context-change") mounted.rerender(<LocalExtraction document={{ ...association, datasetId: "changed" }} commitRoute={commit} />);
  await act(async () => {
    if (mode === "reject") reject(new Error("Final context unavailable"));
    else resolve({ snapshot: buildDemoSnapshot(), routes: [{ mentionId: "stored-mention", documentId: "registered-doc", candidateId: "registered-candidate", disposition: "auto", reasons: ["clear_explicit"] }] });
  });
  if (mode === "complete") { expect(publish).toHaveBeenCalledOnce(); expect(screen.getByRole("status")).toHaveTextContent("1 stored proposals routed"); }
  else { expect(publish).not.toHaveBeenCalled(); expect(screen.queryByText(/1 stored proposals routed/)).not.toBeInTheDocument(); }
  if (mode === "cancel") expect(screen.getByRole("status")).toHaveTextContent("may already be committed");
});
