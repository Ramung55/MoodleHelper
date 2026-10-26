# Shared data model and ingestion decision (#5)

## Decision recorded before helper implementation

`openapi.yaml` is the HTTP authority; `frontend/src/domain/types.ts` is the Zod baseline and `backend/schemas.py` implements the wire. Keep all 16 endpoints permissive. Wire timestamp, timezone and URL strings are arbitrary strings; date strings check shape only. Domain helpers in `backend/domain_validation.py` are opt-in ingestion checks, never installed in HTTP, restore or storage. They do not fetch URLs. No schema changes or dependencies are required here.

Domain policy: exact dates are ISO instants with explicit offset/Z and a known IANA timezone; retain the original precision and strings, with no inferred midnight or converted timezone. Date-only means a real calendar day; week remains integer 1..30; unknown is explicit, optional absence stays absent. All domain observation timestamps require a zone. Moodle observation URLs require HTTPS, canonical host `moodle.sdu.edu.kz`, default port 443, no credentials. General material/personal/syllabus URLs permit HTTPS on a syntactically valid DNS hostname or IP, no credentials; HTTP and javascript/data/file are rejected at this opt-in boundary. This general policy does not limit other sources to Moodle. Existing wire URLs are unaffected.

## Wire parity inventory conventions

The table below exhaustively lists current Snapshot fields, recursively including named nested records. Each row maps the **same spelling** in Zod / source OpenAPI / Python unless stated otherwise. `R` = required, `O` = optional key, never JSON null. Types/constraints apply identically except the explicit differences below. `string` imposes no nonempty, URL, timestamp or timezone validation; `number` has no extra range unless shown. Snapshot arrays have no minimum except Assessment.sources. There is no wire referential integrity check. Unknown object keys: Zod strips and Python ignores on parse; OpenAPI permits extra properties and validation alone does not strip them. Python `None` placeholders for omitted O fields must be serialized with `exclude_unset=True`/`exclude_none=True`; they are not nullable wire values or wire defaults. Strict Python rejects booleans as numbers, accepts integral JSON floats for integers as JSON Schema does; Zod `.int()` accepts integral JS numbers. Python forbids nonfinite numbers (JSON values must be finite).

Zod input accepts omission and inserts `false` for Assessment.personal, Overlay.hidden/completed and Material.syllabusSuggestion. OpenAPI **requires** these four keys despite `default:false`; Python requires them too and merely annotates their schema default. This intentional discrepancy is reproducible in `tests/test_model_inventory.py` through the actual Zod probe (tests/zod_model_probe.mjs). Do not claim a Zod-defaulted input is valid HTTP input. All other R/O markings match. `DateValue` is a `kind` discriminated union: exact/date/week/unknown, not nullable. OpenAPI oneOf and Python discriminator/union branch schemas describe equivalent disjoint cases.

