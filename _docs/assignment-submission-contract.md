# Assignment submission mapper review (#16)

PM review, 2026-10-26. **BLOCKED for full acceptance by missing observed wording, not by an invented live UI gate.**

## Goal

Represent assignment submission status only when Moodle supplies supporting evidence. A pure offline mapper is locally feasible; it cannot establish supported SDU wording or language coverage.

## Acceptance criteria

The five original requirements remain unchanged:

- [ ] Fixtures for submitted, draft, not submitted, reopened/resubmission-required, and unknown each produce a distinct normalized state with source wording.
- [ ] A grade alone does not imply submitted, and a personal completion check does not change Moodle status.
- [ ] A reopened item is flagged for action only when the page explicitly indicates resubmission or a reopened submission.
- [ ] An inaccessible status page stays unknown and does not overwrite a previously confirmed status as not submitted.
- [ ] The result includes an observation time and source link so stale status can be shown later.

## Out of scope

Personal controls remain [#34](https://github.com/Ramung55/MoodleHelper/issues/34) and status presentation remains [#35](https://github.com/Ramung55/MoodleHelper/issues/35). Coordinator integration and coordinated wire/storage work remain [#18](https://github.com/Ramung55/MoodleHelper/issues/18) / [#20](https://github.com/Ramung55/MoodleHelper/issues/20). Observed page evidence remains [#3](https://github.com/Ramung55/MoodleHelper/issues/3) and sanitized coverage [#4](https://github.com/Ramung55/MoodleHelper/issues/4). Nothing has been removed from the original criteria.

## Constraints and precode decision

The canonical issue explicitly requires: **Use #3/#4 observed wording in supported languages and #5 model.** The compatibility report records no inspection, no language and no observed status labels. The #4 README explicitly calls English/Russian synthetic input languages rather than observed SDU locale support. Its draft/reopened/unknown values are raw invented facts, not working page structures. Existing frontend demo prose is also not observed wording. Thus synthetic fixtures can verify the five behaviors offline, but cannot fulfill this constraint. This is narrower than #14's only-verified-variants restriction: no extra live UI, browser demonstration or production wiring criterion is imposed here.

Required unblock evidence: permitted sanitized assignment-status evidence under #3/#4 with actual source type, language, inspection date, status field context and exact visible wording. Representative submitted, draft, explicit not-submitted and reopened/resubmission cases must be distinguished from absent/unrecognized/inaccessible evidence; unknown need not have a guessed translation. Do not invent translations, treat grades as status, bypass browser policy or request credential transfer. Unsupported languages/wording must remain unknown. Keep this issue open; a test-only synthetic draft cannot receive overall QA PASS.

A future implementation can stay in a pure assignment-status mapper and fixture checks using existing Bun/jsdom/shared Moodle date helpers; no dependency, endpoint, UI, network request or backend change is required. It must call the actual #10 access detector first, inspect scoped assignment status DOM rather than arbitrary body/title/grade/checkbox text, and leave inputs unchanged. Source course/activity/module IDs must remain distinct canonical positive decimal strings with exact matching safe SDU assignment URL as in #13. Observation time must be a caller-supplied valid zoned instant preserving original precision; invalid times never become current time. Diagnostics must use fixed safe codes and never echo credentials, grade/private HTML or caught exception text.

Record raw attempted observation separately from retained confirmed status: a current inaccessible/unknown attempt remains unknown with its own observation time and safe source link, while a pure reduction can retain the prior confirmed observation and mark it stale. Never fabricate not_submitted or replace a newer confirmation with an older attempt. Check same exact identity/source before reduction; actionRequired is true only for current explicit reopened/resubmission evidence, not grade, old retained reopened evidence alone, draft, unknown, personal completion or an inferred absence. Retain sanitized scoped source wording for recognized states; unknown records preserve only an explicitly safe scoped unrecognized status phrase, never unrestricted page text.

The #5 current SubmissionObservation wire contains status, observedAt and optional evidence. It lacks direct sourceUrl, actionRequired, attempted/confirmed separation and staleness. Use a detached raw DTO for these facts; do not send it to Snapshot endpoints and allow unknown keys to disappear. Before #18/#20 backend integration, agree an additive optional assignment-submission provenance model in OpenAPI/Zod/Python and round-trip tests, preserving existing SubmissionObservation compatibility. No schema change is claimed here.

Future independent fixture checks must cover all five states and retained wording; grade-only and checked/unchecked completion invariance; explicit reopened versus incidental title/body prose; inaccessible/unsupported-language/unrecognized/conflicting status; stale retention and temporal/identity mismatch; valid/invalid times; safe/unsafe links and exact IDs; privacy sentinels, immutable DOM and no side effects. Use #4 fact-only corpus as negative structural inputs, not expected mapper truth. Synthetic fixtures must be clearly labeled UNVERIFIED and cannot close the observed-wording gap.

Evidence read: canonical #16 (all five AC), #4, local #3 compatibility report, #4 README/assignment/reopened/unknown fixtures, #5 data-model inventory, #13 contract, actual #10 access detector and existing frontend submission/completion semantics. No implementation or test pass is asserted by this PM review.

## Evidence-independent partial engineering handoff

The actual #6 implementation is `backend/storage.py:SourceUpserts.upsert_source`,
not a separate source_upsert module. It merges SourceEvidence and retains first
observation time and personal overlays, but replaces incoming submission facts;
it has no unknown/older submission retention policy. Existing SQLite tests check
replay and personal isolation, not this missing policy. A pure policy primitive
therefore supplies useful partial progress without inventing Moodle wording.

Engineer bounds: `backend/submission_retention.py` and
`tests/test_submission_retention.py`. Retention is authoritative backend domain
policy under #2/#6; the extension supplies raw attempts rather than owning a
second merge policy. Use actual `backend.schemas.SubmissionObservation` values
inside a detached identity/source wrapper, never
claim raw enum inputs classify Moodle DOM. Define explicit success/error result;
input is latest attempt plus optional previous confirmed record. Each carries
exact course/activity/module string IDs and canonical safe assignment sourceUrl.
Validate timestamps with existing #5 backend domain timestamp validation using
the standard library, without globally tightening legacy wire fields. Require exact
identity/source agreement when previous exists. Invalid inputs return fixed
diagnostics with no echoed values. Do not accept grade/completion/HTML inputs.

Return latest attempted record separately from optional confirmed record and
stale boolean. Unknown/inaccessible attempts cannot create a confirmation;
newer unknown retains previous confirmation and sets stale=true. An older unknown
attempt never marks a more recent confirmed observation stale. At an equal instant,
unknown cannot disprove a confirmed fact: retain confirmation with stale=false.
Known newer
attempt replaces confirmation and sets stale=false. Older attempt cannot replace
newer confirmation; identical replay is stable; equal-time contradictory states
must be rejected rather than arbitrarily selecting truth; return a fixed safe
error without replacing or mutating the supplied current confirmation. Compare
validated instants only; preserve original timestamp strings and source wording,
including offset-equivalent values. Equal-time same-state input is an idempotent
replay: retain the existing confirmation and its original wording/precision.
Unknown with no prior
has no confirmation and is stale=false (there is no retained fact to mark stale).
This is observation retention, not actionRequired classification; do not invent
reopened semantics from a raw enum. No store, endpoint, Snapshot serialization,
Moodle DOM classifier, shell, UI, network or dependency change. Tests cover
time/identity/URL failure, known-to-unknown retention, inaccessible equivalent
unknown, older attempts, contradictory ties, replay, detached outputs and input
immutability. Overall #16 remains blocked until observed wording is supplied;
QA may report only this partial primitive's checks, never overall issue PASS.

## Owner decision on evidence (2026-11-02)

PM grooming 2026-11-02 unblocked #16. Where this section differs from the observed-wording constraint above, it wins.

| State | Evidence | Source |
| --- | --- | --- |
| `submitted` | `td.submissionstatussubmitted` "Submitted for grading" | Observed on SDU, compatibility report Addenda 5 and 6 (5 of 19 assignments) |
| `not_submitted` | "Submission status" cell with no `submissionstatus*` class, "No submissions have been made yet" | Observed on SDU, Addenda 5 and 6 (14 of 19) |
| `draft` | `td.submissionstatusdraft` "Draft (not submitted)" | Upstream, not seen on SDU |
| `reopened` | `td.submissionstatusreopened` "Reopened" | Upstream, not seen on SDU |
| `unknown` | Everything else: unrecognised wording, a non-English page, a class and text that disagree, no or conflicting status rows, an inaccessible or unreadable page | Contract default |

Upstream citation, checked 2026-11-02: repository `moodle/moodle`, branch `MOODLE_405_STABLE`, commit `c0690bbc765fccacd4956452cbff3f6aacad77c5`. `mod/assign/lang/en/assign.php` keys `submissionstatus_draft` = 'Draft (not submitted)', `submissionstatus_reopened` = 'Reopened', `submissionstatus_submitted` = 'Submitted for grading', `nosubmissionyet` = 'No submissions have been made yet' and `submissionstatus` = 'Submission status'. On `main` (commit `0580991669815767026aea115a2053e2040378af`) the strings are in `public/mod/assign/lang/en/assign.php`. `mod/assign/classes/output/renderer.php` (status table, around lines 709–720) renders a non-team, non-`new` submission as cell text `get_string('submissionstatus_' . <status>)` with class `'submissionstatus' . <status>`, and otherwise a class-less `nosubmissionyet` cell, which explains the class-less not-submitted cell seen on SDU.

Draft and reopened stay Unavailable / UNVERIFIED on SDU in `_docs/compatibility/sdu-moodle.md`. The decision changes only what counts as evidence for them. Team submissions, `submissionstatus_marked` "Graded", `submissionstatus_new`, `noonlinesubmissions` and Russian/Kazakh interfaces are not mapped and stay `unknown`.

### Mapper (implemented for #16)

`extension/src/moodle-submission-status.ts:parseMoodleSubmissionStatus(input, observedAt)` is pure and read-only and takes no grade or completion argument. `input` is the #10 access envelope plus the caller's `expectedSourceCourseId` and `expectedSourceCourseModuleId`: the scan always knows which course and assignment it requested (QA on #16, 2026-11-02).

- It calls `detectMoodleAccess` first. SDU assignment pages do not show the synthetic #10 session navigation and `main[data-region]` markers, so the observed fixtures report `ambiguous_content`; only `accessible` and `ambiguous_content` allow the DOM read. A network failure without a final URL is checked with the requested URL in its place. Every other access reason, a non-200 status or a final `/login/index.php` URL gives `unknown` with `unknownReason: "inaccessible"` and the detector's `access` status and reason, never `not_submitted`.
- It reads only the `.submissionstatustable` row whose `th` is "Submission status". A recognised state needs the exact class and the exact English text after whitespace normalisation; not-submitted needs a cell with no `submissionstatus*` class. The page must be `body#page-mod-assign-view` with `<html lang="en">` and no body `lang-*` class other than `lang-en`.
- A result is `{status: "observed", observation}` with `state`, `wording` and `evidenceBasis` (`observed-sdu` or `upstream-not-seen-on-sdu`; both absent for `unknown`), `actionRequired` (true only for the reopened cell), `observedAt` (caller string, unchanged), canonical `sourceUrl`, `sourceCourseId` (body `course-<id>` when the page shows it, even if a later structure check fails; otherwise the caller's expected id, for example on an inaccessible page), `sourceCourseModuleId` (requested URL `id`). The expected ids must be positive decimals, the requested URL id, the final URL id and body `cmid-<id>` must equal the expected cmid, and body `course-<id>` must equal the expected course id; otherwise `identity_mismatch`, `access` and a fixed `unknownReason` for `unknown`.
- Errors are `{status: "error", error}` with `invalid_observed_at`, `unsafe_url` or `identity_mismatch`. A missing or invalid `observedAt` is never replaced by the current time.
- `state` values are the #5 `SubmissionStatus` enum, the strings `backend/submission_retention.py:retain_submission` accepts. Storing results through the retention policy, the provenance wire model and the activity-instance id are #81.

Fixtures: `tests/fixtures/moodle/observed/assign-submitted.html`, `observed/assign-not-submitted.html`, and `upstream/assign-draft.html` and `upstream/assign-reopened.html` (`sourceKind: "upstream-string"`, label "upstream, not seen on SDU"). Tests: `frontend/src/test/moodle-submission-status.test.ts` and `tests/test_moodle_fixtures.py`.

## Owner decision: course-module keyed submission identity (2026-11-08)

The owner approved using the observed Moodle course-module ID as a separately named submission identity, with compatible storage and tests. This revises #81's earlier rule that a submission must always carry a recorded assignment-instance ID; it does not claim the two identifiers are equal. A live observation may omit `sourceActivityId` while retaining its observed `sourceCourseModuleId`, course ID, canonical source URL and observation time. An explicitly supplied activity ID must still be a valid positive decimal identifier.

New module-keyed records have a distinct, tagged identity. Existing instance-keyed records and their original identifiers remain unchanged and readable; no stored instance ID is rewritten or inferred from a module ID. New and legacy records for one course/module can coexist, and the retention policy replays validated attempts across them. Conflicting known instance IDs for the same course/module are rejected on ingestion; a restored conflicting history is not projected. Unknown observations retain an earlier confirmation, and the dashboard marks it potentially out of date. Projection occurs only when the module matches one uniquely validated assignment source for the same course; an ambiguous association does not receive a submission status. Personal completion remains separate.

This decision governs the identity change; it does not itself establish live Moodle compatibility, enable visited-page refresh, or constitute independent QA PASS. Snapshot compatibility is additive: old records stay in their original form and new records use the separate module key rather than a destructive migration.

The status is projected into `reconciliation.logicalAssessments` after the logical view is rebuilt; original `assessments` remain unchanged, including any submission and staleness fields supplied by a snapshot or backup. Original submissions are never overwritten; the logical view compares valid observation times, keeps a newer known status, marks a known status stale after a newer unknown, and withholds conflicting known statuses at the same instant. A failed verified course scan may make an existing projected status stale without inventing an assignment observation. A partial scan leaves an older submission stale unless that specific submission was observed again since the scan began. An older failed attempt does not stale a newer observation. Restored and unrelated course data remain distinct, and ambiguous or conflicting source identities do not acquire a projected submission.

## Live account-binding safety gate

Lifted for **Sync all** by #94 through #93's account check. The live registry's `submission` collector (`extension/src/page-refresh.ts:liveRegistry`) is available in verified mode and reads the status from the `/mod/assign/view.php?id=<cmid>` page the scan already fetches: no new request, URL or click. Records are module-keyed: the expected course is the scan's course and the expected cmid is the requested page's `id`; no `sourceActivityId` hint is passed and the cmid is never copied into it. The backend no longer has a submission-specific rejection: every verified merge, submission included, goes through `CollectionService._merge_refresh`, which saves nothing unless `account_error(moodleUserId)` is `None` (`backend/identity.py`). A finish from another account (`account_mismatch`) or without a confirmed id (`account_unconfirmed`) saves nothing. #95 opens the visited-page refresh path (`/api/collection/visits`, `/api/collection/refresh`) for the real dataset: a visited assignment page is read once by the worker with the same live registry, and the refresh carries that page's `moodleUserId` through the same account check. `syntheticFixtureRegistry()` and `disabledRegistry()` keep `submission` unavailable; the synthetic injected test context still exercises the parser, retention and projection without student data.
