# Optional cloud AI contract (#42)

Status: **PROVIDER SELECTED, OFF BY DEFAULT; AC1 eval pending the owner's key.** On 2026-11-03 the owner replaced Google `gemini-3.8-flash` (free tier, chosen 2026-11-02) with **Groq, free plan (no card)**, model `openai/gpt-oss-120b`, because Google refused the Gemini free tier for the owner's project. Groq is called through its OpenAI-compatible HTTP API with the Python standard library, so there is no new dependency. External processing stays unavailable until the operator sets `MOODLE_HELPER_AI_PROVIDER=groq`, `GROQ_API_KEY` and `MOODLE_HELPER_AI_LEDGER_PATH` (and optionally `MOODLE_HELPER_AI_MODEL`) in the backend environment. This document is the contract that #43 (gateway) and #44 (consent UI) build on.

## 1. Decision

| Item | Decision |
| --- | --- |
| Selected provider | **Groq, free plan, `openai/gpt-oss-120b`** (owner decision 2026-11-03, replacing Google `gemini-3.8-flash` free tier from 2026-11-02, which replaced Anthropic `claude-haiku-5-5` from 2026-11-01). `GroqProvider` sits behind the `Provider` protocol in `backend/ai_gateway.py` (stdlib `urllib`, strict `json_schema`, no retries), so the wire contract is unchanged. Retention as accepted: Groq keeps no inference data by default but may log inputs and outputs for up to 30 days for reliability or abuse checks, stored in the US; Zero Data Retention is **off** (owner default, 2026-11-03), so the consent copy keeps the 30-day caveat. No training on inputs or outputs; users must be 18+. |
| Model and fallback | Primary `openai/gpt-oss-120b` (Production, strict `json_schema`, 131k context). Operator-selected fallback `openai/gpt-oss-20b` via `MOODLE_HELPER_AI_MODEL`; any other value is a startup `ValueError`. The app never switches models itself. The model is part of the consent destination `groq:<model>`, so a model change needs new consent. Not chosen: Preview models (`qwen/qwen3.8-27b`, `meta-models/muse-spark-open`) and Llama models absent from the free-plan table. |
| Gemini | `GeminiProvider` stays as dormant code (`MOODLE_HELPER_AI_PROVIDER=gemini` still works) and the `google-genai` dependency stays in `pyproject.toml` (owner default 2026-11-03; removal is a separate approved change). It is **not** the selected provider: Google refused the free tier for the owner's project. |
| Wire mode | `mode: "groq"` in `AiAvailable` and `AiExtractResponse` (additive to `"mock"` and `"gemini"`; OpenAPI, Pydantic, Zod and the shared bridge updated together). Destination `groq:<model>`, policy `groq-free-policy-1`, provider label `Groq <model>, free plan (external)`. |
| Activation | Operator-only environment variables: `MOODLE_HELPER_AI_PROVIDER=groq`, `GROQ_API_KEY`, `MOODLE_HELPER_AI_LEDGER_PATH` (durable ledger file), optional `MOODLE_HELPER_AI_MODEL`. No request, header or page message can select a provider. |
| Missing credential | The owner's Groq API key from console.groq.com (free plan, no card). Claude never types or stores it. |
| Missing evidence | **AC1 eval pending the owner's key:** a dated run of all 7 section 3 fixtures with `uv run python tools/run_ai_eval.py` (Groq, free plan, 0 USD), recorded in `ai-contract-eval-results.json`. |
| What may not proceed | Any claim of measured extraction quality before that run is recorded |

## 2. Candidate comparison

The OpenAI, Anthropic and Gemini columns use sources the PM accessed on 2026-10-29; **they were not rechecked** for the Groq change. The Groq column uses the PM's Groq sources accessed on 2026-11-03 (recheck before closing #42). Prices, policies and model names change. These are REST API candidates, not chat plans.

