# Browsing refresh contract (#18)

PM grooming, 2026-10-27, before implementation. READY for a complete locally
testable coordinator using the issue's expressly permitted mock collectors.
All five original criteria remain. Actual SDU compatibility/identity remains
unverified under #3; mock support must be visible and must never enable live writes.

## Goal

A visited selected course/activity triggers one bounded collection and atomic
source update. Revisits refresh identities, dynamic navigation invalidates old
work, and persisted page receipts explain exactly what succeeded or failed.
SQLite is authoritative. This is a functioning coordinator and repository
integration, not only a validator or an in-memory simulation.

## Acceptance criteria

- [ ] AC1: With an explicitly injected mock trusted context and collector registry,
  visiting a selected course, assignment, calendar or resource/folder page calls
  the relevant collector once and commits its normalized records to real SQLite.
  Drive the production content coordinator, internal worker adapter and backend
  route using labeled browser shims and actual loopback HTTP. Also dispatch the
  real #13/#15/#17 pure collectors against their invented structural DOM fixtures.
  Unsupported quiz/submission collectors return visible unavailable outcomes;
  explicitly injected mocks exercise their coordinator contract without claiming
  verified #14/#16 behavior. No test-only alternate coordinator/repository.
- [ ] AC2: Revisit with changed facts updates the same stable identities; replay
  of the same visit has one committed receipt. Preserve overlays, other source
  evidence, personal records and unrelated entities. Restart, snapshot load,
  export/restore and deletion preserve or remove new collection data correctly.
- [ ] AC3: Initial visit, popstate/hashchange and DOM-driven URL transitions are
  observed. Duplicate notifications for one URL/visit collect once; A -> B -> A
  creates three visits. Deferred A results arriving after B never commit. Stop
  disconnects observers/listeners and invalidates work. Changes to selection,
  context/process, permissions or document identity invalidate pending work.
- [ ] AC4: Other hosts, unsupported routes, failed #10 access, unselected or
  unmapped courses, invalid identity/context and disabled live mode produce zero
  collection writes. Calendar records require reliable selected course mapping;
  unassociated safe reviews may be retained only for an otherwise authorized
  selected-course visit, never by guessing the sole selected course.
- [ ] AC5: Persist page/activity identity, collector outcome, observed time,
  supplied-page/range/listing scope, complete/partial/none and fixed reasons.
  Errors remain queryable after failure/restart and do not erase previous facts.
  These receipts never set CourseSyncState.coverage=full or claim a course scan.
  Collection/persistence failures are also returned visibly to the coordinator's
  observable state; do not silently swallow them or expose private exception text.

## Out of scope

