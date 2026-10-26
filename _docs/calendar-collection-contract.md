# Calendar assessment parser contract (#15)

PM decision before implementation, 2026-10-26. All five original #15 criteria
remain required and locally testable. Unlike #14, #15 does not require only
#3-verified variants. This contract supports invented offline structural inputs;
SDU selectors/compatibility remain UNVERIFIED. #4 calendar.html is a fact-only
negative input, never a truth lookup or supported structural page.

## Pure boundary and raw model

Implement `collectMoodleCalendar(inputs: readonly MoodleAccessInput[],
selectedSourceCourseIds: readonly string[], observedAt: string)` in
extension/src/moodle-calendar.ts. Caller selection is explicitly trusted source
course IDs, canonical positive decimal strings; never use opaque Course.id or
infer selection/course from title. Invalid selection or observation timestamp
returns a fixed batch error and no observations. Each page first runs actual #10
access detection, and inaccessible pages report their fixed access result without
parsing. Batch argument validation must not replace these per-page access outcomes.
observedAt uses #13 zoned-instant validation and original precision; no auto-now.

Return detached `observations`, `review`, `exclusions`, `diagnostics`, `pages`,
`coverage: complete|partial|none` and `scope: supplied_ranges_only`.
`RawCalendarObservation` has sourceEventId, optional sourceOccurrenceId and
sourceSeriesId, sourceCourseId, title, sourceUrl, observedAt; independently optional
start/end/date observations, and optional activity reference. Date observation is
`{value: DateValue, rawText: string, location: fixed-structural-path}`. Explicit
date-only is `date`, mutually exclusive with start/end; exact start/end retains
its original precision/offset/IANA timezone, never inferred midnight. Missing
fields stay omitted. Explicit unknown date retains DateValue unknown plus visible
rawText and review reason unknown_date; entirely absent dates require missing_dates
review. Unknown semantics are not absence. Never label an event end/start as a
deadline or exam appointment without later evidence/reconciliation (#33).

Review entries are detached candidates containing the same validated source event
identity, title, URL, dates and optional activity reference, with sourceCourseId
omitted when missing/unreliable, plus fixed reasons. They never become selected
course observations by a title guess. Conflict records may preserve candidate
sourceCourseId as evidence, but that does not establish reliable association.
Exclusions/diagnostics expose only fixed reason and page/record indices, no source
text, arbitrary URL, credentials or private grades. Title/raw date text belong
only in successful/review raw facts, not diagnostic strings.

This raw DTO is NOT Snapshot/Assessment. Existing SourceEvidence.date cannot
retain start/end/date meanings, event/recurrence identity or review provenance.
Agreed future additive wire boundary, before #18/#20 backend calendar ingestion:
Assessment.calendarEvents[] retains the complete raw calendar observation and
source evidence; unresolved course reviews require a separate raw review queue,
never an invented Course reference. Coordinate Zod/OpenAPI/Python plus persistence
and backup round-trips then. #15 owns this semantic gap; no wire change, endpoint,
storage or UI is needed for this pure parser. Do not feed its DTO to Snapshot and
allow unknown fields to disappear. #33 owns calendar/activity matching.

## Exact synthetic DOM and URL vocabulary

Each #10-accessible page has requested/final URL exactly canonical SDU
/calendar/view.php (relative links only where specified below), one
main[data-region="calendar"] with one nonblank h1 and valid real-date
data-range-start/data-range-end, inclusive with start <= end. These ranges describe
the supplied view, not all future events. Fixture builders include real #10
account navigation and canonical content links; markers alone cannot prove access.

Candidates are article[data-region="calendar-event"][data-event-id] inside main.
Article contains one nonblank h2 and exactly one a[data-role="event-link"].
data-event-kind is assessment, site, personal or other. Unknown/missing kind goes
to review as unknown_kind if identity/links/title are valid; never silently treat
unknown kinds as assessments. Site/personal/other are excluded with fixed reasons
site_event/personal_event/non_assessment. No classification by words in title.

Assessment article data-course-id is optional; when present a single
a[data-role="course-link"] must match /course/view.php?id=<courseId>.
Missing course, missing link or conflicting well-formed course/link identities
produce missing_course/unreliable_course review; unsafe links/invalid IDs are
malformed records and never trusted. Reliable courses outside selected source IDs
are excluded as unselected_course. Review of unreliable assessment association
occurs independently of selection; never default to the sole selected course.

All IDs are positive canonical decimal STRINGS, with no numerical conversion or
leading zero. A nonrecurring event URL is /calendar/view.php?event=<eventId>.
Recurring articles explicitly provide both data-series-id and data-occurrence-id;
their event URL is /calendar/view.php?event=<eventId>&occurrence=<occurrenceId>.
Exactly one recurrence attribute alone is malformed. Event ID, series ID and
occurrence ID remain distinct. Future namespace-local identity is canonical JSON
tuple [calendar_event,eventId,occurrenceId-or-null], prefixed by trusted namespace;
not an activity/course helper call with a fabricated module identity. Same series
does not collapse occurrences. Distinct event IDs remain distinct even with
identical titles/times. Parser does not select namespace or persist IDs.

Optional single a[data-role="activity-link"] must be /mod/assign/view.php?id=<cmId>
or /mod/quiz/view.php?id=<cmId> and provide data-activity-id=<instanceId>.
Output activity reference retains moduleType, sourceActivityId,
sourceCourseModuleId and sourceUrl; link id is not the instance id. Missing link
omits reference; dangling instance identity, duplicate/invalid link is malformed.

Links accept canonical relative absolute paths or HTTPS moodle.sdu.edu.kz,
optional explicit port 443, exact query spelling/order above. Reject other origins,
credentials, fragments, whitespace/backslashes, encoded/duplicate/extra query
keys, wrong ports or identity mismatch. Output URLs are rebuilt from validated
IDs. Requested/final page URLs cannot redirect to a different calendar route.

Dates use time[data-date-field="start|end|date"][datetime] with nonblank visible
text; exact values require data-timezone, date-only requires no timezone.
Use #13 real calendar/clock/offset, minute/second/1..3-fraction precision and IANA
validation, rejecting numeric timezone identifiers even if Intl accepts them.
`date` requires DateValue date; start/end may be exact or date-only without
conversion. Explicit unknown is span[data-date-field][data-date-unknown] without
datetime/timezone and with nonblank visible evidence. Duplicate fields, unsupported
field/candidate markup or mixed date versus start/end are malformed. Do not order
unknown or mixed-precision intervals; if both exact, end cannot precede start by
instant comparison; if both dates compare real calendar dates. Never convert a
date-only end into exclusive next-day midnight.

## Deduplication, errors and bounded coverage

Dedup canonical event/occurrence tuple across pages in first-seen order. Equivalent
facts mean same normalized title, course association, activity/recurrence metadata,
and dates (exact comparisons by validated instant AND same precision category;
date-only by day; unknown by retained evidence). Offset-equivalent exact facts
with equal precision dedup, retaining first original representation. Conflicting
facts for one tuple move all distinct validated candidates into review with
event_conflict, remove that tuple from observations, and mark affected pages
partial; never last-writer-wins. Review duplicates also dedup by tuple + retained
candidate facts, with fixed reasons merged. Distinct recurring occurrences never
collapse by title/time/series alone. Explicit absent versus supplied facts conflict.

Exclusion/privacy precedence across duplicate tuples: classification is an
internal validated fact even when the record is excluded. Group the validated
event/occurrence tuple before deciding whether an eligible selected assessment
can remain in observations. A tuple seen as an eligible selected assessment and
also site/personal/other, or with a different reliable course association
(including an unselected course), is contradictory: remove the eligible
observation, retain that eligible candidate in review as event_conflict, and mark
all involved pages partial. The excluded candidate still produces ONLY its fixed
exclusion reason/indices; never expose its title, dates, course/activity facts,
URL, identity or other private raw data in review/diagnostics/observations.
“All distinct validated candidates” above therefore means all otherwise eligible
assessment/review candidates; it never overrides exclusion privacy. An unselected
assessment remains fixed-reason-only when another selected candidate collides.
Candidates already requiring missing/unreliable-course review retain their
review facts and gain event_conflict on contradictory tuple evidence. Conflicting
excluded-only tuples return exclusions only and partial coverage; no invented
assessment review. Identical excluded tuples may retain per-record exclusions.
No source kind/course claim silently wins by input ordering, and no title/time
comparison establishes a collision without the reliable tuple.

Page result includes access, valid inclusive range when available, coverage,
candidateCount and paginationPending. main data-incomplete/data-truncated or
nav[data-region="calendar-pagination"] a[href]/button signals partial/pending
coverage; do not follow links. Nested candidates, malformed/unsafe candidates,
reviews or event conflicts also make coverage partial. Invalid main/range/page
route yields none; valid siblings survive bad records with partial coverage.
Any unrecognized article inside main is malformed rather than silently skipped.
Zero candidates needs exactly one [data-role="calendar-empty"] and genuine #10
access; absent/contradictory empty marker is partial error, never empty success.
Complete means every supplied page/range parsed without unresolved signals, not
full enrollment, historical or future assessment coverage. Empty batch is none.
Batch coverage is complete only if all pages complete, otherwise partial if any
valid page content exists, else none. No disappearance/deletion inference.

## File bounds and verification

Files: parser above, frontend/src/test/moodle-calendar.test.ts and
moodle-calendar-fixtures.ts, this document and #5 inventory cross-reference.
For consistent reuse only, extraction of existing #13 private realDay/exact/dateValue
helpers into extension/src/moodle-dates.ts and narrow assignment imports is allowed;
preserve signatures/behavior and run all 97 #13 regressions. Avoid copied divergent
date rules or unrelated refactoring. No new dependency/install, UI, network,
Moodle write, DOM/input mutation, persistence, bridge/entry-point integration or
extra Chrome/manual gate. Separate builder inputs from expected assertions.

All five AC require independent checks: selected facts and optional link; explicit
exclusion reasons; missing/conflicting association review; repeat/recurrence and
same-title-distinct-ID dedup; partial/empty/range scope. Also test unknown/absent
dates, offset equivalence/precision, invalid calendars/zones/clocks/offsets,
conflicting duplicate facts, invalid selection/observedAt, access/login/403/network,
unsafe/mismatching identities/links, malformed siblings, fact-only #4 negatives,
fixed private-safe diagnostics, unchanged inputs and no effects. Run focused
calendar tests, #10/#11/#13 regressions, full frontend tests/build, #4 hygiene and
backend suite. These are offline checks; no claim of live SDU compatibility.
