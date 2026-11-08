/**
 * #44 with a Groq-shaped gateway (no network): the consent preview shows the server's provider and
 * retention verbatim, and Groq failures as the #42 gateway maps them (429 rate_limit, 504 timeout,
 * 502 provider_failure for Groq 401/403) reach the UI with Retry and local review, keeping local data.
 */
import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { DecompressionStream as NativeDecompressionStream } from "node:stream/web";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiFallback } from "@/components/mh/AiFallback";
import { detectAssessmentMentions, type AssessmentMention } from "@/domain/assessment-mentions";
import { parseSyllabusMention } from "@/domain/syllabus-dates";
import {
  sendFrozen,
  unresolvedMentions,
  type AvailableAi,
  type FrozenPreview,
} from "@/services/ai-fallback";
import { extractDocx } from "@/services/extract-docx";
import { readLocalDocument, saveLocalDocument } from "@/services/local-documents";
import { indexedDbFixture } from "./indexeddb-fixture";

const datasetId = "12345678-1234-4123-8123-123456789abc",
  digest = "b".repeat(64);
const association = {
  datasetId,
  courseId: "c-csc",
  digest,
  name: "ai-fallback-synthetic.docx",
  size: 100,
  source: "Local",
  createdAt: "now",
};
// Word for word from the #44 body (PM grooming 2026-11-03); the server owns this text.
const GROQ_RETENTION =
  "The selected excerpts are sent to Groq (GroqCloud free plan) for processing. By default Groq does not keep inputs or outputs, but it may log them for up to 30 days to troubleshoot errors or investigate suspected abuse; logs are stored in the United States. Groq's terms do not allow it to train models on them. You must be 18 or older. Do not send personal or confidential information. Nothing else from Moodle Helper is sent.";
const groq: AvailableAi = {
  available: true,
  provider: "Groq openai/gpt-oss-120b, free plan (external)",
  retention: GROQ_RETENTION,
  mode: "groq",
  policyVersion: "groq-free-policy-1",
  destination: "groq:openai/gpt-oss-120b",
  limits: {
    maxExcerpts: 8,
    maxExcerptBytes: 2000,
    maxBodyBytes: 3072,
    timeoutSeconds: 30,
    monthlyCapUsd: 0,
    perRequestReserveUsd: 0,
    simulatedCost: false,
  },
};
const fixture = () =>
  new NodeBlob([readFileSync("src/test/fixtures/ai-fallback-synthetic.docx")]) as unknown as Blob;
let storage: ReturnType<typeof indexedDbFixture>;

beforeEach(() => {
  storage = indexedDbFixture();
  vi.stubGlobal("indexedDB", storage.indexedDB);
  vi.stubGlobal("IDBKeyRange", storage.IDBKeyRange);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("DecompressionStream", NativeDecompressionStream);
  // Only currentDataset() uses the global fetch; every AI call goes through the explicit fetcher below.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ datasetId }), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The synthetic fixture through the real local pipeline: these are the excerpts Optional AI help offers. */
async function unresolvedFromFixture(): Promise<AssessmentMention[]> {
  const blocks = await extractDocx(fixture(), new AbortController().signal, vi.fn());
  const mentions = await detectAssessmentMentions(
    { format: "docx", datasetId, courseId: association.courseId, digest, complete: true, blocks },
    new AbortController().signal,
  );
  return unresolvedMentions(
    mentions,
    mentions.map((m) => parseSyllabusMention(m)),
  );
}

/** A gateway that answers like backend/main.py in Groq mode; `extract` decides the /api/ai/extract outcome. */
function gateway(extract: (init: RequestInit) => Promise<Response>) {
  const calls: { url: string; method: string }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    if (url.endsWith("/api/ai/availability")) return new Response(JSON.stringify(groq));
    if (url.endsWith("/api/bridge-context"))
      return new Response(JSON.stringify({ version: "1", binding: "b" }));
    if (url.endsWith("/api/ai/extract")) return extract(init);
    throw new Error(`unexpected ${url}`);
  });
  const send = (preview: FrozenPreview, signal: AbortSignal) =>
    sendFrozen(preview, signal, {
      fetcher: fetcher as unknown as typeof fetch,
      baseUrl: "http://127.0.0.1:8000",
      dataset: async () => datasetId,
    });
  return { calls, send, extracts: () => calls.filter((c) => c.url.endsWith("/api/ai/extract")) };
}
const failure = (status: number, code: string, message: string) => async () =>
  new Response(JSON.stringify({ message: `${message} (code: ${code}; request: ai-x)` }), {
    status,
  });