| Record | Fields in Zod → OpenAPI → Python (identical unless alias shown) |
| --- | --- |
| Snapshot | R courses:Course[], assessments:Assessment[], overlays:Overlay[], materials:Material[], documents:ImportedDocument[], candidates:ExtractionCandidate[], sync:CourseSyncState[], changes:DeadlineChange[], alerts:Alert[], settings:Settings |
| ExactDate (DateValue exact branch) | R kind:literal exact, iso:string, tz:string |
| CalendarDate (date branch) | R kind:literal date, date:string pattern `^\d{4}-\d{2}-\d{2}$` |
| TeachingWeek (week branch) | R kind:literal week, week:integer 1..30 |
| UnknownDate (unknown branch) | R kind:literal unknown; O note:string |
| Course | R id:string, code:string, name:string, color:integer 1..6, current:boolean |
| SourceEvidence | R source:enum moodle/syllabus/personal, date:DateValue, observedAt:string; O excerpt:string, location:string, url:string |
| SubmissionObservation | R status:enum submitted/draft/not_submitted/reopened/unknown, observedAt:string; O evidence:string |
| Assessment | R id:string, courseId:string, title:string, type:enum assignment/quiz/exam/other, sources:SourceEvidence[] minItems 1, personal:boolean (default discrepancy above), firstObservedAt:string, lastObservedAt:string; O activityId:string, availableFrom:string, submission:SubmissionObservation |
| Overlay | R assessmentId:string, hidden:boolean, completed:boolean (default discrepancies above); O titleOverride:string, dateOverride:DateValue, overrideBase:DateValue |
| Material | R id:string, courseId:string, section:string, title:string, fileType:enum pdf/docx/pptx/link/video/other, url:string, accessible:boolean, stale:boolean, lastCheckedAt:string, syllabusSuggestion:boolean (default discrepancy above); O downloadedAt:string |
| ImportedDocument | R id:string, courseId:string, name:string, format:enum pdf/docx, status:enum queued/extracting/done/failed/needs_ocr, progress:number 0..100, importedAt:string, mocked:boolean; O error:string |
| ExtractionCandidate | R id:string, documentId:string, courseId:string, title:string, type:enum assignment/quiz/exam/other, date:DateValue, rawDateText:string, language:enum en/ru, confidence:number 0..1, excerpt:string, location:string, status:enum pending/confirmed/corrected/rejected/auto; O matchAssessmentId:string, reason:string |
| CourseSyncState | R courseId:string, status:enum ok/partial/failed/never/syncing, coverage:enum full/partial/none, progress:number 0..100; O lastSuccessAt:string, error:string |
| DeadlineChange | R id:string, assessmentId:string, from:DateValue → from:DateValue → from_:DateValue (alias `from`, serialize by_alias=True), to:DateValue, detectedAt:string |
| Alert | R id:string, kind:enum deadline/busy_week/change/sync, message:string, deliveryKey:string, createdAt:string, read:boolean; O assessmentId:string |
| Settings | R trackedCourseIds:string[], semesterStart:string same date pattern, semesterWeeks:integer 1..30, timezone:string, weights:Weights, thresholds:Thresholds, reminders:ReminderSettings, ai:AiSettings |
| Weights (Zod inline weights) | R exam:number, assignment:number, quiz:number, other:number |
| Thresholds (Zod inline thresholds) | R maxOutstanding:number, maxWeighted:number |
| ReminderSettings (Zod inline reminders) | R enabled:boolean, hoursBefore:number, busyWeek:boolean |
| AiSettings (Zod inline ai) | R enabled:boolean, consentGiven:boolean |

PATCH is a separate command model. SettingsPatch has all Settings keys O but supplied nested objects remain complete and replace their group. OverlayPatch has all keys O; only titleOverride, dateOverride, overrideBase additionally allow explicit null. Omission keeps values; null clears optional overrides, date null clears baseline too, and null date plus nonnull baseline is rejected. hidden/completed null is invalid. Snapshot optional overrides are never null. Frontend adapter converts explicitly present undefined overrides into null; Zod Overlay itself is not the PATCH command schema.

## Ownership and identity table

All current records belong to the selected dataset namespace, including settings; references resolve only within it. Current opaque IDs (including demo c-csc/a1/m1/d1/k1 and UUID-based p-/d-/k-/syl- IDs) remain valid and are never retroactively rewritten. Namespace is trusted startup partitioning, not authentication or live identity proof.

