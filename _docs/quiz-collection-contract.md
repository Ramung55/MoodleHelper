# Quiz collection decision (#14)

PM review 2026-10-26, before implementation. Canonical #14 has five acceptance
criteria and the explicit constraint **Support only variants verified in #3**.
The #3 compatibility report has no verified variants. #4 quiz.html is synthetic
fact-only markup without an accessible structural page, not a supported variant.
Do not weaken this constraint, treat synthetic inputs as verification, or close
#14 with a vacuous pass. Assignment #13's different constraint does not change #14.

## Disposition

#14 release support is externally blocked. Required evidence is permitted,
sanitized #3 inspection identifying a quiz variant, source, actual inspection
date/language and observed/unavailable outcomes for identity, dates and attempts,
with supported access/navigation behavior. No credential transfer or alternate
network/browser bypass is authorized. #3 must verify a variant before that variant
is supported by the collector. All five original AC remain outstanding for that
supported collector, including offline fixture checks tied to its evidence.

An independent experimental parser/model and synthetic tests are locally feasible;
they could validate preservation of date precision, distinct identity and visible
attempt wording. They cannot establish #3 verification or satisfy #14 overall.
PM recommendation: record the model now and continue to independent #15 review;
do not spend implementation work inventing provisional quiz selectors unless the
orchestrator explicitly chooses the experimental partial deliverable. No candidate
code exists or is claimed complete by this document.

## Raw model and future wire decision

Before eventual backend ingestion, retain a raw `RawQuizObservation`, not Snapshot:
required sourceCourseId, sourceActivityId (quiz instance), sourceCourseModuleId,
sourceUrl, title and observedAt; optional opening and closing date observations;
attemptInformation as explicit unknown or known visible facts. IDs are distinct
canonical positive decimal strings. Final/requested/source quiz module IDs and
course link ID must agree, with safe canonical SDU HTTPS links and no credentials,
extra query keys, fragments or reflected private diagnostics. Future #5 identity
uses namespace + course ID + module type quiz + quiz-instance activity ID.

Each date observation retains DateValue, visible rawText and fixed location.
Closing means quiz close, never exam start/appointment. No closing observation
means open-ended; opening never supplies a closing deadline. Preserve #13 validated
minute/second/1..3-fraction exact strings with explicit ISO offset and known IANA
timezone, and real calendar date-only precision without midnight/timezone invention.
observedAt is a validated explicitly zoned instant preserved as supplied. Access
is classified first, before any page structure is read; invalid observations fail
safely without output. (Originally "Access gate #10 runs first"; superseded for
the verified variant by the Access bullet under "Implementation for the verified
variant" below.) Reuse #13
validation through a small regression-tested extraction if justified, rather than
duplicating permissive date parsing; no mandatory refactor is prescribed now.

Known attempt facts are records with a semantic field (state, allowed, used,
remaining or other explicit attempt wording), source wording and fixed location.
Keep wording rather than deriving counts, attempts remaining, grades, appointment,
submission status or personal completion. Absent information remains explicit
unknown; a partial set preserves observed facts and unknown missing categories.
Do not infer zero, unlimited or completed. Individual date facts, if a verified
variant displays them, require distinct base/effective fields and explicit scope
evidence as in #13; never silently replace generic facts.

Agreed future additive wire boundary: optional nonnullable Assessment.quizDetails
retains these identities/provenance, optional opening/closing observations and
attemptInformation. Coordinate OpenAPI/Zod/Python with persistence/backup round-trip
tests before #18/#20 backend ingestion. The #14 schema gap stays explicitly tracked
until then. Existing sources[].date/submission alone are insufficient; raw DTO
must not be sent to Snapshot and stripped. No wire/API change is needed for this
decision or an isolated experiment; no unrelated current/discovery metadata change.

## Bounds if an experimental partial deliverable is chosen

Candidate files only: extension/src/experimental/moodle-quiz-candidate.ts,
frontend/src/test/moodle-quiz-candidate.test.ts and a synthetic structural builder;
this document and #5 inventory cross-reference. Exact candidate structural
vocabulary must be documented before code and remain explicitly invented. Use
the actual #10 gate and separate assertions, not data-fact/manifest truth lookup.
Do not relabel or rewrite #4 fixtures as verified inputs.

Candidate exports are test-only, explicitly experimental, never exported by the
extension entry point, bridge, coordinator or backend. The verified quiz support
registry remains empty; production selection cannot dispatch any quiz parser.
Tests must prove no production import/dispatch and empty supported variants, plus
all five AC's synthetic analogues (both dates, quiz-close label, wording/unknown,
absent close, access/malformed errors), distinct IDs, unsafe links, no mutation,
date precision/calendar/offset/zone errors and private-safe diagnostics. Report
these as candidate checks, never supported-variant acceptance or overall QA PASS.
Use approved Vitest/jsdom/Intl only, no dependency installation, live fetch,
Chrome/manual gate invention, Moodle writes, UI, storage or external service.

