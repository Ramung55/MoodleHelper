# Moodle fixtures

All fixtures are offline, inert inputs. They contain no captured student or course information, private document bodies, real names, grades, file names or session values. Every identifier, title and date is fictional. There are two kinds, and the manifest labels each entry with `sourceKind`:

- **`observed-structure`** (`observed/`): the markup structure is taken from the live SDU inspection in [issue #3](https://github.com/Ramung55/MoodleHelper/issues/3), recorded in the [SDU Moodle compatibility matrix](../../../_docs/compatibility/sdu-moodle.md) (inspected 2026-11-01, English, theme `alpha`). The selectors, classes, data attributes and label wording follow the matrix. All content is invented. These files are not captures.
- **`synthetic`** (top level): invented edge-case inputs with fixture-specific `data-fact` markers. They are not SDU markup, and their English and Russian text claims no SDU locale support.

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
| Login redirect: course page (final path `/login/index.php`, HTTP 200) | observed-login-redirect-course |
| Login redirect: file download (final path `/login/index.php`, HTTP 200, `text/html`) | observed-login-redirect-resource |

The rows #3 marks UNVERIFIED or unavailable are listed in `observedCoverage.unverifiedVariants` as `synthetic-only`. These are: draft and reopened submissions, cut-off/extension/individual override, quiz in-progress or multiple attempts, other calendar views and event types, video and restricted resources, folders with files or subfolders, restricted activities, RU/KK interfaces, calendar and resource pagination, restricted folders and session expiry. Where a synthetic fixture exercises one of them, the manifest names it. That fixture claims no SDU support.

## How observed-structure fixtures differ from the live pages

- Links keep their target only as a relative path in a `data-href` attribute on an `<a>` without `href`, so nothing can navigate. Collectors that match `a[href*=...]` on live pages should treat `data-href` as the fixture stand-in.
- `<img class="icon">` has no `src`. The live resource icon path (`/theme/image.php/alpha/core/<rev>/f/pdf`) is noted in the manifest only.
- The folder page's `/course/jumpto.php` navigation form is omitted, because forms are rejected.
- Mark, grade and file-submission values are replaced by `[not retained]`. Course shortnames keep the `<code>-<n>-<login>-<year>-<term>` shape, with the instructor-login segment replaced by `redacted`, and fullnames have no instructor name.
- HTTP-level facts (redirects, status codes, content types) are JSON response records, not HTML. #3 did not record the content type of the unauthenticated course-page request, so that record keeps it as `null`.
- Values #3 did not record are listed under `unrecordedFields`, never invented as if observed. One example is `nextoffset` for an empty grouping. The AJAX request `limit` of 24 is invented and labelled as such.

## Manifest

Each entry names its ID, path, source variant, page class, language, purpose, provenance and edge cases. Observed-structure entries also carry `inspectionDate` 2026-11-01 and theme `alpha`. Their `expected` block has:

- `fields`: the visible raw facts.
- `checks`: CSS selectors (HTML) or JSON paths (records) that tie each field to the fixture's visible markup.
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
- Inert markup, through an allowlist for each kind.
- Safe invented URLs and personal-data patterns (grade values, session keys and cookies, real host, e-mail, instructor-login shortnames).
- Negative controls for scripts, handlers, `href`/`src`, styles, forms, frames, comments and unsafe paths or URLs.

These are hygiene checks. They are not product parsers, and they do not prove that a future real capture is sanitized.
