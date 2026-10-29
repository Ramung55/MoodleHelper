import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { DecompressionStream as NativeDecompressionStream } from "node:stream/web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { extractDocx } from "@/services/extract-docx";
import { detectAssessmentMentions } from "@/domain/assessment-mentions";
import { parseSyllabusMention } from "@/domain/syllabus-dates";
import { prepareLocalEvidence } from "@/domain/local-routing";
import { readLocalEvidence, retainLocalEvidence, markLocalRoutes } from "@/services/local-evidence";
import { saveLocalDocument } from "@/services/local-documents";
import { routeLocalProposals } from "@/services/route-local-syllabus";
import { LocalEvidenceView } from "@/components/mh/LocalEvidenceView";
import { buildDemoSnapshot } from "@/services/fixtures";
import { indexedDbFixture } from "./indexeddb-fixture";
const datasetId = "12345678-1234-4123-8123-123456789abc", digest = "a".repeat(64);
const association = { datasetId, courseId: "c-csc", digest, name: "local.docx", size: 100, source: "Local", createdAt: "now" };
let storage: ReturnType<typeof indexedDbFixture>, dataset: string;
beforeEach(() => {
  dataset = datasetId; storage = indexedDbFixture();
  vi.stubGlobal("indexedDB", storage.indexedDB); vi.stubGlobal("IDBKeyRange", storage.IDBKeyRange);
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("DecompressionStream", NativeDecompressionStream);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ datasetId: dataset }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function source() {
  const blob = new NodeBlob([readFileSync("src/test/fixtures/extraction-bilingual.docx")]) as unknown as Blob;
  await saveLocalDocument(association, blob, [], new AbortController().signal);
  const blocks = await extractDocx(blob, new AbortController().signal, vi.fn());
  const extraction = { format: "docx" as const, datasetId, courseId: association.courseId, digest, complete: true as const, blocks };
  const mentions = await detectAssessmentMentions(extraction, new AbortController().signal), parsed = mentions.map(mention => parseSyllabusMention(mention));
  const records = await prepareLocalEvidence(extraction, mentions, parsed, undefined, true, new AbortController().signal);
  return { extraction, mentions, parsed, records };
}
it("uses actual bilingual extractor/parser proposals and retains immutable originals across reopened connections", async () => {
  const { records } = await source();
  expect(records.map(record => record.proposal.language)).toEqual(["en", "ru"]);
  expect(records.every(record => record.proposal.facts.explicitDate && record.proposal.facts.traceable)).toBe(true);
  await retainLocalEvidence(records, new AbortController().signal);
  const replay = await retainLocalEvidence(records, new AbortController().signal);
  expect(replay).toEqual(records); expect(storage.controls.rows("evidence")).toHaveLength(2);
  const original = (await readLocalEvidence(records[0])).record;
  const route = { mentionId: records[0].mentionId, documentId: "registered-doc", candidateId: "registered-candidate", disposition: "review" as const, reasons: ["contradictory" as const] };
  await markLocalRoutes([records[0]], [route], new AbortController().signal);
  const stored = await readLocalEvidence(records[0]);
  expect(stored.record!.original).toEqual(original!.original); expect(stored.record!.proposal).toEqual(original!.proposal);
  expect(stored.record!.receipt).toEqual(route); expect(stored.record!.audit).toHaveLength(2);
  storage.controls.remove("blobs", [datasetId, digest]);
  expect((await readLocalEvidence(records[0])).sourceAvailable).toBe(false);
  render(<LocalEvidenceView reference={records[0]} />);
  expect(await screen.findByText(/Original document is unavailable/)).toBeInTheDocument();
  expect(document.querySelector("blockquote")!.textContent).toBe(records[0].original.mention.excerpt);
});
it("fails atomically on quota/collision and never submits metadata when original evidence is not retained", async () => {
  const { records, extraction, mentions, parsed } = await source();
  const client = { load: vi.fn(async () => buildDemoSnapshot()), routeLocalSyllabus: vi.fn() };
  storage.controls.failNextEvidenceWrite = true;
  await expect(routeLocalProposals(association, extraction, mentions, parsed, undefined, new AbortController().signal, client)).rejects.toThrow(/could not be retained/);
  expect(client.routeLocalSyllabus).not.toHaveBeenCalled(); expect(client.load).not.toHaveBeenCalled();
  expect(storage.controls.rows("evidence")).toHaveLength(0);
  await retainLocalEvidence(records, new AbortController().signal);
  await expect(retainLocalEvidence([{ ...records[0], fingerprint: "changed" }, records[1]], new AbortController().signal)).rejects.toThrow(/immutable identity/);
  expect((await readLocalEvidence(records[0])).record!.original).toEqual(records[0].original);
});
it("serializes two-tab originals, preserves scope, and stops on context/cancellation", async () => {
  const { records } = await source();
  await Promise.all([retainLocalEvidence(records, new AbortController().signal), retainLocalEvidence(records, new AbortController().signal)]);
  expect(storage.controls.rows("evidence")).toHaveLength(2);
  expect((await readLocalEvidence({ ...records[0], courseId: "other-course" })).record).toBeUndefined();
  const controller = new AbortController(); controller.abort();
  await expect(retainLocalEvidence(records, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  dataset = "87654321-4321-4321-8321-cba987654321";
  await expect(readLocalEvidence(records[0])).rejects.toThrow(/dataset changed/);
});
it("reconciles an uncertain result from the existing server receipt without a new POST or invented IDs", async () => {
  const { records, extraction, mentions, parsed } = await source();
  await retainLocalEvidence(records, new AbortController().signal);
  const snapshot = buildDemoSnapshot();
  snapshot.localSyllabusReceipts = records.map(record => ({ evidence: { datasetId, courseId: record.courseId, digest, mentionId: record.mentionId, locationId: record.locationId, pipelineVersion: record.pipelineVersion }, fingerprint: "b".repeat(64), route: { mentionId: record.mentionId, documentId: "backend-registered-doc", candidateId: "backend-" + record.mentionId, disposition: "review", reasons: ["source_unavailable"] } }));
  storage.controls.remove("blobs", [datasetId, digest]);
  const client = { load: vi.fn(async () => snapshot), routeLocalSyllabus: vi.fn() };
  const result = await routeLocalProposals(association, extraction, mentions, parsed, undefined, new AbortController().signal, client);
  expect(client.routeLocalSyllabus).not.toHaveBeenCalled(); expect(result.routes.every(route => route.disposition === "retained")).toBe(true);
  expect(result.routes[0].candidateId).toBe(snapshot.localSyllabusReceipts[0].route.candidateId);
  expect((await readLocalEvidence(records[0])).record!.original).toEqual(records[0].original);
});
it("consumes actual parser ambiguity/inferred-year/unknown-zone and OCR adapter outputs conservatively", async () => {
  for (const [text, context, check] of [
    ["Quiz due 03/04/2027", {}, "localeAmbiguous"],
    ["Assignment due 12 March", { semester: { start: "2027-01-01", end: "2027-06-30" } }, "inferredYear"],
    ["Exam due 2027-03-12T14:00 XYZ", {}, "timezoneUnresolved"],
    ["Quiz and exam due 12 March 2027", {}, "associationAmbiguous"],
  ] as const) {
    const extraction = { format: "docx" as const, datasetId, courseId: "c-csc", digest, complete: true as const, blocks: [{ kind: "paragraph" as const, paragraph: { id: "p1", text, location: { part: "word/document.xml" as const, bodyBlock: 1, paragraph: 1 } } }] };
    const mentions = await detectAssessmentMentions(extraction, new AbortController().signal), parsed = mentions.map(mention => parseSyllabusMention(mention, context));
    const records = await prepareLocalEvidence(extraction, mentions, parsed, undefined, true, new AbortController().signal);
    expect(records.every(record => record.proposal.date.kind === "unknown" || record.proposal.facts.inferredYear)).toBe(true);
    if (check === "localeAmbiguous") expect(records[0].proposal.facts.localeAmbiguous).toBe(true);
    if (check === "inferredYear") expect(records[0].proposal.facts.inferredYear).toBe(true);
    if (check === "timezoneUnresolved") expect(records[0].proposal.facts.timezoneResolved).toBe(false);
    if (check === "associationAmbiguous") expect(records.every(record => !record.proposal.facts.singleAssociation)).toBe(true);
  }
  // Labelled adapter fixture: this test does not execute or claim real OCR.
  const text = "Exam due 12 March 2027";
  const extraction = { format: "ocr" as const, datasetId, courseId: "c-csc", digest, complete: true, status: "complete" as const, selectedPages: [1], language: "eng" as const, dpi: 120, engine: "tesseract.js-7.0.0" as const, pages: [{ page: 1, width: 100, height: 100, text, confidence: 45, status: "review_needed" as const, regions: [{ text, confidence: 45, bounds: [1, 1, 90, 20] }] }] };
  const mentions = await detectAssessmentMentions(extraction, new AbortController().signal);
  const records = await prepareLocalEvidence(extraction, mentions, mentions.map(mention => parseSyllabusMention(mention)), undefined, true, new AbortController().signal);
  expect(records[0].proposal.facts.ocr).toBe("low_quality");
  const lostLocation = structuredClone(mentions); lostLocation[0].location = undefined as any;
  const lost = await prepareLocalEvidence(extraction, lostLocation, lostLocation.map(mention => parseSyllabusMention(mention)), undefined, true, new AbortController().signal);
  expect(lost[0].proposal.facts.traceable).toBe(false);
});
it("checks cancellation after the final pending dataset lookup and leaves a reconcilable marker", async () => {
  const { records, extraction, mentions, parsed } = await source(), controller = new AbortController();
  let release!: (response: Response) => void;
  const client = { load: vi.fn(async () => buildDemoSnapshot()), routeLocalSyllabus: vi.fn(async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    return { snapshot: buildDemoSnapshot(), routes: records.map(record => ({ mentionId: record.mentionId, documentId: "registered-doc", candidateId: "registered-" + record.mentionId, disposition: "review" as const, reasons: ["contradictory" as const] })) };
  }) };
  const work = routeLocalProposals(association, extraction, mentions, parsed, undefined, controller.signal, client);
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); controller.abort();
  release(new Response(JSON.stringify({ datasetId }), { status: 200 }));
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
  expect(storage.controls.rows("evidence").every(record => record.state === "pending")).toBe(true);
});