| | OpenAI `gpt-6-luna` | Anthropic `claude-haiku-5-5` | Google `gemini-3.8-flash` | **Groq `openai/gpt-oss-120b` (selected)** |
| --- | --- | --- | --- | --- |
| Price (USD per M tokens, in/out) | 0.10 / 0.50 ([pricing](https://developers.openai.com/api/docs/pricing)) | 0.10 / 0.50 for prompts up to 100k ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)); a higher tier applies above that, but it is unreachable under the 20k input cap | Paid: 0.75 / 3.75 through 2026-12-31, then 1.50 / 7.50 from 2027-01-01; thinking tokens count as output ([pricing](https://ai.google.dev/gemini-api/docs/pricing)) | 0 on the free plan (no card on file, so it cannot be billed). Free-plan limits for both gpt-oss models: 30 RPM, 1K RPD, 8K TPM, 200K TPD, per organization; a 429 carries `retry-after` ([rate limits](https://console.groq.com/docs/rate-limits), "Free Plan Limits") |
| Retention / training | Not trained on by default. Abuse logs may be kept up to 30 days, with exceptions ([data controls](https://developers.openai.com/api/docs/guides/your-data)). `store:false` is required, but it does **not** remove abuse retention or grant ZDR | Standard deletion within 30 days, with Files/agreement/policy/legal exceptions ([retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)). Model-specific exceptions also exist ([API retention](https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention)), so verify against the chosen model and account | The unpaid tier allows content use and human review. The paid tier is handled differently, with region exceptions ([terms](https://ai.google.dev/gemini-api/terms)). Paid no-training is not a documented zero-retention guarantee | No customer data from inference is kept by default, but inputs and outputs may be logged for up to 30 days to troubleshoot reliability errors or investigate suspected abuse; stored in US GCP buckets; Zero Data Retention can be enabled in Data Controls (off here) ([your data](https://console.groq.com/docs/your-data)). No training on Inputs or Outputs unless the customer permits it (§4.2), users 18+ (§2) ([Services Agreement](https://console.groq.com/docs/legal/services-agreement), last modified 2026-06-22). Beta-specific processing covers only Kimi K2 0905, not gpt-oss ([service-specific terms](https://groq.com/groq-service-specific-terms)) |
| Structured extraction | Documented ([structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)) | Documented ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [multilingual](https://platform.claude.com/docs/en/build-with-claude/multilingual-support)) | Documented ([structured output](https://ai.google.dev/gemini-api/docs/structured-output)) | Strict `json_schema` supported by both gpt-oss models: every property required, optional values as `[T, "null"]`, `additionalProperties: false`; no streaming or tools ([structured outputs](https://console.groq.com/docs/structured-outputs)). Production model, 131,072 context ([models](https://console.groq.com/docs/models)); `reasoning_effort` low/medium/high and `include_reasoning: false` ([reasoning](https://console.groq.com/docs/reasoning)); OpenAI-compatible base URL `https://api.groq.com/openai/v1`, `n` must be 1 ([OpenAI compatibility](https://console.groq.com/docs/openai)) |
| EN/RU syllabus quality | **Unmeasured** | **Unmeasured** | **Unmeasured.** Owner runs on 2026-11-02 and 2026-11-03 failed 0/7 with `403 PERMISSION_DENIED` at 0 USD: Google refused the free tier for the owner's project | **Pending the owner's key** (section 3) |
| Credential needed | Server project API key + billing | Server API key + billing | Free tier refused for the project; paid needs billing | Server-side Groq API key, free plan, no card |

No candidate is ranked on token price. A schema-valid response does not prove that its dates or evidence are accurate.

### Published nonprivate examples (dated 2026-10-29, publisher-authored, not executed here)

- OpenAI structured-outputs guide: event extraction from a short synthetic English sentence. Published output: a JSON object.
- Anthropic structured-outputs guide: contact-detail extraction, with example JSON output shown in English.
- Google structured-output guide: recipe extraction to a JSON schema, in English.

Limits: all three are English, non-syllabus, publisher demos. They show schema-constrained extraction exists. They are **not** independent measurements, and none covers Russian text, date ambiguity or source-location fidelity.

## 3. Evaluation plan (expected judgments, NOT provider results)

The nonprivate fixture inputs are in `_docs/architecture/ai-contract-eval-fixtures.json`. Each case states the judgment a compliant provider must produce. **AC1 eval pending the owner's key.** The owner sets `GROQ_API_KEY` in their own terminal and runs `uv run python tools/run_ai_eval.py` (default `--provider groq`, model from `MOODLE_HELPER_AI_MODEL` or `openai/gpt-oss-120b`). The runner sends the 7 synthetic fixtures (each under 200 B) one at a time, 21 s apart, with no retries (a 429 is recorded as `rate_limit`), and writes `ai-contract-eval-results.json` with `provider`, `model`, `tier: "free"`, `reasoningEffort: "low"`, `ranAt` (UTC), `priceTable`, `totalCostUsd: 0`, `passed` and per-case rows with token counts. Without a key it prints "GROQ_API_KEY is not set; nothing was sent." and exits 2. The run is summarized here case by case once it exists; failing cases are recorded honestly, and a run in which every case returns 401, 403 or 429 is not results.

Earlier attempt (one line, superseded): on 2026-11-03 17:47 UTC the Gemini `gemini-3.8-flash` free-tier run failed 0/7 with `403 PERMISSION_DENIED` at 0 USD; no extraction ran.

## 4. Request schema (version `ai-extract.v1`)

```json
{
  "version": "ai-extract.v1",
  "requestId": "opaque<=128",
  "consent": {
    "policyVersion": "string",
    "destination": "provider/model/tier | mock",
    "approvedExcerptIds": ["opaque<=128"],
    "payloadDigest": "sha256 of canonical excerpts+context"
  },
  "excerpts": [
    {"id": "opaque<=128", "documentDigest": "sha256", "locationId": "opaque<=128", "text": "<=2000 UTF-8 bytes"}
  ],
  "context": {"dateOrder": "DMY|MDY?", "timezone": "IANA?", "explicitSemesterBounds": {"start": "date?", "end": "date?"}}
}
```

Rules:
- The object is closed: unknown fields are rejected. A request has 1 to 8 excerpts, the body is at most 16 KiB (3072 B in Groq mode, published as `limits.maxBodyBytes`), and all IDs are opaque strings of at most 128 characters.
- Excerpts must be explicitly selected by the student. Their IDs must equal `consent.approvedExcerptIds`, and `payloadDigest` must match. Any change to the selection or destination requires new consent.
- A request must never carry binary data, file URLs, Moodle URLs, rosters, Snapshot data, credentials or automatically included whole-document text.
- Excerpt text is untrusted data. It is never treated as instructions or as authorization for tools.
- The existing metadata-only #31 route stays text-free. This boundary is the only proposed path for sending excerpts out, and it is inactive by default.

## 5. Response schema

```json
{
  "version": "ai-extract.v1",
  "requestId": "echo",
  "status": "ok | refused | invalid_output | cancelled | timeout | limit_exceeded | unavailable",
  "proposals": [
    {
      "title": "string",
      "type": "assignment|quiz|exam|other",
      "date": {"value": "ISO date/datetime or null", "precision": "datetime|date|month|week|none"},
      "uncertain": true,
      "uncertaintyReason": "ambiguous_order|missing_year|relative_week|no_date|other|null",
      "evidence": [{"excerptId": "supplied id", "start": 0, "end": 10}]
    }
  ]
}
```

Rules:
- A response holds at most 50 proposals. Every evidence reference must name a supplied excerpt ID with offsets inside that excerpt. The gateway checks that the quoted span supports the proposal and rejects unknown references or out-of-range offsets.
- Yearless, ambiguous (`03/04`) and week-relative expressions stay `uncertain` and keep their original evidence pointer. The model must not invent a page, date, year or timezone.
- Every proposal goes to human review. It never auto-confirms and never changes an assessment. A model score is not confidence policy.
- Any status other than `ok` is a non-success and yields no proposals.

## 6. Consent copy

Without activation the copy is: **"External AI unavailable: provider not selected; no text sent."** Mock mode adds: "Mock demonstration; stays local." With the Groq provider active, `/api/ai/availability` returns provider "Groq openai/gpt-oss-120b, free plan (external)", destination `groq:openai/gpt-oss-120b` (or `groq:openai/gpt-oss-20b`) and the disclosure `GROQ_RETENTION` from `backend/ai_gateway.py`: the excerpts go to Groq (free plan) and are processed in the US; under Groq's terms they are not used for training and nothing is kept by default, but Groq may log inputs and outputs for up to 30 days to troubleshoot errors or investigate suspected abuse; Groq requires users to be 18+; nothing else is sent. The existing consent sheet (#44, `frontend/src/components/mh/AiFallback.tsx`) shows the provider, the destination and mode, the retention text, the exact excerpts and the "Decline / continue locally" path; it is generic and names whatever the server returns, so no UI copy changed. If the selection exceeds the server's body limit, the sheet now states that limit (for Groq, "3072-byte request limit"). The dormant Gemini path still returns its own free-tier disclosure (`GEMINI_RETENTION`).

The consent sheet must show:
1. Destination: the provider, model and service tier by name, plus the server route the text takes.
2. Content sent: the exact selected excerpt text and its location IDs, and nothing else.
3. Retention: that provider's standard retention caveat from section 2, for example "may be kept up to 30 days for abuse monitoring".
4. Approximate cost: at most the reservation in section 7. Every result needs review.
5. **"Decline / continue locally"**. This sends nothing and keeps local PDF/DOCX/OCR extraction and review fully working.

Turning on a Settings flag is not consent to any particular payload. Consent cannot be shown for an unselected provider as if it named a real destination.

## 7. Limits and stop behavior

| Limit | Value | When hit |
| --- | --- | --- |
| Payload | 8 excerpts, 2000 B each, 16 KiB body; **Groq mode: 3072 B body**, published as `limits.maxBodyBytes` | Rejected before any provider work (413 `payload_too_large`) |
| Input tokens | At most 20,000 reserved, including prompt and schema (provider count, or a proven UTF-8 byte bound plus fixed overhead). **Groq mode:** bound = UTF-8 bytes of system prompt + serialized `response_format` + user message + 256 template tokens (a byte-level BPE token covers at least one byte); bound + 2000 output must be at most Groq's free **8K TPM**. Today the fixed part is 2318, so 2318 + 3072 + 2000 = 7390 (unit-tested) | Rejected before any provider work (413 `payload_too_large`) |
| Response size | HTTP body read up to 256 KiB; extracted content at most 64 KiB, depth 24, 50 proposals | `invalid_output`, no proposals |
| Output tokens | At most 2,000 billed, including reasoning | Hard cap in the request |
| Timeout | 30 s total | Aborted, `timeout`, no retry |
| Concurrency | 1 active request per process and 1 globally | Rejected, not queued |
| Rate | 3 per minute and 20 per day per local process, enforced server-side rather than by a resettable browser ID. Under Groq's free 30 RPM / 1K RPD; 20 × 8K = 160K tokens a day, under 200K TPD | 429 `rate_limit` with `Retry-After` before any call. A provider 429 also maps to `rate_limit`, passing `Retry-After` through (capped at 86400), and is not retried |
| Retries | No automatic provider retries | The student must explicitly resend |
| Exposure | Localhost-only. There is no public or anonymous gateway until an auth/abuse design exists. Origin alone is not authentication | Non-local requests are refused |
| Features | Text only: no tools, search, files, agents, cache, batch or background | Not offered |
| Credentials | Gateway env only. Never in `VITE_*` variables or browser code | n/a |
| Monthly cap | **0 USD.** Groq price table `groq-free-2026-11-03`, 0/0 USD per M tokens, valid until 2027-02-28; per-request reservation 0. The free plan has no card on file, so it cannot be billed; moving to the Developer plan needs a new owner decision and price table | After 2027-02-28 the table expires and requests stop with 503 `price_unavailable`; a nonzero reservation over the 0 USD cap stops with `budget_exhausted` |

Budget mechanics:
- A durable SQLite ledger records global spend plus in-flight reservations, and it survives restarts. The worst-case reservation is made atomically before each call. If the actual cost is unknown, the worst-case reservation is kept.
- The price table is fixed, versioned and carries a validity date. It expires as soon as a known price changes. A missing or expired price, an unavailable budget, or an exceeded cap rejects the request. There is no silent fallback to another model.
- A provider-side quota is not a guaranteed app cap.
- Mock runs record simulated costs that are clearly labeled as simulated, with no network and no billing.

Worst-case arithmetic for 20k input + 2k output (an example, not a measured bill):
- 0.10/0.50 candidates: 0.02 × 0.10 + 0.002 × 0.50 = **0.003 USD**
- Gemini promotional rate: 0.02 × 0.75 + 0.002 × 3.75 = **0.0225 USD**
- Gemini from 2027-01-01: **0.045 USD**

All three are under the 0.10 USD per-request reservation.

## 8. Criteria status

| AC | Status |
| --- | --- |
| 1. Comparison with sources and dated nonprivate results | **Blocked: AC1 eval pending the owner's key.** The dated Groq column (sources 2026-11-03) is in section 2 and the runner is ready; the dated run of all 7 fixtures with `provider: "groq"` and cost 0 still has to be produced and summarized in section 3 |
| 2. Explicit decision | Done: Groq free plan, `openai/gpt-oss-120b` (fallback `openai/gpt-oss-20b` by operator only), selected 2026-11-03; ZDR off; the missing credential is the owner's Groq key (section 1) |
| 3. Request/response schema | Done (sections 4 and 5) |
| 4. Consent copy | Done: names `groq:<model>`, Groq's retention and training terms, the content sent and the local decline path (section 6) |
| 5. Limits and stop behavior | Done (section 7) |
