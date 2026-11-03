# Issue 20: selected-course scan contract

## Goal

Connect the durable selected-course queue to bounded, read-only traversal and the existing normalized collector/repository pipeline. Make page-level evidence and incomplete coverage durable without losing prior observations. The independently testable synthetic page-source seam is authorized by the original issue; it does not establish live SDU compatibility.

## Acceptance criteria

- [ ] A run schedules only the currently selected, uniquely mapped courses and invokes every available relevant collector on discovered supported pages. Test production queue, coordinator, actual #13/#15/#17 parsers, and repository against explicitly synthetic DOM/envelopes and real HTTP/file SQLite; unavailable #14/#16 produce explicit incomplete outcomes. Invented DOM is not evidence of live selectors.
- [ ] Readback after restart identifies each checked page type and observation time, scope, outcome and incomplete reasons. Unavailable, inaccessible, undiscovered or incomplete sections cannot be reported as complete; a job completing execution does not itself prove complete course coverage.
- [ ] A recorded mock request trace, including two workers and restart, proves no overlapping active Moodle requests, at least one second between request starts, and at most two retries with delays of at least two and five seconds respectively, or longer valid Retry-After. Retryable failures terminate. Cancellation and invalid claims stop further requests and fence late results.
- [ ] Login expiry terminates or pauses affected work with fixed sign-in guidance. Forbidden pages are terminal for that page, without infinite retries; other independently authorized work can proceed.
- [ ] Partial and failed scans retain prior records, reviews, overlays and unrelated data. Missing entities are never interpreted as deleted merely because collection failed or scope was incomplete. Queue outcome, coverage and accepted source updates commit atomically, including crash and cancellation races.

## Out of scope

