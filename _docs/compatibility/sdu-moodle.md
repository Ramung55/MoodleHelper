# SDU Moodle compatibility matrix

Live inspection date: **2026-11-01**. Interface language: **English** (`<html lang="en">`, body class `lang-en`). Theme: `alpha` (RaiseUI, `rui-*` classes), dark variant. Report updated: 2026-11-01.

This is the compatibility report for [#3](https://github.com/Ramung55/MoodleHelper/issues/3). It replaces the earlier no-session UNVERIFIED artifact (2026-10-26). Scope is Chrome and `https://moodle.sdu.edu.kz`, with read-only access through the student's own session, local-first data and no product account, as the [product scope](../plan.md) specifies.

## Source and privacy record

- **Source type:** one authorized, read-only live inspection of SDU Moodle on 2026-11-01. The student signed in themselves in the Claude built-in browser. Claude never typed credentials.
- **Read-only:** no submit, upload, enrol, settings or other state-changing action was taken. The "Add submission" action link was recorded but never clicked. Same-origin course page fetches were spaced 1.2 s apart.
- **Not recorded:** cookies, `sesskey` values, session tokens, grades, marks, instructor or student names, file names and document bodies.
- **Identifier choice:** numeric course and course-module (cmid) ids are generalised to `N` / `<cmid>` throughout. Raw ids from one account's enrolment and submission state could help identify that student. The exceptions are ids `2` and `1`, which were used only as non-existent ids for the error-page probe. The course shortname is described only by its pattern, because it embeds an instructor login.
- **Folder addendum:** in the same session on 2026-11-01, extra read-only same-origin GETs (1.2 s apart) were made to course pages of not-enrolled, guest-viewable courses and to one folder module page, because no enrolled course has a folder. These courses are not the student's own. Only page structure was read; no content, names or files were kept.
- **Single-account scope:** the evidence comes from one student account with 8 in-progress courses. "Unavailable" below means "not present in this account on 2026-11-01". It does not mean that SDU Moodle cannot produce the case.

Status vocabulary: **Observed** means seen live, with sanitized evidence below. **Unavailable** means the page was inspected and the field or state was absent in this account. **UNVERIFIED** means the page or variant was not inspected, so nothing is known about it.

## Inspected pages and endpoints

All rows were inspected on 2026-11-01 with the English interface.

| # | URL (ids generalised) | Method | What was read |
| --- | --- | --- | --- |
| 1 | `/login/index.php` | GET (navigation) | Login form only; the student signed in |
| 2 | `/my/courses.php` | GET | Course card DOM, paging controls |
| 3 | `/lib/ajax/service.php?info=core_course_get_enrolled_courses_by_timeline_classification` | POST (the page's own call, plus 4 read-only calls: inprogress/past/future/all) | Response shape |
| 4 | `/course/view.php?id=N` (8 enrolled courses via same-origin fetch, 1.2 s apart) | GET | Activity list DOM, modtypes, dates |
| 5 | `/mod/assign/view.php?id=<cmid>` (submitted) | GET | Dates, submission status table |
| 6 | `/mod/assign/view.php?id=<cmid>` (not submitted) | GET | Dates, submission status table |
| 7 | `/mod/quiz/view.php?id=<cmid>` (finished) | GET | Dates, quiz info, attempts block |
| 8 | `/calendar/view.php?view=upcoming` | GET | Event DOM attributes |
| 9 | `/mod/resource/view.php?id=<cmid>` | HEAD, and GET with credentials omitted | Redirect target and content type only (no body kept) |
| 10 | `/course/view.php?id=N` with credentials omitted | GET | Login redirect behaviour |
| 11 | `/course/view.php?id=2`, `/mod/assign/view.php?id=1` | GET | Error page for non-existent ids |
| 12 | `/course/view.php?id=N` for 2 courses the student is not enrolled in | GET | Access behaviour only (no content kept) |
| 13 | `/course/view.php?id=N` for 11 not-enrolled, guest-viewable courses (same-origin, 1.2 s apart; not the student's own courses) | GET | Structure only: searched for `li.activity.modtype_folder` (all HTTP 200; no content kept) |
| 14 | `/mod/folder/view.php?id=<cmid>` for one folder in a not-enrolled course (not the student's own course) | GET | Structure only: page id, language, folder-tree markup (no names or files kept) |
| 15 | `/lib/ajax/service.php?info=core_course_get_enrolled_courses_by_timeline_classification` (classification `all`), then `/course/view.php?id=N` for the 8 enrolled courses (same-origin, 1.2 s apart) | POST, GET | Addendum 5: course count and `li.activity.modtype_assign` cmids only |
| 16 | `/mod/assign/view.php?id=<cmid>` for all 19 assignments in the enrolled courses (same-origin, 1.2 s apart) | GET | Addendum 5: `.submissionstatustable` rows "Submission status", "Grading status", "Time remaining" (cell classes and text with digits replaced by `N`), row headers, activity-date labels. No grades, comments, file names or ids kept |
| 17 | `/my/` with credentials omitted; `/lib/ajax/service.php?info=core_session_time_remaining` with and without credentials | GET, POST | Addendum 5: signed-in versus signed-out signals (response keys and error code only; the user id value was not recorded) |
| 18 | 2026-11-02: `core_course_get_enrolled_courses_by_timeline_classification` (`inprogress`), then `/course/view.php?id=N` for the 8 enrolled courses (same-origin, 1 s apart) | POST, GET | Addendum 6: course count, body id/classes, `li.activity` modtypes and cmids only |
| 19 | 2026-11-02: `/mod/quiz/view.php?id=<cmid>` for all 3 quizzes in the enrolled courses (1 s apart) | GET | Addendum 6: body id/classes, attempts-block element chain, `.rui-infobox` titles, activity-date and quiz-info labels with digits replaced. No marks, grades or durations kept |
| 20 | 2026-11-02: `/mod/assign/view.php?id=<cmid>` for all 19 assignments (1.2 s apart) | GET | Addendum 6: `.submissionstatustable` row headers and status-cell classes/text with digits replaced |
| 21 | 2026-11-02: `/mod/resource/view.php?id=<cmid>` for the 14 resources in one course (HEAD, 1.2 s apart); one GET of a resource with and without credentials | HEAD, GET | Addendum 6: final route, status, content type, disposition type and the first 5 bytes of one file (its magic number). No file names or bodies kept |

The pages also made these requests themselves; Claude did not call them: `core_calendar_get_action_events_by_timesort`, `core_get_user_dates`, `block_recentlyaccesseditems_get_recent_items`, `media_videojs_get_language`.

**Time zone:** times are displayed in the user's Moodle time zone. The calendar day link epoch `1793698200` is 2026-11-03 09:30 UTC, and the page displayed it as "2:30 PM". The time zone is therefore UTC+5 (Asia/Almaty). Displayed date strings carry no offset, so collectors must apply UTC+5 or use the epoch values from endpoints and links.

## Page variant matrix

| Page family | Variant | Status | Date | Language | Evidence row |
| --- | --- | --- | --- | --- | --- |
| Course list | `/my/courses.php` card list, grouping "All" | Observed | 2026-11-01 | English | 2 |
| Course list | Enrolled-courses AJAX, `inprogress` / `all` | Observed (8 courses) | 2026-11-01 | English | 3 |
| Course list | `past` / `future` groupings | Observed empty (0 courses); populated shape UNVERIFIED | 2026-11-01 | English | 3 |
| Course page | `format-topics` course with activity list | Observed | 2026-11-01 | English | 4 |
| Assignment | Submitted for grading, not graded | Observed | 2026-11-01 | English | 5 |
| Assignment | Not submitted, time remaining | Observed | 2026-11-01 | English | 6 |
| Assignment | Draft submission | Unavailable in this account → UNVERIFIED | 2026-11-01 | English | 5, 6 |
| Assignment | Reopened submission | Unavailable in this account → UNVERIFIED | 2026-11-01 | English | 5, 6 |
| Assignment | Cut-off date, extension, individual override | Unavailable on sampled assignments → UNVERIFIED | 2026-11-01 | English | 5, 6 |
| Quiz | Finished attempt, no attempts remaining | Observed | 2026-11-01 | English | 7 |
| Quiz | Open / in-progress attempt, multiple attempts, individual override | UNVERIFIED (not inspected) | — | — | — |
| Calendar | Upcoming view, assignment due events | Observed (2 events) | 2026-11-01 | English | 8 |
| Calendar | Day/month views, other event types (quiz, course, user) | UNVERIFIED (day link observed only as a URL) | — | — | 8 |
| Material | File resource (PDF) via `mod/resource` redirect | Observed | 2026-11-01 | English | 4, 9 |
| Material | URL and page modules | Observed in activity list only; targets not inspected | 2026-11-01 | English | 4 |
| Material | Video, restricted resource | UNVERIFIED | — | — | — |
| Folder | Empty folder, separate-page display (`mod/folder` card on the course page and the folder page), not-enrolled guest-viewable course | Observed | 2026-11-01 | English | 13, 14 |
| Folder | Folder with files, nested subfolders, inline display on the course page, "Download folder" button | UNVERIFIED (not observed; no folder in any of the 8 enrolled courses, and the inspected folder was empty) | — | — | — |
| Restricted activity | `.availabilityinfo` present | Unavailable: none observed → UNVERIFIED | 2026-11-01 | English | 4 |
| Any page | Russian (RU) or Kazakh (KK) interface | UNVERIFIED (not inspected) | — | — | — |

## Field matrix

### Course list

| Field | Status | Sanitized evidence |
| --- | --- | --- |
| Course card | Observed | `div.rui-course-card[data-region="course-content"][data-course-id]` |
| Course id | Observed | `data-course-id` on the card; `courses[].id` in AJAX |
| Course link | Observed | `a[href*="/course/view.php?id="]`; `courses[].viewurl` |
| Course name | Observed | `.multiline` (also duplicated in `sr-only` strings); `courses[].fullname`. **The fullname embeds the instructor name in parentheses. It is personal data and must be stripped before storage or fixtures.** |
| Course code | Observed | `courses[].shortname`, pattern `<code>-<n>-<instructor login>-<year>-<term>`. The code is the leading segment. The login segment is personal and must be dropped. |
| `idnumber` | Observed, mostly empty | `courses[].idnumber`; not usable as a stable key |
| Term / category | Observed | `courses[].coursecategory`, e.g. "Fall 2026 (2026-2027)" |
| Start / end date | Observed | `courses[].startdate` / `enddate` (epoch seconds) |
| Visibility, favourite, progress | Observed | `visible`, `hidden`, `isfavourite`, `progress` / `hasprogress` |
| Current-course indicator | Observed via classification | `classification=inprogress` (8) vs `past` (0) / `future` (0) |
| Enrolment | Observed, endpoint only | Only the enrolled-courses endpoint establishes enrolment (see Permission failures) |

### Course page and activities

| Field | Status | Sanitized evidence |
| --- | --- | --- |
| Page / course id | Observed (2026-11-01, Addendum 3) | `body#page-course-view-topics`; body classes include `format-topics`, `path-course-view`, `pagelayout-course`, `course-<courseid>`, `context-<n>`. There is no `cmid-` class on the course page. |
| Activity node / cmid | Observed | `li.activity.modtype_<mod>#module-<cmid>` |
| Activity link | Observed | `a[href*="/mod/<mod>/view.php?id=<cmid>"]` |
| Activity name | Observed | `.instancename`; type label in nested `.accesshide` (e.g. "File", "URL"), which must be removed from the name |
| Module type | Observed | Seen across 8 enrolled courses: `assign`, `quiz`, `forum`, `url`, `resource`, `page`. No `folder` in enrolled courses; `folder` was observed only in a not-enrolled, guest-viewable course (rows 13, 14). |
| Section | Observed | `li.section` / `data-sectionid`; 17 section nodes on the sample course (`format-topics`) |
| Inline dates | Observed | `[data-region="activity-dates"]` children: "Opened: <weekday>, <d> <Month> <yyyy>, <h:mm AM/PM>", "Due: …", "Closed: …". The shown weekday can disagree with its own date (observed quirk, 2026-11-01, Addendum 4; see the note under Quiz). |
| Resource file type | Observed | `.activitybadge` / details text "PDF", "PPTX"; icon path `/theme/image.php/alpha/core/<rev>/f/pdf` |
| Restriction info | Unavailable | No `.availabilityinfo` in any enrolled course |

### Assignment (`/mod/assign/view.php?id=<cmid>`)

| Field | Status | Sanitized evidence |
| --- | --- | --- |
| Page / ids | Observed | `body#page-mod-assign-view`, body classes `cmid-<cmid>`, `course-<courseid>` |
| Opening date | Observed | "Opened: …" |
| Due date | Observed | "Due: …" (in the activity dates region and on the course page); calendar `data-event-eventtype="due"` |
| Cut-off date | Unavailable | No cut-off date on the sampled assignments |
| Extension | Unavailable | None observed |
| Individual override | Unavailable | None observed; no DOM marker is known |
| Status: submitted | Observed | `.submissionstatustable` "Submission status" → `td.submissionstatussubmitted` "Submitted for grading" |
| Status: not submitted | Observed | Same row has **no status class**; text "No submissions have been made yet". Collectors must match this by text and must not expect a class. |
| Overdue / late (Time remaining row) | Observed (2026-11-01, Addendum 5) | `td.overdue` "Assignment is overdue by: N days N hours" (also "N hours N mins"); `td.latesubmission` "Assignment was submitted N days N hours late"; `td.earlysubmission` also seen as "… N mins N secs early". Two of 19 assignments had no "Time remaining" row and no activity dates. |
| Status: draft | Unavailable | Not present in this account (0 of 19 assignments, Addendum 5) |
| Status: reopened | Unavailable | Not present in this account (0 of 19 assignments, Addendum 5) |
| Grading status | Observed | `td.submissionnotgraded` "Not graded" (no grade values recorded) |
| Time remaining | Observed | `td.timeremaining` "1 day 17 hours remaining"; `td.earlysubmission` "Assignment was submitted … early" |
| Last modified, submission comments | Observed (row presence) | Rows present in `.submissionstatustable` |
| File submissions | Observed (row presence) | Contains student file names. **Must be redacted or not collected.** |

### Quiz (`/mod/quiz/view.php?id=<cmid>`)

| Field | Status | Sanitized evidence |
| --- | --- | --- |
| Page / ids | Observed (2026-11-01, Addendum 3) | `body#page-mod-quiz-view`; body classes include `lang-en`, `pagelayout-incourse`, `course-<courseid>`, `context-<n>`, `cmid-<cmid>`, `theme`, `theme-dark`, `rui-course--showactivitydates` |
| Open / close dates | Observed | "Opened: …" / "Closed: …". On the quiz view page the `[data-region="activity-dates"]` region starts with a decorative, text-less `<svg class="d-none d-md-flex mr-2">` before the two `div` rows (2026-11-01, Addendum 4); course-page cards have only the two `div`s. |
| Attempts allowed, time limit | Observed | `.quizinfo p`: "Attempts allowed: 1", "Time limit: 10 mins", password notice |
| Attempt list | Observed (theme-specific) | The standard `table.quizattemptsummary` is **replaced** by `div.rui-attempts-list`. The observed chain is `div.rui-attempts-list > div.w-100 > div.rounded.border.p-3 > h4.card-title.mb-3` "Attempt 1", followed by the `.rui-summary-table.quizreviewsummary` / `.rui-infobox` blocks. There is **no** `.card` element inside `.rui-attempts-list` (Addendum 3). The attempt has `.rui-infobox` pairs (`h5.rui-infobox-title` / `.rui-infobox-content--small`): Status "Finished", Started, Completed, Duration, Marks, Grade. Marks and grade values were not recorded. |
| Attempts exhausted | Observed (2026-11-01, Addendum 4) | `.box.quizattempt > p.text-start` "No more attempts are allowed"; the same box also holds `div.continuebutton` "Back to the course", so the box's full text is "No more attempts are allowed Back to the course". The status sentence is the `p.text-start` text. |
| Final grade | Observed (heading only) | Value not recorded; out of scope for collection |
| In-progress / multiple attempts | UNVERIFIED | Not inspected |
| Individual override | Unavailable | None observed |

> **Note (2026-11-01, Addendum 3):** a read-only re-check of the same quiz view page and course page by the orchestrator, in the same session, recorded the body classes and the attempts-block chain above. The earlier wording "each attempt has `h4.card-title`" was read by the #4 fixture and the first #14 parser as a `.card` wrapper; the live page has no `.card` there, so collectors must not require one. Only `.rui-attempts-list`, `h4.card-title` and the `.rui-infobox` pairs are relied on; the exact placement of the `.rui-infobox` blocks inside the attempt box was not recorded.

> **Observed quirk (2026-11-01, Addendum 4): inconsistent weekday.** A live run of the #14 parser against the student's own pages found a quiz whose course card and quiz view page both show "Opened: Tuesday, 15 September 2026, 9:00 AM" and "Closed: Wednesday, 15 September 2026, 11:00 PM". 15 September 2026 is a Tuesday, so the weekday on the "Closed:" line disagrees with its own day, month and year. Moodle probably computes the weekday in a different time zone from the day-of-month and time; that cause is not confirmed. Collectors treat the numeric day/month/year/time as authoritative (they agree with the "Opened:" line), keep the full row text, and flag the disagreement explicitly (`weekdayMismatch: { shown, computed }` in the #14 quiz collector). They do not drop the quiz. A numerically invalid date (for example 31 February) is still rejected. The same live run also recorded the dates-region `svg` and the `.box.quizattempt` children in the table above.

### Calendar (`/calendar/view.php?view=upcoming`)

| Field | Status | Sanitized evidence |
| --- | --- | --- |
| Event node | Observed | `div.calendar-event-box[data-type="event"]` |
| Event id | Observed | `data-event-id` |
| Course | Observed | `data-course-id` |
| Component / type | Observed | `data-event-component` (`mod_assign`), `data-event-eventtype` (`due`) |
| Title | Observed | `data-event-title` "<name> is due" (the suffix must be stripped to match the activity name) |
| Date / time | Observed | Day link `/calendar/view.php?view=day&time=<epoch>` gives epoch precision; displayed times are UTC+5 |
| Activity link | Observed | `/mod/assign/view.php?id=<cmid>&action=editsubmission` ("Add submission"). The cmid comes from this link. **Never follow or click it.** |
| Coverage | Observed | 2 upcoming events, both assignment due events |

### Materials

| Field | Status | Sanitized evidence |
| --- | --- | --- |
| File resource target | Observed | `/mod/resource/view.php?id=<cmid>` → 303/302 → `/pluginfile.php/<ctx>/mod_resource/content/<rev>/<filename>` |
| Content type | Observed | `Content-Type: application/pdf`, `Content-Disposition: inline` |
| File type label | Observed | `.activitybadge` "PDF" / "PPTX" on the course page |
| URL / page targets | UNVERIFIED | Seen as modtypes only |
| Folder relationships | Unavailable in enrolled courses; parent-to-child UNVERIFIED | No folder module in this account's courses. The one inspected folder (row 14) was empty, so no parent-to-child file or subfolder relationship was observed. |

### Folder (`/mod/folder/view.php?id=<cmid>`)

Evidence: rows 13 and 14, one empty folder in a not-enrolled, guest-viewable course, English, 2026-11-01. Only structure was read.

| Field | Status | Sanitized evidence |
| --- | --- | --- |
| Course-page card | Observed | `li.activity.modtype_folder.folder`; the nested `.instancename .accesshide` type label reads "Folder" and must be removed from the name |
| Display mode | Observed (separate page) | The tree is not rendered inline on the course page; the folder opens on its own page. Inline display is UNVERIFIED. |
| Page | Observed | `body#page-mod-folder-view`, `<html lang="en">`, HTTP 200 |
| Folder tree | Observed | `div.box.generalbox.foldertree > div#folder_tree<N>.filemanager > ul > li > div.fp-filename-icon > (span.fp-icon > img.icon) + span.fp-filename`. `span.fp-filename` is a sibling of `span.fp-icon`; both are children of `div.fp-filename-icon`. The single root `li` is the folder itself. (Corrected 2026-11-01: an earlier version wrongly placed `span.fp-filename` inside `span.fp-icon`, a transcription error.) |
| Child files | UNVERIFIED | The inspected folder was empty: 0 `pluginfile.php` links |
| Nested subfolders | UNVERIFIED | 0 nested `ul` under the root `li` |
| "Download folder" button | UNVERIFIED | No download-folder form was present; the only form on the page was the `/course/jumpto.php` navigation |

## Navigation and access behaviour collectors must handle

| Behaviour | Status | Evidence and required handling | Owner |
| --- | --- | --- | --- |
| Pagination: course list | Observed | `/my/courses.php` has `[data-region="paging-bar"]` and `[data-region="paging-control-container"]`. The AJAX `nextoffset` was 8 even when the list was exhausted. **Do not treat `nextoffset` alone as "more pages". Stop when the returned count is less than the limit.** | #11 |
| Pagination: calendar ranges, resource lists | UNVERIFIED | Only the upcoming view was inspected | #15, #17 |
| Dynamic navigation | Observed (partially) | `/my/courses.php` issues its own `core_course_get_enrolled_courses_by_timeline_classification` POST to fill the card list, so prefer the endpoint over the rendered cards. Pages also issued `core_calendar_get_action_events_by_timesort`, `core_get_user_dates` and `block_recentlyaccesseditems_get_recent_items` themselves. Section expand/collapse and calendar range changes are UNVERIFIED. | #11, #15 |
| Permission failure: not enrolled | Observed | Two not-enrolled course ids returned **HTTP 200 and rendered the course page**. Page reachability does not prove enrolment, so enrolment must come only from the enrolled-courses endpoint. | #11, #12 |
| Permission failure: non-existent id | Observed | HTTP 404, `body#page-site-index`, text "Can't find data record in database…" for both course and module ids | #13–#17 |
| Permission failure: restricted activity / folder | UNVERIFIED | No restricted activity was observed. The one inspected folder page (row 14, not-enrolled guest-viewable course) returned HTTP 200; a restricted or inaccessible folder was not observed. | #13–#17 |
| Login redirect: page | Observed | An unauthenticated `/course/view.php?id=N` redirects to final path `/login/index.php` with **HTTP 200**. The content type was not recorded for this request. A 200 status therefore does not prove success; check the final path. | #10 |
| Login redirect: file download | Observed | An unauthenticated `/mod/resource/view.php?id=<cmid>` also ends at `/login/index.php`, HTTP 200, `text/html`. **Downloaders must check the final path and content type, or they will save the login page as the PDF.** | #17 |
| Session expiry mid-collection | UNVERIFIED as a timed event | Expected to look the same as the unauthenticated redirect above, but this was not observed | #10 |

> **Addendum 5 (2026-11-01): assignment-status survey and session signals.** In a new session the student again granted read-only access and signed in themselves. Every assignment in the 8 enrolled courses was read once (rows 15 and 16). Of 19 assignments, "Submission status" was `td.submissionstatussubmitted` "Submitted for grading" on 5 and the class-less "No submissions have been made yet" on 14. "Grading status" was `td.submissionnotgraded` "Not graded" on all 19. No draft, reopened, "new attempt" or other submission status appeared, and no "Attempt number" row appeared, so draft and reopened stay **Unavailable / UNVERIFIED**. Session signals (row 17): with credentials omitted, `/my/` redirects (HTTP 200 after redirect) to `/login/index.php` with `body#page-login-index`, classes `path-login`, `pagelayout-login`, `rui-login-page` and **`lang-ru`** (the login page defaults to Russian, so text matching must not be used there). `core_session_time_remaining` returns `{userid, timeremaining}` with `error: false` when signed in and `error: true`, `errorcode: "servicerequireslogin"` when not. RaiseUI has no `#user-menu-toggle` on the dashboard, so that selector is not a signed-in signal.

> **Addendum 6 (2026-11-02): re-check.** In a new session the student again granted read-only access; the built-in browser was still signed in from the earlier session and the student confirmed it was their account. Rows 18–21 were read. Everything recorded in Addenda 3–5 was seen again unchanged: every course page has `body#page-course-view-topics` with `format-topics` and `course-<courseid>` (8 of 8); every quiz view page has `body#page-mod-quiz-view` with `course-<courseid>` and `cmid-<cmid>` (3 of 3), theme assets under `/theme/…/alpha`; the attempts block is `div.rui-attempts-list > div.w-100 > div.rounded.border.p-3 > h4.card-title.mb-3` with **zero** `.card` elements inside the list (3 of 3), and the `.rui-infobox` blocks sit at `div.rounded.border.p-3 > div.rui-summary-table.quizreviewsummary.mb-0 > div.rui-info-container.rui-quizreviewsummary > div.rui-infobox.pl-3`. **New variants:** one quiz's attempt has no "Marks" infobox (Status, Started, Completed, Duration, Grade only), so collectors must not require Marks; two quizzes show the extra `.quizinfo p` "To attempt this quiz you need to know the quiz password". Assignment status was again 5 × `submissionstatussubmitted` "Submitted for grading" and 14 × class-less "No submissions have been made yet", with "Not graded" on all 19; still no draft or reopened. Materials: `/mod/resource/view.php` redirected to `/pluginfile.php/<ctx>/mod_resource/content/<rev>/<file>` for 4 of 14 resources (2 × `application/pdf`, 2 × `application/epub+zip`, all `Content-Disposition: inline`, `Content-Length` present; the EPUB body starts `PK\x03\x04`). The other 10 stayed on `/mod/resource/view.php` as `text/html` (a resource page, not a file), so a resource link is not always a direct file. Fetching a `pluginfile.php` URL **with credentials omitted** was redirected to `/login/index.php`, HTTP 200, `text/html; charset=utf-8`, `body#page-login-index`, `lang-ru`: an expired or missing session on a file URL returns the login page with a 200. **Live #14 parser run:** the parse logic of `extension/src/moodle-quizzes.ts` (copied into the page from the `bun build` bundle, with only the output fields trimmed) was run on the 3 live quiz view pages and the one course page that holds quizzes. All 4 returned `complete` with no diagnostics; every quiz kept both "Opened:" and "Closed:", `close: "quiz_close"`, attempt facts Attempts allowed / Time limit / Status / Started / Completed / Attempt summary with `used` unknown, and one weekday mismatch flagged (the Addendum 4 quiz). The same 4 URLs fetched with credentials omitted each returned `error` / `signed_out`. Only statuses, reasons and label names were printed; no dates, titles or ids were kept.

## UNVERIFIED and unavailable variants

These cases were not observed on 2026-11-01. They stay UNVERIFIED, and collectors must not claim support for them until they are inspected:

- **Folder variants beyond the empty one:** a folder with files, nested subfolders, inline display on the course page and the "Download folder" button. No folder module appeared in any of the 8 enrolled courses, and the one folder inspected in a not-enrolled, guest-viewable course was empty and shown on a separate page.
- **Cut-off dates and extensions** on assignments.
- **Individual overrides** on assignments and quizzes.
- **Draft and reopened** assignment submissions.
- **Restricted activities** (`.availabilityinfo`) and restricted or inaccessible resources.
- **RU/KK UI:** the Russian and Kazakh interface variants. All label-text matching above ("Opened:", "Due:", "Closed:", "Submitted for grading", "No submissions have been made yet", "Attempts allowed:") is English-only. Prefer classes, data attributes and endpoint fields.
- **Past and future course groupings:** both were empty, so the response shape is only known for in-progress courses.
- **Quiz variants:** in-progress attempts and multiple attempts.
- **Calendar variants:** other event types and the day and month views.
- **URL, page and video targets.**

Inspecting these needs an account or course that has them, with the same authorized, read-only session path. That is follow-up evidence; it is not a blocker for the observed rows.

## Current wire capacity versus observed evidence

The [#5 data-model inventory](../architecture/data-model.md) records the current wire fields and their constraints. Its authorities are [OpenAPI](../../openapi.yaml), [Zod](../../frontend/src/domain/types.ts) and [Python](../../backend/schemas.py). This table compares their representational capacity with what was observed live. It does not show that any collector exists yet.

| Concern | Present wire fields | Live evidence impact / gap / owner |
| --- | --- | --- |
| Courses and identity | `Course.id`, `code`, `name`, `color`, `current`; `Settings.trackedCourseIds`; `Assessment.id`, optional `activityId`, `courseId`, `title`, `type` | Stable sources were observed: the course id (`data-course-id` / `courses[].id`) and the cmid (`#module-<cmid>`, `cmid-<cmid>`). `code` must be derived from the first shortname segment. `name` must have the parenthesised instructor name stripped. `current` maps to the `inprogress` classification. `activityId` must hold the cmid, not the assign or quiz instance id. Those are different id spaces, and only the cmid was observed. Owners: [#11](https://github.com/Ramung55/MoodleHelper/issues/11) / [#12](https://github.com/Ramung55/MoodleHelper/issues/12). |
| Dates and provenance | `Assessment.availableFrom` (optional string), `sources` (nonempty `SourceEvidence[]`), `firstObservedAt`, `lastObservedAt`; `SourceEvidence.source`, `date`, `observedAt`, optional `excerpt`, `location`, `url` | Displayed dates are minute-precision in UTC+5 (Asia/Almaty) with no offset. The calendar provides epochs. Both fit the exact `DateValue` branch (`iso`, `tz`). There is still no dedicated cut-off field and no structured individual-override model. Cut-offs and overrides were unavailable live, so the gap is not yet exercised. Owners: [#13](https://github.com/Ramung55/MoodleHelper/issues/13) (cut-off), [#14](https://github.com/Ramung55/MoodleHelper/issues/14) (quiz open/close and attempts), [#15](https://github.com/Ramung55/MoodleHelper/issues/15) (calendar). |
| Submission versus personal completion | Optional `Assessment.submission`: `status` = submitted/draft/not_submitted/reopened/unknown, `observedAt`, optional `evidence`; `Overlay.completed` is separate | Observed mappings: `submissionstatussubmitted` → `submitted`; the class-less "No submissions have been made yet" → `not_submitted`. The `draft` and `reopened` labels remain unverified, so any unrecognised status must map to `unknown`. There are no wire fields for the quiz's attempts allowed or used, or its attempt state. The RaiseUI `rui-attempts-list` is the live source for these. Owners: [#16](https://github.com/Ramung55/MoodleHelper/issues/16), #14. Moodle individual overrides are not the personal `Overlay.dateOverride` / `overrideBase`. |
| Materials and folders | `Material.id`, `courseId`, `section`, `title`, `fileType` = pdf/docx/pptx/link/video/other, `url`, `accessible`, `stale`, `lastCheckedAt`, `syllabusSuggestion`, optional `downloadedAt` | `fileType` covers the observed "PDF"/"PPTX" badges and `url` modules. `section` is available from `data-sectionid`. `accessible` must come from the final path and content type, not the HTTP status (see the login redirect rows). There are still no folder parent/child fields. Only an empty folder was observed (rows 13, 14), so the parent-to-child shape is not yet exercised. Owner: [#17](https://github.com/Ramung55/MoodleHelper/issues/17). |
| Coverage and failures | `CourseSyncState.courseId`, `status`, `coverage`, `progress`, optional `lastSuccessAt`, `error` | Collectors must report a login-page final path as a session failure, not as empty content, and a 404 "Can't find data record" as a missing source. Owners: [#10](https://github.com/Ramung55/MoodleHelper/issues/10), [#19](https://github.com/Ramung55/MoodleHelper/issues/19) / [#21](https://github.com/Ramung55/MoodleHelper/issues/21). |

Wire timestamp, time zone and URL strings remain permissive, and date strings validate their shape only. Unknown keys may be stripped or ignored, so collectors must report unsupported facts (cut-off, override, attempt counts, folder tree) explicitly. Each owning feature must agree additive Zod/OpenAPI/Python changes first. Cross-source reconciliation remains [#33](https://github.com/Ramung55/MoodleHelper/issues/33). [#4](https://github.com/Ramung55/MoodleHelper/issues/4) owns sanitized fixtures; this document creates none.

## Acceptance-criteria status

1. **Inspected variants, language and date:** met for the course list, course page, assignment, quiz, calendar, material and folder variants listed above (English, 2026-11-01). The folder variant is an empty folder shown on a separate page, inspected in a not-enrolled, guest-viewable course because no enrolled course has a folder. A folder with files, nested subfolders, inline display and the "Download folder" button remain UNVERIFIED.
2. **Field status with sanitized evidence:** every field is marked, including the folder fields. Due dates are observed. Individual overrides, drafts and reopened submissions are unavailable in this account and remain UNVERIFIED for SDU in general.
3. **Pagination, dynamic navigation, permission failures and login redirects:** each one is observed, with the remaining sub-cases marked UNVERIFIED.
4. **Unverified sources and access:** the unobserved variants are listed explicitly; no live compatibility is claimed for them.
5. **Read-only and privacy:** the inspection was read-only, and the report contains no credentials, session tokens, grades or personal names.
