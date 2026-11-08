# Proposed additive scan API contract, issue 20

This proposal is review material; it does not change the source OpenAPI or
activate a scan. All operations use the existing loopback trust boundary,
1 MiB request cap, safe `{message}` errors, and the existing bridge-binding
header for writes. Error statuses are 404 for an absent run/job, 409 for stale
binding/claim, invalid synthetic context, conflicting key or mixed-kind active
course, 422 for invalid bodies, and 503 for storage failure.

## Operations

- `POST /api/scan/runs`: request `ScanStart`; response `ScanRun`. Resolves the
  selected courses and uniquely mapped source IDs at the server, no client URLs
  or namespace. Replay of its key returns the original run and selection. Empty,
  missing or ambiguous mappings fail. Any active mock job for a selected course
  causes an atomic 409; a key owned by a mock run also causes 409.
- `GET /api/scan/runs/{runId}?cursor=&limit=`: response `ScanRun`. Job pagination
  is stable, with `limit` 1–100, default 100.
- `POST /api/scan/runs/{runId}/cancel`: response `ScanRun`. Removes only this
  run's demand; shared jobs continue for another non-cancelled run.
- `POST /api/scan/claim`: request `{}`; response `ScanClaimResponse`. Claims
  only scan jobs. A claim includes course mapping and selection revision.
- `POST /api/scan/renew`: request `QueueClaimToken`; response
  `QueueRenewResponse`. Requires a current scan claim and live demand.
- `POST /api/scan/finish`: request `ScanFinish`; response `ScanJob`. The claim,
  mapping, live demand, synthetic context and all page entries are checked in
  the transaction that merges source observations, records coverage and finishes
  the job. Stale or cancelled claims commit nothing.
- `GET /api/scan/jobs/{jobId}/pages?cursor=&limit=`: response `ScanPageList`,
  with stable bounded pagination. Missing or incomplete sections remain explicit.

## Closed types and bounds

All new object schemas reject unknown fields. `ScanStart` requires an
`idempotencyKey` of 1–128 characters matching `^[A-Za-z0-9._~-]+$`, the
existing queue ID constraints. `ScanJob` has the queue job fields `id`,
`courseId`, `state`, `attempts`, `generation`, plus optional `errorCode` from
`signed_out`, `request_failed`, `invalid_context`; it does not contain the mock
result. `ScanRun` has the same fields and bounds as `QueueRun`, except its jobs
are `ScanJob`. `ScanClaim` has `job`, `token`, `generation`, `expiresAt`,
`sourceCourseId` (1–128 decimal digits without leading zero) and
`selectionRevision` (64 lowercase hex digits). `ScanClaimResponse` requires
`unfinished` and has an optional `claim`.

`ScanPageInput` requires `pageType`, `scope`, `outcome`, `coverage`, and
`reasons` with the same fixed values as `ScanPageRecord`. It optionally carries
`observedAt` (required for checked pages, omitted for undiscovered sections),
a safe `pageUrl` (1–4096 characters), a `collector` from assignment/calendar/
material/quiz/submission and `result` as one of the existing collector result
schemas. Collector and result occur together. Domain validation requires a
canonical supported route, valid instant, matching collector/result and only
observations associated with the claimed source course. Inaccessible,
unsupported or undiscovered sections may omit collector result and URL. A page
with accepted observations cannot claim a failed or unavailable outcome.

`ScanFinish` requires `jobId`, `generation`, `token`, `selectionRevision`,
`outcome` (`completed` or `failed`), `pages` (0–100 `ScanPageInput` entries)
and `incompleteReasons` (0–9 distinct values from `undiscovered`,
`unsupported_page`, `collector_unavailable`, `access_error`, `signed_out`,
`forbidden`, `request_failed`, `limit_reached`, `invalid_context`). Optional
`errorCode` is present exactly for failed outcomes and uses the `ScanJob` error
values. Empty or incomplete listings cannot establish complete coverage.

