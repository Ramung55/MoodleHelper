import { prepareLocalEvidence } from "@/domain/local-routing";
import type { LocalExtraction } from "@/domain/local-extraction";
import type { AssessmentMention } from "@/domain/assessment-mentions";
import type { ParsedAssessmentMention } from "@/domain/syllabus-dates";
import type { LocalSyllabusResult, TeachingCalendar } from "@/domain/types";
import { currentDataset, readLocalDocument, type LocalAssociation } from "./local-documents";
import { markLocalRoutes, readLocalEvidence, retainLocalEvidence, stableJson } from "./local-evidence";
import { HttpAdapter } from "./http-adapter";

export async function routeLocalProposals(association: LocalAssociation, extraction: LocalExtraction, mentions: AssessmentMention[], parsed: ParsedAssessmentMention[], calendar: TeachingCalendar | undefined, signal: AbortSignal, client: Pick<HttpAdapter, "load" | "routeLocalSyllabus"> = new HttpAdapter()): Promise<LocalSyllabusResult> {
  const check = async () => { signal.throwIfAborted(); if (await currentDataset(signal) !== association.datasetId) throw new Error("The dataset changed. Reconnect before routing."); signal.throwIfAborted(); };
  await check();
  if (association.datasetId !== extraction.datasetId || association.courseId !== extraction.courseId || association.digest !== extraction.digest) throw new Error("Document association does not match the extracted proposals.");
  const available = async () => {
    try { await readLocalDocument(association, signal); await check(); return true; }
    catch (failure) { await check(); if (signal.aborted) throw failure; return false; }
  };
  const sourceAvailable = await available();
  const prepared = await prepareLocalEvidence(extraction, mentions, parsed, calendar, sourceAvailable, signal);
  // Reuse immutable originals/policy even after backend review or calendar changes.
  for (let index = 0; index < prepared.length; index++) {
    const { record: previous } = await readLocalEvidence(prepared[index], signal);
    if (!previous) continue;
    const immutable = (record: typeof previous) => ({ original: record.original, proposal: { ...record.proposal, facts: undefined }, format: record.format });
    if (stableJson(immutable(previous)) !== stableJson(immutable(prepared[index]))) throw new Error("Original proposal changed. Review a revision explicitly; prior evidence and decisions were retained.");
    prepared[index] = previous;
  }
  const stored = await retainLocalEvidence(prepared, signal);
  await check();
  // A reload/uncertain response reconciles against registered server receipts first.
  const snapshot = await client.load(); await check();
  const retained = stored.map(record => snapshot.localSyllabusReceipts?.find(receipt => stableJson(receipt.evidence) === stableJson({ datasetId: record.datasetId, courseId: record.courseId, digest: record.digest, mentionId: record.mentionId, locationId: record.locationId, pipelineVersion: record.pipelineVersion })));
  if (retained.length && retained.every(Boolean)) {
    const routes = retained.map(receipt => ({ ...receipt!.route, disposition: "retained" as const }));
    await markLocalRoutes(stored, routes, signal); await check();
    return { snapshot, routes };
  }
  if (stored.some(record => record.state === "routed" && !snapshot.localSyllabusReceipts?.some(receipt => receipt.route.mentionId === record.mentionId && receipt.evidence.digest === record.digest && receipt.evidence.courseId === record.courseId))) throw new Error("A previously registered route is absent from this backend state. Restore/review the original dataset; no new event was submitted.");
  const currentSource = await available(); await check();
  if (!currentSource && stored.some(record => record.proposal.facts.sourceAvailable)) throw new Error("Original source is unavailable. Stored evidence was retained; reselect the original document before fresh verification.");
  const result = await client.routeLocalSyllabus({ datasetId: association.datasetId, courseId: association.courseId, digest: association.digest, format: extraction.format === "docx" ? "docx" : "pdf", pipelineVersion: "local-syllabus-1", proposals: stored.map(record => record.proposal) }, signal);
  await check();
  await markLocalRoutes(stored, result.routes, signal); await check();
  return result;
}
