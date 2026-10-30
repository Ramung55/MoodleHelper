/**
 * Minimal client/types for the optional AI gateway (#43, contract ai-extract.v1).
 * #44 owns consent UI. This module holds no provider secret and never selects a
 * provider: the backend decides (ordinary runtime: unavailable, 503).
 */
import { z } from "zod";

export const AI_VERSION = "ai-extract.v1" as const;
export const AI_MAX_EXCERPTS = 8;
export const AI_MAX_EXCERPT_BYTES = 2000;
export const AI_MAX_BODY_BYTES = 16 * 1024;

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AiExcerpt = z.object({ id: Id, documentDigest: Digest, locationId: Id, text: z.string().min(1).max(2000) }).strict();
export const AiContext = z.object({
  dateOrder: z.enum(["DMY", "MDY"]).optional(),
  timezone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+/-]+$/).optional(),
  explicitSemesterBounds: z.object({ start: IsoDate.optional(), end: IsoDate.optional() }).strict().optional(),
}).strict();
export const AiExtractRequest = z.object({
  version: z.literal(AI_VERSION), requestId: Id, expectedDatasetId: Id,
  consent: z.object({ policyVersion: Id, destination: z.string().min(1).max(128), approvedExcerptIds: z.array(Id).min(1).max(8), payloadDigest: Digest }).strict(),
  excerpts: z.array(AiExcerpt).min(1).max(AI_MAX_EXCERPTS),
  context: AiContext.optional(),
}).strict();
export const AiProposal = z.object({
  title: z.string().min(1).max(200), type: z.enum(["assignment", "quiz", "exam", "other"]),
  date: z.object({ value: z.string().optional(), precision: z.enum(["datetime", "date", "month", "week", "none"]) }).strict(),
  uncertain: z.boolean(), uncertaintyReason: z.enum(["ambiguous_order", "missing_year", "relative_week", "no_date", "other"]).optional(),
  week: z.number().int().min(1).max(30).optional(), confirmed: z.literal(false),
  evidence: z.array(z.object({ excerptId: Id, locationId: Id, start: z.number().int().min(0), end: z.number().int().min(1) }).strict()).min(1).max(8),
}).strict();
export const AiExtractResponse = z.object({
  version: z.literal(AI_VERSION), requestId: Id, mode: z.literal("mock"), policyVersion: z.string(), status: z.literal("ok"),
  proposals: z.array(AiProposal).max(50),
  usage: z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), costUsd: z.number(), simulated: z.boolean() }).strict().optional(),
}).strict();
export type AiExcerptValue = z.infer<typeof AiExcerpt>;
export type AiContextValue = z.infer<typeof AiContext>;
export type AiExtractRequestValue = z.infer<typeof AiExtractRequest>;
export type AiExtractResponseValue = z.infer<typeof AiExtractResponse>;

/** Same canonical form as backend/ai_gateway.py: sorted keys, no whitespace, UTF-8. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function aiPayloadDigest(policyVersion: string, destination: string, excerpts: AiExcerptValue[], context?: AiContextValue): Promise<string> {
  const payload = { version: AI_VERSION, policyVersion, destination, context: context ?? {},
    excerpts: excerpts.map(({ id, documentDigest, locationId, text }) => ({ id, documentDigest, locationId, text })) };
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function requestAiExtract(baseUrl: string, input: AiExtractRequestValue, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<AiExtractResponseValue> {
  const body = AiExtractRequest.parse(input), base = baseUrl.replace(/\/$/, "");
  if (body.excerpts.some(e => new TextEncoder().encode(e.text).length > AI_MAX_EXCERPT_BYTES)) throw new Error("An excerpt exceeds 2000 bytes. Select a shorter passage.");
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).length > AI_MAX_BODY_BYTES) throw new Error("The AI request exceeds the 16 KiB limit. Select fewer excerpts.");
  const context = await fetcher(`${base}/api/bridge-context`, { credentials: "omit", cache: "no-store", signal });
  if (!context.ok) throw new Error("Could not verify the local process. Reconnect before sending.");
  const binding = z.object({ version: z.literal("1"), binding: z.string().min(1) }).strict().parse(await context.json());
  const response = await fetcher(`${base}/api/ai/extract`, { method: "POST", credentials: "omit", cache: "no-store", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Moodle-Helper-Bridge-Binding": binding.binding }, body: encoded });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(z.object({ message: z.string() }).safeParse(result).data?.message ?? "AI request failed. No proposals were accepted.");
  return AiExtractResponse.parse(result);
}
