import type { MoodleHelperAdapter, ReviewDecision } from "./adapter";
import { BackendResponseError } from "./http-adapter";
import { appendLocalReviewAudit, localHash, readLocalEvidence, stableJson, type LocalAuditOnlyRecord, type LocalEvidenceRecord, type LocalReviewAuditEntry } from "./local-evidence";
import { currentDataset } from "./local-documents";
import type { ExtractionCandidate, LocalEvidenceMode, Snapshot } from "@/domain/types";

type Receipt = NonNullable<Snapshot["localSyllabusReceipts"]>[number];
/** Validated lookup result for one registered local candidate (#32). */
export type LocalReviewEvidence =
  | { mode: "original-available" | "stored-evidence-only"; record: LocalEvidenceRecord; receipt: Receipt; reviewAudit: LocalReviewAuditEntry[] }
  | { mode: "unavailable"; reason: string; receipt?: Receipt; auditOnly?: LocalAuditOnlyRecord; reviewAudit: LocalReviewAuditEntry[] };

const sameRef = (a: object, b: object) => stableJson(a) === stableJson(b);
const reviewEntries = (audit: readonly unknown[]): LocalReviewAuditEntry[] => audit.filter((row): row is LocalReviewAuditEntry => String((row as { kind?: string }).kind).startsWith("review-"));

