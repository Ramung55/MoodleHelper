# MVP verification audit

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
