# MVP verification audit

## Live journey attempt for #96, 2026-11-13 (Claude in Chrome)

Setup: HEAD `ca3d48e`, freshly built `extension/dist` loaded unpacked by the owner in their own Chrome, backend started with `MOODLE_HELPER_DATASET=moodle` and the owner's numeric Moodle user id (environment only, not recorded here), frontend dev server on 127.0.0.1:5173. The owner signed in to SDU Moodle themselves; no credentials were typed. Moodle was read-only: only GET page loads and the course-list AJAX call that the extension and Moodle's own page make. Nothing was submitted or changed.

**Blocking defect found.** On every live page read (`/my/`, `/my/courses.php`, `/calendar/view.php?view=upcoming`, `/course/view.php`), Moodle's inline `M.cfg` now contains `"homeurl":{}` before `"userId"`. The extension's `M_CFG_USER_ID` pattern (`extension/src/moodle-page-analysis.ts:55`) allows no `}` between `M.cfg = {` and `"userId"`, so it does not match. The extension therefore sends no `moodleUserId`, and the backend rejects live saves with 409 `account_unconfirmed`. Seen in the dashboard: Settings → **Find my SDU courses** showed "The Moodle account could not be confirmed. Nothing was saved."; backend log `POST /api/courses/discovery 409`. Compatibility Addendum 7 (2026-11-12) recorded `M.cfg` as flat, so either the live shape changed or the earlier check missed the field.

First run, before the fix: every criterion failed or was blocked at discovery.

**Fix (same day, uncommitted at the time of writing).** `M_CFG_USER_ID` now allows flat `{...}` objects inside `M.cfg`. The `observed/m-cfg-user-id.txt` fixture gains `"homeurl":{}`, and a unit case checks that a `"userId"` outside `M.cfg` is still ignored after such an object. Tests: `uv run pytest tests/test_moodle_fixtures.py` 104 passed; browser-workspace `live-scan-units`, `course-discovery-network`, `live-scan-network` and `sign-in-probe` 44 passed. The owner reloaded the rebuilt extension. The first reload did not take; after the owner re-checked the extension source and reloaded again, the new code ran.

### Rerun after the fix

Moodle comparison method: Moodle's own `/mod/assign/index.php?id=<course>` and `/mod/quiz/index.php?id=<course>` tables and `/calendar/view.php?view=upcoming` (GET only), compared by course-module id and local minute with the dashboard's records and its Deadlines page.

| #96 criterion | Result | Evidence |
| --- | --- | --- |
| Select current courses; Sync all; assignment, quiz and calendar deadlines match Moodle | **PASS** | Find my SDU courses: "Found 8 in-progress courses", matching the 8 enrolled courses. All 8 were ticked; Sync all finished all 8 (`/api/scan/finish` × 8). Assignments: 32 in Moodle, 32 in the dashboard, same set, same due date or no date on all 32. Quizzes: 3 in Moodle (one course), 3 in the dashboard, same close times. Calendar upcoming: 6 events (all `mod_assign` due), all 6 in the dashboard at the same minute. The Deadlines page shows "35 shown". |
| Opening one assignment page updates the dashboard; submission status matches Moodle | **PASS** | One synced assignment page was opened. The backend recorded a `submission` refresh, `outcome: ok`, `coverage: complete`, `evidenceMode: verified`, and the assessment's `lastObservedAt` moved to the visit time. The dashboard shows "Moodle: Not submitted"; the page shows "No submissions have been made yet". Across all 32 assignments, the dashboard shows 8 Submitted and 24 Not submitted, and Moodle's index shows 8 "Submitted for grading" and 24 "No submission". |
| Still shown after backend restart | **PASS** | Backend process stopped (port closed) and restarted with the same settings. The snapshot still had 35 assessments, 8 tracked courses, 8 sync states and the visit's `lastObservedAt`. The Deadlines page again showed "35 shown", 8 Submitted and 24 Not submitted. |
| One PDF material download completes | **PASS** (third attempt) | The Materials page listed 87 materials. Attempts 1 and 2 on one PDF lecture ended "Download interrupted": attempt 1 left a ~718 KB `.tmp` starting with `%PDF-` that was never renamed (about 7 min in "saving"), attempt 2 stopped after about 8 s. Chrome's own History database records both, and three earlier extension downloads on 2026-11-03, as `interrupt_reason` 40 (USER_CANCELED) with an empty target path, after all bytes had been received; the extension's own cancel paths would have ended as `cancelled` or `page_closed` instead. Attempt 3: Chrome showed a Save As window although the extension passes `saveAs: false` and the profile has no "ask where to save" preference; the owner clicked Save. A 717,990-byte file starting with `%PDF-1.7` was saved to Downloads, and the dashboard shows "Download record: saved by Chrome". Probable cause of attempts 1 and 2: the same Save As window was closed, or not seen, so Chrome cancelled. Why Chrome asks is not established. |
| Sanitised evidence in this file and `compatibility/sdu-moodle.md`, dated | **Done** | This section and compatibility Addendum 8. No user id, names, course ids, titles or dates are recorded. |
| Each requirement row marked, verdict reassessed | **Done** | Below. |

Other observations:
- Every course ends with coverage `partial` and reason `unselected_course` (course pages link to modules in courses the scan does not select). Settings therefore shows "0 of 8 courses fully scanned" and the Overview "Last full sync" can never complete, although all deadlines matched.
- During and for some time after Sync all, Settings kept showing "Sync running…" after all 8 jobs had finished; a page reload cleared it.

Requirement rows after this run:

