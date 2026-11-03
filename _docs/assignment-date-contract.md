# Assignment date parser contract (#13)

PM decision recorded before implementation, 2026-10-26. All conventions below are
synthetic and UNVERIFIED at SDU; #3 remains blocked and #4 fact-only fixtures are
negative inputs, not supported structural pages. All five original #13 criteria
are feasible offline and remain required.

## Boundary and model decision

Implement a pure `parseMoodleAssignment(input: MoodleAccessInput, observedAt: string)`
in `extension/src/moodle-assignments.ts`. Call the actual #10 detector first; only
accessible inputs proceed. Return a discriminated success/error result containing
the detector result and fixed diagnostic codes. Success contains one detached raw
observation; failure contains no observation. Never accept caller access labels.
No fetch, browser navigation, DOM mutation, storage, logging or shell wiring.

After the actual #10 access gate, validate caller `observedAt` as a nonblank string
using the exact zoned-instant syntax and real calendar/clock/offset rules below:
minute, second or 1..3 fractional-second precision with explicit Z or signed HH:MM.
It is an observation instant, so it needs no separate IANA timezone argument.
Preserve the original string and precision. Invalid type, blank, unzoned or
impossible values return a fixed safe parse error with no observation; never use
an automatic current time, default timezone, normalization or inferred seconds.
Access failure takes precedence over invalid observedAt and other parse failures.

`RawAssignmentObservation` is explicitly NOT Assessment or Snapshot. Required:
`sourceCourseId`, `sourceActivityId`, `sourceCourseModuleId`, `sourceUrl`, `title`,
`observedAt`, `baseDates`, `individualExtensions`, `effectiveDates`.
IDs are canonical positive decimal strings, never numbers. Course-module URL id
is separate from assignment-instance activity id. Future #5 identity input is
namespace + course ID + module type `assign` + sourceActivityId; module id remains
provenance. Namespace selection and persistence are not parser responsibilities.

`baseDates` and `effectiveDates` each have independently optional `opening`, `due`,
`cutoff` keys. A date observation is `{value: DateValue, rawText: string,
location: string}`. Use #5 DateValue without coercion; location is a fixed structural
field descriptor, not arbitrary markup. `individualExtensions` is an array of
`{field: opening|due|cutoff, date: date-observation, evidence: string,
scope: individual}`. Normalize whitespace in title/rawText/evidence; reject blank
title and evidence. Preserve each base and explicit extension fact. Effective
fields use the explicit individual field extension, otherwise that same base
field; never substitute another date meaning. An extension can supply an effective
due with base due absent; if neither supplies due, both due keys stay absent.

The existing Assessment.sources[].date cannot express these semantics, and
availableFrom:string cannot preserve date-only opening precision. Agreed future
additive wire design, owned by #13 and integrated before backend assignment ingestion
under #18/#20: optional nonnullable `Assessment.assignmentDates` with the same
baseDates/individualExtensions/effectiveDates values plus sourceCourseId,
sourceActivityId, sourceCourseModuleId, sourceUrl and observedAt. Preserve rawText,
location and extension evidence. Coordinate OpenAPI, Zod and Python and round-trip
storage/backup tests when that wire boundary is implemented. No wire changes are
needed for this pure raw parser; do not send its DTO to existing Snapshot endpoints,
drop unsupported facts, or claim the gap is already closed. Keep #5 gap entry open
with this decision linked. Existing discovery/current metadata remains unchanged.

## Exact synthetic structural vocabulary

Accessible #10 `/mod/assign/view.php?id=<moduleId>` page; exactly one
`main[data-region="activity"]` containing exactly one
`article[data-region="assignment"][data-course-id][data-assignment-id][data-course-module-id]`.
Article contains one nonblank `h1`, exactly one
`a[data-role="assignment-link"]`, and one
`a[data-role="course-link"]`. Course link `/course/view.php?id=<courseId>` and
assignment link `/mod/assign/view.php?id=<moduleId>` must match identity and final
URL. Allow canonical relative paths or exact HTTPS SDU origin, default port 443;
reject credentials, other origin/port, fragments, whitespace/backslashes, extra or
duplicate/encoded query keys, noncanonical IDs. Rebuild output sourceUrl from id.
Validate requested assignment URL too; differing requested/final module identities
are an error. Different course, instance and module values are tested explicitly.

