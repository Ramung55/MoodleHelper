import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiFallback } from "@/components/mh/AiFallback";
import type { AssessmentMention } from "@/domain/assessment-mentions";
import { AiRequestError } from "@/services/ai-gateway";
import { classifyAiFailure, freezePreview, sendFrozen, validateAiResponse, type AvailableAi } from "@/services/ai-fallback";

vi.stubGlobal("crypto", webcrypto);
vi.mock("@/services/local-documents", () => ({ currentDataset: vi.fn(async () => "dataset") }));
const digest = "a".repeat(64);
const association = { datasetId: "dataset", courseId: "course", digest, name: "source.pdf", size: 10, source: "Local selection", createdAt: "now" };
const mention = (id: string, excerpt: string): AssessmentMention => ({ datasetId: "dataset", courseId: "course", digest, complete: true, id, detectorVersion: "assessment-mentions-1", type: "quiz", title: `Quiz ${id}`, excerpt,
  mention: { start: 0, end: 4, text: "Quiz" }, location: { kind: "pdf_row", page: 3, items: [{ text: excerpt, page: 3, transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 }] }, rawScheduleText: excerpt, date: { kind: "unknown" }, status: "unconfirmed", reasons: [] } as unknown as AssessmentMention);
const info: AvailableAi = { available: true, provider: "Local mock; no external provider", retention: "Mock demonstration; stays local.", mode: "mock", policyVersion: "mock-policy-1", destination: "mock",
  limits: { maxExcerpts: 8, maxExcerptBytes: 2000, maxBodyBytes: 16384, timeoutSeconds: 30, monthlyCapUsd: 0, perRequestReserveUsd: 0, simulatedCost: true } };
const m1 = mention("m1", "Quiz 1 on 2026-12-05 <script>alert(1)</script>"), m2 = mention("m2", "Квиз 2 неделя 5 😀");
const ok = (preview: Awaited<ReturnType<typeof freezePreview>>, proposals: unknown[]) => ({ version: "ai-extract.v1" as const, requestId: preview.requestId, mode: "mock" as const, policyVersion: "mock-policy-1", status: "ok" as const, proposals: proposals as never });
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("freezes exactly the wire request and rejects oversized selections without truncation", async () => {
  const preview = await freezePreview({ association, datasetId: "dataset", info, mentions: [m1, m2], context: { timezone: "Europe/Copenhagen" } });
  expect(preview.request.excerpts.map(e => e.text)).toEqual([m1.excerpt, m2.excerpt]);
  expect(preview.request.consent.approvedExcerptIds).toEqual(["ex-0", "ex-1"]);
  expect(preview.request.consent.payloadDigest).toBe(preview.payloadDigest);
  expect(JSON.stringify(preview.request)).not.toMatch(/cookie|token|snapshot|base64/i);
  await expect(freezePreview({ association, datasetId: "dataset", info, mentions: [mention("big", "ж".repeat(1001))] })).rejects.toThrow("2000");
  await expect(freezePreview({ association, datasetId: "dataset", info, mentions: Array.from({ length: 9 }, (_, i) => mention(`x${i}`, "Quiz")) })).rejects.toThrow("at most 8");
});

