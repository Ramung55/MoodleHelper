# Remaining backlog dependency and feasibility inventory

2026-10-25, reviewed against clean `b53373d` and canonical open issue bodies. This is triage, not QA or completed implementation. #1 and #57 are closed backend work; 55 original issues remain open (#2–#56), plus focused integration follow-up #58 created after explicit approval. Existing frontend functionality must be inspected and tested before assigning new code; a mock screen is not evidence of live collection or persistence.

## Mandatory gates

1. Backend checkpoint: independently verify existing #1/#57 tests, startup, contract and Swagger; record evidence.
2. Integration checkpoint: focused issue [#58](https://github.com/Ramung55/MoodleHelper/issues/58), approved by the user after the initial rejection. Preserve reset via coordinated #53 decision. No new dependencies anticipated.
3. Persistence checkpoint: the human explicitly approved SQLAlchemy>=2,<3 on 2026-10-25, superseding deferral. #58/#50/#2/#5 prerequisite QA passed before #6 implemented environment-configured SQLite, migrations/atomicity, restart checks and namespace isolation. See the milestone-3 checkpoint; independent #6 QA is still required.
4. Remaining implementation starts only after those gates. While milestone 3 is blocked, documentation, dependency review and feasibility triage may proceed; do not silently implement milestone-4 features out of order.

## Exact external/decision blockers

- GitHub integration issue creation: initial review rejected broader mutation under earlier backend-only authorization. Resolved when the user explicitly authorized expanded scope and the concrete nonduplicate issue; #58 was then created successfully. This is no longer a blocker.
- SQLAlchemy: dependency approval resolved (SQLAlchemy>=2,<3 plus ordinary locked transitives only). #6 implementation is ready for independent QA; milestone-4 remains blocked until #6 PASS.
- #3 live compatibility: requires the user's authorized SDU Moodle browser session and permitted read-only access to representative course/activity/material pages. No credentials/session evidence supplied here; synthetic fixtures cannot substitute for observed compatibility.
- Architecture #2/#50/#6: backend authority and trusted process-bound demo/Moodle origin/profile/user partitioning are agreed and implemented. Future verified collector identity/permission handoff remains #9/#3; public hosting/accounts and broad browser permissions remain unapproved.
- #25/#26/#27: PDF/DOCX/OCR libraries and OCR language assets are provisional and unapproved. Request exact packages only when needed after reviewing installed tooling; never claim filename-only mock imports extract bytes. #24 needs an explicit local file-content handoff before extraction; no implicit external upload.
- #42: provider choice, retention/cost policy and nonprivate evaluation evidence remain undecided. Documentation can record a still-blocked decision. #43 mock-provider gateway is locally feasible once concrete policy is fixed; real provider use additionally needs owner approval, server-side credentials and bounded budget. No paid calls authorized.
- #47 browser automation: Playwright is proposed, not approved as a dependency. Existing computer-use/browser tooling can supply manual evidence, but cannot be mislabeled as the documented automated journey. Any new test dependency needs approval.
- #49 pilot: approved HTTPS dashboard origin and live SDU smoke evidence are absent. Local packaging/docs can proceed later with truthful unverified labels; public distribution/store submission/paid hosting remain separately authorized work.

## Per-issue order and disposition

Every row retains the issue's original acceptance criteria. “Feasible” means locally implementable after gates/dependencies, not already PASS. Grouped rows still require one-issue-at-a-time implementation and independent QA.

| Issues | Dependencies and next review | Feasibility / unresolved evidence |
| --- | --- | --- |
| #50 | Existing frontend manifests; new explicit backend choice | Documentation feasible; preserve working packages. Reconcile actual commands rather than presenting Python/TypeScript as alternatives. No dependency approval implied. |
| #2 | #50; backend and adapter operations | Document local authority/namespace, bridge origins/operations, trust/errors, gaps. Update now-stale assertion that DemoAdapter is default only when integration actually changes it. |
| #5 | #2/#50; current schemas | Map every field/union/default and ownership. Real invalid dates/unsafe URL validation conflicts with permissive current wire contract; explicitly agree domain validation versus coordinated schema change. Cutoffs/attempts/folders/calendar/reminders are missing fields, not completed support. |
| #6 | Prerequisites and SQLAlchemy approval resolved | SQLite implementation and restart/migration/failure/isolation checks complete at engineering handoff; independent QA pending. Original observable durability, isolation and failure guarantees retained; see milestone-3 checkpoint. |
| #51 | #50 | Preserve integrated frontend; inspect missing extension/shared packages. Any proposed manifests/dependencies need approval. |
| #7 | #51 | Minimal MV3 shell feasible; actual Chrome unpacked loading and unrelated-site noninjection need browser evidence. WXT is provisional, not required if dependency-free approved build suffices. |
| #8 | #50/#51 | Inspect existing routes first; verify loading/empty/error switches, deep links and keyboard behavior. No need to rebuild completed UI. |
| #3 | Authorized SDU session | Externally blocked live inspection; write explicit unverified coverage rather than invent page support. |
| #4 | #3 coverage, #5 paths | Synthetic cases feasible and labeled; observed supported variants remain blocked on #3 evidence. Sanitize private content and inert scripts. |
| #9 | #2, #7, repository mock | Allowlisted versioned bridge feasible with fixtures; ping/hello alone does not fulfill operation catalog. Never allow arbitrary privileged URL fetch. |
| #10 | #3/#4 | Independent access detector feasible on labeled synthetic fixtures; live SDU compatibility stays unverified. |
| #11 | #3/#4/#5/#10 | Course parser and dedup fixtures feasible; supported live variants depend on #3. |
| #12 | #5/#6/#11 | Existing selection UI/backend partly cover; reopening persistence, exclusion retention and failure rollback require tests. |
| #13 | #3/#4/#5/#10 | Assignment parser fixtures feasible; distinct due/cutoff schema decision needed. Individual overrides/timezones require evidence. |
| #14 | #3/#4/#5/#10 | Quiz parser fixtures feasible; attempts/open/close representation must be agreed, not discarded. |
| #15 | #3/#4/#5/#10 | Calendar fixtures feasible; identity/duplicate/date precision rules required. |
| #16 | #3/#4/#5/#10 | Submission status fixtures feasible; preserve completion separation and unknown/reopened cases. |
| #17 | #3/#4/#5/#10 | Material/folder parser fixtures feasible; folder relationships currently not in wire schema. |
| #18 | #6/#7/#10–#17 | Browsing update coordinator feasible on fixture pages; real navigation/session behavior remains live-unverified. |
| #19 | #2/#5/#6 | Durable resumable/cancellable bounded queue after persistence; final-only /api/sync is insufficient. Define transport/job model explicitly. |
| #20 | #3/#10–#19 | Fixture coordinator/pacing/retry traces feasible; at most one request, one-second spacing, two retries (2/5 seconds or longer Retry-After); no false deletion after failure. |
| #21 | #2/#19/#20 | Existing UI can be reused; per-course progress, cancellation/restart and distinct freshness require real queue contract beyond final HTTP snapshots. |
| #33 | #5/#6; extraction/collector records | Reconciliation identity/conflict model before change detector; fixture implementation feasible. |
| #22 | #5/#6/#33 | Deterministic history/precision/equivalent-time checks feasible; simulated fixed change is not full source detection. |
| #23 | #17 records or mocks | Deterministic syllabus suggestions feasible; dismissal persistence and reasons need explicit state. No content transfer on display. |
| #24 | #2/#5/#6; chosen file handoff | File validation/hash/dedup feasible with existing browser APIs; explicit content boundary required, 20 MiB configurable limit, signature/corruption/cancel states. |
| #25 | #24; approved PDF extraction tooling | Dependency decision required; real bilingual page/table/evidence/corrupt/encrypted/image-only fixtures then feasible. |
| #26 | #24; approved DOCX tooling | Dependency decision required; table/paragraph provenance and inert output, corrupt/protected/cancellation tests then feasible. |
| #27 | #25; approved OCR/runtime/assets | Dependency/assets approval required; 20 pages, 120 DPI, 60 seconds/page, bilingual provenance/cancel/offline checks. |
| #28 | #5/#25–#27 | Deterministic bilingual detection can use text fixtures independently; do not claim unavailable extractor integration. |
| #29 | #5/#28 | Explicit date parser feasible; ambiguity/missing year/impossible dates and row association retained. |
| #30 | #5/#29 | Semester mapping feasible after schema agreement for breaks/settings; full-week breaks only, unknowns unresolved. |
| #52 | #30 | Irregular calendars/partial-week override validation feasible; no institutional numbering guessed. |
| #31 | #5/#28–#30 | Confidence routing feasible from fixtures; auto-confirm only specified clear evidence, uncertain stays reviewable. |
| #32 | #6/#31 | Existing review UI must be verified for correction/reject/evidence and failure persistence; mock candidates alone incomplete. |
| #34 | #5/#6 | Existing event forms/CRUD partly cover; test real calendar validation, no invented times and persisted edit/delete. |
| #53 | #2/#5/#6/#22 | Reset wire prerequisite is proposed explicitly in integration draft. Full resync conflict/hide/restore/latest-source/date-error criteria remain for QA. |
| #54 | #5/#6/#16/#36/#38 | Completion UI/backend partly cover; persistence, resync separation, reminder/workload eligibility and reopened actionability need tests. |
| #35 | #5/#6/#33/#34/#53/#54 | Inspect existing list/details; verify filters, unknown precision/status, source conflicts, empty/failure/accessibility states. |
| #36 | #5/#30/#54 | Existing workload logic reusable; verify completed-but-reopened actionability and all precision buckets against original criteria. |
| #37 | #36 | Inspect existing weekly overview; threshold changes, uncertain/unallocated events, accessible display and empty/error states need QA. |
| #38 | #6/#22/#30/#36 | Reminder persistence/reconstruction and Chrome alarms; add explicit 7-day busy-week lead schema decision (current schema lacks it). Date-only local reminder is not a due time. |
| #39 | #6/#7/#22/#38 | Browser notification permission, durable dedup and route destinations need Chrome tests; no email/push service. |
| #40 | #17 or fixtures; safe link policy | Existing materials library partly covers; folders/schema, search Russian, stale/login warnings and distinct failure states need validation. |
| #41 | #7/#17/#40 | Explicit Chrome downloads can use authorized fixtures; real Moodle authenticated access remains session-dependent. Never save login HTML as file. |
| #42 | Primary-source provider policy/evaluation | Documentation may mark selected provider blocked; no paid request or upload. Owner decision and credentials absent. |
| #43 | #42 concrete bounds; approved runtime | Mock gateway feasible with bounded payload/rate/concurrency/timeout/cost, secret-safe diagnostics; real service remains external blocker. |
| #44 | #24/#31/#32/#42/#43 | Consent/local fallback UI feasible using mock gateway; genuine external call blocked on provider approval/credentials. |
| #45 | #5/#6 | Existing backup export must verify consistent snapshot, redaction, metadata/counts/empty/failure behavior. No offline-binary promise. |
| #55 | #45/#6/#38 | Atomic restore and reminder rebuild with wrong-identity/version/size/failure checks; bare Snapshot PUT alone insufficient. |
| #56 | #6/#19/#24/#38/#39 | Existing API clears arrays but retains settings; original issue asks confirmed deletion including settings/jobs/cache/alarms and no resurrection. Needs justified contract alignment, not silent closure. |
| #46 | #9/#10/#12/#20/#21/#30/#39/#44 | Existing onboarding inspected after dependencies; resumable state, denied notifications and separate AI consent need real tests. |
| #47 | Full feature journey; approved automation tooling | Automated fixture Chrome journey feasible once tooling approved; worker restart and deliberately failing artifact required, no live credentials. |
| #48 | Implemented permissions/bridge/doc/AI paths | Evidence review feasible after features; findings require linked issues and fixes through workflow, not certification by assertion. |
| #49 | #3/#47/#48; HTTPS origin decision | Packaging/docs feasible with unverified labels, live smoke/approved origin externally blocked. No publication/distribution authorization. |

## Suggested post-gate execution batches

Keep execution sequential per issue: #50 → #2 → #5 → reconcile/complete #6; #51 → #7 → #8; document #3 blocker and build #4 fixtures honestly; #10 → #11 → #12 → #13–#17 → #9 → #18 → #19 → #20 → #21; #33 → #22; #23 → #24 → approved #25/#26/#27 → #28 → #29 → #30 → #52 → #31 → #32; #34 → #53 → #36 → #54 → #35 → #37 → #38 → #39 → #40 → #41; #42 → mock #43 → #44; #45 → #55 → #56 → #46 → #47 → #48 → #49. If a dependency is externally blocked, retain its exact unmet criteria and continue only with a genuinely independent fixture/document path. Do not convert a mock implementation into a live-compatibility PASS.