## Implementation for the verified variant (2026-11-01)

#3 now verifies one quiz variant (matrix rows 4 and 7: English UI, theme
`alpha`, quiz view page with a finished attempt, and the course-page quiz
card). #4 supplies observed-structure fixtures for it. The collector is
`extension/src/moodle-quizzes.ts`, tested in
`frontend/src/test/moodle-quizzes.test.ts`.

- **Registry.** `SUPPORTED_QUIZ_VARIANTS` lists only
  `sdu-en-alpha/quiz-finished-no-attempts-left` (quiz view) and
  `sdu-en-alpha/course-page-format-topics` (course card), the #4 manifest
  source variants. Other languages, other theme assets, the standard
  `table.quizattemptsummary`, in-progress or multiple attempts, attempt
  controls other than "No more attempts are allowed", and date labels other
  than "Opened:" / "Closed:" give an explicit `unsupported` result. Theme
  `alpha` is the site theme #3 recorded for every inspected SDU page and the
  host is pinned to `moodle.sdu.edu.kz`; a page is rejected as another theme
  only on positive evidence (a non-`alpha` `/theme/<script>.php/<name>/` asset
  or `table.quizattemptsummary`), because #3 recorded no alpha asset URL on the
  quiz view page.
- **Dates.** Each row keeps its full wording, label, `meaning`
  (`quiz_open` / `quiz_close`) and location. The #3 display format is read as
  an exact time at the observed UTC+5 offset, zone `Asia/Almaty`. No "Closed:"
  row gives `close: "open_ended"` and no closing observation.
- **Attempts.** "Attempts allowed", "Time limit", the `rui-attempts-list`
  (one `h4.card-title` attempt; no `.card` wrapper is required, since the live
  chain is `div.w-100 > div.rounded.border.p-3` with no `.card`, Addendum 3)
  Status / Started / Completed and "No more attempts are allowed" are kept as
  wording with the wire field vocabulary (state, allowed, used, remaining,
  other). Counts are never derived. Marks, grade, duration and the password
  notice are not kept. No attempt markup gives explicit unknown.
- **Identity.** Course id and cmid come from the body classes `course-<id>` /
  `cmid-<cmid>` (quiz view) or `course-<id>` (course page), observed in the
  2026-11-01 Addendum 3 re-check, or from the `#module-<cmid>` card and its quiz
  view link(s); the source link is rebuilt from the cmid. Other anchors in a
  card are ignored, because #3 did not record how many a card holds; every
  quiz view link in a card must be canonical and agree on the cmid.
  The quiz instance id is not observable on this variant, so
  `sourceActivityId` is explicit unknown. The view-page title element was not
  recorded by #3, so that title stays unknown; the course card title comes
  from `.instancename`.
- **Access.** The collector's own access classification replaces the #10 gate
  for this variant and runs first, before any structure is read. The #10 gate's
  synthetic vocabulary (`nav[aria-label="Account"]`, `main[data-region]`) does
  not match the observed pages, so the collector classifies the observed envelope itself: final path
  `/login/index.php` (HTTP 200) or 401 is `signed_out`, 403 is `denied`, the
  observed 404 is `missing_source`, and missing or contradictory structure is
  `incomplete`.
- **Wire.** Output stays internal raw evidence. It is not dispatched by the
  page-refresh registry, and no OpenAPI, Zod or Python change was made. The
  existing `RawQuizObservation` wire DTO requires a quiz instance id, which this
  variant does not show; mapping is left to #18/#20.
