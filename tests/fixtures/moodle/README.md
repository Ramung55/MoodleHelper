# Synthetic Moodle fixture baseline

All inputs are invented, offline, inert HTML. They contain no captured student or course information, private document bodies, names or grades. Identifiers and generic titles are fictional. The reserved `.invalid` URLs are inert text, never navigation links. English and Russian are synthetic input languages, not observed SDU locale support. There are no inspected Moodle versions, themes or selectors here.

`observedCoverage=pending #3`: [issue #3](https://github.com/Ramung55/MoodleHelper/issues/3) and the [UNVERIFIED compatibility report](../../../_docs/compatibility/sdu-moodle.md) have no observed supported variants. Issue #4 AC1 remains blocked; this baseline cannot establish live coverage or an overall PASS.

| Requirement | Fixture IDs |
| --- | --- |
| Course list; duplicate identity | courses |
| Assignment; exact date, explicit timezone, base due/cutoff versus individual effective override; draft | assignment |
| Absent dates; reopened | reopened |
| Ambiguous/unknown date and unknown status; Russian | unknown |
| Quiz; date-only, attempts/state | quiz |
| Calendar; date-only; Russian | calendar |
| Material link | resource |
| Nested folder and child file | folder |
| Inert login redirect representation | login |
| Denied access; Russian | denied |
| Malformed/truncated and incomplete markup | incomplete |

Each manifest entry names a source variant, class, language, purpose and synthetic provenance. `expected.rawFacts` maps a field to visible text in its `data-fact` element; these fixture-specific markers are not Moodle selectors. `absentFields` identifies omitted source facts, and `unknownFields` distinguishes unknown semantics from absence. Duplicate relationships identify equal source identities, not an expected deduplication algorithm. Malformed input is deliberately unclosed after its last complete fact; its marker records the expected input condition, not product recovery behavior.

Expectations are raw source facts, not current Snapshot objects, verified SDU facts or results of working collectors. Date-only values have no invented midnight/timezone. Exact values retain their explicit offset and timezone text. Base due/cutoff and individual effective override facts remain separate; personal completion is never inferred. Course-module and activity identifiers are distinct even when associated with one item.

The [#5 inventory](../../../_docs/architecture/data-model.md) defines `DateValue` exact/date/week/unknown, submission submitted/draft/not_submitted/reopened/unknown and material pdf/docx/pptx/link/video/other. Raw cutoff/individual-override semantics require agreed schema design under [#13](https://github.com/Ramung55/MoodleHelper/issues/13); quiz attempts/state require [#14](https://github.com/Ramung55/MoodleHelper/issues/14); folder relationships require [#17](https://github.com/Ramung55/MoodleHelper/issues/17). These facts are deliberately retained in expectations rather than discarded or claimed as wire support. Parsing belongs to #10–#17.

Run `uv run pytest tests/test_moodle_fixtures.py`. The checks enforce complete manifest discovery, safe paths, required cases, visible fact consistency, inert markup and safe invented URLs, with negative controls for active content and unsafe paths/URLs. They are fixture hygiene checks, not product parsers or proof that a future real capture is sanitized. All HTML and metadata were authored as fictional input; no browser or live connection was used. No scripts, styles, remote assets, forms, event handlers, frames or automatic navigation are retained.