Dates are `time[data-date-field="opening|due|cutoff"][datetime]` inside the article.
Base nodes have `data-date-scope="base"`; extensions have
`data-date-scope="individual"` and nonblank `data-extension-evidence`.
Exact nodes require `data-timezone` containing a known IANA name validated with
existing Intl; UTC and Intl-recognized IANA aliases are allowed. Reject numeric
fixed-offset timezone identifiers (including +05:00/-0500/Z), even if this Intl
version accepts them; an ISO timestamp offset is distinct from an IANA identifier.
Named IANA zones such as Etc/GMT+5 remain eligible if recognized by Intl.
Date-only nodes omit timezone. Time text must be nonblank, retained
as rawText. Unknown field/scope, invalid or blank datetime, duplicate same-scope
field, nested assignment article, missing/duplicate identity/title/links, explicit
data-incomplete/data-truncated on main/article all fail. Recognized unsupported or
ambiguous date markup cannot produce an empty success. No natural-language date
guessing, generic unscoped override inference or manifest/data-fact truth lookup.

Exact syntax: YYYY-MM-DDTHH:mm, optionally :ss and then optionally 1..3 fractional
second digits, followed by Z or signed HH:MM. This preserves #5 minute precision
alongside seconds/milliseconds; reject fractional minutes. Validate real calendar
(including leap years), clock 00..23 /
00..59 / 00..59, offset 00..23 / 00..59 before instant parsing; reject normalization,
missing zone, impossible dates and unsupported precision. Preserve original exact
string and timezone, including minute-only input without adding seconds; instant
comparison may use a validated epoch value without
changing persisted precision. Date-only YYYY-MM-DD must be real; retain date branch
without time/timezone. No inferred midnight, current year, local timezone or week.
Ambiguous visible prose without a valid machine value fails with fixed reason.

## Verification and bounds

Files: parser above, `frontend/src/test/moodle-assignments.test.ts`,
`frontend/src/test/moodle-assignments-fixtures.ts`, this document and #5 inventory
cross-reference. Synthetic DOM builders supply real #10 account navigation, main,
heading and canonical links; expected values live separately in assertions.
Do not rewrite #4 corpus into accepted markup or change its provenance.

Tests independently cover all five AC: all three semantics and distinct identities;
base/effective extension and evidence; missing due plus extension-only due;
offset-equivalent instants and date-only precision; malformed/access failures.
Include leap/invalid calendar, bad clock/offset/zone, unzoned timestamps,
minute/second/millisecond offset equivalence without changing stored precision,
rejection of numeric fixed-offset timezone identifiers and accepted UTC/IANA names,
invalid observedAt types/blank/unzoned/calendar/clock/offset and unchanged valid
observedAt precision, including access-failure precedence when it is also invalid,
duplicates, unknown scope/field, generic date, unsafe origin/credentials/query,
identity mismatch, absent identity/heading, truncation, login/403/network/ambiguous
envelopes, fact-only #4 inputs, private sentinel not reflected in diagnostics,
unchanged input DOM/envelope and no side effects. Mutation tests of structural
fixtures must prove input facts drive output. Existing #10/#11 and #4 hygiene
checks remain green; run focused frontend tests, full frontend tests/build and
backend suite as regression checks. No new dependencies or live/manual gate.

## Engineer implementation checkpoint

The pure parser and separate synthetic builders/assertions implement all five
criteria. Diagnostic results use `status: error`, a fixed `reason` and the actual
#10 access result; they never include partial observations or source text.
Success uses `status: success` and one `observation`. Structural locations are
`assignment.base.<field>` and `assignment.individual.<field>`.

Verification and final counts are recorded in the engineer handoff on #13.
These are offline synthetic checks; #3 compatibility and the coordinated future
#18/#20 wire gap remain open. No shell consumer or existing Snapshot endpoint
accepts the raw assignment DTO.