/** The single server receipt registered for exactly this candidate/document/reference; never a global search. */
export function serverReceipt(candidate: ExtractionCandidate, snapshot: Snapshot): Receipt | undefined {
  const ref = candidate.localEvidence;
  if (!ref) return;
  const matches = (snapshot.localSyllabusReceipts ?? []).filter(receipt => sameRef(receipt.evidence, ref) && receipt.route.candidateId === candidate.id && receipt.route.documentId === candidate.documentId);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Reads the exact same-dataset local record and checks it against the server receipt.
 * Original source "available" requires a successful association+Blob lookup, not server metadata.
 */
export async function inspectLocalReviewEvidence(candidate: ExtractionCandidate, snapshot: Snapshot, signal?: AbortSignal): Promise<LocalReviewEvidence> {
  const ref = candidate.localEvidence;
  if (!ref) throw new Error("Not a registered local candidate.");
  const receipt = serverReceipt(candidate, snapshot);
  const read = await readLocalEvidence(ref, signal);
  const audit = reviewEntries(read.record?.audit ?? read.auditOnly?.audit ?? []);
  const unavailable = (reason: string): LocalReviewEvidence => ({ mode: "unavailable", reason, receipt, auditOnly: read.auditOnly, reviewAudit: audit });
  if (!receipt) return unavailable("The registered server routing receipt for this candidate is missing.");
  if (read.auditOnly) return unavailable("Original local evidence was unavailable when this candidate was reviewed; only its review audit is stored.");
  if (read.corrupt) return unavailable("Stored original evidence is corrupt.");
  const record = read.record;
  if (!record) return unavailable("Original evidence is not stored in this browser/profile for this dataset.");
  const { fingerprint, original, proposal, format, pipelineVersion } = record;
  if (await localHash({ original, proposal, format, pipelineVersion }) !== fingerprint) return unavailable("Stored original evidence is corrupt (its fingerprint does not match).");
  if (record.locationId !== ref.locationId || proposal.mentionId !== ref.mentionId || proposal.locationId !== ref.locationId || original.mention.id !== ref.mentionId) return unavailable("Stored original evidence does not match this candidate's location.");
  if (record.receipt && (record.receipt.candidateId !== candidate.id || record.receipt.documentId !== candidate.documentId)) return unavailable("Stored original evidence is registered to a different candidate.");
  const derived = candidate.localDecision?.originalValues ?? { title: candidate.title, type: candidate.type, date: candidate.date };
  if (!sameRef({ title: proposal.title, type: proposal.type, date: proposal.date }, { title: derived.title, type: derived.type, date: derived.date })) return unavailable("Stored original proposal does not match the registered server proposal.");
  return { mode: read.sourceAvailable ? "original-available" : "stored-evidence-only", record, receipt, reviewAudit: audit };
}

/** A requested/unknown decision without a definitive outcome must be retried under the SAME id. */
export function unresolvedDecisionId(audit: LocalReviewAuditEntry[], candidateId: string): string | undefined {
  const ours = audit.filter(entry => entry.candidateId === candidateId);
  const last = ours[ours.length - 1];
  return last && (last.kind === "review-requested" || last.kind === "review-unknown") ? last.decisionId : undefined;
}

export type LocalChoice = { kind: "confirm" } | { kind: "reject" } | Extract<ReviewDecision, { kind: "correct" }>;
export class LocalReviewUnknownError extends Error { constructor(message: string, readonly decisionId: string) { super(message); this.name = "LocalReviewUnknownError"; } }

/**
 * Pending audit is stored before HTTP (failure sends nothing); a definitive backend answer is recorded,
 * an uncertain one is reconciled from backend status under the same decisionId.
 */
export async function submitLocalReview(candidate: ExtractionCandidate, snapshot: Snapshot, evidence: LocalReviewEvidence, choice: LocalChoice, acknowledgedStoredOnly: boolean, client: Pick<MoodleHelperAdapter, "review" | "load">): Promise<Snapshot> {
  const ref = candidate.localEvidence, receipt = serverReceipt(candidate, snapshot);
  if (!ref || !receipt) throw new Error("This candidate has no registered local routing receipt. Nothing was sent.");
  const evidenceMode: LocalEvidenceMode = evidence.mode;
  if (evidenceMode === "unavailable" && choice.kind !== "reject") throw new Error("Original evidence is unavailable. Confirm and Correct are blocked; Reject remains available.");
  if (evidenceMode === "stored-evidence-only" && choice.kind !== "reject" && !acknowledgedStoredOnly) throw new Error("Acknowledge that this is a manual decision from stored evidence only.");
  if (choice.kind === "confirm" && candidate.date.kind === "unknown") throw new Error("The source date is unresolved. Correct it with an explicit date or week instead.");
  const datasetId = await currentDataset();
  if (datasetId !== ref.datasetId) throw new Error("The dataset changed. Reload before reviewing; nothing was sent.");
  const decisionId = unresolvedDecisionId(evidence.reviewAudit, candidate.id) ?? `review-${crypto.randomUUID()}`;
  const ack = evidenceMode === "stored-evidence-only" && acknowledgedStoredOnly;
  const base: Omit<LocalReviewAuditEntry, "kind" | "at"> = {
    decisionId, decision: choice.kind, candidateId: candidate.id, documentId: candidate.documentId,
    ...(evidence.mode !== "unavailable" ? { originalFingerprint: evidence.record.fingerprint } : {}),
    routingFingerprint: receipt.fingerprint, evidenceMode, acknowledgedStoredOnly: ack,
    proposedValues: { title: candidate.title, type: candidate.type, date: candidate.date },
    ...(choice.kind === "correct" ? { correctedValues: { title: choice.title, type: choice.type, date: choice.date } } : {}),
  };
  const record = (kind: LocalReviewAuditEntry["kind"], extra: Partial<LocalReviewAuditEntry> = {}) => appendLocalReviewAudit(ref, { ...base, ...extra, kind, at: new Date().toISOString() });
  await record("review-requested"); // throws on quota/storage: no HTTP request
  const localReview = { datasetId, pipelineVersion: ref.pipelineVersion, proposalFingerprint: receipt.fingerprint, decisionId, evidenceMode, acknowledgedStoredOnly: ack };
  const committed = async (result: Snapshot) => {
    const saved = result.candidates.find(item => item.id === candidate.id)?.localDecision;
    try { await record("review-committed", saved ? { backendReceipt: saved } : {}); } catch { /* backend state is authoritative; audit retry happens on next review read */ }
    return result;
  };
  let result: Snapshot;
  try {
    result = await client.review(candidate.id, { ...choice, localReview });
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : "Review failed.";
    if (failure instanceof BackendResponseError) {
      try { await record("review-failed", { message }); } catch { /* request already definitively failed */ }
      throw failure;
    }
    try { await record("review-unknown", { message }); } catch { /* the pending entry already keeps this decision id */ }
    try {
      const current = await client.load();
      if (current.candidates.find(item => item.id === candidate.id)?.localDecision?.decisionId === decisionId) return committed(current);
    } catch { /* still uncertain */ }
    throw new LocalReviewUnknownError(`${message} Retry uses the same decision, so no duplicate event can be created.`, decisionId);
  }
  if (await currentDataset() !== datasetId) throw new Error("The dataset changed while saving. Reload to see the authoritative result.");
  return committed(result);
}
