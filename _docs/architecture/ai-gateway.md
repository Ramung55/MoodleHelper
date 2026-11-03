# Optional AI gateway (#43)

Status: **off by default; selected provider Groq `openai/gpt-oss-120b`, free plan (#42, 2026-11-03); production budget 0 USD.** Contract: `ai-contract.md` (`ai-extract.v1`, #42).
Code: `backend/ai_gateway.py`, route `POST /api/ai/extract`, client `frontend/src/services/ai-gateway.ts`.

## Modes

| Mode | How selected | Behavior |
| --- | --- | --- |
| unavailable (default) | Ordinary `create_app()` | `GET /api/ai/availability` keeps `available:false` with the legacy reason; `POST /api/ai/extract` returns 503 `unavailable`. No ledger, no provider. |
| mock | Trusted code only: `create_app(ai_gateway=AiGateway(mock_config(path), MockProvider()))` | Deterministic local rules, no network, simulated cost (10 USD/month UTC cap, 0.10 USD/request reservation). Availability says "Local mock; no external provider". |
| groq (selected) | Operator env only: `MOODLE_HELPER_AI_PROVIDER=groq`, `GROQ_API_KEY`, `MOODLE_HELPER_AI_LEDGER_PATH`, optional `MOODLE_HELPER_AI_MODEL` (`openai/gpt-oss-120b` default or `openai/gpt-oss-20b`; anything else is a startup `ValueError`) | `GroqProvider`: stdlib `urllib` POST to the hardcoded `https://api.groq.com/openai/v1/chat/completions`, explicit `User-Agent`, no redirects, strict `json_schema`, `max_completion_tokens` 2000, `reasoning_effort` low, `n` 1, no tools, no retries. Destination `groq:<model>`, policy `groq-free-policy-1`, price table `groq-free-2026-11-03` (0/0, valid to 2027-02-28), cap 0 USD, body bound 3072 B, 8K-token input+output bound. |
| gemini (dormant) | Operator env only: `MOODLE_HELPER_AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `MOODLE_HELPER_AI_LEDGER_PATH` | `GeminiProvider` via `google-genai`. Kept as code, not selected: Google refused the free tier for the owner's project. |

No request body, query, header, page or bridge message can switch modes. `GatewayConfig(mode=...)` rejects anything other than `unavailable`, `mock`, `gemini` and `groq`.

## Request handling (in order, all before provider work)

1. Middleware checks the `X-Moodle-Helper-Bridge-Binding` (409), then applies a 16 KiB body bound (413) before parsing.
2. Closed schema (unknown fields → 422 `invalid_request` with a fixed message; submitted values are never echoed), 1 to 8 excerpts, 2000 UTF-8 bytes each (413), unique IDs, `expectedDatasetId` equal to the startup dataset (409).
3. Consent: `approvedExcerptIds` must equal the excerpt IDs in order, and destination/policy must equal the configured ones. `payloadDigest` = SHA-256 of the UTF-8 canonical JSON `{"context","destination","excerpts":[{documentDigest,id,locationId,text}],"policyVersion","version"}` with sorted keys, `,`/`:` separators, no ASCII escaping, and `context` `{}` when absent.
4. Groq mode only: the compact JSON body must be at most 3072 B (413 `payload_too_large`), and the provable input bound (UTF-8 bytes of system prompt + serialized `response_format` + user message, plus 256 template tokens) plus 2000 output tokens must be at most 8000 (413 `payload_too_large`).
5. Price table present and unexpired; the worst case (20,000 input + 2,000 output tokens) must fit the per-request reservation (503 `price_unavailable`).
6. Atomic SQLite admission (`BEGIN IMMEDIATE`): duplicate ID (same digest → 409 `duplicate_request`, other digest → 409 `request_conflict`), concurrency 1 (429), 3/min and 20/day (429 + `Retry-After`), monthly reservation cap (429 `budget_exhausted`). The ledger stores only request ID, digest, status, timestamps and cost, and never text, prompts or responses. On restart, `running` rows become `unknown` and keep their reservation. They are never re-executed.

Then the provider runs once with a 30 s deadline and no retries. It is cancelled on client disconnect (`cancelled`), and its output is checked against a 64 KiB / depth 24 bound and validated closed. Evidence must name a supplied excerpt, with offsets in **UTF-16 code units** inside that excerpt's `text`. Calendar values must be valid. `week`/`none` carry no invented value and must be uncertain. `confirmed` is always `false`, and `locationId` is set by the gateway. Any defect rejects the whole result with 502 `invalid_output`. Nothing is written to the Snapshot: proposals are review-only handoff for #44/#31/#32.

Groq outcome mapping (the provider raises a typed `ProviderError` carrying only status and code): 429 → `rate_limit` with `Retry-After` passed through, capped at 86400; 400 (including strict-schema mismatches) → `invalid_output`; 401, 403, 413, 3xx, 5xx, network errors, bad JSON, more or fewer than one choice, `finish_reason` other than `stop`, non-string content → `provider_failure`; socket timeout → `timeout`; an HTTP body over 256 KiB → `invalid_output`. `usage.prompt_tokens`/`completion_tokens` are recorded at 0 USD; if usage is missing the (0 USD) reservation is kept.

Errors use the existing `{message}` envelope: fixed text plus `(code: X; request: ID)`. Logs record only the request ID and code. The raw provider exception text, response body and key are never logged, returned or written to the ledger.

## Server-side secret supply

The owner supplies the key; Claude never types or stores it. It goes only into the backend process environment, for example:

```
# backend host shell only. Placeholder, not a real key.
$env:MOODLE_HELPER_AI_PROVIDER = 'groq'
$env:GROQ_API_KEY = '<set-by-owner>'
$env:MOODLE_HELPER_AI_LEDGER_PATH = 'C:\path\to\ai-ledger.sqlite3'
```

Never put it in `VITE_*` variables, `frontend/`, `extension/`, `shared/`, Snapshot exports, URLs or logs. `tests/test_ai_gateway.py` and `tests/test_ai_groq_provider.py` check that browser sources don't reference the key variables and that responses, logs and ledger rows don't contain a planted key or provider message.

## Threat boundary

Localhost only, with the existing origin/binding checks. The binding and consent digest prove that the payload is consistent, but they are **not** authentication and do not prove that a UI action happened: any local process can call the route. Excerpt text is inert data. The mock never interprets it, and there are no tools, URL fetches or dynamic prompts.

## Not verified

A real Groq call has not been made from this repository: the provider is tested against a fake HTTP layer only. EN/RU quality is unmeasured until the owner runs `uv run python tools/run_ai_eval.py` with their key (#42 AC1).
