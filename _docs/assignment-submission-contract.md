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
