# SDU Moodle compatibility — UNVERIFIED

Report prepared: 2026-10-26. Live inspection date: **not inspected**. Page language: **unknown**.

This is the no-session reporting artifact for [#3](https://github.com/Ramung55/MoodleHelper/issues/3), following the [PM review](https://github.com/Ramung55/MoodleHelper/issues/3#issuecomment-6411584975). It does not establish live compatibility. The issue remains open and externally blocked; the original acceptance criteria remain unchanged.

Scope is Chrome and `https://moodle.sdu.edu.kz`, read-only access through the student's existing authorized session, local-first data and no product account, as specified in the [product scope](../plan.md). No live inspection occurred. No screenshots, credentials, session tokens, private grades or names were collected. No Moodle data was changed or submitted. No Moodle version, theme, selector, route shape or supported page variant is established by this report. Repository examples and synthetic/demo data are not live evidence.

The browser URL-confidence policy stopped Chrome inspection twice, as recorded in the PM review. No authorized SDU student session or permitted representative page evidence has been supplied. Do not retry or bypass that policy, transfer credentials, or use an alternative network path to circumvent it.

## Status and evidence rules

**UNVERIFIED** means there is no inspected evidence for a field or behavior. **Observed** requires permitted, sanitized evidence tied to a source, inspection date and language. **Unavailable** requires inspected evidence of absence on a particular variant; missing access does not establish absence. Every live field and variant below is UNVERIFIED. The variant names are inspection targets, not claims that these variants exist at SDU.

## Page and field inspection matrix

Each listed field and awkward case inherits the row's UNVERIFIED status independently; none has supporting live evidence.

| Page / candidate variants to inspect | Required fields and awkward cases to verify | Live status | Inspection date | Language | Evidence |
| --- | --- | --- | --- | --- | --- |
| Course list: initial, filtered, paginated or dynamically loaded list | Stable course identifier, course code/name, course link, current-course indicators versus student selection, complete enrolled-course coverage | UNVERIFIED | not inspected | unknown | none |
| Assignment: ordinary, individual override, draft, reopened | Stable course/activity/module identifiers and their distinctions; title, source link, opening time, due date versus cutoff date; individual effective dates and override provenance; submitted/draft/not_submitted/reopened/unknown status and status evidence | UNVERIFIED | not inspected | unknown | none |
| Quiz: ordinary, individual override, attempt-state variants | Stable identifiers, title/link, opening and closing dates and their meanings, individual effective dates, allowed/used/remaining attempts and attempt state | UNVERIFIED | not inspected | unknown | none |
| Calendar: event list/detail and alternative ranges | Event identity, course/activity association, title/type, event/source link, date semantics, precision, timezone, duplicate-event relationships and coverage across ranges | UNVERIFIED | not inspected | unknown | none |
| Material: file, external link, video or restricted resource | Stable resource/course/module identifiers, section, title, file type, target link, accessibility, freshness evidence; redirect targets and syllabus-candidate evidence | UNVERIFIED | not inspected | unknown | none |
| Folder: parent listing, nested folder, child file/link | Stable folder/child identifiers, parent-child relationships, section/title, child links/types, nested coverage and accessibility | UNVERIFIED | not inspected | unknown | none |

For every date-bearing row, displayed date text, exact versus date-only precision, explicit offset/timezone, missing or ambiguous dates and locale interpretation are individually UNVERIFIED. Do not infer midnight, timezone, an individual override, or a deadline's meaning from presentation alone. Preserve distinct due/cutoff/open/close semantics in future evidence; a single generic date cannot prove them all.

## Current wire capacity versus future collection

The [#5 data-model inventory](../architecture/data-model.md) records current wire fields and their constraints. Its authorities are [OpenAPI](../../openapi.yaml), [Zod](../../frontend/src/domain/types.ts) and [Python](../../backend/schemas.py). The mappings here describe representational capacity only: they do not show that a collector obtains any value from SDU.

| Concern | Present wire fields | Gap / owning follow-up |
| --- | --- | --- |
| Courses and identity | `Course.id`, `code`, `name`, `color`, `current`; `Settings.trackedCourseIds`; `Assessment.id`, optional `activityId`, `courseId`, `title`, `type` | Stable source-ID discovery is unverified. `activityId` is provenance, not globally unique; do not conflate activity and course-module IDs. Future namespace/source-key helpers described in #5 do not discover identifiers. [#11](https://github.com/Ramung55/MoodleHelper/issues/11) / [#12](https://github.com/Ramung55/MoodleHelper/issues/12) own collection/selection. |
| Dates and provenance | `Assessment.availableFrom` (optional string), `sources` (nonempty `SourceEvidence[]`), `firstObservedAt`, `lastObservedAt`; `SourceEvidence.source`, `date`, `observedAt`, optional `excerpt`, `location`, `url` | `DateValue` branches: exact (`iso`, `tz`), date (`date`), week (`week`), unknown (optional `note`). No dedicated due-versus-cutoff fields or structured individual-override provenance/effective-date model. [#13](https://github.com/Ramung55/MoodleHelper/issues/13) owns separate cutoff extension; [#14](https://github.com/Ramung55/MoodleHelper/issues/14) owns quiz date/attempt extensions; [#15](https://github.com/Ramung55/MoodleHelper/issues/15) owns calendar mapping. |
| Submission versus personal completion | Optional `Assessment.submission`: `status` = submitted/draft/not_submitted/reopened/unknown, `observedAt`, optional `evidence`; `Overlay.completed` is separate | Enum capacity does not prove SDU labels or transitions. No quiz attempt count/state details. [#16](https://github.com/Ramung55/MoodleHelper/issues/16) owns assignment status; #14 owns quiz details. Moodle individual overrides are not personal `Overlay.dateOverride`/`overrideBase`. |
| Materials and folders | `Material.id`, `courseId`, `section`, `title`, `fileType` = pdf/docx/pptx/link/video/other, `url`, `accessible`, `stale`, `lastCheckedAt`, `syllabusSuggestion`, optional `downloadedAt` | No folder parent/child relationship fields; `section` does not encode a folder tree. [#17](https://github.com/Ramung55/MoodleHelper/issues/17) owns resource collection and folder schema extension. `downloadedAt` is a local observation, not evidence of source accessibility. |
| Coverage and failures | `CourseSyncState.courseId`, `status`, `coverage`, `progress`, optional `lastSuccessAt`, `error` | A summary is not a durable collection job or proof of full coverage. [#10](https://github.com/Ramung55/MoodleHelper/issues/10) owns session availability; [#19](https://github.com/Ramung55/MoodleHelper/issues/19) / [#21](https://github.com/Ramung55/MoodleHelper/issues/21) own jobs/progress. |

Wire timestamp/timezone/URL strings remain permissive, and date strings validate shape only. The opt-in ingestion helpers in #5 impose additional semantic checks; they are not installed in HTTP/storage/restore and do not fetch or inspect pages. Unknown keys may be stripped/ignored, so future collectors must report unsupported facts explicitly. Each owning feature must agree additive Zod/OpenAPI/Python changes before claiming support for schema gaps. Cross-source reconciliation remains [#33](https://github.com/Ramung55/MoodleHelper/issues/33).

## Navigation and access requirements — all UNVERIFIED

| Risk to inspect | Required future handling / owner | Evidence status |
| --- | --- | --- |
| Pagination, filters, lazy loading and incomplete course/resource listings | Establish completion criteria without claiming missing items are absent; #11/#17 | UNVERIFIED |
| Dynamic navigation, rerenders, expanded sections and calendar range changes | Establish page readiness, stable identity and duplicate-safe collection; #11/#13–#17 | UNVERIFIED |
| Permission failures, hidden/restricted activities, broken links and inaccessible folders | Distinguish access failure from empty content; preserve partial coverage and useful errors; #13–#17 | UNVERIFIED |
| Login redirects, expired sessions, interstitials and redirects to another origin | Detect session/access boundary and stop collection appropriately without credentials transfer; #10 | UNVERIFIED |

These are requirements for later authorized inspection and implementation, not tested behaviors, working selectors or verified SDU failure modes.

## Access needed and acceptance-criteria handoff

Resume live inspection only with the student's authorized existing Chrome session, explicit read-only permission for representative SDU course/activity/calendar/material/folder pages and a browser path allowed by tool policy. Alternatively, explicitly permitted sanitized captures may establish visible page fields if each is labeled with source type, language and actual inspection date. Captures cannot establish unobserved live navigation, pagination or redirect behavior. Never request credential transfer. Collect only the minimum sanitized evidence; redact private names, grades and tokens before retaining supporting artifacts.

The future evidence record must identify each actually inspected variant and field, source type (live page or supplied capture), language, inspection date, sanitized evidence reference and observed/unavailable/unverified outcome. Representative due/cutoff, individual override, draft/reopened and quiz-attempt cases remain outstanding. [#4](https://github.com/Ramung55/MoodleHelper/issues/4) owns sanitized fixtures; this document creates none.

Acceptance criteria 1 and 2 remain incomplete: there are no inspected variants or observed/unavailable fields with sanitized evidence. Criterion 3 has a requirements inventory but no verified navigation findings. Criterion 4's no-session reporting path is documented, and criterion 5's privacy/read-only boundary is recorded with no inspection performed. This partial artifact is not an overall compatibility PASS. Keep #3 open until independent QA verifies the remaining authorized evidence against all five original criteria.