| Record | Dataset-local entity key | Ownership and references |
| --- | --- | --- |
| Course | id | Moodle/source facts; tracked selection is personal settings |
| Assessment | id; optional activityId is provenance, not globally unique | source facts, courseId → Course; personal=true marks personal event; type must participate in future source key |
| SourceEvidence | canonical replay comparison of all present fields, no new wire id | source/date/provenance/observedAt belong to source; nested under assessment; preserve distinct Moodle and syllabus evidence |
| SubmissionObservation | assessment parent | observed Moodle status, never overlay.completed |
| Overlay | assessmentId | personal title/date/baseline/hidden/completed; assessmentId → Assessment |
| Material | id | source metadata, courseId → Course; local downloadedAt observation separate from source accessibility |
| ImportedDocument | id | personal import plus extraction state, courseId → Course |
| ExtractionCandidate | id | extracted proposal/review state; documentId → ImportedDocument, courseId → Course, optional matchAssessmentId → Assessment |
| CourseSyncState | courseId | final course coverage/result → Course, not durable job identity |
| DeadlineChange | id | derived source change, assessmentId → Assessment; from/to retain precision |
| Alert | id; deliveryKey deduplicates a delivery intent within namespace | derived/personal read state; optional assessmentId → Assessment |
| Settings | singleton per namespace | personal config, trackedCourseIds → Course |
| DateValue/settings subobjects | parent-owned value, no standalone id | copied without precision invention |

`backend/identity.py` defines canonical JSON tuple keys, not delimiter concatenation. Proposed #6 startup environment: `MOODLE_HELPER_DATASET=demo` (default) or `moodle`; Moodle additionally requires `MOODLE_HELPER_MOODLE_ORIGIN=https://moodle.sdu.edu.kz`, `MOODLE_HELPER_PROFILE_LABEL` and `MOODLE_HELPER_STABLE_USER_ID`, all nonblank. Partial Moodle configuration or Moodle fields in demo is an error. Profile labels are trusted user choices and stable user IDs must come from future approved discovery; this does not detect them. No request header can choose a namespace. `namespace_key('demo')` → `["demo"]`; Moodle → `["moodle","https://moodle.sdu.edu.kz","personal","42"]`. Distinct users/profiles differ, delimiter-like strings cannot collide.

Future collector requirements (helpers tested against labeled fixture identifiers, not implemented collectors): course key = namespace + [course, stable course ID]; activity = namespace + [activity, course ID, Moodle module type, stable activity ID]; resource = namespace + [resource, course ID, Moodle module type, stable resource ID]. E.g. course 101, assign 7001 versus quiz 7001 have distinct keys, unchanged by title/date. Missing source identifiers raise useful errors; never guess from title. #11/#13/#14/#15/#16/#17 implement collectors; #33 owns cross-source matching. Do not conflate an activity identifier with a course-module identifier without a collector-specific decision.

Evidence replay uses canonical JSON of every present SourceEvidence field including origin, provenance and observed facts. Same field values with reordered object keys are idempotent; changed observedAt, URL, date, excerpt/location or source survives. Array order is preserved. Absent optional field differs from supplied content. `merge_source_evidence` only returns a fresh evidence list; it does not persist or mutate overlays. A source upsert merges source facts while retaining assessment ID and separate overlay title/date/overrideBase/hidden/completed; submitted observation never sets completed. Explicit PUT Snapshot is full replacement and may replace overlays too; it is not a source upsert. #6 owns atomic transactions, #33 owns matching. Tests demonstrate this separation without claiming storage integration.

## Examples and executable checks

Run `uv run pytest tests/test_model_inventory.py tests/test_domain_validation.py tests/test_identity.py` and the full `uv run pytest`. Existing `tests/test_contract.py` retains generated/source parity and HTTP checks. The checked-in examples below and tests use no Moodle credentials.

```json
{"id":"a1","activityId":"7001","courseId":"c-csc","title":"Lab","type":"assignment","sources":[{"source":"moodle","date":{"kind":"exact","iso":"2028-02-29T14:00:00+05:00","tz":"Asia/Almaty"},"url":"https://moodle.sdu.edu.kz/mod/assign/view.php?id=7001","observedAt":"2028-02-28T09:00:00Z"},{"source":"syllabus","date":{"kind":"week","week":8},"location":"page 2","observedAt":"2028-02-28T09:00:00Z"}],"submission":{"status":"unknown","observedAt":"2028-02-28T09:00:00Z"},"personal":false,"firstObservedAt":"2028-02-28T09:00:00Z","lastObservedAt":"2028-02-28T09:00:00Z"}
```

