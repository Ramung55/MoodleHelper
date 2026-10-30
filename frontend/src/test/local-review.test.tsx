import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { DecompressionStream as NativeDecompressionStream } from "node:stream/web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { extractDocx } from "@/services/extract-docx";
import { detectAssessmentMentions } from "@/domain/assessment-mentions";
import { parseSyllabusMention } from "@/domain/syllabus-dates";
import { prepareLocalEvidence } from "@/domain/local-routing";
import { readLocalEvidence, retainLocalEvidence, type LocalEvidenceRecord } from "@/services/local-evidence";
import { saveLocalDocument } from "@/services/local-documents";
import { inspectLocalReviewEvidence, submitLocalReview } from "@/services/local-review";
import { BackendResponseError } from "@/services/http-adapter";
import { buildDemoSnapshot } from "@/services/fixtures";
import type { ExtractionCandidate, Snapshot } from "@/domain/types";
import { indexedDbFixture } from "./indexeddb-fixture";

const app = vi.hoisted(() => ({ snap: undefined as unknown, run: undefined as unknown }));
vi.mock("@/lib/app-store", () => ({ useApp: () => ({ snap: app.snap, run: app.run, views: [] }) }));
import { LocalReviewCard, correctionErrors, describeLocation } from "@/components/mh/LocalReviewCard";

