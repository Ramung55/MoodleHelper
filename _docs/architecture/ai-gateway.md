# Optional AI gateway (#43)

Status: **no provider active; production budget 0 USD.** Contract: `ai-contract.md` (`ai-extract.v1`, #42).
Code: `backend/ai_gateway.py`, route `POST /api/ai/extract`, client `frontend/src/services/ai-gateway.ts`.

## Modes

| Mode | How selected | Behavior |
| --- | --- | --- |
| unavailable (default) | Ordinary `create_app()` | `GET /api/ai/availability` keeps `available:false` with the legacy reason; `POST /api/ai/extract` returns 503 `unavailable`. No ledger, no provider. |
| mock | Trusted code only: `create_app(ai_gateway=AiGateway(mock_config(path), MockProvider()))` | Deterministic local rules, no network, simulated cost (10 USD/month UTC cap, 0.10 USD/request reservation). Availability says "Local mock; no external provider". |

No request body, query, header, page or bridge message can switch modes. `GatewayConfig(mode=...)` rejects anything other than `unavailable` and `mock`. No real provider transport exists.

## Request handling (in order, all before provider work)

1. Middleware checks the `X-Moodle-Helper-Bridge-Binding` (409), then applies a 16 KiB body bound (413) before parsing.
2. Closed schema (unknown fields → 422 `invalid_request` with a fixed message; submitted values are never echoed), 1 to 8 excerpts, 2000 UTF-8 bytes each (413), unique IDs, `expectedDatasetId` equal to the startup dataset (409).
3. Consent: `approvedExcerptIds` must equal the excerpt IDs in order, and destination/policy must equal the configured ones. `payloadDigest` = SHA-256 of the UTF-8 canonical JSON `{"context","destination","excerpts":[{documentDigest,id,locationId,text}],"policyVersion","version"}` with sorted keys, `,`/`:` separators, no ASCII escaping, and `context` `{}` when absent.
4. Price table present and unexpired; the worst case (20,000 input + 2,000 output tokens) must fit the per-request reservation (503 `price_unavailable`).
5. Atomic SQLite admission (`BEGIN IMMEDIATE`): duplicate ID (same digest → 409 `duplicate_request`, other digest → 409 `request_conflict`), concurrency 1 (429), 3/min and 20/day (429 + `Retry-After`), monthly reservation cap (429 `budget_exhausted`). The ledger stores only request ID, digest, status, timestamps and cost, and never text, prompts or responses. On restart, `running` rows become `unknown` and keep their reservation. They are never re-executed.

Then the provider runs once with a 30 s deadline and no retries. It is cancelled on client disconnect (`cancelled`), and its output is checked against a 64 KiB / depth 24 bound and validated closed. Evidence must name a supplied excerpt, with offsets in **UTF-16 code units** inside that excerpt's `text`. Calendar values must be valid. `week`/`none` carry no invented value and must be uncertain. `confirmed` is always `false`, and `locationId` is set by the gateway. Any defect rejects the whole result with 502 `invalid_output`. Nothing is written to the Snapshot: proposals are review-only handoff for #44/#31/#32.

Errors use the existing `{message}` envelope: fixed text plus `(code: X; request: ID)`. Logs record only the request ID and code. The raw provider exception text is never logged or returned.

## Server-side secret supply (future activation only)

No key exists, and none is read today. When an owner activates a provider (see `ai-contract.md` section 1), the key goes only into the backend process environment, for example:

```
# backend host shell / service manager only. Placeholder, not a real key.
MOODLE_HELPER_AI_API_KEY=<set-by-owner-on-server>
```

Never put it in `VITE_*` variables, `frontend/`, `extension/`, `shared/`, Snapshot exports, URLs or logs. `tests/test_ai_gateway.py` checks that browser sources don't reference the variable and that responses and logs don't contain a planted secret marker.

## Threat boundary

Localhost only, with the existing origin/binding checks. The binding and consent digest prove that the payload is consistent, but they are **not** authentication and do not prove that a UI action happened: any local process can call the route. Excerpt text is inert data. The mock never interprets it, and there are no tools, URL fetches or dynamic prompts.

## Not verified

Real provider integration, retention, billing and EN/RU quality evaluation are not verified. They are blocked on the owner decisions recorded in #42.
