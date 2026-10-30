import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { aiPayloadDigest, requestAiExtract } from "@/services/ai-gateway";

vi.stubGlobal("crypto", webcrypto);
const excerpt = { id: "ex-0", documentDigest: "a".repeat(64), locationId: "loc-0", text: "Контрольная \"1\"\n2026-12-05 😀" };

it("computes the same canonical payload digest as the backend", async () => {
  // Reference value from backend.ai_gateway.payload_digest for the same input.
  expect(await aiPayloadDigest("mock-policy-1", "mock", [excerpt], { timezone: "Asia/Almaty", explicitSemesterBounds: { start: "2026-09-01" } }))
    .toBe("89503ecf28cef230276c76c04db2130aa7d76ccf76be422ff95e754d7cf7a98a");
});

it("sends a bound request and parses unconfirmed proposals; rejects oversize before fetch", async () => {
  const consent = { policyVersion: "mock-policy-1", destination: "mock", approvedExcerptIds: ["ex-0"], payloadDigest: "b".repeat(64) };
  const request = { version: "ai-extract.v1" as const, requestId: "r1", expectedDatasetId: "d1", consent, excerpts: [excerpt] };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.endsWith("/bridge-context")
    ? new Response(JSON.stringify({ version: "1", binding: "b1" }))
    : (expect((init?.headers as Record<string, string>)["X-Moodle-Helper-Bridge-Binding"]).toBe("b1"),
      new Response(JSON.stringify({ version: "ai-extract.v1", requestId: "r1", mode: "mock", policyVersion: "mock-policy-1", status: "ok",
        proposals: [{ title: "Mock candidate (quiz)", type: "quiz", date: { value: "2026-12-05", precision: "date" }, uncertain: false, confirmed: false, evidence: [{ excerptId: "ex-0", locationId: "loc-0", start: 16, end: 26 }] }] }))));
  const result = await requestAiExtract("http://127.0.0.1:8000", request, fetcher as unknown as typeof fetch);
  expect(result.proposals[0].confirmed).toBe(false);
  fetcher.mockClear();
  await expect(requestAiExtract("http://127.0.0.1:8000", { ...request, excerpts: [{ ...excerpt, text: "ж".repeat(1001) }] }, fetcher as unknown as typeof fetch)).rejects.toThrow("2000 bytes");
  expect(fetcher).not.toHaveBeenCalled();
});

it("surfaces the sanitized backend failure message", async () => {
  const consent = { policyVersion: "p", destination: "mock", approvedExcerptIds: ["ex-0"], payloadDigest: "b".repeat(64) };
  const fetcher = vi.fn(async (url: string) => url.endsWith("/bridge-context") ? new Response(JSON.stringify({ version: "1", binding: "b" }))
    : new Response(JSON.stringify({ message: "External AI unavailable: provider not selected; no text sent. (code: unavailable)" }), { status: 503 }));
  await expect(requestAiExtract("http://x", { version: "ai-extract.v1", requestId: "r", expectedDatasetId: "d", consent, excerpts: [excerpt] }, fetcher as unknown as typeof fetch)).rejects.toThrow("code: unavailable");
});