async function openPreview(
  mentions: AssessmentMention[],
  send: (p: FrozenPreview, s: AbortSignal) => Promise<never> | ReturnType<typeof sendFrozen>,
) {
  render(
    <AiFallback
      document={association}
      mentions={mentions}
      deps={{ send, loadAvailability: async () => groq, dataset: async () => datasetId }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Optional AI help" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select excerpt Assignment 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Review what will be sent" }));
  await screen.findByRole("button", { name: "Send" });
}

it.each(["demo", "real"])("hides technical fields in the %s dataset preview", async (dataset) => {
  const id = dataset === "demo" ? datasetId : "87654321-4321-4321-8321-abcdefabcdef";
  const { send } = gateway(failure(500, "provider_failure", "unused"));
  render(
    <AiFallback
      document={{ ...association, datasetId: id }}
      mentions={(await unresolvedFromFixture()).map((mention) => ({ ...mention, datasetId: id }))}
      deps={{ send, loadAvailability: async () => groq, dataset: async () => id }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Optional AI help" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select excerpt Assignment 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Review what will be sent" }));
  const preview = await screen.findByLabelText("AI send preview");
  const visible = preview.cloneNode(true) as HTMLElement;
  visible.querySelectorAll("details:not([open])").forEach((d) =>
    Array.from(d.children).forEach((c) => {
      if (c.tagName !== "SUMMARY") c.remove();
    }),
  );
  for (const pattern of [
    /[0-9a-f]{64}/,
    /\d{4}-\d{2}-\d{2}T\d{2}:/,
    /\bbytes\b/i,
    /policy-\d/,
    /\b(?:partial|verified|visited_activity_only|reference_only)\b/,
    /\b(?:record|request|location|paragraph|course|job)[-_]id\s*[:=]/i,
  ])
    expect(visible.textContent).not.toMatch(pattern);
});

it("offers the unresolved synthetic fixture sentences and keeps the locally resolved one out", async () => {
  const unresolved = await unresolvedFromFixture();
  const excerpts = unresolved.map((m) => m.excerpt).join("\n");
  expect(excerpts).toContain("Assignment 1 (essay) deadline: 03/04/2027.");
  expect(excerpts).toContain("Midterm exam in Week 6.");
  expect(excerpts).toContain("Контрольная работа 2 — 20 ноября.");
  expect(excerpts).not.toContain("Lab assignment 2");
});

it("shows the server's Groq provider and retention word for word, with no Gemini or Google copy", async () => {
  const { send, extracts } = gateway(failure(500, "provider_failure", "unused"));
  await openPreview(await unresolvedFromFixture(), send);
  const preview = screen.getByLabelText("AI send preview");
  const defaultView = preview.cloneNode(true) as HTMLElement;
  defaultView.querySelectorAll("details:not([open])").forEach((details) =>
    Array.from(details.children).forEach((child) => {
      if (child.tagName !== "SUMMARY") child.remove();
    }),
  );
  for (const pattern of [
    /[0-9a-f]{64}/,
    /\d{4}-\d{2}-\d{2}T\d{2}:/,
    /\bbytes\b/i,
    /policy-\d/,
    /visited_activity_only|reference_only|mode groq/,
  ])
    expect(defaultView.textContent).not.toMatch(pattern);
  expect(preview).toHaveTextContent("Sends to: Groq openai/gpt-oss-120b, free plan (external)");
  expect(preview).toHaveTextContent(
    "Excerpts may contain private information and are sent exactly as shown without automatic redaction. Files, Moodle session data and cloud-sync records are never sent.",
  );
  expect(screen.getByText(GROQ_RETENTION)).toBeVisible();
  expect(preview).toHaveTextContent(
    "groq-free-policy-1 · cost cap $0/month, reserve $0/request · timeout 30 s",
  );
  expect(preview).not.toHaveTextContent("(simulated)");
  expect(screen.getByText("Assignment 1 (essay) deadline: 03/04/2027.")).toBeVisible();
  const bytes = Number(/· (\d+) bytes ·/.exec(preview.textContent ?? "")![1]);
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThanOrEqual(3072);
  expect(document.body.textContent).not.toMatch(/gemini|google/i);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(extracts()).toHaveLength(0);
});