| MVP requirement | Status |
| --- | --- |
| Local Chrome dashboard, no account; local-first and read-only | **verified** (live, this run) |
| Detect session, discover and select current courses | **verified** (live, this run) |
| Update while browsing and sync all selected courses, with freshness and failures | **verified** for Sync all and one visited assignment; full-sync freshness shows partial (see above) |
| Collect Moodle assignment, quiz and calendar deadlines | **verified** (live, this run) |
| Track changes and notify with old and new dates | **verified** on the local stack with the synthetic harness (#106, 2026-11-13), including the owner's real Windows notification and click; the denied case is verified by mocked test only (limitation: Windows Chrome offered no control that produced `denied` for the extension) |
| Suggest syllabus and import PDF/DOCX; extract locally | **verified** on the local stack with the synthetic harness and synthetic files (#107, 2026-11-13), after two fixes (specific message for a renamed non-document; self-hosted fonts so the dashboard makes no third-party requests). Live Moodle route not exercised, by owner decision; OCR text is not restored after reload, by design (#27) |
| Add clear dates with provenance, review and reconcile | **verified** on the local stack with the synthetic harness and synthetic files (#108, 2026-11-13); no code defect found. Criterion 1 judged on complete-text synthetic PDFs by owner decision; a PDF with an image-only page goes to review, which is correct per #31. Live Moodle route not exercised, by owner decision |
| Teaching weeks; configure calendar and breaks | **verified** on the local stack with the synthetic harness (#109, 2026-11-13); no code defect found. Week groups show the range as "8–14 Feb 2027" rather than ISO dates (same range). Live Moodle route not exercised, by owner decision |
| Personal deadlines, edits, hiding and source preservation | **verified** on the local stack with the synthetic harness (#110, 2026-11-14), after two fixes (planner contributor line now marks personal events; `DELETE /api/personal-events/{id}` with a Moodle id is a full no-op that keeps the overlay, by owner decision). Live Moodle route not exercised, by owner decision |
| Moodle submission status distinct from personal completion | **verified** for submitted / not submitted (draft and reopened not available in this account) |
| Weekly counts, weighted workload and warnings | **verified** on the local stack with the synthetic harness (#111, 2026-11-14); no code defect found. Busy-week alert delivered once (state shown, one attempt id, not repeated after a threshold re-trigger), including the owner's real Windows notification: exactly one, at about T, none after the re-trigger (owner-confirmed 2026-11-14). Live Moodle route not exercised, by owner decision |
| Materials links and optional selective offline download | links **verified**; download **verified** for one PDF, after confirming Chrome's Save As window |
| Optional AI with consent | unverified; #112 in progress (2026-11-14): Settings-switch gate fixed (frontend + backend 403 `ai_disabled`), phase A (no key) verified on the synthetic harness, phases B/C (owner Groq key) pending |
| Local backup, restore and deletion | unverified |
| Student journey and privacy | unverified as a whole |

#96 criteria 1–4 pass live in this run; #96 stays open pending independent QA. **MVP verdict: FAIL**, because most requirement rows above are still unverified. Known weak points: Chrome may show an unexpected Save As window that, if closed, ends as "Download interrupted" with no hint, because the extension does not keep Chrome's error code (`chromeStopped` in `extension/src/material-transfer.ts`). Full-sync coverage also never reaches complete.

## Deadline change tracking for #106, 2026-11-13 (synthetic harness, local stack)

**Source of the date changes: the SYNTHETIC fixture harness `tests.collection_network_app:app`, not live Moodle.** Live Moodle cannot be changed for this check, and SDU Moodle was not opened while the harness ran. Fixture values are fictional and are written here as dates A, B and C.

Setup: branch `verify/issue-106-deadline-changes`. The owner stopped their live-mode backend. The harness ran on 127.0.0.1:8000 with `MOODLE_HELPER_COLLECTION_TEST_DATABASE` set to a fresh absolute `synthetic-collection.sqlite3` outside the repository. The frontend dev server was already running on 127.0.0.1:5173. The extension was built (`bun run --cwd extension build`) and already loaded in the owner's Chrome; no extension or shared code has changed since the owner's last reload for #96, and `chrome://` pages could not be opened from Claude in Chrome. Pages were read with Claude in Chrome in a new tab. Each step ran `tests/deadline_change_driver.py` (test-only), which makes one `POST /api/collection/visits` and one `POST /api/collection/refresh` with `observedAt` = now. Sample settings have reminders enabled. Notification evidence is the alert delivery state that the extension worker reports to the backend (`chrome.notifications.getAll` runs only in the extension context, which these tools cannot reach).

| Step | `/deadlines` | `/alerts`, delivery |
| --- | --- | --- |
| Course tracked; unknown due date first | – | no new row |
| First date A (baseline) | row shows A | no new row (only the sample row) |
| Date B | row shows B, not A | exactly one new unread row "`<title>` changed from A (date only, no time given) to B (date only, no time given)", "Browser notification pending"; became `shown` about 42 s later (one attempt id) |
| Date B again, then a later unknown due date | B stays | no new row, change count unchanged |
| `syntheticDeadlineRemoval` | "Date unknown" (no syllabus date for this item) | one new row "`<title>`: deadline removed (was B …)", `shown` within about 1 min |
| Date C | row shows C | one new row "`<title>` changed from deadline removed to C …", `shown` within about 1 min |
| Assessment sheet (`/deadlines?id=…`) | history lists A → B, B → Removed, Removed → C, each with observed and detected times | – |
| Harness stopped and restarted on the same SQLite file; waited 75 s (past one worker alarm); replayed C | row shows C | same 3 change rows, all "Sent to Chrome notifications"; attempt ids and `updatedAt` unchanged (no new issuance); replay added no change |

Tests run: `uv run pytest` 1547 passed, 9 skipped (includes the new `test_established_removal_then_known_date_alerts_old_and_new` for criterion 6). Browser-workspace `notification-delivery` and `reminder-worker`: 14 passed (mocked Chrome APIs).

| #106 criterion | Result |
| --- | --- |
| 1 Changed date shown | **verified** (fixture + auto) |
| 2 Dashboard alert with both dates, sheet history | **verified** (fixture + auto) |
| 3 Notification, permission granted | **verified** (fixture + auto + owner). Delivery became `shown` within 2 min, one issuance per change. Owner rerun (below): exactly one Windows notification; clicking it opened `127.0.0.1:5173/deadlines` at that assessment. |
| 4 Notification, permission denied | **verified by mocked-Chrome tests** (`notification-delivery` "denied capability…"), per owner decision 2026-11-13, **with a recorded limitation**: on Windows, neither of the owner's attempts made Chrome report `denied` for the extension (see below). |
| 5 No duplicates | **verified** for change records, Alerts rows and OS issuance (one attempt id per alert, none after the restart); owner saw exactly one notification per change. Extension reload not exercised (`chrome://extensions` unreachable). |
| 6 Gains a date | **verified** (a) and (b) (fixture + auto) |
| 7 Loses a date | **verified** (a) and (b) (fixture + auto) |
| 8 Dashboard only when hidden or reminders disabled | **auto only** (`test_source_change_alert_keeps_old_new_distinct_ids_and_hidden_policy`, `test_denied_failed_and_ineligible_states_are_truthful`) |
| 9 Restart | **verified** (fixture + auto) |

No defect found. Windows-level notification settings are a known limitation: Chrome would still report `granted` and the backend would record `shown`.

**Owner checks, 2026-11-13.** The orchestrator reran the harness on 127.0.0.1:8000 with a fresh database outside the repository and drove the changes with `tests/deadline_change_driver.py`; the harness was stopped afterwards. Results as reported by the owner:

- Permission granted, change date A → B: exactly one Windows notification; clicking it opened `127.0.0.1:5173/deadlines` at that assessment. Delivery `shown`.
- Owner blocked notifications for the extension in Chrome's site settings, change B → C: a notification still appeared; delivery `shown`.
- Owner used the notification's own "turn off notifications" option, change C → D: a notification still appeared; delivery `shown`.

Limitation (criterion 4): on Windows, neither Chrome control the owner tried made Chrome report `denied` for the extension (the extension still saw `granted` and recorded `shown`). The denied path is therefore verified only by the mocked-Chrome test, by owner decision.


## Syllabus suggestion and local extraction for #107, 2026-11-13 (synthetic harness and synthetic files, local stack)

**Route for every criterion: the SYNTHETIC fixture harness `tests.collection_network_app:app` plus synthetic files, not live Moodle**, by owner decision 2026-11-13. SDU Moodle was not opened. No owner document was used.

Setup: branch `verify/issue-107-syllabus-extraction`. Port 8000 was free. The harness ran on 127.0.0.1:8000 with `MOODLE_HELPER_COLLECTION_TEST_DATABASE` set to a fresh absolute `synthetic-collection.sqlite3` outside the repository; this is the "fixture/mock dataset on the local stack". The frontend dev server was already running on 127.0.0.1:5173. Pages were driven with Claude in Chrome in a new tab of the owner's Chrome, closed afterwards. Files were chosen with Claude in Chrome's file-upload tool, which sets the page's file input directly (no native file chooser). `tests/syllabus_material_driver.py` (test-only, talks only to the harness) runs `setup` (tracks the harness course, as in #106) and `post` (one `POST /api/collection/visits` and one `POST /api/collection/refresh` with collector `material` on the course page, carrying a synthetic "Lecture 1" PDF first and a synthetic "Syllabus" PDF second).

Documents: the committed synthetic fixtures `extraction-bilingual.pdf`, `extraction-bilingual.docx`, `ocr-scanned.pdf`, `local-truncated.pdf`, `local-encrypted.pdf` and `extraction-unsupported.docx`; and, by owner decision, two single-language PDFs made in a scratch folder outside the repository (not committed) from `extraction-bilingual.pdf` by same-length byte edits: the page tree keeps only page 1 (English) or page 2 (Russian) and the other pages' content streams are blanked, so the original cross-reference offsets stay valid. Temporary rejection files (a plain-text file named `.pdf`, a PDF renamed `.doc`) were made in the same scratch folder; the over-limit file was a 20 MiB + 1 byte in-page `File` set on the file input by script, because the upload tool is limited to 10 MB.

| Criterion | Steps | Observed |
| --- | --- | --- |
| 1 Suggestion listed | driver `setup`, `post`; read "Suggested from Moodle" | "Syllabus" under the harness course's code, `pdf · Title mentions a syllabus or course programme`, first; "Lecture 1" below it, `Title does not clearly identify a syllabus · Uncertain` (it was posted first, so the order comes from the ranking) |
| 2 Suggestion imported and extracted | **Choose local file for this course** on "Syllabus"; choose `extraction-bilingual.pdf`; **Extract text**; **Find assessments** | Course selector preselected the harness course, "Selected resource: Syllabus". Import: course, name, `80456 bytes`, SHA-256, source "Syllabus", state Ready, "Complete: validated and stored locally". Proposals, each "Unconfirmed" with excerpt and `pdf_row` page: Assignment 1 (assignment, p1), Quiz 2 (quiz, p1), Задание 1 (assignment, p2), Экзамен (exam, p2) |
| 3 Manual upload, three documents | Cancel the suggestion, choose a sample course in **Import a file**, upload each, **Extract text**, **Find assessments** | English PDF: Assignment 1 (assignment), Quiz 2 (quiz), page 1. Russian PDF: Задание 1 (assignment), Экзамен (exam), page 1 (its only page). DOCX: Assignment 1 (assignment) and Экзамен (exam), `docx_row` with table, row, cell and paragraph references (Экзамен: table 2, row 1, cell 1, paragraph 1). All "Unconfirmed" |
| 4 Scanned PDF and OCR | upload `ocr-scanned.pdf`, **Extract text**, OCR pages `1,2,3`, English and Russian | Pages 1–3 "OCR needed (image-only)". OCR: page 1 "Text found", "Assignment 1"; page 2 "Text found", "Экзамен"; page 3 "Low quality/no reliable text — review needed". "Text remains unconfirmed" |
| 5 Rejected files | upload each; reload | `local-truncated.pdf`: "The PDF is corrupt or uses an unsupported structure…". `local-encrypted.pdf`: "Password-protected PDFs are unsupported…". Plain text named `.pdf`: first the generic corrupt-PDF message (**defect**, fixed below), after the fix "The file contents are not a PDF document, although the name ends in .pdf…". Renamed `.doc`: "Legacy .doc is unsupported. Export it as DOCX." Over-limit: "The file exceeds the 20 MiB limit…". `extraction-unsupported.docx`: imported, then **Extract text** gave "Extraction failed: This DOCX contains unsupported body structure…" and no **Find assessments** / proposals. After reload the imported list still had only the six accepted documents; the three PDF rejections stay visible as failed job notices with retry, not as imported rows |
| 6 No document traffic off the device | Claude in Chrome `read_network_requests` on the dashboard tab during criteria 2–5 and after reload; recaptured after fix 2 (reload + one Extract text / Find assessments) | First capture: every request was `GET`, so no request carried a body; requests to `127.0.0.1:5173` only (`/api/local-context`, Vite modules, `pdf.worker.min.mjs`, `/ocr/7.0.0/local-worker.js`), **plus `fonts.googleapis.com` / `fonts.gstatic.com`** webfont GETs from the dashboard shell (fixed by fix 2). None to `moodle.sdu.edu.kz`. The harness log showed no document upload endpoint. The tab log did not show the OCR worker's own `/ocr/7.0.0/` fetches. Recapture after fix 2: only `127.0.0.1:5173` |
| 7 Restart persistence | stop the harness, restart on the same SQLite file, reload | Same dataset; all six documents listed under their courses; "Restored from this browser: the local extraction"; proposals from criteria 2–3 shown again without re-running. `ocr-scanned.pdf` shows its restored extraction (pages "OCR needed"); the OCR text from criterion 4 is not restored, by design (`StoredExtraction.result` excludes the OCR format; #27 says OCR does not persist results), so OCR must be rerun |

Fix (criterion 8): a non-document file renamed `.pdf` (or `.docx`) got the generic "corrupt" message, but #24 requires a specific message for mismatched signatures. `validate-pdf.ts` and `validate-docx.ts` now report "The file contents are not a PDF/DOCX document, although the name ends in .pdf/.docx. Choose the original PDF or DOCX file." Regression test: `saved-web-page.test.tsx` "#107 renamed non-document" (2 cases; both fail without the fix). The browser recheck saw this message from an earlier placement of the same check in `syllabus.tsx`; the final validator placement is covered by the test.

Fix 2 (criterion 6, owner decision 2026-11-13: self-host the fonts): the Google Fonts `<link>`s are removed from `frontend/src/routes/__root.tsx`; `frontend/src/styles.css` declares `@font-face` rules for seven woff2 files in `frontend/src/assets/fonts/` (SIL OFL 1.1), downloaded once from `fonts.gstatic.com` as listed by the same Google Fonts CSS request the app used: Fraunces latin (variable 500–600), IBM Plex Sans latin and cyrillic (variable 400–600), IBM Plex Mono 500 and 600, latin and cyrillic each. Vite fingerprints them, so the Pages base path works. `browser-workspace/e2e/privacy-evidence.spec.ts` no longer allows the Google Fonts hosts.

Tests run: targeted `bun run test` of `syllabus-suggestions`, `extract-pdf-real`, `extract-docx`, `assessment-mentions`, `ocr-real`, `local-ocr`, `local-documents`, `validate-pdf`, `validate-docx`, `local-extraction-persistence`: 10 files, 91 passed, 0 skipped. Full `bun run test`: 78 files, 1560 passed. `uv run pytest`: 1547 passed, 9 skipped.

| #107 criterion | Result |
| --- | --- |
| 1 Suggestion listed | **verified** (fixture + auto) |
| 2 Suggestion imported and extracted | **verified** (fixture route, synthetic `extraction-bilingual.pdf`) |
| 3 Manual upload, three documents | **verified** (fixture + auto; two single-language synthetic PDFs by owner decision) |
| 4 Scanned PDF and OCR | **verified** (fixture + auto; real Chrome WASM worker) |
| 5 Rejected files | **verified** after the fix (fixture + auto); over-limit file supplied by in-page script |
| 6 No document traffic off the device | **verified** after the font fix (fixture + code check). Recapture after a reload plus one Extract text / Find assessments: 273 requests, all `GET` to `127.0.0.1:5173` (plus one in-page `data:` URL), fonts from `/src/assets/fonts/`; no third-party host. OCR worker hosts: by owner decision a code check suffices: `local-ocr-worker.ts` builds the worker, `corePath` and `langPath` from `OCR_ASSET_BASE` (`${BASE_URL}ocr/7.0.0`) on `window.location.origin`; `local-ocr-worker.test.ts` "uses only explicit same-origin worker/core/language paths…" and `ocr-real.test.ts` (network-disabled worker) pass |
| 7 Restart persistence | **verified** for imports, extraction results and proposals (fixture + auto). OCR text is not restored after reload: **by design** per #27 (`StoredExtraction.result` excludes OCR), owner decision 2026-11-13; OCR must be rerun |
| 8 Failures | two defects fixed: the signature-mismatch message (regression test) and the third-party font requests (privacy e2e allow-list tightened) |
| 9 Evidence | this section |


## Syllabus dates, review and Moodle conflicts for #108, 2026-11-13 (synthetic harness and synthetic files, local stack)

**Route for every criterion: the SYNTHETIC fixture harness `tests.collection_network_app:app` plus synthetic files, not live Moodle**, by owner decision 2026-11-13. SDU Moodle was not opened. No owner document was used.

Setup: branch `verify/issue-108-syllabus-dates`. Port 8000 was free. The harness ran on 127.0.0.1:8000 with `MOODLE_HELPER_COLLECTION_TEST_DATABASE` set to a fresh absolute `synthetic-collection.sqlite3` outside the repository (dataset A); this is the "fixture/mock dataset on the local stack". The frontend dev server was already running on 127.0.0.1:5173. Pages were driven with Claude in Chrome in a new tab of the owner's Chrome, closed afterwards; files were chosen with its file-upload tool. The new test-only driver `tests/syllabus_conflict_driver.py` (talks only to the harness) runs `setup` (tracks the harness course, as in #106) and `post` (one `POST /api/collection/visits` and one `POST /api/collection/refresh` per activity: "Assignment 1" due 2026-10-30 and "Задание 1" due 2026-10-29, date only, each with its own activity and course-module id).

Documents: the committed synthetic `extraction-bilingual.pdf` (four pages: English text, Russian text, one image-only page, one blank page), and a DOCX made in a scratch folder outside the repository (not committed) with the standard library `zipfile`: the package parts of the committed synthetic `extraction-bilingual.docx` with a new body of one table, rows "Quiz 3 | 12 March" and "Assignment 4 | 03/04/2027". For the criterion 1 recheck (dataset B, a second fresh `synthetic-collection.sqlite3`): the two single-language PDFs from #107 (same-length byte edits of `extraction-bilingual.pdf` keeping only page 1 or page 2, made in scratch, not committed).

Every document ran **Extract text** → **Find assessments** → **Interpret explicit dates** (no day/month order, no semester bounds) → **Retain evidence and route proposals** for the harness course, after the driver's `post`.

| Criterion | Steps | Observed |
| --- | --- | --- |
| 1 Clear date with provenance | dataset A: `extraction-bilingual.pdf` | **Not as the issue expected.** All four proposals went to "Needs review" with "Text extraction was incomplete" (`incomplete_extraction`); Assignment 1 and Задание 1 also with "May relate to an existing item". Cause: page 3 is image-only ("OCR needed"), and #31 sends any PDF with an image-only page to review (`complete` fact in `local-routing.ts`; `_docs/confidence-routing-31.md`: "Incomplete/image-only extraction … Review"). Running OCR does not change that fact. Nothing reached Deadlines before review. Quiz 2 and Экзамен were then added with **Confirm** so that criteria 6–7 could use this dataset. Owner decision 2026-11-13: this review routing is correct per #31, and criterion 1 is judged on complete-text documents (next row) |
| 1 recheck | dataset B: driver `setup`, `post`; single-language English PDF, then Russian PDF | Quiz 2 (5 Nov) and Экзамен (5 Nov) were on Deadlines with no review action and not under "Needs review"; Assignment 1 and Задание 1 went to review with only "May relate to an existing item". Each sheet: "Syllabus · 5 Nov (no time)", "Stored original local evidence", "Original document is available locally.", the excerpt ("Quiz 2 5 November 2026" / "Экзамен 5 ноября 2026"), and under "Original proposals, location and routing audit" a `pdf_row` location on page 1 listing the row's items |
| 2 Uncertain dates wait | dataset A: scratch DOCX | "Quiz 3": "Date unresolved in the source", "Why review: Date is not explicit; No date was found; …", "Missing year; no explicit semester start/end supplied." "Assignment 4": "Why review: Date is not explicit; Day/month order is ambiguous; …", "Ambiguous numeric day/month; declare document/course DMY or MDY order." Each shows "Original document is available locally.", its excerpt and "Location: DOCX word/document.xml, body block 2, table 1, row 1" (row 2) ", cell(s) 1, 2". Neither on Deadlines |
| 3 Accept adds with source | **Correct** on Quiz 3: Date only, 2027-03-12, **Save correction** | One "Quiz 3" row on 12 Mar 2027; sheet "Syllabus · 12 Mar 2027 (no time)", "Original document is available locally.", excerpt, location audit. "Decided": "Quiz 3 — 12 Mar 2027 (no time) (original proposal: Quiz 3 — Date unknown) Corrected" |
| 4 Reject is permanent | **Reject** on Assignment 4; import the same DOCX again for the same course ("Already added", same document); reload; rerun all four steps | "Decided: Assignment 4 — Date unknown, Rejected"; never on Deadlines. Rerun: "2 stored proposals routed … Replays retain prior decisions"; "Needs review" count unchanged, no Assignment 4, one Quiz 3 row; backend still 6 local candidates, 6 routing receipts, 2 local documents |
| 5 Conflict, Moodle wins | **Confirm** on Assignment 1 (review, "May relate to an existing item"); **Review another pair** (Moodle "Assignment 1 … 30 Oct", syllabus "Assignment 1 … 29 Oct"), **Review selected pair**, **Confirm match** | Right after Confirm, with no Moodle refresh: no Possible match card ("Match review (0)"), and the syllabus source "Assignment 1 · … · 29 Oct" was already listed under "Choose a syllabus source". After Confirm match: one "Assignment 1" row, 30 Oct (no time), "Moodle and syllabus disagree"; sheet "Sources disagree — Moodle date is used", "Moodle: 30 Oct (no time)", "Syllabus: 29 Oct (no time)", both sources with the syllabus's local evidence |
| 6 Same date, no duplicate | **Confirm** on Задание 1 (review, "May relate to an existing item"; no second row before review); **Confirm match**; driver `post` again (unchanged dates); rerun `extraction-bilingual.pdf` through **Retain evidence and route proposals** | **The Possible match card appeared directly after Confirm, without a Moodle refresh** ("Moodle: Задание 1 · … · 29 Oct", "Syllabus: Задание 1 · … · 29 Oct"). After Confirm match: one "Задание 1" row on 29 Oct with Moodle and Syllabus sources, no disagreement indicator. Re-post and re-route ("4 stored proposals routed"): same Deadlines rows, "Match review (0)", 2 confirmed pairs |
| 7 Restart persistence | stop the harness, restart on the same SQLite file, reload `/deadlines` and `/syllabus` | Same rows: Задание 1 (29 Oct), Assignment 1 (30 Oct, "Moodle and syllabus disagree", sheet with both dates), Quiz 2, Экзамен, Quiz 3 (plus the harness's two sample rows). "Decided" keeps Quiz 3 Corrected and Assignment 4 Rejected; "Needs review" holds only the two demo items; "Match review (0)", "Decided matches: 2 confirmed, 0 rejected". Quiz 3 sheet still shows "Stored original local evidence" and "Original document is available locally." |

Open point from grooming, answered: the local review path does recompute. `SQLiteStore.mutate` (and the in-memory store) run `project_sources` after every mutation once a `reconciliation` layer exists, so accepting a local proposal projects its syllabus source and proposes a same-day pair in the same transaction. The new test `test_local_review_accept_projects_syllabus_source_and_same_day_match_without_moodle_refresh` in `tests/test_reconciliation.py` (same day: one pending pair; different day: none, syllabus source present) locks this in. No application code changed.

Observation, not reproduced: once, after re-importing an already added DOCX and clicking the four steps by script within a few seconds while the page was restoring its stored extraction, **Retain evidence and route proposals** did nothing and the status stayed "Restored from this browser…". After a reload, the same four steps, each awaited, routed normally.

Tests run: `uv run pytest`: 1549 passed, 9 skipped (includes the 2 new cases). `bun run test` (frontend): 78 files, 1560 passed (includes `syllabus-dates`, `local-routing`, `local-review`, `reconciliation-review`, `assessment-overrides`).

| #108 criterion | Result |
| --- | --- |
| 1 Clear date with provenance | **verified** (fixture + auto) on complete-text documents, per owner decision 2026-11-13 ("Judge on complete docs"): the dataset B run with the single-language synthetic PDFs is the evidence. `extraction-bilingual.pdf` going to review because of its image-only page is **correct per #31** |
| 2 Uncertain dates wait | **verified** (fixture + auto) |
| 3 Accept adds with source | **verified** (fixture + auto) |
| 4 Reject is permanent | **verified** (fixture + auto) |
| 5 Conflict, Moodle wins | **verified** (fixture + auto); the syllabus source was selectable directly after accepting |
| 6 Same date, no duplicate | **verified** (fixture + auto); the card appeared directly after accepting, no refresh needed |
| 7 Restart persistence | **verified** (fixture) |
| 8 Failures | no code defect found. The routing stall above stays an observation only, per owner decision 2026-11-13 ("Note it only") |
| 9 Evidence | this section |

## Teaching weeks and semester calendar for #109, 2026-11-13 (synthetic harness, local stack)

**Route for every criterion: the SYNTHETIC fixture harness `tests.collection_network_app:app`, not live Moodle**, by owner decision 2026-11-13. SDU Moodle was not opened. `tests/deadline_change_driver.py` was not run (it would narrow tracked courses).

Setup: branch `verify/issue-109-teaching-calendar`. Port 8000 was free. The harness ran on 127.0.0.1:8000 with `MOODLE_HELPER_COLLECTION_TEST_DATABASE` set to a fresh absolute `synthetic-collection.sqlite3` outside the repository; this is the "fixture/mock dataset on the local stack". Fresh state: three tracked synthetic courses, no teaching calendar, legacy semester fields present, a seeded exam dated only "Week 9". The frontend dev server was already running on 127.0.0.1:5173. Pages were driven with Claude in Chrome in a new tab of the owner's Chrome, closed afterwards; fields were set with its form tools and each step was awaited. Via Deadlines → **Personal event**: "Synthetic quiz" (Quiz, Teaching week 6) and "Synthetic task" (Assignment, Date only 2027-02-10). Calendar C: 2027-01-04 – 2027-03-14, Asia/Almaty, no exclusions. C+B: C with excluded start 2027-01-18.

| Criterion | Steps | Observed |
| --- | --- | --- |
| 1 No calendar | Deadlines, quiz sheet, Overview, Weekly planner | "Unresolved week" group holds "Synthetic quiz" ("Week 6 (no exact date)", "Teaching calendar not set.") and the seeded exam ("Week 9 (no exact date)", "Teaching calendar not set."). Quiz sheet: "Deadline Week 6 (no exact date) Teaching calendar not set."; its source line shows only the observation time, no deadline day or time. Overview: "Teaching calendar not set · Set calendar", both week cards "Set your teaching calendar to count weeks." Planner: "Set your teaching calendar to see weeks. Set calendar" linking to `/settings#teaching-calendar`; all items Unallocated, reason "Teaching calendar not set." |
| 2 Calendar set | save C | "Saved: 4 Jan 2027 – 14 Mar 2027."; Preview Weeks 1–10. Deadlines: group "Week 6" (heading range "8–14 Feb 2027") holds "Synthetic quiz" ("Week 6 (no exact date)", "Week 6 · 8–14 Feb 2027") and "Synthetic task" ("10 Feb 2027 (no time)"); "Week 9" ("1–7 Mar 2027") holds the exam ("Week 9 · 1–7 Mar 2027"). Quiz sheet: "Week 6 (no exact date)", "8–14 Feb 2027", "Teaching week 6", no day or time. The group heading renders the range in the friendly form; the group's underlying detail is "2027-02-08 – 2027-02-14" (`deadline-display.ts`), the same range |
| 3 Breaks | save C+B; remove the exclusion and save; partial holiday 2027-01-13 with "I confirm numbering stays unchanged", save; switch to "Unknown — unresolved", save; remove holiday, save | C+B Preview: Weeks 1–9 with 2027-01-25 as Week 3, 2027-02-08 Week 5, 2027-02-15 Week 6, 2027-03-08 Week 9, and "2027-01-18 2027-01-24 Break — counter paused, Full exclusion" (listed as the last row of the table). Deadlines: "Week 5" (8–14 Feb) "Synthetic task"; "Week 6" (15–21 Feb) "Synthetic quiz", "Week 6 · 15–21 Feb 2027"; "Week 9" (8–14 Mar) the exam. Removing the exclusion restored criterion 2 exactly. Preserve: Preview Week 2 notes "2027-01-13–2027-01-13: numbering kept", Deadlines equal criterion 2. Unknown: Preview Week 1 resolved, Weeks 2–10 "Unresolved" with "Institutional numbering is unresolved from a partial holiday…"; Deadlines "Unresolved week" holds "Synthetic quiz" and the exam with "Week N (no exact date)" and "Institutional numbering is unresolved from a partial holiday.", no date (the date-only "Synthetic task" also falls in this group, as Week 6 is unresolved). Removing the holiday restored criterion 2 |
| 4 Invalid input | with C saved, each draft, **Save teaching calendar**, then **Cancel calendar draft** | Each showed its `role=alert` message and a "Draft: …" line with the same text: "Inclusive boundaries must form 1–60 complete seven-day calendar slots."; "Use at most 59 distinct excluded slot starts."; "Excluded weeks must be full seven-day slots aligned to the calendar start and inside its boundaries."; "Partial breaks must not overlap, including inclusive endpoints."; "A partial break must be shorter than seven days within one nonexcluded anchored slot." The harness log shows no `PATCH /api/settings` for any of them (the only PATCHes after the restart are the four valid saves of criterion 3). Cancel restored the saved inputs and removed the draft line. After a full page reload: "Saved: 4 Jan 2027 – 14 Mar 2027.", inputs and Preview of C; Deadlines equal criterion 2 |
| 5 Weekly planner | `/planner` with C, then with C+B; Deadlines "Group by day" with C | C: Week 6 Total 2 / Outstanding 2 / Weighted estimate 3, "Synthetic quiz … Date: week only", "Synthetic task … Date: date only"; Week 9 1 / 1 / 3 (exam, "Date: week only"); Unallocated 4 (three dated seeded items "The source date is outside the explicit semester boundaries.", one "Unknown date."). C+B: Week 5 1 / 1 / 2 ("Synthetic task"), Week 6 1 / 1 / 1 ("Synthetic quiz"), Week 9 1 / 1 / 3. Group by day: "Week 6 · no exact day" and "Week 9 · no exact day" groups; only "Synthetic task" under "Wednesday 10 February · no time" |
| 6 Restart persistence | with C+B saved, stop the harness, restart on the same SQLite file, reload Settings, Deadlines, Planner | Backend returned the same calendar; Settings "Saved: 4 Jan 2027 – 14 Mar 2027.", inputs 2027-01-04 / 2027-03-14 / 2027-01-18, Asia/Almaty, the C+B Preview; Deadlines and Planner equal criterion 3's and 5's C+B results |

New test: `test_saved_calendar_survives_sqlite_restart` in `tests/test_teaching_calendar.py` saves a calendar with an exclusion and a partial holiday through `PATCH /api/settings` on a file-backed `SQLiteStore`, closes it, reopens a new app on the same file and checks the settings are identical. No application code changed.

Observations, not defects: the Deadlines week heading and sheet show the range as "8–14 Feb 2027" (the issue text quoted the ISO detail string); the Preview lists the break row after the teaching weeks rather than in date order.

Tests run: issue-named tests: `tests/test_teaching_calendar.py` + `tests/test_irregular_calendar.py` 58 passed before the new case (28 in `test_teaching_calendar.py` with it); `teaching-calendar`, `personal-event`, `irregular-calendar`, `weekly-overview`, `workload-ui` 33 passed; `workload.test.ts` 12 passed. Full suites: `uv run pytest` 1550 passed, 9 skipped (includes the new case); `bun run test` (frontend) 78 files, 1560 passed.

| #109 criterion | Result |
| --- | --- |
| 1 No calendar | **verified** (fixture + auto) |
| 2 Calendar set | **verified** (fixture + auto); range shown in friendly form, same dates |
| 3 Breaks | **verified** (fixture + auto) |
| 4 Invalid input | **verified** (fixture + auto) |
| 5 Weekly planner | **verified** (fixture + auto) |
| 6 Restart persistence | **verified** (fixture + new auto test) |
| 7 Failures | no code defect found |
| 8 Evidence | this section |


## Personal deadlines, edits, hiding and source preservation for #110, 2026-11-14 (synthetic harness, local stack)

**Route for every criterion: the SYNTHETIC fixture harness `tests.collection_network_app:app` plus `tests/deadline_change_driver.py`, not live Moodle**, by owner decision 2026-11-13. These two are the "fixture/mock dataset on the local stack". SDU Moodle was not opened and the extension was not exercised.

Setup: branch `verify/issue-110-personal-deadlines`. Port 8000 was free. The harness ran on 127.0.0.1:8000 with `MOODLE_HELPER_COLLECTION_TEST_DATABASE` set to a new absolute `synthetic-collection.sqlite3` outside the repository. Before any browser step: driver `setup` (tracks only the first seeded course, "CSS 215"), then driver `2027-02-10`, creating the Moodle-collected "Synthetic assignment" (Assignment, date only, no submission status). The frontend dev server was already running on 127.0.0.1:5173 and served the working tree with the fixes below. Pages were driven with Claude in Chrome in a new tab of the owner's Chrome, closed afterwards; each step was awaited. Settings → Teaching calendar: calendar C (2027-01-04 – 2027-03-14, Asia/Almaty, no exclusions). Before any edit the planner showed Week 6 Total 1 / Outstanding 1 / Weighted estimate 2 with "Synthetic assignment", Weeks 7–9 0 / 0 / 0.

| Criterion | Steps | Observed |
| --- | --- | --- |
| 1 Personal deadline | Deadlines → **Personal event**: "Synthetic personal" (Quiz, Date only 2027-03-03) and "Synthetic extra" (Other, Date only 2027-03-04), course CSS 215; open the first sheet; Weekly planner | Deadlines (All visible) "5 shown"; group "Week 9" holds both, each with the "Personal event" badge, "3 Mar 2027 (no time)" / "4 Mar 2027 (no time)". Sheet: "Quiz · Personal event", "Teaching week 9", no "Original source" section. Planner Week 9: 2 / 2 / 1, contributors "Synthetic personal — Quiz · Personal event · +1 est." and "Synthetic extra — Other · Personal event · +0 est.". **Without the fix the contributor line has no personal marker** (grooming finding); fixed, see below |
| 2 Edit | sheet of "Synthetic assignment": Display title "Edited assignment", Your date Date only 2027-02-19, **Save changes**; **Reset title**; re-type the title, **Save changes**; planner | Row "Edited assignment", "Your date", "19 Feb 2027 (no time)", group "Week 7". Sheet: "Teaching week 7"; Original source "Source title Synthetic assignment", "Latest source date 10 Feb 2027 (no time) · Moodle", "Shown to you Edited assignment · 19 Feb 2027 (no time) (personal override)"; "Saved: “Edited assignment”". Sheet buttons: Save changes, Reset title, Reset date, Hide item (no delete). Reset title: row and sheet show "Synthetic assignment", date still 19 Feb. Re-save restored "Edited assignment". Planner: Week 6 0 / 0 / 0, Week 7 1 / 1 / 2 "Edited assignment" |
| 3 Later sync | driver `2027-02-24`, reload Deadlines, open the sheet; **Reset date**; Your date Date only 2027-02-19, **Save changes**; planner | Row "Edited assignment", "Your date", "Source changed under your edit", "19 Feb 2027 (no time)", Week 7. Sheet: "The source date changed after you edited it", "Needs review", "When you edited (previous baseline): 10 Feb 2027 (no time)", "Source now (Moodle): 24 Feb 2027 (no time)", "Your date: 19 Feb 2027 (no time)", "Moodle changed: 10 Feb 2027 (no time) → 24 Feb 2027 (no time)", Original source "Latest source date 24 Feb 2027 (no time) · Moodle". Reset date: row "24 Feb 2027 (no time)" in "Week 8", "Teaching week 8", no Needs review block. Re-entering 19 Feb: Week 7, "Your date", no review block; backend overlay `overrideBase` 2027-02-24. Planner (read after the re-entry, not between the sync and Reset date): Week 7 1 / 1 / 2, Week 8 0 / 0 / 0 |
| 4 Hide / restore | **Hide item** on "Edited assignment"; Status **Hidden**; planner; **Restore item**; same on "Synthetic personal" | Hide: "5 shown" → "4 shown · All visible", row gone. Hidden: "1 shown · Hidden", "Edited assignment … Your date · Hidden · 19 Feb 2027 (no time)". Planner Week 7 0 / 0 / 0 "No assessments this week.", not under Unallocated, not on the page. Restore: sheet identical to before hiding (title, 19 Feb, Teaching week 7, history line, Original source 24 Feb · Moodle, Shown to you … (personal override)); planner Week 7 1 / 1 / 2. "Synthetic personal": hide → "4 shown", Week 9 1 / 1 / 0 (only "Synthetic extra"), listed under Hidden with the "Hidden" badge; restore returned it. Note: "Source changed under your edit" was absent before and after hiding, because criterion 3's last step (re-entering the date) sets a new baseline, as #53 defines; hide/restore of an item in the review state is covered by `assessment-overrides.test.tsx` |
| 5 Delete | sheet of "Synthetic extra" → **Delete event** → in-page "Delete personal event?" → **Confirm deletion**; backend `DELETE /api/personal-events/{id}` with the Moodle item's id while it was hidden | Gone from All visible ("4 shown") and Hidden ("0 shown"); planner Week 9 1 / 1 / 1, "Synthetic personal" unchanged. "Edited assignment" sheet offers Hide item, no delete control. Backend call (with the bridge binding header): assessment kept, overlay identical (title, date, baseline, `hidden: true`). Before the fix the overlay was removed (grooming finding) |
| 6 Restart | with "Edited assignment" restored and "Synthetic personal" visible: stop the harness, restart on the same file, reload Deadlines, sheets, planner; hide "Synthetic personal"; restart again; reload | After restart 1: "4 shown"; "Edited assignment" in Week 7 with "Your date" 19 Feb, sheet history "10 Feb → 24 Feb", Original source 24 Feb · Moodle, Shown to you … (personal override); "Synthetic personal" "Quiz · Personal event", Week 9; "Synthetic extra" absent; planner Week 7 1 / 1 / 2, Week 9 1 / 1 / 1. After hiding and restart 2: All visible "3 shown" without it; Hidden "1 shown": "Synthetic personal … Personal event · Hidden". As in criterion 4, the Needs review block was no longer present (baseline 24 Feb after the re-entry), so its own survival across a restart was not observed here |

Fixes (criterion 7):
- `frontend/src/routes/planner.tsx`: a personal contributor line reads "<Type> · Personal event · +N est." (same wording as the sheet subtitle). Regression test "marks personal events in the contributor list (#110)" in `weekly-overview.test.tsx`.
- `backend/services.py` `delete_personal_event`: a non-personal or missing id is now a full no-op, so a Moodle item's overlay (edit, baseline, hidden flag) stays; owner decision 2026-11-14. `openapi.yaml` description updated. Regression test `test_delete_personal_event_keeps_moodle_overlay` in `tests/test_api.py` (fails on the old code). The demo adapter (`frontend/src/services/demo-adapter.ts` `deletePersonalEvent`) was aligned to the same contract, with a test in `assessment-overrides.test.tsx`.

Tests run: issue-named backend tests `tests/test_api.py`, `test_assessment_overrides.py`, `test_overlay_reset.py`, `test_deadline_tracking.py` 147 passed; frontend `personal-event`, `weekly-overview`, `workload-ui`, `assessment-overrides`, `deadline-list`, `workload` 79 passed. Full suites: `uv run pytest` 1552 passed, 9 skipped (includes the new case); `bun run test` (frontend) 78 files, 1562 passed.

| #110 criterion | Result |
| --- | --- |
| 1 Personal deadline added and marked | **verified** (fixture + auto) after the planner fix |
| 2 Edit keeps the original | **verified** (fixture + auto) |
| 3 Later sync keeps the edit | **verified** (fixture + auto); planner read after the re-entry step |
| 4 Hide / restore | **verified** (fixture + auto); review indicator not present in this sequence (see note) |
| 5 Delete personal only | **verified** (fixture + auto) after the backend fix |
| 6 Restart persistence | **verified** (fixture); Needs review block not present in this sequence (see note) |
| 7 Failures | two found, both fixed with regression tests |
| 8 Evidence | this section |

## Weekly counts, weighted workload and warnings for #111, 2026-11-14 (synthetic harness, local stack)

**Route for every criterion: the SYNTHETIC fixture harness `tests.collection_network_app:app` plus `tests/deadline_change_driver.py`, not live Moodle**, by owner decision 2026-11-13. These two are the "fixture/mock dataset on the local stack". SDU Moodle was not opened.

Setup: branch `verify/issue-111-weekly-workload`. Port 8000 was free. The harness ran on 127.0.0.1:8000 with `MOODLE_HELPER_COLLECTION_TEST_DATABASE` set to a new absolute `synthetic-collection.sqlite3` outside the repository, created on the test day. Before any browser step: driver `setup` (tracks only "CSS 215"), then driver `2027-02-10` ("Synthetic assignment", Assignment, date only). The frontend dev server was already running on 127.0.0.1:5173. Pages were driven with Claude in Chrome in a new tab of the owner's Chrome, closed afterwards; each step was awaited. Settings → Teaching calendar C (2027-01-04 – 2027-03-14, Asia/Almaty, no exclusions). Via Deadlines → **Personal event** (course CSS 215): "Synthetic exam" (Exam, Teaching week 6), "Synthetic week quiz" (Quiz, Teaching week 6), "Synthetic quiz" (Quiz, 2027-02-12), "Synthetic done" (Assignment, 2027-02-09, then ticked "I've finished this (personal check)"), "Synthetic hidden" (Exam, 2027-02-13, then **Hide item**), "Synthetic W7 assignment" (Assignment, 2027-02-16). The two seeded tracked items are dated three days after the harness first started. Run order 1, 2, 3, 4, 6, 7, 5. In criteria 3, 4 and the criterion 5 re-trigger, settings were saved on the Settings page and the planner and Overview were then opened through the app's own navigation links; a marker set on `window` before the first save was still present at every check (no reload).

| Criterion | Steps | Observed |
| --- | --- | --- |
| 1 Counts equal Deadlines | default settings, calendar C; `/planner`; `/deadlines?week=6` with no filter, `&type=assignment` / `quiz` / `exam`, `&status=outstanding`; `/deadlines?week=7` | Planner Week 6 Total 5 / Outstanding 4; contributors Synthetic assignment and Synthetic done (Assignment), Synthetic quiz and Synthetic week quiz (Quiz), Synthetic exam (Exam); "Synthetic done" struck through with "done". Deadlines "5 shown", "2 shown · Assignment", "2 shown · Quiz", "1 shown · Exam", "4 shown · Outstanding". Week 7 1 / 1, "1 shown · All visible · Week 7". Weeks 1–5 and 8–10 0 / 0 "No assessments this week.". Unallocated "2 total · 2 outstanding · weighted estimate 2" (the two seeded items, "outside the explicit semester boundaries") |
| 2 Default weights | same state | Week 6 Weighted estimate 7; lines "+2 est.", "+1 est.", "done", "+3 est.", "+1 est.". Week 7 Weighted 2. No "Busy week warning" on the planner; Overview "Busy weeks ahead" 0 "No busy weeks ahead."; `GET /api/reminders/plan` no `busy_week` item |
| 3 Weight change without reload | Settings: Exam 5 (unsaved), open the planner; back to Settings, Exam 5, **Save workload**, open the planner | Unsaved: "Unsaved changes. Planner and Overview still show saved values.", planner Week 6 Weighted 7. Saved: Week 6 9, "Synthetic exam — Exam · Personal event · +5 est.", Week 7 2, Unallocated weighted 2, weight note "Weights: exam 5, assignment 2, quiz 1, other 0." |
| 4 Thresholds | with Exam 5: weighted 8; 9; weighted 10 + outstanding 3; outstanding 4, each saved, then planner, plan and Overview | 8: header "Busy week: more than 5 due or estimate above 8.", Week 6 "Busy week warning: weighted estimate 9 is above the threshold of 8." with the warning border (`border-warning ring-warning`), Week 7 none, Overview 1 "Week 6", plan one `busy_week` week 6 `scheduled`. 9: no warning, no border, Overview 0, plan empty. Outstanding 3: "Busy week warning: 4 outstanding is above the threshold of 3.", border, Overview 1 "Week 6", plan week 6. Outstanding 4: no warning, Overview 0, plan empty. The plan listed week 6 exactly when the planner warned |
| 6 Hidden / week-only | Exam 5, thresholds 4 / 9; planner; Deadlines; Hidden filter → **Restore item**; planner, `/deadlines?week=6`; **Hide item** again; planner | Hidden: "Synthetic hidden" in no planner card, not in Unallocated, not in `/deadlines?week=6` ("5 shown"). Restored: Week 6 6 / 5 / 14, "Busy week warning: 5 outstanding is above the threshold of 4; weighted estimate 14 is above the threshold of 9.", "6 shown", plan week 6. Hidden again: 5 / 4 / 9, no warning, plan empty, Unallocated still 2 / 2 / 2. "Synthetic exam" and "Synthetic week quiz" in Week 6 with "Date: week only"; in the Deadlines "Week 6" group as "Week 6 (no exact date)" ("Week 6 · 8–14 Feb 2027"); not under Unallocated |
| 7 Restart | Exam 5, outstanding 4, weighted 8 saved; days ahead 6, time 10:30 (saved on blur); stop the harness, restart on the same file, reload | Settings: exam 5, assignment 2, quiz 1, other 0, outstanding 4, weighted 8, days ahead 6, time 10:30, busy-week warnings on. Planner header "Busy week: more than 4 due or estimate above 8.", Week 6 5 / 4 / 9 with "weighted estimate 9 is above the threshold of 8"; Overview "Busy weeks ahead" 1 "Week 6" |
| 5 Notification | D = today in Asia/Almaty. Calendar N: start D − 28, end D + 13, Asia/Almaty, no exclusions. Days ahead 7, time T about 8 minutes after the save (Asia/Almaty, equal to the machine's local time). Then outstanding 5, weighted 3, **Save workload** at about T − 8 min. Wait past T; at about T + 4 min raise weighted to 10 and, 4 s later, lower it to 3; wait 3 minutes | Before T: Overview "Teaching week 5", "Busy weeks ahead" 1 "Week 6"; planner Week 5 ("· now", D … D+6) 2 / 2 / 2 (seeded items), no warning; Week 6 (D+7 … D+13) 2 / 2 / 6 with "Busy week warning: weighted estimate 6 is above the threshold of 3."; dated 2027 items under Unallocated. Plan: one `busy_week`, week 6, `localTime` "D T", `timezone` Asia/Almaty, status `scheduled`; Alerts had no busy-week row. After T: the harness log shows one `POST /api/reminders/dispatch` with its `delivery-status` reports; at T + 37 s one Alerts row "BUSY WEEK" "Teaching week 6 looks busy. Plan ahead.", "Sent to Chrome notifications" (delivery `os`, state `shown`, one attempt id); plan status `requested`. Re-trigger: weighted 10 cleared the planner warning and the plan item; weighted 3 brought both back (status `requested`). 3 minutes later (the worker kept calling `reminders/reconcile` every minute): still one busy-week Alerts row, same attempt id, no further dispatch. **[owner]** Owner-confirmed 2026-11-14: exactly one Windows notification, at about T, and none after the re-trigger |

No application code changed; no defect found.

Tests run: issue-named `tests/test_reminders.py` + `tests/test_alert_delivery.py` 44 passed; frontend `workload`, `weekly-overview`, `workload-ui`, `alert-delivery`, `reminder-settings` 5 files, 33 passed; browser-workspace `notification-delivery` + `reminder-worker` 2 files, 14 passed (against the existing `extension/dist`, not rebuilt so the owner's loaded extension stayed untouched; no extension or shared code changed). Full suites: `uv run pytest` 1552 passed, 9 skipped; `bun run test` (frontend) 78 files, 1562 passed.

| #111 criterion | Result |
| --- | --- |
| 1 Weekly counts equal Deadlines | **verified** (fixture + auto) |
| 2 Default weights | **verified** (fixture + auto) |
| 3 Weight change without reload | **verified** (fixture + auto) |
| 4 Thresholds warn and clear | **verified** (fixture + auto) |
| 5 Notification once at lead time | **verified** (fixture + auto + owner): dashboard and backend state, and exactly one Windows notification, owner-confirmed 2026-11-14 |
| 6 Hidden excluded; week-only counted | **verified** (fixture + auto) |
| 7 Restart persistence | **verified** (fixture) |
| 8 Failures | none found |
| 9 Evidence | this section |

## Optional AI with consent for #112, 2026-11-14 (synthetic harness, local stack) — phase A; B/C pending

**Route: the SYNTHETIC fixture harness `tests.collection_network_app:app` plus the committed synthetic `frontend/src/test/fixtures/ai-fallback-synthetic.docx`, not live Moodle.** These are the "fixture/mock dataset on the local stack". SDU Moodle was not opened. Phase A ran with **no** `MOODLE_HELPER_AI_*`, `GROQ_API_KEY` or `GEMINI_API_KEY` variables; nothing was sent to any provider.

### Fix (criterion 6 grooming defect, owner decision 2026-11-14 "Frontend + backend gate")

- `frontend/src/components/mh/AiFallback.tsx`: opening **Optional AI help** reads the saved `settings.ai.enabled` fresh from the backend Snapshot. When AI is available but the switch **Allow asking before sending excerpts** is off, it shows "AI help is off in Settings (Allow asking before sending excerpts). No text was sent." with **Continue locally**, no excerpt checkboxes, no Send. With no key the existing "External AI unavailable; continue locally. No text was sent." still takes precedence.
- `backend/routers.py` + `backend/ai_gateway.py`: when a provider is configured and the stored `settings.ai.enabled` is false, `POST /api/ai/extract` returns 403 `ai_disabled` ("AI help is off in Settings. No text was sent.") before any ledger row or provider call, so a preview frozen before the switch was turned off cannot be sent. `frontend/src/services/ai-fallback.ts` maps it to the fixed off message. Documented in `_docs/architecture/ai-gateway.md` (request handling step 2) and `openapi.yaml` (403 response).
- Regression tests (each fails on `main`): backend `test_settings_switch_off_refuses_before_ledger_and_provider` (`tests/test_ai_gateway.py`: preview frozen while on, switch turned off via `PATCH /api/settings`, send → 403, 0 provider calls, 0 ledger rows; default-off store → 403); frontend "#112: while the Settings switch is off …" (`ai-fallback.test.tsx`). Existing gateway/provider tests now run on a store with the switch on (`ai_on_store()`); `local-extraction-persistence.test.tsx` serves a Snapshot with the switch on.

### Phase A (agent, no key)

Setup: branch `verify/issue-112-ai-consent`. Port 8000 was free. Harness on 127.0.0.1:8000 with `MOODLE_HELPER_COLLECTION_TEST_DATABASE` = `synthetic-collection.sqlite3` in a new folder outside the repository, created on the test day (reused for phases B/C together with `ai-ledger.sqlite3` there). Vite was already running on 127.0.0.1:5173 (serving this branch's working tree). Claude in Chrome, new tab of the owner's Chrome; the tab's network log was read from a reload of `/syllabus` onwards. Baseline before import: `/syllabus` **Needs review (2)**, `/deadlines` "5 shown".

| Criterion | Steps | Observed |
| --- | --- | --- |
| 1 No key, default settings | `/syllabus` → course CSS 215 → file set with the upload tool → **Extract text** → **Find assessments** → order Unspecified, context empty → **Interpret explicit dates** → **Optional AI help** → **Continue locally**; Settings | "4 possible assessments found. All are unconfirmed …", four rows "Unconfirmed" (Assignment 1, exam, Контрольная работа 2, assignment 2). The "Optional AI help can suggest proposals for unresolved excerpts you choose. Nothing is sent unless you review a preview and press Send." block and **Optional AI help** appeared. Pressing it: "External AI unavailable; continue locally. No text was sent." with only **Continue locally**; 0 checkboxes, no Send. Network log: `/api/ai/` requests were `GET /api/ai/availability` only (200; three over the phase: AI help and Settings visits); no `POST /api/ai/extract`; every request went to `http://127.0.0.1:5173`, none to `https://`. Data folder held only `synthetic-collection.sqlite3`: no ledger file. Settings → AI explanations: "Not available on this device.", switch **Allow asking before sending excerpts** disabled and off (`aria-checked=false`); backend Snapshot `settings.ai` = `{enabled:false, consentGiven:false}` |
| 5a No key: nothing saved | after criterion 1 | Message as in criterion 1; no ledger file, no proposals; **Needs review (2)** and `/deadlines` "5 shown" unchanged. Reload of `/syllabus`: "Restored from this browser: the local extraction, 4 possible assessments and their evidence. All remain unconfirmed; nothing was sent." |
| 6 (switch-off part) | phase A | With no key the unavailable message correctly takes precedence, so the "off" message itself is shown in phase B. Verified here: the switch defaults to off and is persisted off in the harness Snapshot; the gate is covered by the two [auto] regression tests above. Live phase B/C steps pending |

The harness was stopped at the end of phase A (port 8000 free); the browser's IndexedDB (imported document, extraction, mentions) was left in place for phase B.

Tests run: AI suites `tests/test_ai_gateway.py` + `tests/test_ai_groq_provider.py` + `tests/test_ai_gemini_provider.py` 77 passed; frontend `ai-fallback.test.tsx` + `ai-fallback-groq.test.tsx` 19 passed, `local-extraction-persistence.test.tsx` 3 passed. Full suites: `uv run pytest` 1553 passed, 9 skipped; `bun run test` (frontend) 78 files, 1563 passed.

| #112 criterion | Result |
| --- | --- |
| 1 No key: offered, nothing sent | **verified** (fixture + auto) |
| 2 Consent preview names Groq | pending (phase B, owner key) |
| 3 Declining sends nothing | pending (phase B) |
| 4 Consent: sent once, to review | pending (phase B) |
| 5a No key | **verified** (fixture + auto) |
| 5b Provider failure | pending (phase C) |
| 6 Settings switch gates sends | fixed with regression tests (auto pass); fixture steps pending (phases B/C) |
| 7 Failures | one defect (criterion 6) fixed in this branch |
| 8 Evidence | this section (phase A); B/C to follow |

## Read-only observation, 2026-11-13

The owner's already signed-in in-app browser displayed a course list, a course page with assignment due dates and an assignment page with a due date and submission-status table. This confirms source fields are visible, not that MoodleHelper collects, displays or persists them. Course selection, Sync all, quiz/calendar comparisons, page refresh, restart persistence and an application-initiated PDF download were not verified. All requirement rows retain their existing verified/unverified/failed status and the MVP verdict remains FAIL. Issue #96 remains open; see `autonomous-work-2026-11-13.md` for the criterion-by-criterion record. No private identifiers or credentials are included.

Date: 2026-11-08. **Verdict: FAIL.** Critical end-to-end Moodle collection and the complete acceptance criteria have not been verified in the current working tree. This verdict includes lack of evidence; it is not a claim that every listed implementation fails. The scope is `_docs/plan.md`; issue references below point to [the project backlog](https://github.com/Ramung55/MoodleHelper/issues). Historical issue documents and test names are leads, not current passing QA results. The working tree contained approximately 246 changed or untracked entries before this audit, so HEAD `08a325e` alone does not identify the audited implementation.

## Requirement traceability

Status is **unverified** unless explicitly stated. A file or test's existence is evidence of an implementation or intended check, not proof all acceptance criteria are satisfied. Issue grouping maps related scope; it does not assert each individual acceptance criterion has passed.

| MVP requirement | Related issues | Implementation evidence | Verification evidence and outstanding acceptance |
| --- | --- | --- | --- |
| Local Chrome dashboard, no account; local-first and read-only | #2, #6–#9, #46, #48–#49, #57–#58 | `frontend/src/routes`, `frontend/src/services/http-adapter.ts`, `backend/main.py`, `backend/database_config.py`, `extension/src` | Frontend suite passes below; `tests/test_contract.py`, `tests/test_sqlite_store.py`, `browser-workspace/e2e` exist. Full local journey, security boundaries and restart persistence not independently confirmed in this run. |
| Detect session, discover and select current courses | #3, #10–#12, #82, #84 | `extension/src/moodle-sign-in-probe.ts`, `moodle-courses.ts`, `course-discovery.ts`; frontend selection | Frontend tests include `moodle-courses.test.ts`, `course-selection.test.ts`; live authorized session and complete journey not tested. |
| Update while browsing and sync all selected courses, with freshness and failures | #18–#21, #83 | `extension/src/page-refresh.ts`, `scan-coordinator.ts`, `backend/scan_queue.py` | Browser workspace and live scan tests exist. Real page refresh and complete scan require live evidence; synthetic paths do not establish it. |
| Collect Moodle assignment, quiz and calendar deadlines | #13–#15, #20, #83 | `extension/src/moodle-assignments.ts`, `moodle-quizzes.ts`, `moodle-calendar.ts` | Fixture tests exist and frontend suite passed; live variants and end-to-end synchronization are unverified. |
| Track changes and notify with old and new dates | #22, #38–#39 | `backend/deadline_tracking.py`, `backend/reminders.py`, `backend/alert_delivery.py` | `tests/test_deadline_tracking.py`, `test_reminders.py`, `test_alert_delivery.py` exist; backend suite did not run and live notification delivery not established. |
| Suggest syllabus and import PDF/DOCX; extract locally, including English and Russian | #23–#29 | `frontend/src/services/local-documents.ts`, `extract-pdf.ts`, `extract-docx.ts`, `local-ocr-worker.ts`, `domain/assessment-mentions.ts` | Frontend suite passed, including local extraction tests; tests may be gated, and real-document/language coverage and all issue criteria are not established by this count. |
| Add clear dates with provenance, review uncertain dates and reconcile conflicts | #29, #31–#33 | `frontend/src/domain/syllabus-dates.ts`, `local-routing.ts`, `backend/reconciliation.py`, review components | `syllabus-dates.test.ts`, `local-review.test.tsx`, `tests/test_reconciliation.py`; backend test execution and complete acceptance unverified. |
| Teaching weeks without invented dates; configure calendar and breaks | #30, #52 | `backend/teaching_calendar.py`, `frontend/src/domain/teaching-weeks.ts` | `teaching-calendar.test.tsx`, `tests/test_teaching_calendar.py`, `tests/test_irregular_calendar.py`; frontend tests pass as part of suite, backend unrun. |
| Personal deadlines, edits, hiding and source preservation | #34–#35, #53 | `frontend/src/domain/personal-event.ts`, `AssessmentSheet.tsx`, backend overlays | Frontend personal-event and assessment-overrides tests passed in suite; backend regression and all issue criteria unverified. |
| Moodle submission status distinct from personal completion | #16, #35, #54, #81 | `extension/src/moodle-submission-status.ts`, `backend/submission_retention.py`, frontend assessment views | Mapper tests exist, but `extension/src/page-refresh.ts` marks submission unavailable in `liveRegistry`; the complete live path is not established. Draft/reopened variants remain unverified in `_docs/compatibility/sdu-moodle.md`. |
| Weekly counts, weighted workload and configurable warnings | #36–#39 | `frontend/src/domain/workload.ts`, `weekly-overview.ts`, settings components, backend reminders | Frontend workload tests passed in suite; actual browser notifications and backend checks unverified. |
| Materials links and optional selective offline download | #17, #40–#41, #85 | `extension/src/moodle-materials.ts`, `frontend/src/domain/material-library.ts`, `backend/material_downloads.py` | Frontend material tests passed in suite; `tests/test_material_downloads.py` and live integration exist but full live download path unverified. |
| Optional AI for difficult documents only with consent | #42–#44 | `frontend/src/components/mh/AiFallback.tsx`, `frontend/src/services/ai-gateway.ts`, `backend/ai_gateway.py` | Frontend consent/gateway tests passed in suite; backend provider tests not run, no real-provider consent/send verified. |
| Local backup, restore and deletion | #45, #55–#56 | `frontend/src/domain/backup.ts`, `backend/backup_restore.py`, `backend/local_erase.py` | Frontend backup and erase tests passed in suite; backend and restart behavior not verified in this audit. |
| Student journey and privacy | #3–#4, #47–#49 | `_docs/compatibility/sdu-moodle.md`, `browser-workspace/e2e`, `_docs/reviews/privacy-permissions.md` | Compatibility report records a 2026-11-01/02 authorized inspection, but several page variants and Russian interface are unverified. Browser E2E could not start. Historical review is not current end-to-end QA. |

## Tests run

- `bun run test` in `frontend`: **PASS**, 78 files, 1,524 tests, exit 0. This does not establish tests excluded by configuration or requiring opt-in ran.
- `bun run --cwd frontend typecheck`: **PASS**, exit 0.
- `uv run pytest`: **BLOCKED**, before collection; uv could not query the existing `.venv` interpreter (`ModuleNotFoundError: No module named 'python'` in its interpreter probe). No backend test results can be inferred.
- `bun run --cwd frontend test:e2e`: **BLOCKED** before browser tests; port 5173 was already in use. The existing process was not stopped. Extension build ran as a pre-step.
- Browser workspace Vitest suite: **PASS**, 19 files, 310 tests, exit 0.
- Compose end-to-end suite was not run; it starts containers and creates a temporary database volume. Live SDU and external AI tests were not run.

## Findings and limits

1. **Critical live submission integration gap:** `extension/src/page-refresh.ts` identifies the live submission adapter as unavailable. A mapper and retention code are not a working live collection path. Confirm how #16/#20/#81/#83 divide this acceptance before attributing incorrect closure.
2. **Live compatibility is incomplete:** the compatibility matrix documents real observations but marks drafts, reopened submissions, individual overrides, several quiz/calendar/folder variants and Russian/Kazakh interfaces unverified. Synthetic fixtures cannot establish these cases.
3. **Regression and contract status unknown:** backend and browser end-to-end suites did not execute; the frontend suite and typecheck alone cannot prove cross-process communication, contract parity, persistence across restarts, or delivery of notifications.
4. **Issue closure audit incomplete:** GitHub search returned no open issues in the preceding check and returned historical closed issue bodies, but the connector output does not supply reliable per-issue state and CLI access failed. The audit has not independently checked every criterion and closure comment; no issue is asserted incorrectly closed without that evidence.
5. The traceability above groups the scope, not a line-by-line acceptance audit. Precise per-criterion verdicts and some issue-specific verification remain outstanding. No end-to-end PASS should be inferred from historical checkpoints.

## Next action

Restore the project's Python test environment without overwriting local work, free or configure a separate browser-test port, and run backend, browser workspace and end-to-end suites. Then inspect every relevant issue and QA record against the current tree, and perform an authorized read-only SDU journey covering sync, persistence and submission tracking. Resolve the unavailable live submission path and record evidence before reassessing the verdict.


## Follow-up verification, 2026-11-08

- Existing alternate `.qa-venv` Python: `python -m pytest` completed with **1,467 passed, 4 skipped**, and 3 warnings. The normal `uv run pytest` remains blocked by its interpreter probe. The skipped Compose and PostgreSQL tests are not covered by this result.
- Browser E2E: **35 passed, 3 failed**. The document import test expects prior validation wording; the journey test expects the old review badge while the current UI shows the revised student-facing label. The privacy test counted one element matching its broad injected-element selector; the exact match has not been identified and no conclusion about exploitability is justified yet. The first two failures may also hide later assertions, so neither test is certified.
- A signed-in SDU dashboard was visible through the connected Chrome browser. This confirms access to the real site, not that MoodleHelper collected, stored, or displayed the live information.
- The development server was restarted on 127.0.0.1:5173 after the browser test.

Verdict remains **FAIL** until the three browser failures are investigated, the skipped tests are addressed as appropriate, and the live product journey and issue criteria are verified.

## Follow-up implementation and testing

- Using isolated Docker resources: Compose integration **2 passed**; PostgreSQL tests **3 passed**. The test-owned stack, volumes and database container were removed by their harnesses.
- The updated document-import test passed independently and in the complete browser run. The updated fixture journey and privacy tests passed independently. The privacy test now compares inline scripts before and after processing the malicious fixture, retaining checks for executed markers, handlers and unsafe links; the previously flagged baseline element was the theme bootstrap script.
- Complete browser run: **37 passed, 1 failed**. The fixture journey timed out because Start mock run remained disabled; an earlier focused run passed. This intermittent failure remains unresolved and the later steps of the failing run were not verified.
- A read-only live SDU assignment page visibly reports a submission state. This confirms the source exists, not that MoodleHelper synchronizes it. Implementation of a separately identified course-module submission path is in progress; final QA remains outstanding.

## Account-isolation review

Independent QA found that a configured non-demo namespace is not proof that the currently signed-in Moodle account is the matching account. Account switches could therefore contaminate a dataset, including through existing non-submission collectors. The new submission-specific path is deliberately fail-closed: the live registry reports it unavailable and backend ingestion rejects verified-mode submission observations. Independent scoped QA passed (286 backend, 141 frontend and 17 browser scan tests). This safeguard does not establish account binding for other collectors or deliver live submission tracking. Do not use these fixture results as evidence of a complete or safe live sync.

The original scope still requires updates while browsing. Issue #18 was closed against documented mock-backed criteria; this alone is not evidence that its closure was wrong. The live visited-page path needs trustworthy active-account binding and evidence for the specific displayed response before enabling it. MVP verdict remains **FAIL**.

## 2026-11-09 continuation

- The submission-only fail-closed safeguard received independent scoped QA PASS: 286 backend, 141 frontend and 17 fixture/network tests passed. It does not bind the active Moodle account, does not enable live submission tracking, and does not fix account isolation for the other live collectors.
- The complete frontend suite reported 1,525 passed. The backend suite reported 1,489 passed and four skipped; after displaying the summary its process did not exit, and was interrupted, so a clean command exit is **not established**. The four skipped Compose/PostgreSQL cases passed separately in isolated Docker runs before this final backend run.
- A browser startup-order experiment did not reliably fix the intermittent mock-bridge failure. The experiment was reverted; the last complete browser run remains 37 passed and one failed. The development server was restored.
- The signed-in Chrome window is present but its Codex browser connection was unavailable during this continuation; no new live product journey or account-switch verification was performed.

**MVP verdict remains FAIL**: active Moodle-account binding, live submission and visited-page refresh, the intermittent mock-bridge failure, and a clean final regression run remain outstanding. The previously existing working-tree changes and this work remain uncommitted; no issue was closed.

## Audit continuation, 2026-11-09 (current session)

**Verdict: FAIL; audit incomplete.** This session preserved the existing traceability table and prior evidence above. It independently confirmed `extension/src/page-refresh.ts:142` registers live submission collection as unavailable, so the product requirement to show available Moodle submission status is not demonstrated end to end. The compatibility report still identifies draft and reopened SDU variants as unverified. GitHub issue #16 is closed and explicitly scopes itself to an offline mapper, not the live integration; the missing integration alone does not prove that issue was incorrectly closed. Other closures and individual acceptance criteria have not been independently audited in this session.

Current attempts: `uv run pytest -q` failed before collection because the configured Python interpreter could not start; the alternate `.qa-venv` interpreter also could not start. `bun run test` in frontend failed before tests because Bun could not read the current directory. Browser workspace Vitest reported 19 failed suites and zero tests due to EPERM filesystem errors during setup; these are environment failures, not demonstrated product regressions. Browser E2E, Compose and PostgreSQL suites were not rerun in this session. Prior test results above are historical and do not establish a clean current run. The GitHub CLI could not connect, although the GitHub connector retrieved issue #16; the full backlog and issue comments remain unchecked. No application code or issue state was changed. The broad pre-existing working tree changes prevent identifying this audit with the commit alone.

A complete independent criterion-by-criterion audit and complete test run remain outstanding; this report must not be interpreted as confirming every requirement or identifying every incorrectly closed issue.

## Sequential frontend rerun, 2026-11-09

`bun run test` completed successfully with 78 files and 1,525 tests passed (exit 0). Earlier concurrent runs were interrupted after timeouts and do not establish product failures. The user can provide one live SDU account, not two; a live two-account isolation check remains unavailable. The fail-closed submission gate remains in place and the MVP verdict remains FAIL.