- Queue baseline is [#19](https://github.com/Ramung55/MoodleHelper/issues/19), scan UI [#21](https://github.com/Ramung55/MoodleHelper/issues/21), notifications [#39](https://github.com/Ramung55/MoodleHelper/issues/39), verified SDU evidence [#3](https://github.com/Ramung55/MoodleHelper/issues/3), observed fixtures [#4](https://github.com/Ramung55/MoodleHelper/issues/4), quiz and submission classification [#14](https://github.com/Ramung55/MoodleHelper/issues/14) and [#16](https://github.com/Ramung55/MoodleHelper/issues/16). No original acceptance criterion is removed.

## Constraints and implementation decisions

Read `_docs/sync-queue-contract.md`, `_docs/page-refresh-contract.md`, collector contracts, #10 access states and compatibility matrix first. No new dependencies or credentials, browser-policy retry, arbitrary host, live activation or fabricated selectors. Ordinary runtime remains disabled: #3 has not verified identity, response envelope or selectors. Clearly distinguish synthetic results from live evidence; do not report live compatibility. The original issue explicitly asks for mock traces, but real-site operation remains externally blocked until #3 and other relevant evidence are resolved.

Extend the existing queue and collection layers, not a validator-only or alternate test implementation. Introduce a narrowly injected page-source seam with synthetic trusted context in an isolated harness. It supplies explicit requested/final URL, status, DOM, and discovered page links. Production algorithm must consume this interface, dispatch real pure assignment/calendar/material collectors for supported discovered routes, and represent unavailable quiz/submission and unsupported pages. The trusted source may enumerate synthetic pages but cannot confer verified mode. Apply #10 before parsing. Follow only exact HTTPS SDU host and explicit route/query whitelist already accepted by pageRoute and collector contracts; reject credentials, ports except canonical HTTPS, redirects to other routes/hosts, fragments for requests, traversal, unknown query parameters and arbitrary URLs. A selected course is resolved by exact existing sourceCourseId mapping; reject ambiguous or missing mappings and recheck selection before commit. Bound pages, response size, depth and cycles, report truncation as incomplete, and never infer coverage from an empty or incomplete listing. Calendar associations require explicit mapping. Record per-page scope and fixed reason codes; avoid HTML, private exception text, cookies and tokens in output.

Before code, specify additive source OpenAPI, corresponding typed schemas and migration for scan run/job/page outcomes and coverage, including fixed bounds, stable IDs, replay semantics, readback, errors, and exact request shapes. Reuse #18 domain validation and merge logic, preserving its source identity and evidence retention; do not treat page-visit tokens as durable scan claims. Implement one SQLite transaction that checks current claim generation, live demand, trusted context and selected mapping, merges accepted source observations and coverage, and finalizes the job; a stale, cancelled, expired or context-changed claim writes none. Shared jobs retain demand while another run needs them. Page failures must not delete or replace prior observations. A crash before commit can repeat execution; after commit no result repeats. Preserve existing mock queue/API behavior and source OpenAPI parity.

A single global request gate must govern all scan workers and courses, including restarts and multiple backend processes; per-worker sleeps or namespace-only job concurrency do not satisfy it. Persist request-start spacing and retry not-before time in SQLite, use atomic coordination, and serialize request execution with a mechanism that cannot release while an old request remains active. A lease alone cannot prove that property after expiry: require an enforceable bounded request lifetime and abort/termination confirmation before another request, or fail closed if ownership cannot be established. In an injected synthetic trace, assert actual start/end events across worker restart, lease expiration and cancellation, including stalled/late responses. Live request execution stays disabled until its cross-process/worker lifetime guarantee can actually be established. Persist server Retry-After as a not-before instant; accept valid seconds or HTTP-date, never shorten it to a local cap. Excessively long or malformed values must fail/defer safely with a fixed visible reason, never retry earlier. Retry delays are relative to the preceding failure and globally paced; at most three attempts total. Abort on cancellation, stale generation or context change; no late response may commit.

Independent QA should drive the installed production worker wakeup and queue with actual loopback HTTP and SQLite, synthetic source and clock, and inspect trace plus durable readback. Include overlapping runs, multi-worker race, restart before/after commit, stale claim, cancellation and mapping changes; 429/503, Retry-After, login redirect, forbidden, inaccessible pages, pagination/cycle/limit and partial failure; assert existing data and unrelated jobs survive. Run relevant backend, browser-workspace, frontend and build checks. Report exact commands and results, no live claims. If the full global request gate cannot be safely guaranteed with current disposable-worker execution, document the blocker and ship no enabled network transport; do not weaken AC3.

## Global request authority clarification (issue 20)

The authority is separate from every configurable application data database. A
namespace or a row in `MOODLE_HELPER_DATABASE_URL` cannot coordinate distinct
data files. For the supported single-Windows-machine synthetic deployment, use
one fixed machine-wide authority file at
`%PROGRAMDATA%\MoodleHelper\scan-authority.sqlite3`, resolved from the OS known
folder rather than a caller-controlled environment override. Every backend process
must use that same absolute location, including processes with different data
files or namespaces. Create/open it transactionally with one versioned singleton
row; reject inaccessible, malformed, replaced or incompatible authority state and
fail closed. Never fall back to a per-process, per-user, per-installation or data
DB gate. Authority deletion, reset, copying, and administrative recovery while
requests may exist are unsupported; no automatic recreation may clear an occupied
or unknown state. The first-time provisioning and permissions must ensure all
participating processes access the same file, with an explicit durable installation
marker so a missing authority after provisioning fails closed. If that property
cannot be established, refuse requests. This is a local-machine authority, not a
claim of coordination across machines, containers or separate OS installations;
network execution is disabled wherever a single authority cannot be established.

Atomically reserve the singleton before each actual start, recording a random
owner, start time, and durable global not-before. Grant only when unoccupied and
both the prior start plus 1,000 ms and persisted retry deadline have elapsed.
Persist the maximum of existing and applicable Retry-After/retry deadlines before
releasing the owner. Handle clock rollback conservatively: no request until the
persisted deadlines are reached; invalid/unrepresentable times fail closed. Never
reclaim on lease expiry, worker exit, backend restart, elapsed timeout, or a
stale job claim. Only the matching owner may release after a trustworthy end or
abort acknowledgement establishes that the actual request has stopped. If the
acknowledgement is lost or cannot be established, retain occupancy indefinitely;
this intentionally sacrifices availability. A browser may outlive its worker,
so worker death is not such an acknowledgement. Cancellation and stale claims
stop future work and fence results but do not themselves release the request gate.

For the explicitly synthetic harness only, inject one isolated authority file
shared by all tested backend processes; this injection must not be an ordinary
runtime configuration or activate live transport. Synthetic request objects must
expose observable actual start/end and explicit abort acknowledgement; a stalled
request remains active until acknowledgement, and a lost acknowledgement keeps
the authority occupied after restart. Test two independently configured data
databases, multiple workers and process restart against the same authority, plus
spacing, persisted Retry-After, cancellation, stale claims, lease expiration and
late responses. Trace actual events, not just grant times. This demonstrates the
production coordinator and the mock-trace criterion within that isolated scope;
it is not evidence that Chrome network requests terminate on worker death, nor
that SDU selectors or live transport work. All five acceptance criteria still
require the queue, collector, atomic merge and readback behavior in this contract.
Issue #3 remains the live evidence blocker, and live activation additionally
requires a demonstrated browser termination acknowledgement protocol and a
single authority for every participating backend. The existing data-file gate
primitive is preparatory only and cannot be treated as global across data files.

## Queue job kind isolation (issue 20)

Retain #19's existing partial unique index on active `(namespace, course_id)`
without adding kind to the key. Existing queue records migrate to `mock` and
retain their IDs, states, claims, links and results. Add a distinct `scan` kind
for #20. The installed mock worker may claim, renew and finish only mock jobs;
the scan worker may claim, renew and finish only scan jobs. Enforce kind at the
server on each operation, including a valid claim submitted to the wrong route,
so a mock result cannot complete scan work or vice versa. An expired claim or
other invalid claim remains fenced as in #19.

Start is one transaction: replay of an existing idempotency key with the same
kind returns its original run even if terminal. For mock starts, reusing a key
with different supplied course IDs returns 409; scan starts do not supply a
selection and replay the original selection regardless of current selection.
Reusing a key across kinds returns 409. For a new
key, overlapping active jobs of the same kind are shared as in #19. If any
selected course already has an active job of the other kind, reject the entire
start with 409 and create no run, job or link; do not silently attach a mock job
to a scan or weaken the uniqueness index. Concurrent mixed-kind starts serialize
under the write transaction: at most one kind creates active work for that course.
The caller may retry after the conflicting job reaches a terminal state. Shared
jobs retain demand and cancellation semantics from #19. The scan start still
uses the current selected courses and exact mapping as specified above; replay
returns the original immutable selection rather than silently changing it.

Verification must exercise both start orders, concurrent starts, mixed selections
with one conflict and no partial writes, same-kind sharing, cross-kind key reuse,
wrong-kind claim/renew/finish, old mock-worker behavior and recovery after a
conflicting job becomes terminal. This preserves #19's original queue behavior
for mock-only runs while preventing a mock worker from consuming #20 scan jobs;
all #20 collection and coverage acceptance criteria remain required.
