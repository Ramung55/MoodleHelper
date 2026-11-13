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
| Track changes and notify with old and new dates | **verified** on the local stack with the synthetic harness (#106, 2026-11-13) up to delivery state `shown`; the real Windows toast, a real notification click and the denied case still need the owner |
| Suggest syllabus and import PDF/DOCX; extract locally | unverified |
| Add clear dates with provenance, review and reconcile | unverified |
| Teaching weeks; configure calendar and breaks | unverified |
| Personal deadlines, edits, hiding and source preservation | unverified |
| Moodle submission status distinct from personal completion | **verified** for submitted / not submitted (draft and reopened not available in this account) |
| Weekly counts, weighted workload and warnings | unverified |
| Materials links and optional selective offline download | links **verified**; download **verified** for one PDF, after confirming Chrome's Save As window |
| Optional AI with consent | unverified |
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
| 3 Notification, permission granted | **verified** up to `shown` within 2 min, exactly one issuance per change (fixture + auto). **Owner only:** that the Windows toast appeared, and a real click on it. The click target `/deadlines?id=<assessment id>` was opened in the tab and showed that assessment's sheet; the real click is covered only by mocked tests. |
| 4 Notification, permission denied | **auto only; owner check pending.** Chrome's per-extension notification block is in `chrome://settings`, which Claude in Chrome cannot open. |
| 5 No duplicates | **verified** for change records, Alerts rows and OS issuance (one attempt id per alert, none after the restart). **Owner only:** count of toasts seen; extension reload not exercised (`chrome://extensions` unreachable). |
| 6 Gains a date | **verified** (a) and (b) (fixture + auto) |
| 7 Loses a date | **verified** (a) and (b) (fixture + auto) |
| 8 Dashboard only when hidden or reminders disabled | **auto only** (`test_source_change_alert_keeps_old_new_distinct_ids_and_hidden_policy`, `test_denied_failed_and_ineligible_states_are_truthful`) |
| 9 Restart | **verified** (fixture + auto) |

No defect found. Windows-level notification settings are a known limitation: Chrome would still report `granted` and the backend would record `shown`.


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