Full-course traversal, fetch queues, durable scan jobs and cross-page pagination
are [#19](https://github.com/Ramung55/MoodleHelper/issues/19) /
[#20](https://github.com/Ramung55/MoodleHelper/issues/20); scan progress UI is
[#21](https://github.com/Ramung55/MoodleHelper/issues/21). Live observed selectors
and stable signed-in identity evidence remain [#3](https://github.com/Ramung55/MoodleHelper/issues/3)
and sanitized fixtures [#4](https://github.com/Ramung55/MoodleHelper/issues/4).
Verified quiz/submission classification remains #14/#16; actual Chrome smoke
remains #7/#8. Cross-source calendar/activity matching is #33; material library
presentation is #40 and assessment presentation #35. No original #18 behavior is
moved out: mock collectors are its explicit dependency substitution seam.

## Constraints

Read AGENTS.md, process, architecture/data-model/messages/sqlite-storage,
dashboard-bridge-contract, assignment-date-contract, calendar-collection-contract,
material-collection-contract, assignment-submission-contract and
quiz-collection-contract. No dependency, Moodle fetch/write, HTML transfer,
cookie/token/password access, account, competing database or browser-policy retry.

### Pre-code wire decision: typed normalized source layer

The existing Assessment/Material fields cannot hold all collector facts. Adopt
an additive **typed normalized source layer**, rather than prematurely projecting
unknown material types into known `other`, calendar starts into deadlines, or
silently discarding raw fields. This is the concrete alternative to the earlier
proposed assignmentDates/calendarEvents/sourceDetails additions: those legacy
entity projections are NOT required in #18 and are not claimed implemented.
The source layer itself contains persisted normalized entities, not opaque logs.
Its future projection/UI owners are #20/#33/#35/#40 as appropriate. Existing
Assessment/Material/Overlay schemas and consumers keep their semantics.

Before implementation, amend source openapi.yaml, then coordinated Python/Zod/
shared source-derived schemas. Add optional nonnullable Snapshot.collection:
`{records: NormalizedSourceRecord[], reviews: CollectionReview[], refreshes:
PageRefreshReceipt[]}`. Old snapshots/backups omit it; absence means no collected
data, never erase a present value on source upsert. Explicit full replace/restore
retains its existing full-replacement semantics. Deletion/reset clears this layer.
All fields and nested variants are typed, not arbitrary JSON/dict/unknown payloads.

NormalizedSourceRecord = `{id, courseId, kind, firstObservedAt, lastObservedAt,
observations}`. kind is assignment|calendar|material|quiz|submission. observations
is the corresponding nonempty typed evidence array; no cross-kind values.
For assignment/calendar/material copy the COMPLETE exported raw DTO respectively
from extension/src/moodle-assignments.ts, moodle-calendar.ts and
moodle-materials.ts, with their existing exact optionality, discriminated date/
known/unknown values, references, folder listing/child-key proof and provenance.
Do not serialize access Documents. Each DTO needs a named source schema, not
additionalProperties:any. Date strings preserve their original precision.
Assignment includes base/effective/individual evidence; calendar includes event,
series/occurrence and optional activity reference; material includes every safe
reference and conflict/listing fact. Source records retain observations by
canonical JSON equality, and never union contradictory complete child listings.

Quiz raw DTO follows quiz-collection-contract's named fields. Submission follows
assignment-submission-contract: exact source identity/URL plus latest attempt,
optional confirmed record and stale state, using backend submission_retention
for its authoritative reduction. Do not introduce a DOM status classifier.
Mock quiz/submission DTOs are labeled synthetic in receipts and tests; unavailable
real adapters yield no records. Require typed mock attemptInformation/date facts,
not permissive dictionaries. Original canonical DTO spelling from these linked
contracts controls; document any ambiguity before implementation.

Record identity is backend-generated canonical JSON namespace-prefixed tuple:
assignment/quiz/submission = namespace + [kind, sourceCourseId, moduleType,
sourceActivityId]; calendar = namespace + [calendar_event, sourceEventId,
sourceOccurrenceId-or-null]; material = namespace + [material, resourceKey].
No title/date/observation time in keys. IDs remain strings without numeric casts.
courseId resolves from existing Course.discovery.sourceCourseId and selected
settings.trackedCourseIds, rejecting missing/ambiguous associations. Source IDs
must agree with safe URLs, page context and raw DTO. Backend revalidates domain
rules; parsing wire JSON alone is insufficient. Canonical evidence replay is
idempotent. firstObservedAt is retained; lastObservedAt never moves backwards.
Personal overlays reference existing assessment IDs and are never rewritten.

CollectionReview stores `{id, visitId, collector, reasons, candidate?}` with
typed safe calendar/material candidate variants already returned by collectors;
it is separate from source records and cannot invent a course. Exclusions/errors
are fixed codes/indexes, never arbitrary text/HTML/URLs from caught exceptions.

PageRefreshReceipt = `{visitId, pageUrl, observedAt, collector, sourceCourseIds,
sourceActivityId?, sourceCourseModuleId?, outcome, coverage, scope, reasons,
evidenceMode}`. outcome = ok|partial|failed|unavailable; coverage =
complete|partial|none; scope = visited_activity_only|supplied_pages_only|
supplied_ranges_only; evidenceMode = synthetic|verified. Keep failed receipts
without replacing prior successful entity observations. No stale/cancelled visit
is recorded as a completed refresh. Backend returns fixed safe failure outcomes.

### Operations and trusted context

Add fixed internal collection operations, separate from the public dashboard's
17-operation catalog: GET /api/collection-context (collectionContext), POST
/api/collection/visits (beginPageVisit), POST /api/collection/refresh
(ingestPageRefresh). Source OpenAPI defines all requests/responses first.
Context response is `{version:"1", binding, mode:"disabled"|"synthetic"|"verified",
selectionRevision, courses:[{courseId,sourceCourseId}], reason?}`; no namespace,
stable user ID or credentials leave backend. binding uses existing process binding.
Begin takes `{documentKey,visitId,pageUrl,selectionRevision}` and returns a backend
opaque visit token. Refresh takes `{visitToken, observedAt, collector, result}`;
result is a closed kind-specific normalized collector result above, with explicit
unavailable/failure branches. Response `{snapshot,receipt}`. Require process
precondition for these new write routes, unlike optional legacy CRUD precondition.
Enforce bounded strings/arrays/message bytes using existing bridge limits, fail
closed on oversized observation batches rather than truncate source facts.

Default collection mode is disabled. Production cannot infer verified identity
from #10 logout navigation, configured stable-user ID, dashboard session or course
selection. A startup/service injected trusted CollectionContextProvider supplies
synthetic mode only in the labeled local integration harness with isolated SQLite;
ordinary runtime has no synthetic/live enable switch in messages or HTTP bodies.
Verified provider remains unavailable until #3 establishes a safe actual account
comparison; configured Moodle namespace alone is not sufficient. Context supplies
the existing namespace internally, never accepts a caller dataset or user ID.
Thus the full mock-backed workflow is executable now and live student writes
remain explicitly unavailable. This is the original issue's allowed mock seam,
not an extra acceptance gate. Document harness invocation and actual limitations.

Internal worker accepts isolated top-frame runtime messages only from exact SDU
HTTPS sender.url, extension runtime ID, valid tab ID and required documentId;
check consistent origin/tab.url when present. Derive documentKey from browser
sender data, not message payload. Reuse fixed loopback fetch rules, credentials
omit, redirect error, closed DTOs, binding checks, bounded pending/dedup behavior
and fixed errors. Never route these messages from dashboard window postMessage,
extend dashboard-approved origins to SDU, or forward arbitrary paths/headers.
Backend trusts local CRUD partitioning, but collection additionally requires the
trusted provider. No Moodle privileged fetch is needed: only current Document.

### Coordinator and transaction ordering

Inject read-only page source, collector registry, repository adapter and clock;
production code owns the algorithm and test shims supply those environmental
interfaces. Registry records collector availability/evidenceMode explicitly.
Route dispatch: course/resource/url/folder -> materials, assignment -> dates plus
optional submission, calendar -> calendar, quiz -> unavailable unless mock injected.
No enrollment discovery scan or following links. Access detector runs before DOM
parsing. Do not fabricate HTTP 200/network metadata for a live Document: the
page-source seam supplies trustworthy envelope or returns unavailable. Tests
supply labeled synthetic envelopes; unavailable live envelope is visible.

Each distinct visit has generation and UUID; identical notifications share it.
Invalidate synchronously on navigation, begin the new visit before accepting
results, and check current generation/context/selection immediately before commit.
Worker serializes begin/commit for each document; backend tokens bind process,
document, active visit and selection revision. Replacing active visit invalidates
previous token. Refresh transaction rechecks token, current tracked courses and
identity mappings, merges records/reviews and receipt atomically, then commits.
Same token/collector replay returns original receipt without another write;
different payload under same key rejects. Stale token rejects with no mutation.
If old commit already completed before navigation was observed it is legitimate;
late unresolved collector results after observed navigation must never be sent or
accepted. This makes stale suppression testable at both async boundaries.
Use a bounded in-memory process token registry; restart invalidates it. This is
not durable scan queue/retry. Do not automatically replay uncertain writes.

### Files and validation handoff

New extension/src/page-refresh.ts and collection-repository.ts own coordinator/
internal transport; content.ts installs lifecycle and index.ts installs the
worker handler. Keep dashboard bridge behavior unchanged. Shared collection DTO/
protocol module may be new. Backend collection service/domain module plus
routers.py/schemas.py/main.py and storage boundaries implement atomic writes.
Extend frontend/src/domain/types.ts, source OpenAPI, snapshot/backups and deletion
handling only as required for the additive layer. Update architecture inventories.
No replacement frontend or new UI framework. Existing observer/Chrome APIs and
Vitest/jsdom, Python/SQLAlchemy suffice; ask before any dependency addition.

Tests: deferred A/B/A plus duplicate mutation/popstate notifications, dispose,
selection/unmap/process/grant changes, stale tokens and delayed HTTP replies;
one write per visit/collector, changed observation replay and distinct IDs;
overlay/private/source preservation; failing/unavailable collectors and storage
failure with visible retained state; strict unsafe URL/identity/message negatives;
calendar ranges, assignment dates, unknown material metadata/folder references,
complete-empty/partial/listing conflicts/review persistence; real SQLite restart,
backup round trip and deletion; direct/dashboard attempts cannot enable collection.
Drive real pure parsers and separately injected unavailable/quiz/submission mocks.
Run focused tests, full backend `uv run pytest`, frontend Vitest, browser-workspace
suite, shared/extension/frontend builds and focused strict TypeScript. Inventory
source/generated OpenAPI operation/schema parity and legacy snapshot compatibility.
Report labeled shims versus real HTTP/SQLite honestly. Do not retry blocked Chrome
UI, fabricate SDU selectors or make an installed-browser smoke a new #18 gate.