it("sends nothing to the extract route when the gateway is unavailable, and offers only local continuation", async () => {
  const send = vi.fn();
  render(<AiFallback document={association} mentions={[m1]} deps={{ send, loadAvailability: async () => ({ available: false, reason: "x" }) }} />);
  fireEvent.click(screen.getByRole("button", { name: "Optional AI help" }));
  expect(await screen.findByText(/External AI unavailable; continue locally/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it("previews inert text and named destination; cancel sends nothing; selection change requires a new preview", async () => {
  const send = vi.fn();
  render(<AiFallback document={association} mentions={[m1, m2]} deps={{ send, loadAvailability: async () => info }} />);
  fireEvent.click(screen.getByRole("button", { name: "Optional AI help" }));
  const box = await screen.findByRole("checkbox", { name: "Select excerpt Quiz m1" });
  expect(box).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Review what will be sent" })).toBeDisabled();
  fireEvent.click(box); fireEvent.click(screen.getByRole("button", { name: "Review what will be sent" }));
  expect(await screen.findByText(/Local mock; no external provider/)).toBeVisible();
  expect(screen.getByText(/Mock demonstration; stays local/)).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText(m1.excerpt)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Optional AI help" })).toBeVisible();
});

it("invalidates a preview when the explicit context changes", async () => {
  const send = vi.fn();
  const view = render(<AiFallback document={association} mentions={[m1]} context={{ dateOrder: "DMY" }} deps={{ send, loadAvailability: async () => info }} />);
  fireEvent.click(screen.getByRole("button", { name: "Optional AI help" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select excerpt Quiz m1" }));
  fireEvent.click(screen.getByRole("button", { name: "Review what will be sent" }));
  await screen.findByRole("button", { name: "Send" });
  view.rerender(<AiFallback document={association} mentions={[m1]} context={{ dateOrder: "MDY" }} deps={{ send, loadAvailability: async () => info }} />);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send" })).toBeNull());
  expect(screen.getByText(/changed. Review a new preview/)).toBeVisible();
  expect(send).not.toHaveBeenCalled();
});

it("shows a sanitized failure and retries only explicitly with the same request id", async () => {
  const send = vi.fn().mockRejectedValueOnce(new AiRequestError("x (code: rate_limit)", 429, "rate_limit")).mockRejectedValueOnce(new AiRequestError("x (code: duplicate_request)", 409, "duplicate_request"));
  render(<AiFallback document={association} mentions={[m1]} deps={{ send, loadAvailability: async () => info }} />);
  fireEvent.click(screen.getByRole("button", { name: "Optional AI help" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select excerpt Quiz m1" }));
  fireEvent.click(screen.getByRole("button", { name: "Review what will be sent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("rate limit");
  expect(screen.getByRole("alert")).not.toHaveTextContent(m1.excerpt);
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already processed"));
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].requestId).toBe(send.mock.calls[0][0].requestId);
  expect(screen.getByRole("button", { name: "Continue local review" })).toBeVisible();
});

it("maps every failure to a fixed local-review message", () => {
  const cases: [unknown, string][] = [[new TypeError("fetch failed"), "offline"], [new DOMException("t", "TimeoutError"), "timeout"], [new AiRequestError("m", 503, "unavailable"), "unavailable"],
    [new AiRequestError("m", 502, "provider_failure"), "provider"], [new AiRequestError("m", 502, "invalid_output"), "invalid"], [new AiRequestError("m", 429, "budget_exhausted"), "rate_limit"]];
  for (const [error, kind] of cases) { const outcome = classifyAiFailure(error, false); expect(outcome.kind).toBe(kind); expect(outcome.message).toMatch(/local review are unchanged/); }
  expect(classifyAiFailure(new TypeError(), true)).toMatchObject({ kind: "cancelled", maybeReceived: true });
});

it("validates evidence against selected excerpts, forces AI review and never invents dates", async () => {
  const preview = await freezePreview({ association, datasetId: "dataset", info, mentions: [m1, m2] });
  const [e0, e1] = preview.excerpts;
  const base = { title: "Quiz 1", type: "quiz", uncertain: false, confirmed: false };
  const result = await validateAiResponse(preview, ok(preview, [
    { ...base, date: { value: "2026-12-05", precision: "date" }, evidence: [{ excerptId: "ex-0", locationId: e0.locationId, start: 10, end: 20 }] },
    { ...base, date: { value: "2026-02-31", precision: "date" }, evidence: [{ excerptId: "ex-1", locationId: e1.locationId, start: 0, end: 4 }] },
    { ...base, date: { precision: "none" }, uncertain: true, uncertaintyReason: "missing_year", evidence: [{ excerptId: "ex-1", locationId: e1.locationId, start: 0, end: 4 }] },
    { ...base, date: { precision: "none" }, evidence: [{ excerptId: "ex-0", locationId: e1.locationId, start: 0, end: 4 }] },
    { ...base, date: { precision: "none" }, evidence: [{ excerptId: "ex-9", locationId: e0.locationId, start: 0, end: 4 }] },
    { ...base, date: { precision: "none" }, evidence: [{ excerptId: "ex-1", locationId: e1.locationId, start: 0, end: 999 }] },
  ]));
  expect(result.records).toHaveLength(3); expect(result.rejected.map(r => r.index)).toEqual([3, 4, 5]);
  expect(result.records.every(r => r.proposal.facts.aiProposal === true && r.proposal.facts.explicitDate === false)).toBe(true);
  expect(result.records[0].proposal.date).toEqual({ kind: "date", date: "2026-12-05" });
  expect(result.records[1].proposal.date).toEqual({ kind: "unknown" });
  expect(result.records[2].proposal.facts.inferredYear).toBe(true);
  expect(result.records[0].original.mention.excerpt).toBe(m1.excerpt);
  await expect(validateAiResponse(preview, { ...ok(preview, []), requestId: "other" })).rejects.toThrow("does not match");
});

it("sends the frozen body through the real client only after re-checking dataset and policy", async () => {
  const preview = await freezePreview({ association, datasetId: "dataset", info, mentions: [m1] });
  const bodies: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/ai/availability")) return new Response(JSON.stringify(info));
    if (url.endsWith("/api/bridge-context")) return new Response(JSON.stringify({ version: "1", binding: "b" }));
    bodies.push(String(init?.body)); return new Response(JSON.stringify(ok(preview, [])));
  });
  await sendFrozen(preview, new AbortController().signal, { fetcher: fetcher as unknown as typeof fetch, dataset: async () => "dataset" });
  expect(JSON.parse(bodies[0])).toEqual(preview.request);
  await expect(sendFrozen(preview, new AbortController().signal, { fetcher: fetcher as unknown as typeof fetch, dataset: async () => "other" })).rejects.toThrow("dataset changed");
  const changed = vi.fn(async (url: string) => url.endsWith("/availability") ? new Response(JSON.stringify({ ...info, policyVersion: "mock-policy-2" })) : new Response("{}"));
  await expect(sendFrozen(preview, new AbortController().signal, { fetcher: changed as unknown as typeof fetch, dataset: async () => "dataset" })).rejects.toThrow("policy or destination changed");
  expect(changed.mock.calls.some(([url]) => String(url).includes("/extract"))).toBe(false);
  expect(bodies).toHaveLength(1);
});