const cases: [string, () => Promise<Response>, RegExp, string][] = [
  [
    "429 rate_limit",
    failure(429, "rate_limit", "AI request rate limit reached. Try again later."),
    /^AI rate limit reached\. Try again later or continue local review\./,
    "rate_limit",
  ],
  [
    "504 timeout",
    failure(
      504,
      "timeout",
      "AI provider timed out. Nothing was retried; review and resend manually.",
    ),
    /^The AI provider timed out\. Nothing was retried automatically\./,
    "timeout",
  ],
  [
    "Groq 401 (502 provider_failure)",
    failure(
      502,
      "provider_failure",
      "AI provider failed. Nothing was retried; review and resend manually.",
    ),
    /^AI provider failed\. Nothing was retried automatically/,
    "provider",
  ],
  [
    "Groq 403 (502 provider_failure)",
    failure(
      502,
      "provider_failure",
      "AI provider failed. Nothing was retried; review and resend manually.",
    ),
    /^AI provider failed\. Nothing was retried automatically/,
    "provider",
  ],
];
it.each(cases)(
  "%s reaches the UI with Retry same request and local review, and keeps the imported document",
  async (_name, extract, message, kind) => {
    await saveLocalDocument(association, fixture(), [], new AbortController().signal);
    const before = new Uint8Array(
      await (await readLocalDocument(association, new AbortController().signal)).arrayBuffer(),
    );
    const { send, extracts } = gateway(extract);
    await openPreview(await unresolvedFromFixture(), send);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(message);
    expect(alert).toHaveTextContent("Imported document data and local review are unchanged.");
    expect(alert).not.toHaveTextContent("03/04/2027");
    expect(alert).not.toHaveTextContent("code:");
    expect(alert).not.toHaveTextContent("ai-x");
    expect(screen.getByText(new RegExp(`Last outcome: ${kind}`))).toBeInTheDocument();
    expect(extracts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
    await waitFor(() => expect(extracts()).toHaveLength(2));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Continue local review" })).toBeVisible();
    const after = new Uint8Array(
      await (await readLocalDocument(association, new AbortController().signal)).arrayBuffer(),
    );
    expect(after).toEqual(before);
    fireEvent.click(screen.getByRole("button", { name: "Continue local review" }));
    expect(screen.getByRole("button", { name: "Optional AI help" })).toBeVisible();
  },
);

it("a 30 s client timeout says the request may have been received and offers Retry and local review", async () => {
  // The 30 s client limit is AbortSignal.timeout(30_000); fire it by hand instead of waiting.
  const clock = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
  try {
    const { send, extracts } = gateway(
      (init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    );
    await openPreview(await unresolvedFromFixture(), send);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Cancel request" });
    await waitFor(() => expect(extracts()).toHaveLength(1));
    expect(timeout).toHaveBeenCalledWith(30_000);
    clock.abort(new DOMException("signal timed out", "TimeoutError"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "No answer within 30 seconds. The request may already have been received",
    );
    expect(
      screen.getByText(/Last outcome: timeout · request possibly received/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry same request" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Continue local review" })).toBeVisible();
  } finally {
    timeout.mockRestore();
  }
});