`ScanPageList` has `pages` (0–100 `ScanPageRecord` entries),
`incompleteReasons`, and optional bounded `nextCursor`. Each record requires a
stable ordinal, `pageType` (course/assignment/calendar/material/quiz/
submission/unsupported), `scope` (visited_activity_only/supplied_pages_only/
supplied_ranges_only/unknown), `outcome` (ok/partial/failed/unavailable/
forbidden/signed_out/undiscovered), `coverage` (complete/partial/none), and
`reasons` (0–9 distinct values from the fixed incompleteReasons enum). Failed,
unavailable, forbidden, signed-out, unsupported and undiscovered entries need an
applicable reason. `observedAt` is required for checked pages and omitted for
undiscovered sections; optional `pageUrl` and `collector` appear only when a
supported page or collector was reached. Inaccessible and unsupported entries
cannot claim complete coverage. Signed-out readback has explicit fixed guidance
“Sign in to SDU Moodle to continue.” and the fixed URL
https://moodle.sdu.edu.kz/login/index.php. No raw response text is stored.

## Authorization evidence

The original issue #20 asks to connect the queue and collectors and list checked
page types with incomplete outcomes. Its PM grooming comment explicitly says:
“Source OpenAPI and typed migration decisions must precede code; preserve #19
behavior.” The user objective says to preserve `openapi.yaml` as the API contract
unless a justified change is necessary and instructs completion of the issue
backlog. The recorded PM contract `_docs/scan-coordinator-contract.md` requires
additive source OpenAPI and typed schemas before wire code. A source update is
necessary to describe new scan operations and durable coverage readback; it is
not a request to publish or deploy the API.


## PM review decision and required refinements

The seven additive operations above are approved as the issue 20 API design,
subject to these concrete refinements. Updating source OpenAPI to describe them
is necessary for queue-to-collector execution and durable coverage readback;
it is within the authorized backlog work and does not enable live transport or
change the existing dashboard catalog. Preserve all existing API operations,
bridge binding, origin/loopback checks, request limits and #19 behavior. Match
source OpenAPI and generated implementation schemas, including status codes,
closed objects and request/response bounds. This review is not a claim that the
implementation or acceptance criteria have passed.

- `QueueId` is not a named existing OpenAPI schema. Reuse the exact current
  queue ID pattern and bounds or introduce an equivalent named schema; do not
  refer to a nonexistent schema or loosen the existing bounds.
- Use the listed `incompleteReasons` values as the fixed page-reason enum too,
  with at most nine distinct values per list. A failed, unavailable, forbidden,
  signed-out, unsupported or undiscovered entry carries an applicable reason;
  incomplete run-level reasons cannot be silently discarded on readback.
- Do not invent a page observation time for an undiscovered section. Require
  `observedAt` for an actually checked page; omit it for undiscovered evidence,
  which records an incomplete section rather than asserting a visit. Explicitly
  distinguish these cases in schema and validation. Readback still identifies
  observation time for every checked page.
- Specify the signed-out guidance and login URL as explicit fixed response fields
  and document when they are present. Reject unknown fields and malformed values;
  no response carries DOM, credentials or arbitrary exception text.
- The APIs must enforce job-kind isolation on claim, renew and finish and the
  atomic mixed-kind conflict rules in the coordinator contract. They must not
  provide a request-selected synthetic context or authority path. The shared
  machine-wide request gate, acknowledged termination and safe fail-closed
  behavior remain separate requirements; job claims and leases do not satisfy
  them. Synthetic injection remains isolated to the test harness, while the
  ordinary live execution path stays disabled.

Exact route/result pairing, conditional invariants and every fixed enum must be
spelled out in source schemas and server-side validation before implementation;
errors and bounds must have parity. This decision does not authorize extra
operations, arbitrary URLs, broader transport permissions or new dependencies.