Personal overlay example: `{"assessmentId":"a1","dateOverride":{"kind":"date","date":"2028-02-29"},"overrideBase":{"kind":"week","week":8},"hidden":true,"completed":false}`. An absent override is omitted; unknown date is `{"kind":"unknown","note":"not published"}`, distinct from an absent availableFrom. Resource example: `{"id":"m1","courseId":"c-csc","section":"Week 1","title":"Notes","fileType":"pdf","url":"https://example.org/notes.pdf","accessible":true,"stale":false,"lastCheckedAt":"2028-02-28T09:00:00Z","syllabusSuggestion":false}`. Full Snapshot examples for courses, settings and changes are supplied by sample_data and round-tripped by tests, including documents/candidates/sync/alerts. Settings remain the complete inventory above; no hidden job field exists.

Proposed #19 job (NOT current wire): `{"id":"job-uuid","namespace":["demo"],"courseIds":["c-csc"],"state":"queued","requestedAt":"2028-02-28T09:00:00Z","cancelRequested":false}`. Backend owns lifecycle/ordering/retained partial outcomes; #21 owns progress/cancel UI. This job cannot be passed as CourseSyncState.

Examples of useful domain failures: date `2027-02-29` → `date.date: must be a real calendar day`; exact `2028-02-29T14:00:00` → `date.iso: must include an explicit timezone offset or Z`; URL `javascript:alert(1)` → `url: must use HTTPS`; missing assessment id → `id: must be a nonempty stable identifier`. Calendar-shaped impossible dates and unsafe URLs still pass wire parsing; focused tests reproduce both boundaries.

## Coverage checklist and extension owners

- [x] All current Snapshot and nested fields above are representable; opt-in semantic validation/namespace/replay helpers are tested.
- [ ] Separate cutoff dates: #13; current sources dates do not distinguish due/cutoff.
- [ ] Quiz attempt count/state details: #14; submission status alone is insufficient.
- [ ] Folder parent/child relationships: #17; Material.section is not a folder relationship.
- [ ] Semester breaks/week overrides: #30/#52; start/weeks alone are insufficient.
- [ ] Busy-week reminder lead setting: #38; busyWeek boolean and hoursBefore do not claim separate lead support.
- [ ] Durable/cancellable jobs: #19/#21; course-level sync summary is insufficient.

Before backend implementation, each owning feature issue must record its agreed additive schema extension and coordinated Zod/OpenAPI/Python changes. Unsupported values must be explicitly reported by the owning ingestion feature, never silently discarded as supported fields. No feature extension is added here.

Timezone availability: the standard-library ZoneInfo database is absent on this Windows host. UTC, Asia/Almaty and Asia/Qyzylorda are explicitly recognized product IANA names without any offset calculation; additional names require an installed system ZoneInfo database. Unknown/unavailable names receive an actionable timezone error. No timezone package is added. The Node probe decodes UTF-8 explicitly so Russian evidence survives the cross-language round trip.


Verification at engineer handoff: `uv run pytest -q` passed **154 tests** including 63 new focused checks and all existing API/source-generated contract tests. Existing Starlette/httpx deprecation warning remains. The cross-language probe requires the already approved Node/TypeScript/Zod frontend dependencies installed by the documented toolchain; no package was added. Strict helpers are not connected to HTTP/storage and no SQLAlchemy/SQLite code or dependency was introduced. Independent QA must verify all expanded #5 criteria before closure.

Exact-instant offset syntax is Z or signed HH:MM with offset hours 00..23 and minutes 00..59. Clock hours/minutes/seconds also require valid datetime ranges (no leap-second normalization). Offset components are checked before datetime parsing so invalid +05:99/+00:60 cannot be normalized into accepted instants. Original valid timestamp precision and offset strings are retained.

QA repair verification: focused model/identity/domain checks pass **84 tests**, and `uv run pytest -q` passes **175 tests**. Added offset and clock boundaries plus invalid exact calendar dates; wire models continue to accept these arbitrary strings. Only the existing Starlette/httpx warning remains.
