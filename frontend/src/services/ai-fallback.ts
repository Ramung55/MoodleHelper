/**
 * #44 consent-based optional AI fallback: selection, frozen preview, sanitized
 * failure mapping, response validation and review-first #31 records.
 * The backend decides availability; the client never names or selects a provider.
 */
import { z } from "zod";
import type { AssessmentMention } from "@/domain/assessment-mentions";
import { LOCAL_PIPELINE_VERSION } from "@/domain/local-routing";
import { LocalSyllabusProposal, type LocalSyllabusResult, type LocalSyllabusInput } from "@/domain/types";
import { AI_MAX_BODY_BYTES, AI_MAX_EXCERPT_BYTES, AI_MAX_EXCERPTS, AI_VERSION, AiRequestError, aiPayloadDigest, requestAiExtract, type AiContextValue, type AiExcerptValue, type AiExtractRequestValue, type AiExtractResponseValue } from "./ai-gateway";
import { currentDataset, type LocalAssociation } from "./local-documents";
import { localHash, markLocalRoutes, retainLocalEvidence, type LocalEvidenceRecord } from "./local-evidence";

export const AI_CLIENT_TIMEOUT_MS = 30_000;
export const UNAVAILABLE_COPY = "External AI unavailable; continue locally";

export const AiAvailabilityInfo = z.union([
  z.object({ available: z.literal(false), reason: z.string().max(500) }).passthrough(),
  z.object({ available: z.literal(true), provider: z.string().min(1).max(200), retention: z.string().min(1).max(500), mode: z.literal("mock"),
    policyVersion: z.string().min(1).max(128), destination: z.string().min(1).max(128),
    limits: z.object({ maxExcerpts: z.number().int(), maxExcerptBytes: z.number().int(), maxBodyBytes: z.number().int(), timeoutSeconds: z.number(), monthlyCapUsd: z.number(), perRequestReserveUsd: z.number(), simulatedCost: z.boolean() }).passthrough() }).passthrough(),
]);
export type AiAvailabilityInfo = z.infer<typeof AiAvailabilityInfo>;
export type AvailableAi = Extract<AiAvailabilityInfo, { available: true }>;