const datasetId = "12345678-1234-4123-8123-123456789abc", digest = "a".repeat(64);
const association = { datasetId, courseId: "c-csc", digest, name: "local.docx", size: 100, source: "Local", createdAt: "now" };
let storage: ReturnType<typeof indexedDbFixture>;
beforeEach(() => {
  storage = indexedDbFixture();
  vi.stubGlobal("indexedDB", storage.indexedDB); vi.stubGlobal("IDBKeyRange", storage.IDBKeyRange);
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("DecompressionStream", NativeDecompressionStream);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ datasetId }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Actual DOCX extraction → #28 mentions → #29 dates → #31 retained evidence, registered as review candidates. */
async function registered(): Promise<{ records: LocalEvidenceRecord[]; snapshot: Snapshot; candidates: ExtractionCandidate[] }> {
  const blob = new NodeBlob([readFileSync("src/test/fixtures/extraction-bilingual.docx")]) as unknown as Blob;
  await saveLocalDocument(association, blob, [], new AbortController().signal);
  const blocks = await extractDocx(blob, new AbortController().signal, vi.fn());
  const extraction = { format: "docx" as const, datasetId, courseId: association.courseId, digest, complete: true as const, blocks };
  const mentions = await detectAssessmentMentions(extraction, new AbortController().signal);
  const records = await prepareLocalEvidence(extraction, mentions, mentions.map(mention => parseSyllabusMention(mention)), undefined, true, new AbortController().signal);
  await retainLocalEvidence(records, new AbortController().signal);
  const snapshot = buildDemoSnapshot();
  const candidates = records.map((record, index): ExtractionCandidate => ({ id: `local-k-${index}`, documentId: "local-d-1", courseId: record.courseId, title: record.proposal.title, type: record.proposal.type, date: record.proposal.date, rawDateText: "", language: record.proposal.language ?? "unknown", confidence: 0, excerpt: "", location: "", status: "pending", localEvidence: { datasetId, courseId: record.courseId, digest, mentionId: record.mentionId, locationId: record.locationId, pipelineVersion: record.pipelineVersion } }));
  snapshot.candidates = [...snapshot.candidates, ...candidates];
  snapshot.localSyllabusReceipts = candidates.map((candidate, index) => ({ evidence: candidate.localEvidence!, fingerprint: String(index + 1).repeat(64), route: { mentionId: records[index].mentionId, documentId: "local-d-1", candidateId: candidate.id, disposition: "review" as const, reasons: ["year_inferred" as const] } }));
  return { records, snapshot, candidates };
}
const decided = (snapshot: Snapshot, id: string, decisionId: string, kind: "confirm" | "reject" = "confirm"): Snapshot => ({ ...snapshot, candidates: snapshot.candidates.map(item => item.id !== id ? item : { ...item, status: kind === "reject" ? "rejected" : "confirmed", localDecision: { decisionId, proposalFingerprint: "1".repeat(64), requestFingerprint: "f".repeat(64), kind, originalValues: { title: item.title, type: item.type, date: item.date as never }, evidenceMode: "original-available", acknowledgedStoredOnly: false, decidedAt: "2027-01-01T00:00:00Z" } }) });
const reviewAudit = async (record: LocalEvidenceRecord) => (await readLocalEvidence(record)).record!.audit.filter(entry => entry.kind.startsWith("review-")) as any[];

it("validates original availability, stored-only source loss and missing/corrupt/mismatched evidence without fallback", async () => {
  const { records, snapshot, candidates } = await registered();
  expect((await inspectLocalReviewEvidence(candidates[0], snapshot)).mode).toBe("original-available");
  storage.controls.remove("blobs", [datasetId, digest]);
  const stored = await inspectLocalReviewEvidence(candidates[0], snapshot);
  expect(stored.mode).toBe("stored-evidence-only");
  expect(stored.mode !== "unavailable" && stored.record.original).toEqual(records[0].original);
  expect((await inspectLocalReviewEvidence({ ...candidates[0], title: "Server title drift" }, snapshot))).toMatchObject({ mode: "unavailable", reason: expect.stringMatching(/does not match the registered server proposal/) });
  expect((await inspectLocalReviewEvidence(candidates[0], { ...snapshot, localSyllabusReceipts: [] }))).toMatchObject({ mode: "unavailable", reason: expect.stringMatching(/receipt/) });
  storage.controls.remove("evidence", [datasetId, "c-csc", digest, records[0].mentionId, records[0].pipelineVersion]);
  expect((await inspectLocalReviewEvidence(candidates[0], snapshot))).toMatchObject({ mode: "unavailable", reason: expect.stringMatching(/not stored/) });
  await retainLocalEvidence([{ ...records[0], original: { ...records[0].original, mention: { ...records[0].original.mention, excerpt: "tampered" } } }], new AbortController().signal);
  expect((await inspectLocalReviewEvidence(candidates[0], snapshot))).toMatchObject({ mode: "unavailable", reason: expect.stringMatching(/corrupt/) });
});

it("stores the pending audit before HTTP, sends nothing on quota failure and records the committed receipt", async () => {
  const { records, snapshot, candidates } = await registered();
  const evidence = await inspectLocalReviewEvidence(candidates[0], snapshot);
  const client = { load: vi.fn(), review: vi.fn(async (id: string, decision: any) => decided(snapshot, id, decision.localReview.decisionId)) };
  storage.controls.failNextEvidenceWrite = true;
  await expect(submitLocalReview(candidates[0], snapshot, evidence, { kind: "confirm" }, false, client)).rejects.toThrow(/Nothing was sent/);
  expect(client.review).not.toHaveBeenCalled(); expect(await reviewAudit(records[0])).toHaveLength(0);
  const result = await submitLocalReview(candidates[0], snapshot, evidence, { kind: "confirm" }, false, client);
  const wire = client.review.mock.calls[0][1];
  expect(wire).toEqual({ kind: "confirm", localReview: { datasetId, pipelineVersion: "local-syllabus-1", proposalFingerprint: "1".repeat(64), decisionId: expect.stringMatching(/^review-/), evidenceMode: "original-available", acknowledgedStoredOnly: false } });
  expect(JSON.stringify(wire)).not.toContain(records[0].original.mention.excerpt);
  const audit = await reviewAudit(records[0]);
  expect(audit.map(entry => entry.kind)).toEqual(["review-requested", "review-committed"]);
  expect(audit[0]).toMatchObject({ originalFingerprint: records[0].fingerprint, routingFingerprint: "1".repeat(64), proposedValues: { title: records[0].proposal.title } });
  expect(audit[1].backendReceipt.decisionId).toBe(wire.localReview.decisionId);
  expect(result.candidates.find(item => item.id === candidates[0].id)!.status).toBe("confirmed");
  expect((await readLocalEvidence(records[0])).record!.original).toEqual(records[0].original);
});

it("reconciles an uncertain response under the same decision id and never assigns a fresh id on retry", async () => {
  const { records, snapshot, candidates } = await registered();
  let evidence = await inspectLocalReviewEvidence(candidates[1], snapshot);
  const lost = { load: vi.fn(async () => snapshot), review: vi.fn(async () => { throw new Error("The review result is unknown"); }) };
  await expect(submitLocalReview(candidates[1], snapshot, evidence, { kind: "confirm" }, false, lost)).rejects.toMatchObject({ name: "LocalReviewUnknownError" });
  const first = lost.review.mock.calls[0] as any[];
  const id = first[1].localReview.decisionId;
  expect((await reviewAudit(records[1])).map(entry => entry.kind)).toEqual(["review-requested", "review-unknown"]);
  evidence = await inspectLocalReviewEvidence(candidates[1], snapshot);
  const committedElsewhere = { load: vi.fn(async () => decided(snapshot, candidates[1].id, id)), review: vi.fn(async () => { throw new TypeError("network"); }) };
  const result = await submitLocalReview(candidates[1], snapshot, evidence, { kind: "confirm" }, false, committedElsewhere);
  expect((committedElsewhere.review.mock.calls[0] as any[])[1].localReview.decisionId).toBe(id);
  expect(result.candidates.find(item => item.id === candidates[1].id)!.localDecision!.decisionId).toBe(id);
  expect((await reviewAudit(records[1])).at(-1).kind).toBe("review-committed");
  // A definitive conflict (e.g. another tab decided first) is failed; a later attempt may use a new id.
  const conflict = { load: vi.fn(), review: vi.fn(async () => { throw new BackendResponseError("already has a different committed decision", 409); }) };
  await expect(submitLocalReview(candidates[0], snapshot, await inspectLocalReviewEvidence(candidates[0], snapshot), { kind: "reject" }, false, conflict)).rejects.toThrow(/different committed decision/);
  expect((await reviewAudit(records[0])).map(entry => entry.kind)).toEqual(["review-requested", "review-failed"]);
});

it("allows only Reject for unavailable evidence and stores an audit-only entry without fabricating originals", async () => {
  const { records, snapshot, candidates } = await registered();
  storage.controls.remove("evidence", [datasetId, "c-csc", digest, records[0].mentionId, records[0].pipelineVersion]);
  const evidence = await inspectLocalReviewEvidence(candidates[0], snapshot);
  const client = { load: vi.fn(), review: vi.fn(async (id: string, decision: any) => decided(snapshot, id, decision.localReview.decisionId, "reject")) };
  await expect(submitLocalReview(candidates[0], snapshot, evidence, { kind: "confirm" }, true, client)).rejects.toThrow(/blocked/);
  expect(client.review).not.toHaveBeenCalled();
  await submitLocalReview(candidates[0], snapshot, evidence, { kind: "reject" }, false, client);
  expect((client.review.mock.calls[0] as any[])[1].localReview.evidenceMode).toBe("unavailable");
  const read = await readLocalEvidence(candidates[0].localEvidence!);
  expect(read.record).toBeUndefined();
  expect(read.auditOnly).toMatchObject({ originalState: "unavailable", candidateId: candidates[0].id, routingFingerprint: "1".repeat(64) });
  expect(read.auditOnly).not.toHaveProperty("original"); expect(JSON.stringify(read.auditOnly)).not.toContain(records[0].original.mention.excerpt);
  // Genuine evidence later does not silently overwrite the audit-only state.
  await expect(retainLocalEvidence([records[0]], new AbortController().signal)).rejects.toThrow(/immutable identity/);
  expect((await inspectLocalReviewEvidence(candidates[0], snapshot)).mode).toBe("unavailable");
});

it("validates corrections per field and describes original locations as inert text", () => {
  expect(correctionErrors(" ", { kind: "date", date: "2027-03-12" })).toEqual({ title: "Enter a title." });
  expect(correctionErrors("Exam", { kind: "date", date: "2027-02-29" }).date).toMatch(/real calendar date/);
  expect(correctionErrors("Exam", { kind: "week", week: Number.NaN }).date).toMatch(/teaching week/);
  expect(correctionErrors("Exam", { kind: "unknown" }).date).toMatch(/Choose a date/);
  expect(correctionErrors("Exam", { kind: "week", week: 4 })).toEqual({});
  expect(describeLocation({ kind: "docx_row", part: "word/document.xml", bodyBlock: 3, table: 1, row: 2, cells: [{ cell: 1, paragraphs: [] }, { cell: 2, paragraphs: [] }] })).toBe("DOCX word/document.xml, body block 3, table 1, row 2, cell(s) 1, 2");
  expect(describeLocation({ kind: "pdf_row", page: 2, items: [{ text: "x", page: 2, transform: [1, 0, 0, 1, 72.4, 500.6], width: 5, height: 5 } as any] })).toMatch(/PDF page 2, text row of 1 item\(s\) starting at x 72, y 501/);
  expect(describeLocation({ kind: "ocr_region", page: 1, bounds: [1, 2, 3, 4], synthetic: false, confidence: 45, engine: "tesseract.js-7.0.0", dpi: 120 })).toMatch(/OCR page 1.*tesseract.*120 DPI.*not source verification/);
});

it("renders the card with original excerpt, stored-only acknowledgement and editable invalid corrections", async () => {
  const { records, snapshot, candidates } = await registered();
  storage.controls.remove("blobs", [datasetId, digest]);
  const run = vi.fn(async (work: (adapter: any) => Promise<Snapshot>) => { await work({ load: async () => snapshot, review: async (id: string, decision: any) => decided(snapshot, id, decision.localReview.decisionId) }); return true; });
  app.snap = snapshot; app.run = run;
  render(<LocalReviewCard c={candidates[0]} />);
  expect(await screen.findByText("Original source unavailable; stored evidence only.")).toBeInTheDocument();
  expect(document.querySelector("blockquote")!.textContent).toBe(records[0].original.mention.excerpt);
  expect(screen.getByText(/Original date wording:/).textContent).toContain(records[0].original.mention.rawScheduleText);
  expect(screen.getByText(/Why review: Year was inferred/)).toBeInTheDocument();
  expect(screen.queryByText(/Confidence/)).not.toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "Confirm" });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Correct" }));
  fireEvent.change(screen.getByLabelText("Corrected title"), { target: { value: "  " } });
  expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Corrected title")).toHaveValue("  ");
  fireEvent.change(screen.getByLabelText("Corrected title"), { target: { value: "Corrected exam" } });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const audit = await reviewAudit(records[0]);
  expect(audit[0]).toMatchObject({ decision: "correct", evidenceMode: "stored-evidence-only", acknowledgedStoredOnly: true, correctedValues: { title: "Corrected exam" } });
});

it("keeps a week-only candidate as a week and shows an unallocated mapping instead of inventing a date", async () => {
  const { snapshot, candidates } = await registered();
  const week = { ...candidates[0], date: { kind: "week" as const, week: 4 } };
  app.snap = { ...snapshot, settings: { ...snapshot.settings, teachingCalendar: undefined } }; app.run = vi.fn();
  render(<LocalReviewCard c={week} />);
  expect(await screen.findByText(/Week stays unallocated/)).toBeInTheDocument();
  expect(await screen.findByText(/does not match the registered server proposal/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
});
