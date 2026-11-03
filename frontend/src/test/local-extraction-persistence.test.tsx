/**
 * #44 row 10: after a reload, the imported document, its extracted text, mentions, interpreted dates,
 * evidence and validated AI proposals are restored from this browser's store, unconfirmed, with nothing
 * resent. A record for a different SHA-256 is never restored, and erase removes the records.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalExtraction } from "@/components/mh/LocalExtraction";
import type { AvailableAi } from "@/services/ai-fallback";
import { saveLocalDocument, type LocalAssociation } from "@/services/local-documents";
import { captureLocalFence, clearLocalDataset } from "@/services/local-erase";
import { EXTRACTION_SETTINGS, saveStoredExtraction } from "@/services/local-extraction-store";
import { indexedDbFixture } from "./indexeddb-fixture";

const mock = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("@/services/extract-pdf", () => ({ extractPdf: mock.extract }));

const datasetId = "12345678-1234-4123-8123-123456789abc";
const digest = "c".repeat(64), otherDigest = "d".repeat(64);
const association: LocalAssociation = { datasetId, courseId: "c-csc", digest, name: "syllabus.pdf", size: 3, source: "Local selection", createdAt: "now" };
const pages = [{ page: 2, width: 500, height: 400, status: "text", rows: [{ text: "Задание 1 29 октября", items: [{ text: "Задание 1 29 октября", page: 2, transform: [12, 0, 0, 12, 40, 290], width: 100, height: 12 }] }] }];
const info: AvailableAi = { available: true, provider: "Local mock; no external provider", retention: "Mock demonstration; stays local.", mode: "mock", policyVersion: "mock-policy-1", destination: "mock",
  limits: { maxExcerpts: 8, maxExcerptBytes: 2000, maxBodyBytes: 16384, timeoutSeconds: 30, monthlyCapUsd: 0, perRequestReserveUsd: 0, simulatedCost: true } };
let storage: ReturnType<typeof indexedDbFixture>, calls: string[];

beforeEach(async () => {
  vi.resetAllMocks(); mock.extract.mockResolvedValue(pages); calls = [];
  storage = indexedDbFixture();
  vi.stubGlobal("indexedDB", storage.indexedDB); vi.stubGlobal("IDBKeyRange", storage.IDBKeyRange);
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NodeBlob);
  // The local backend only: dataset identity and the mock AI gateway. No live provider is reachable.
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(url);
    if (url.endsWith("/api/local-context")) return new Response(JSON.stringify({ datasetId }));
    if (url.endsWith("/api/ai/availability")) return new Response(JSON.stringify(info));
    if (url.endsWith("/api/bridge-context")) return new Response(JSON.stringify({ version: "1", binding: "b" }));
    if (url.endsWith("/api/ai/extract")) {
      const body = JSON.parse(String(init.body)) as { requestId: string; excerpts: { id: string; locationId: string }[] };
      const excerpt = body.excerpts[0]!;
      return new Response(JSON.stringify({ version: "ai-extract.v1", requestId: body.requestId, mode: "mock", policyVersion: "mock-policy-1", status: "ok",
        proposals: [{ title: "Задание 1 (AI)", type: "assignment", date: { value: "2026-10-29", precision: "date" }, uncertain: true, uncertaintyReason: "missing_year", confirmed: false, evidence: [{ excerptId: excerpt.id, locationId: excerpt.locationId, start: 0, end: 9 }] }] }));
    }
    throw new Error(`unexpected ${url}`);
  }));
  for (const d of [digest, otherDigest]) await saveLocalDocument({ ...association, digest: d }, new NodeBlob([d]) as unknown as Blob, [], new AbortController().signal);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rows = () => storage.controls.rows("extractions");
const aiExtracts = () => calls.filter(url => url.endsWith("/api/ai/extract")).length;

/** Steps 1–9 in short: extract, find, interpret, then one mock AI proposal. */
async function extractFindInterpretAndAskAi() {
  const view = render(<LocalExtraction document={association} />);
  fireEvent.click(screen.getByRole("button", { name: "Extract text" }));
  await screen.findByText("Задание 1 29 октября");
  fireEvent.click(screen.getByRole("button", { name: "Find assessments" }));
  await screen.findByText("Possible assessments · unconfirmed");
  fireEvent.click(screen.getByRole("button", { name: "Interpret explicit dates" }));
  await screen.findByText(/Date proposals are ready/);
  fireEvent.click(screen.getByRole("button", { name: "Optional AI help" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select excerpt Задание 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Review what will be sent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send" }));
  await screen.findByText(/1 AI proposals validated/);
  await waitFor(() => expect(rows()[0]?.ai?.records).toHaveLength(1));
  return view;
}

it("restores the extraction, mentions, evidence and unconfirmed AI proposals after a reload, sending nothing", async () => {
  const view = await extractFindInterpretAndAskAi();
  expect(aiExtracts()).toBe(1);
  const stored = rows()[0]!;
  expect(stored).toMatchObject({ datasetId, courseId: "c-csc", digest, settings: EXTRACTION_SETTINGS });
  expect(stored.mentions).toHaveLength(1); expect(stored.parsedDates).toHaveLength(1);
  view.unmount();

  // Reload: a fresh mount over the same browser store.
  render(<LocalExtraction document={association} />);
  expect(await screen.findByText(/Restored from this browser/)).toBeVisible();
  expect(screen.getByText("Задание 1 29 октября", { selector: "summary" })).toBeVisible();
  expect(screen.getByText("Possible assessments · unconfirmed")).toBeVisible();
  fireEvent.click(screen.getByText("Задание 1 · assignment · Unconfirmed"));
  expect(screen.getByText(/^Original mention offsets \d+–\d+; source pdf_row; SHA-256 c{64}$/)).toBeVisible();
  expect(screen.getByText("Original date expression: 29 октября")).toBeInTheDocument();
  const restored = screen.getByLabelText("Restored AI proposals");
  expect(restored).toHaveTextContent("1 AI proposals restored from this browser");
  expect(restored).toHaveTextContent("All are unconfirmed and require review. No AI request was resent or resumed.");
  expect(restored).toHaveTextContent("Задание 1 (AI) · assignment · 2026-10-29");
  // Nothing was re-extracted, re-sent or resumed.
  expect(mock.extract).toHaveBeenCalledOnce();
  expect(aiExtracts()).toBe(1);
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(screen.queryByText(/Waiting for the gateway/)).toBeNull();
  expect(rows()[0]!.ai.records.every((record: { state: string }) => record.state === "pending")).toBe(true);
});

it("never restores a record whose document SHA-256 differs, and drops it", async () => {
  const view = await extractFindInterpretAndAskAi(); view.unmount();
  // A different document (other SHA-256) shows nothing from the first one.
  render(<LocalExtraction document={{ ...association, digest: otherDigest }} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.queryByText(/Restored from this browser/)).toBeNull();
  expect(screen.queryByText("Задание 1 29 октября")).toBeNull();
  cleanup();
  // A stale record filed under the other document but holding the first document's results is refused and removed.
  const first = rows().find(row => row.digest === digest)!;
  await saveStoredExtraction({ ...first, digest: otherDigest }, await captureLocalFence(datasetId));
  expect(rows().filter(row => row.digest === otherDigest)).toHaveLength(1);
  render(<LocalExtraction document={{ ...association, digest: otherDigest }} />);
  await waitFor(() => expect(rows().filter(row => row.digest === otherDigest)).toHaveLength(0));
  expect(screen.queryByText(/Restored from this browser/)).toBeNull();
  expect(screen.queryByText("Possible assessments · unconfirmed")).toBeNull();
});

it("erase removes the stored results, nothing is restored afterwards, and a mounted view cannot write them back", async () => {
  await extractFindInterpretAndAskAi();
  expect(rows()).toHaveLength(1);
  await clearLocalDataset({ datasetId, epoch: 1, eraseId: "e".repeat(32) });
  expect(rows()).toHaveLength(0);
  // A later change in the still-mounted view is fenced by the erase epoch.
  fireEvent.click(screen.getByRole("button", { name: "Interpret explicit dates" }));
  await screen.findByText(/Date proposals are ready/);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(rows()).toHaveLength(0);
  cleanup();
  render(<LocalExtraction document={association} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.queryByText(/Restored from this browser/)).toBeNull();
  expect(screen.queryByText("Задание 1 29 октября")).toBeNull();
});