/** Unreachable, malformed or unavailable all mean the same thing: local-only, no Send. */
export async function loadAiAvailability(baseUrl = "", fetcher: typeof fetch = (...a) => globalThis.fetch(...a), signal?: AbortSignal): Promise<AiAvailabilityInfo> {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/api/ai/availability`, { credentials: "omit", cache: "no-store", signal });
    if (!response.ok) return { available: false, reason: UNAVAILABLE_COPY };
    const parsed = AiAvailabilityInfo.safeParse(await response.json());
    return parsed.success ? parsed.data : { available: false, reason: UNAVAILABLE_COPY };
  } catch { signal?.throwIfAborted(); return { available: false, reason: UNAVAILABLE_COPY }; }
}

export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
/** Selectable only when the original excerpt fits unchanged; nothing is truncated or redacted invisibly. */
export function selectionProblem(mention: AssessmentMention): string | undefined {
  if (!mention.excerpt.trim()) return "No original excerpt text is available.";
  if (utf8Bytes(mention.excerpt) > AI_MAX_EXCERPT_BYTES) return `Excerpt is ${utf8Bytes(mention.excerpt)} bytes; the limit is ${AI_MAX_EXCERPT_BYTES}. It cannot be sent.`;
}

export type FrozenPreview = {
  requestId: string; datasetId: string; association: Pick<LocalAssociation, "datasetId" | "courseId" | "digest" | "name">;
  policy: Pick<AvailableAi, "provider" | "retention" | "policyVersion" | "destination" | "mode"> & { limits: AvailableAi["limits"] };
  mentions: AssessmentMention[]; excerpts: (AiExcerptValue & { mentionId: string; label: string })[];
  context?: AiContextValue; payloadDigest: string; request: AiExtractRequestValue; bodyBytes: number;
};

export function policyKey(info: AvailableAi): string {
  return JSON.stringify([info.provider, info.retention, info.policyVersion, info.destination, info.mode, info.limits]);
}

function describe(mention: AssessmentMention): string {
  const l = mention.location;
  if (l.kind === "pdf_row") return `page ${l.page}, text row`;
  if (l.kind === "docx_paragraph") return `body block ${l.paragraph.location.bodyBlock}, paragraph ${l.paragraph.location.paragraph}`;
  if (l.kind === "docx_row") return `table ${l.table}, row ${l.row}`;
  return `page ${l.page}, OCR region [${l.bounds.join(", ")}]`;
}

/** Freeze the exact wire request, its #43 digest, the dataset epoch and policy. */
export async function freezePreview(input: { association: LocalAssociation; datasetId: string; info: AvailableAi; mentions: AssessmentMention[]; context?: AiContextValue; requestId?: string }): Promise<FrozenPreview> {
  const { association, datasetId, info, mentions } = input;
  if (!mentions.length) throw new Error("Select at least one excerpt.");
  if (mentions.length > Math.min(AI_MAX_EXCERPTS, info.limits.maxExcerpts)) throw new Error(`Select at most ${AI_MAX_EXCERPTS} excerpts.`);
  for (const mention of mentions) {
    const problem = selectionProblem(mention); if (problem) throw new Error(problem);
    if (mention.datasetId !== datasetId || mention.courseId !== association.courseId || mention.digest !== association.digest) throw new Error("A selected excerpt does not belong to this document. Select again.");
  }
  const excerpts = await Promise.all(mentions.map(async (mention, index) => ({ id: `ex-${index}`, documentDigest: association.digest, locationId: `loc-${await localHash(mention.location ?? null)}`, text: mention.excerpt, mentionId: mention.id, label: `${association.name} · ${describe(mention)} · offsets ${mention.mention.start}–${mention.mention.end}` })));
  const wire = excerpts.map(({ id, documentDigest, locationId, text }) => ({ id, documentDigest, locationId, text }));
  const context = input.context && Object.keys(input.context).length ? input.context : undefined;
  const payloadDigest = await aiPayloadDigest(info.policyVersion, info.destination, wire, context);
  const requestId = input.requestId ?? `ai-${crypto.randomUUID()}`;
  const request: AiExtractRequestValue = { version: AI_VERSION, requestId, expectedDatasetId: datasetId,
    consent: { policyVersion: info.policyVersion, destination: info.destination, approvedExcerptIds: wire.map(e => e.id), payloadDigest }, excerpts: wire, ...(context ? { context } : {}) };
  const bodyBytes = utf8Bytes(JSON.stringify(request));
  if (bodyBytes > Math.min(AI_MAX_BODY_BYTES, info.limits.maxBodyBytes)) throw new Error("The selected excerpts exceed the 16 KiB request limit. Remove an excerpt.");
  return { requestId, datasetId, association: { datasetId: association.datasetId, courseId: association.courseId, digest: association.digest, name: association.name },
    policy: { provider: info.provider, retention: info.retention, policyVersion: info.policyVersion, destination: info.destination, mode: info.mode, limits: info.limits },
    mentions: structuredClone(mentions), excerpts, context, payloadDigest, request, bodyBytes };
}

export type AiOutcome = { kind: "offline" | "timeout" | "rate_limit" | "unavailable" | "provider" | "invalid" | "cancelled" | "conflict" | "consent"; message: string; maybeReceived: boolean };

/** Fixed copy only: never echoes excerpts, credentials or provider detail. */
export function classifyAiFailure(error: unknown, cancelledByUser: boolean): AiOutcome {
  const local = " Imported document data and local review are unchanged.";
  if (cancelledByUser) return { kind: "cancelled", maybeReceived: true, message: `Cancelled. The local gateway may already have received the request; it cannot be retracted. No AI result will be used.${local}` };
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return { kind: "timeout", maybeReceived: true, message: `No answer within 30 seconds. The request may already have been received and cannot be retracted. Check status by retrying the same request, or continue local review.${local}` };
  if (error instanceof AiRequestError) {
    const s = error.status, code = error.code;
    if (s === 429) return { kind: "rate_limit", maybeReceived: false, message: `${code === "budget_exhausted" ? "AI cost cap reached." : code === "concurrency_limit" ? "Another AI request is in progress." : "AI rate limit reached."} Try again later or continue local review.${local}` };
    if (s === 503) return { kind: "unavailable", maybeReceived: false, message: `${UNAVAILABLE_COPY}. No text was processed.${local}` };
    if (s === 504) return { kind: "timeout", maybeReceived: true, message: `The AI provider timed out. Nothing was retried automatically.${local}` };
    if (s === 499) return { kind: "cancelled", maybeReceived: true, message: `The AI request was cancelled. No proposals were accepted.${local}` };
    if (s === 502 && code === "invalid_output") return { kind: "invalid", maybeReceived: true, message: `The AI response was invalid. No proposals were accepted.${local}` };
    if (s === 502) return { kind: "provider", maybeReceived: true, message: `The AI provider refused or failed. Nothing was retried automatically.${local}` };
    if (s === 409 && code === "duplicate_request") return { kind: "conflict", maybeReceived: true, message: `This exact request was already processed; its outcome is recorded and it was not resent. Review and consent again to send a new request.${local}` };
    if (s === 409) return { kind: "conflict", maybeReceived: false, message: `The local dataset or request changed. Review a new preview before sending.${local}` };
    if (s === 422 || s === 413) return { kind: "consent", maybeReceived: false, message: `The gateway rejected the consent or payload. Review a new preview.${local}` };
    return { kind: "provider", maybeReceived: true, message: `The AI request failed. Nothing was retried automatically.${local}` };
  }
  if (error instanceof z.ZodError) return { kind: "invalid", maybeReceived: true, message: `The AI response was invalid. No proposals were accepted.${local}` };
  return { kind: "offline", maybeReceived: true, message: `The local gateway could not be reached. The request may or may not have arrived. Retry the same request or continue local review.${local}` };
}

/** Send exactly the frozen request after re-checking epoch and policy. */
export async function sendFrozen(preview: FrozenPreview, signal: AbortSignal, deps: { baseUrl?: string; fetcher?: typeof fetch; dataset?: () => Promise<string | undefined> } = {}): Promise<AiExtractResponseValue> {
  const dataset = deps.dataset ?? (() => currentDataset());
  if (await dataset() !== preview.datasetId) throw new AiRequestError("Local dataset changed. Review a new preview.", 409, "context_changed");
  const info = await loadAiAvailability(deps.baseUrl, deps.fetcher, signal);
  if (!info.available || policyKey(info) !== policyKey({ ...preview.policy, available: true } as AvailableAi)) throw new AiRequestError("The AI policy or destination changed. Review a new preview.", 409, "policy_changed");
  const timeout = AbortSignal.timeout(AI_CLIENT_TIMEOUT_MS), combined = AbortSignal.any([signal, timeout]);
  return requestAiExtract(deps.baseUrl ?? "", preview.request, deps.fetcher, combined);
}

export type ValidatedAi = { records: LocalEvidenceRecord[]; rejected: { index: number; reason: string }[] };

function aiDate(proposal: AiExtractResponseValue["proposals"][number]): { date: LocalSyllabusProposal["date"]; note?: string } {
  const value = proposal.date.value;
  if (proposal.date.precision === "date" && value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = LocalSyllabusProposal.shape.date.safeParse({ kind: "date", date: value });
    if (parsed.success) return { date: parsed.data };
    return { date: { kind: "unknown" }, note: "AI date is not a real calendar date." };
  }
  if (proposal.date.precision === "week" && proposal.week) return { date: { kind: "week", week: proposal.week } };
  return { date: { kind: "unknown" }, note: value ? "AI date wording is malformed or not a calendar date." : undefined };
}

/** Every evidence span must point inside an excerpt the student approved; nothing is invented. */
export async function validateAiResponse(preview: FrozenPreview, response: AiExtractResponseValue): Promise<ValidatedAi> {
  if (response.requestId !== preview.requestId || response.policyVersion !== preview.policy.policyVersion) throw new Error("The AI response does not match the reviewed request. No proposals were accepted.");
  const records: LocalEvidenceRecord[] = [], rejected: ValidatedAi["rejected"] = [];
  for (const [index, proposal] of response.proposals.entries()) {
    const spans = proposal.evidence.map(span => ({ span, excerpt: preview.excerpts.find(e => e.id === span.excerptId) }));
    const bad = spans.find(({ span, excerpt }) => !excerpt || excerpt.locationId !== span.locationId || span.start >= span.end || span.end > excerpt.text.length);
    if (bad) { rejected.push({ index, reason: "Evidence does not point inside a selected excerpt." }); continue; }
    const mentionIds = [...new Set(spans.map(s => s.excerpt!.mentionId))];
    const mention = preview.mentions.find(m => m.id === mentionIds[0])!;
    const { date, note } = aiDate(proposal);
    const reasons = [`AI-proposed (${preview.policy.provider}); not verified.`, ...(note ? [note] : []), ...(proposal.uncertain ? [`AI marked uncertain: ${proposal.uncertaintyReason ?? "other"}.`] : [])];
    const mentionId = `ai-${(await localHash({ requestId: preview.requestId, index, digest: preview.payloadDigest })).slice(0, 40)}`;
    const locationId = spans[0].excerpt!.locationId;
    const proposalValue = LocalSyllabusProposal.parse({ mentionId, locationId, title: proposal.title.trim() || mention.title, type: proposal.type === "other" ? mention.type : proposal.type, date,
      facts: { complete: true, evidenceRetained: true, traceable: true, sourceAvailable: true, contextVerified: true, singleAssociation: mentionIds.length === 1,
        explicitDate: false, inferredYear: proposal.uncertaintyReason === "missing_year", localeAmbiguous: proposal.uncertaintyReason === "ambiguous_order", contradictory: false, policyOrHeading: false, conflictingMatch: false,
        mappingResolved: date.kind === "date", timezoneResolved: date.kind !== "exact", ocr: mention.location.kind === "ocr_region" ? "review" : "none", aiProposal: true } });
    const original = { mention: { ...structuredClone(mention), reasons: [...mention.reasons, ...reasons] }, dates: [], week: { kind: "unknown" as const } };
    const format = preview.association.name.toLowerCase().endsWith(".docx") ? "docx" as const : "pdf" as const;
    const fingerprint = await localHash({ original, proposal: proposalValue, format, pipelineVersion: LOCAL_PIPELINE_VERSION, ai: { requestId: preview.requestId, payloadDigest: preview.payloadDigest, evidence: proposal.evidence } });
    records.push({ datasetId: preview.datasetId, courseId: preview.association.courseId, digest: preview.association.digest, mentionId, locationId, pipelineVersion: LOCAL_PIPELINE_VERSION, format, fingerprint, original, proposal: proposalValue, state: "pending", audit: [{ kind: "retained", at: new Date().toISOString() }] });
  }
  return { records, rejected };
}

/** Retain AI originals locally, then hand metadata-only proposals to #31 (always review). */
export async function routeAiRecords(preview: FrozenPreview, records: LocalEvidenceRecord[], signal: AbortSignal, client: { routeLocalSyllabus(input: LocalSyllabusInput, signal?: AbortSignal): Promise<LocalSyllabusResult> }, dataset: () => Promise<string | undefined> = () => currentDataset(signal)): Promise<LocalSyllabusResult> {
  const check = async () => { signal.throwIfAborted(); if (await dataset() !== preview.datasetId) throw new Error("The dataset changed. AI results were not routed."); };
  await check();
  const stored = await retainLocalEvidence(records, signal); await check();
  const result = await client.routeLocalSyllabus({ datasetId: preview.datasetId, courseId: preview.association.courseId, digest: preview.association.digest, format: records[0].format, pipelineVersion: LOCAL_PIPELINE_VERSION, proposals: stored.map(r => r.proposal) }, signal);
  await check(); await markLocalRoutes(stored, result.routes, signal);
  return result;
}
