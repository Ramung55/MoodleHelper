# Optional cloud AI contract (#42)

Status: **NO PROVIDER ACTIVE.** External processing is unavailable, and the production monthly budget is **0 USD**. This document is the contract that #43 (mock gateway) and #44 (consent UI) build on. It does not authorize any paid request, provider account, credential, upload or dependency.

## 1. Decision

| Item | Decision |
| --- | --- |
| Selected provider | **None. Blocked.** |
| Missing owner decisions | (a) destination provider, model and service tier; (b) acceptance of that provider's retention terms; (c) the activation of a monthly cap (proposed 10 USD) |
| Missing credentials | A server-side API key on a billed API account (not a chat subscription), held only in gateway env |
| Missing evidence | Dated, comparable English/Russian syllabus extraction results per candidate (see section 3) |
| What may proceed | Local PDF/DOCX/OCR extraction (it does not depend on this work); #43 no-network mock; #44 consent/decline flow with truthful "unavailable"/"mock" status |
| What may not proceed | Any genuine external call, or any claim that one was made |

If activation is requested later, ask the owner for the provider/model/tier, retention acceptance and monthly ceiling, then obtain the credential securely (never in chat, the browser bundle or a `VITE_` variable).

## 2. Candidate comparison

Sources were accessed by the PM on 2026-10-29 and carried into this document on 2026-10-31. **They were not re-fetched for this document.** Prices, policies and model names change, so recheck every row before activation. These are REST API candidates, not chat plans.

| | OpenAI `gpt-6-luna` | Anthropic `claude-haiku-5-5` | Google `gemini-3.8-flash` (paid tier only) |
| --- | --- | --- | --- |
| Price (USD per M tokens, in/out) | 0.10 / 0.50 ([pricing](https://developers.openai.com/api/docs/pricing)) | 0.10 / 0.50 for prompts up to 100k ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)); a higher tier applies above that, but it is unreachable under the 20k input cap | 0.75 / 3.75 through 2026-12-31, then 1.50 / 7.50 from 2027-01-01; thinking tokens count as output ([pricing](https://ai.google.dev/gemini-api/docs/pricing)) |
| Retention / training | Not trained on by default. Abuse logs may be kept up to 30 days, with exceptions ([data controls](https://developers.openai.com/api/docs/guides/your-data)). `store:false` is required, but it does **not** remove abuse retention or grant ZDR | Standard deletion within 30 days, with Files/agreement/policy/legal exceptions ([retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)). Model-specific exceptions also exist ([API retention](https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention)), so verify against the chosen model and account | The unpaid tier allows content use and human review, so it must never be used for this. The paid tier is handled differently, with region exceptions ([terms](https://ai.google.dev/gemini-api/terms)). Paid no-training is not a documented zero-retention guarantee, and exact retention is **unresolved** |
| Structured extraction | Documented ([structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)) | Documented ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [multilingual](https://platform.claude.com/docs/en/build-with-claude/multilingual-support)) | Documented ([structured output](https://ai.google.dev/gemini-api/docs/structured-output)) |
| EN/RU syllabus quality | **Unmeasured** | **Unmeasured** | **Unmeasured** |
| Credential needed | Server project API key + billing | Server API key + billing | Paid-tier project key + active billing |

No candidate is ranked on token price. A schema-valid response does not prove that its dates or evidence are accurate.

### Published nonprivate examples (dated 2026-10-29, publisher-authored, not executed here)

- OpenAI structured-outputs guide: event extraction from a short synthetic English sentence. Published output: a JSON object.
- Anthropic structured-outputs guide: contact-detail extraction, with example JSON output shown in English.
- Google structured-output guide: recipe extraction to a JSON schema, in English.

Limits: all three are English, non-syllabus, publisher demos. They show schema-constrained extraction exists. They are **not** independent measurements, and none covers Russian text, date ambiguity or source-location fidelity.

## 3. Evaluation plan (expected judgments, NOT provider results)

The nonprivate fixture inputs are in `_docs/architecture/ai-contract-eval-fixtures.json`. Each case states the judgment a compliant provider must produce. No provider has run them. **AC1 stays blocked** until the owner authorizes a bounded paid run (or supplies equivalent dated evidence) and the results are recorded per candidate with date, model and tier.

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
- The object is closed: unknown fields are rejected. A request has 1 to 8 excerpts, the body is at most 16 KiB, and all IDs are opaque strings of at most 128 characters.
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

The current (blocked) copy is: **"External AI unavailable: provider not selected; no text sent."** Mock mode adds: "Mock demonstration; stays local."

Once a provider is activated, the consent sheet must show:
1. Destination: the provider, model and service tier by name, plus the server route the text takes.
2. Content sent: the exact selected excerpt text and its location IDs, and nothing else.
3. Retention: that provider's standard retention caveat from section 2, for example "may be kept up to 30 days for abuse monitoring".
4. Approximate cost: at most the reservation in section 7. Every result needs review.
5. **"Decline / continue locally"**. This sends nothing and keeps local PDF/DOCX/OCR extraction and review fully working.

Turning on a Settings flag is not consent to any particular payload. Consent cannot be shown for an unselected provider as if it named a real destination.

## 7. Limits and stop behavior

| Limit | Value | When hit |
| --- | --- | --- |
| Payload | 8 excerpts, 2000 B each, 16 KiB body | Rejected before any provider work (`limit_exceeded`) |
| Input tokens | At most 20,000 reserved, including prompt and schema (provider count, or a proven UTF-8 byte bound plus fixed overhead) | Rejected if the input cannot be bounded |
| Output tokens | At most 2,000 billed, including reasoning | Hard cap in the request |
| Timeout | 30 s total | Aborted, `timeout`, no retry |
| Concurrency | 1 active request per process and 1 globally | Rejected, not queued |
| Rate | 3 per minute and 20 per day per local process, enforced server-side rather than by a resettable browser ID | `limit_exceeded` until the window passes |
| Retries | No automatic provider retries | The student must explicitly resend |
| Exposure | Localhost-only. There is no public or anonymous gateway until an auth/abuse design exists. Origin alone is not authentication | Non-local requests are refused |
| Features | Text only: no tools, search, files, agents, cache, batch or background | Not offered |
| Credentials | Gateway env only. Never in `VITE_*` variables or browser code | n/a |
| Monthly cap | **0 USD now.** Proposed after owner activation: 10 USD per calendar month (UTC), with at most 0.10 USD reserved per request | Rejected before calling (`limit_exceeded` / `unavailable`) |

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
| 1. Comparison with sources and dated nonprivate results | Partial. The comparison and dated publisher examples are recorded, but comparable EN/RU syllabus results are **blocked** on owner authorization of a bounded evaluation run plus credentials |
| 2. Explicit decision | Done: blocked, with missing decisions and credential named (section 1) |
| 3. Request/response schema | Done (sections 4 and 5) |
| 4. Consent copy | Done for blocked/mock states. Destination-specific wording is templated until a provider is chosen |
| 5. Limits and stop behavior | Done (section 7) |
