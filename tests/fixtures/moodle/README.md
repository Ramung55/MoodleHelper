# Moodle fixtures

All fixtures are offline, inert inputs. They contain no captured student or course information, private document bodies, real names, grades, file names or session values. Every identifier, title and date is fictional. There are three kinds, and the manifest labels each entry with `sourceKind`:

- **`observed-structure`** (`observed/`): the markup structure is taken from the live SDU inspection in [issue #3](https://github.com/Ramung55/MoodleHelper/issues/3), recorded in the [SDU Moodle compatibility matrix](../../../_docs/compatibility/sdu-moodle.md) (inspected 2026-11-01, English, theme `alpha`). The selectors, classes, data attributes and label wording that #3 recorded follow the matrix. Some surrounding markup and wording that #3 did not record is filled in from Moodle defaults so the pages are complete. Each such detail is listed in the manifest's `unrecordedFields`, and any check that asserts it is marked `basis: assumed` (see below). All content is invented. These files are not captures.
- **`upstream-string`** (`upstream/`): assignment pages for submission states that SDU did not show (draft and reopened), labelled `"label": "upstream, not seen on SDU"`. Each is a copy of `observed/assign-submitted.html` with only the submission status cell class and text replaced by a cited upstream Moodle string, by the #16 owner decision of 2026-11-02. The entry's `citation` names repository `moodle/moodle`, branch `MOODLE_405_STABLE`, commit `c0690bbc765fccacd4956452cbff3f6aacad77c5`, the files `mod/assign/lang/en/assign.php` (string) and `mod/assign/classes/output/renderer.php` (cell class `'submissionstatus' . <status>`), the `stringKey` (`submissionstatus_draft` "Draft (not submitted)", `submissionstatus_reopened` "Reopened"), the `cellClass` and `citedDate` 2026-11-02. On `main` (commit `0580991669815767026aea115a2053e2040378af`) the strings are in `public/mod/assign/lang/en/assign.php`. These fixtures are not observed SDU markup and make no SDU support claim: draft and reopened stay Unavailable / UNVERIFIED in the compatibility matrix. Their `expected` block holds the `statusCell` selector and text and the `derived` state, evidence basis `upstream-not-seen-on-sdu` and `actionRequired`.
- **`synthetic`** (top level): invented edge-case inputs with fixture-specific `data-fact` markers. They are not SDU markup, and their English and Russian text claims no SDU locale support.
  - `my-courses-shell.html` (#82) stands in for the `/my/courses.php` page shell, which #3 did not record. It holds only the obviously invented session value `"sesskey":"0InventedFixtureKey0"` for the course discovery run's in-memory read. M.cfg sesskey placement assumed from Moodle defaults; not recorded by #3. The owner's Chrome check (#82 step 2) confirms the live placement. This is the only session value any fixture may contain.

## Observed coverage

`observedCoverage=covered`, compared against #3's matrix. Every row the matrix marks Observed has at least one observed-structure fixture:

| #3 matrix row | Fixture IDs |
| --- | --- |
| Course list: `/my/courses.php` card list (`div.rui-course-card[data-region="course-content"][data-course-id]`, `.multiline`); pagination regions | observed-course-list |
| Course list: enrolled-courses AJAX `inprogress` / `all`, including the `nextoffset` quirk; dynamic navigation; pagination | observed-enrolled-courses-inprogress |
| Course list: `past` / `future` groupings, observed empty | observed-enrolled-courses-past-empty |
| Course page: `format-topics`, `li.activity.modtype_*#module-<cmid>`, `[data-region="activity-dates"]`, assign/quiz/resource/url/page/forum cards | observed-course-page |
| Assignment: submitted for grading, not graded (`td.submissionstatussubmitted`, `td.submissionnotgraded`, `td.earlysubmission`) | observed-assign-submitted |
| Assignment: not submitted, time remaining (no status class, `td.timeremaining`) | observed-assign-not-submitted |
| Quiz: finished attempt, no attempts left (`.quizinfo`, `div.rui-attempts-list`, `.rui-infobox`, `.box.quizattempt`) | observed-quiz-finished |
| Calendar: upcoming view, assignment due events (`div.calendar-event-box[data-type="event"]`, `data-event-*`) | observed-calendar-upcoming |
| Material: file resource (PDF) via the `mod/resource` redirect; `.activitybadge` PDF/PPTX | observed-resource-redirect, observed-course-page |
| Material: URL and page modules in the activity list | observed-course-page |
| Folder: empty folder on a separate page (`li.activity.modtype_folder.folder`, `body#page-mod-folder-view`, `.foldertree` / `.filemanager`) | observed-folder-empty, observed-course-page-guest-folder |
| Permission failure: not enrolled (HTTP 200, page rendered) | observed-course-page-guest-folder |
| Permission failure: non-existent id (HTTP 404, `body#page-site-index`, "Can't find data record in database") | observed-not-found |
| Login redirect: course page (final path `/login/index.php`, HTTP 200) | observed-login-redirect-course, observed-login-page |
| Login redirect: file download (final path `/login/index.php`, HTTP 200, `text/html`) | observed-login-redirect-resource |

The rows #3 marks UNVERIFIED or unavailable are listed in `observedCoverage.unverifiedVariants` as `synthetic-only`. These are: draft and reopened submissions, cut-off/extension/individual override, quiz in-progress or multiple attempts, other calendar views and event types, video and restricted resources, folders with files or subfolders, restricted activities, RU/KK interfaces, calendar and resource pagination, restricted folders and session expiry. Where a synthetic fixture exercises one of them, the manifest names it. That fixture claims no SDU support. The draft and reopened rows also name their `upstreamFixtures` (`upstream-assign-draft`, `upstream-assign-reopened`) with `seenOnSdu: false` and a note that says "upstream, not seen on SDU"; their coverage stays `synthetic-only` because SDU never showed them.

## How observed-structure fixtures differ from the live pages

- Links keep their target only as a relative path in a `data-href` attribute on an `<a>` without `href`, so nothing can navigate. Collectors that match `a[href*=...]` on live pages should treat `data-href` as the fixture stand-in.
- `<img class="icon">` has no `src`. The live resource icon path (`/theme/image.php/alpha/core/<rev>/f/pdf`) is noted in the manifest only.
- The folder page's `/course/jumpto.php` navigation form is omitted, because forms are rejected.
- Mark, grade and file-submission values are replaced by `[not retained]`. Course shortnames keep the `<code>-<n>-<login>-<year>-<term>` shape, with the instructor-login segment replaced by `redacted`, and fullnames have no instructor name.
- HTTP-level facts (redirects, status codes, content types) are JSON response records, not HTML. #3 did not record the content type of the unauthenticated course-page request, so that record keeps it as `null`.
- The folder tree places `span.fp-filename` as a sibling of `span.fp-icon`, both inside `div.fp-filename-icon`. This is observed. The #3 one-line chain `span.fp-icon > img.icon + span.fp-filename` was a transcription error, corrected in the 2026-11-01 inspection notes ("folder tree nesting"). The manifest cites that correction on the check.
- The following details were not recorded by #3. They are assumed Moodle defaults, kept in the markup but labelled as assumed:
  - the `.accesshide` type labels "Assignment", "Quiz", "Forum" and "Page" on the course page (#3 recorded only "File", "URL" and "Folder");
  - the wording of the quiz password notice (#3 recorded only that a notice exists);
  - the `h3` "Submission status" heading and the `div.submissionstatustable > table.generaltable` wrapping on assignment pages, and the not-submitted page's "-" and "Comments (0)" cell text (#3 recorded only the th-to-td rows);
  - `paging-bar` nested inside `paging-control-container`, the `nav`/`ul.pagination`/`li.page-item`/`a.page-link` markup and `a.coursename` on the course list (#3 recorded only that both regions exist and the course link pattern);
  - the calendar event date text format, such as "Tuesday, 7 March, 2:30 PM", and its `div` wrapper (#3 recorded only the displayed time);
  - the `p` element around the 404 message (the text itself is observed, see below);
  - the AJAX `[{error, data}]` envelope, the request `limit` of 24 and the omitted `nextoffset` for an empty grouping.
- Addendum 2 of the 2026-11-01 inspection notes recorded two more facts, which are observed:
  - The 404 text for a non-existent module is "Can't find data record in database." (for a non-existent course it is "Can't find data record in database table course."). The fixture uses the module variant. The text is checked against the page body, because the notes did not record its element.
  - The quiz attempt Started and Completed values use the format "<Weekday>, <d> <Month> <yyyy>, <h:mm> <AM|PM>", and Duration uses "<n> mins <n> secs". Only the formats were recorded, so the observed check matches these shapes (`matches`) rather than the invented values.
- Values #3 did not record are either left out, kept as `null`, or filled with an assumed value. Every one is listed under `unrecordedFields`, and an assumed value never backs an expected field.

## Manifest

Each entry names its ID, path, source variant, page class, language, purpose, provenance and edge cases. Observed-structure entries also carry `inspectionDate` 2026-11-01 and theme `alpha`. Their `expected` block has:

- `fields`: the visible raw facts, all listed again in `observedFields`.
- `checks`: CSS selectors (HTML) or JSON paths (records) that tie each field to the fixture's visible markup. Each check has `basis: observed` (recorded by #3 or the inspection notes) or `basis: assumed`, and names the detail it covers in `asserts`. An assumed check's `asserts` is one of its `unrecordedFields` entries; an observed check's `asserts` must not be one, and is exactly its own target and check kinds (for example `request/path: equals`), so it cannot be a free-text detail. Only observed checks can back a field. Besides `count`, `attr`/`values` and `text`, an HTML check can use `contains` (exact node texts present), `includes` (substrings of the selected region's text) and `matches` (one full-match pattern per node, for formats whose values are invented).
- `derived`: the expected interpretation, for example `submission_status`, the exact instant in UTC+5, attempt counts and `moreAvailable`.
- `absentFields`, `redactedFields`, `unrecordedFields` and `schemaGapOwners`.

Synthetic entries keep `expected.rawFacts`, which map each field to visible text in its `data-fact` element, plus `absentFields`, `unknownFields` and duplicate relationships.

Expectations are raw source facts. They are not Snapshot wire objects or the output of working collectors. The [#5 inventory](../../../_docs/architecture/data-model.md) defines `DateValue` exact/date/week/unknown, submission submitted/draft/not_submitted/reopened/unknown and material pdf/docx/pptx/link/video/other. The following facts stay explicit schema gaps rather than claimed wire support:

- cut-off and individual overrides ([#13](https://github.com/Ramung55/MoodleHelper/issues/13));
- quiz attempts and state ([#14](https://github.com/Ramung55/MoodleHelper/issues/14));
- folder relationships ([#17](https://github.com/Ramung55/MoodleHelper/issues/17)).

Course-module and activity ids are distinct concepts, and personal completion is never inferred. Parsing belongs to #10–#17.

## Checks

Run `uv run pytest tests/test_moodle_fixtures.py`. The checks cover the following:

- Manifest discovery and safe paths.
- That every Observed row in the #3 matrix maps to an observed-structure fixture, and every other row to `synthetic-only`.
- Selector and JSON-path facts.
- Observed/assumed labelling, generic for every observed-structure entry: every check has a basis and an `asserts` detail, an assumed check asserts a listed `unrecordedFields` entry, an observed check never asserts one, and every field is in `observedFields` and is backed by an observed check. Relabelling any assumed check as observed therefore fails. The details QA found unrecorded also stay listed.
- Inert markup, through an allowlist for each kind. Upstream-string fixtures reuse the observed-structure allowlist.
- Upstream-string label and citation: the exact label, repository, branch, commit, both file paths, string key, string, cell class and cited date, and that the file equals `observed/assign-submitted.html` with only the status cell changed. Negative tests show that removing the label or any part of the citation fails.
- Safe invented URLs and personal-data patterns (grade values, session keys and cookies, real host, e-mail, instructor-login shortnames).
- Negative controls for scripts, handlers, `href`/`src`, styles, forms, frames, comments and unsafe paths or URLs.

These are hygiene checks. They are not product parsers, and they do not prove that a future real capture is sanitized.
