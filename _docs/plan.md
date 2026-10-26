# Moodle Helper — Project Scope

## Purpose

Help SDU students track deadlines, discover assessments mentioned in syllabuses, organize course materials, monitor submission status, and anticipate busy weeks.

Target Moodle: https://moodle.sdu.edu.kz

This document records the agreed product scope. The local FastAPI backend and frontend/API integration have passed independent QA; compatibility with live SDU Moodle remains unverified. See the [toolchain decision](architecture/toolchain.md) and milestone checkpoints below for implemented boundaries.

## Audience and platform

- Students at SDU; support for other universities is outside the first version.
- Chrome extension for collecting Moodle information using the student's existing logged-in session.
- Separate website for the main dashboard.
- First version works in the connected Chrome browser, without an account.
- Data stays on the student's device by default. Optional cloud sync and accounts can come later.
- Moodle access is read-only: the tool never submits assignments or changes Moodle data.

## Course selection and synchronization

- Suggest current courses and let students adjust the selection to exclude old or irrelevant courses.
- Update course information while students browse Moodle.
- Provide a “Sync all courses” action for a complete check of selected courses.
- When a deadline changes, update it and notify the student, showing the old and new dates.

## Deadlines and assessments

- Collect deadlines available in Moodle.
- Extract exams, quizzes, and assignments from syllabus PDFs and documents, including items missing from Moodle.
- Suggest likely syllabus files found in Moodle and allow manual uploads.
- Support English and Russian syllabus extraction initially.
- Process documents locally first, with optional cloud AI processing for difficult files, subject to student consent.
- Add clear extracted dates automatically with source links.
- Flag uncertain dates for student review.
- When Moodle and a syllabus disagree, prefer Moodle and display the conflict.
- Show events such as “quiz in Week 6” in the relevant teaching week without inventing an exact deadline. Teaching-week mapping needs a semester start date.
- Allow students to add personal deadlines, edit extracted events, and hide irrelevant items while preserving original source information separately.

## Submission tracking

- Show Moodle-reported submission status, including submitted work, drafts, and work requiring resubmission when that information is available.
- Keep Moodle's status separate from the student's personal completion check.
- Let students mark work done themselves, including work submitted outside Moodle.
- Personal completion does not change Moodle's submission status.

## Weekly planning and warnings

- Show how many assignments and other assessment deadlines fall in each week.
- Show estimated workload using different weights for exams, quizzes, and assignments.
- Let students adjust workload settings and warning thresholds.
- Warn in advance when too many deadlines or too much estimated work is approaching.
- Deliver warnings through the dashboard and browser notifications, with adjustable timing.
- Email notifications are outside the agreed first-version scope.

## Course materials library

- Collect and organize links to lectures, presentations, PDFs, and other course materials from selected Moodle courses in one place.
- Allow optional downloads of selected materials for offline access.
- Do not automatically download every file.

## Intended student experience

1. Install the Chrome extension and log into SDU Moodle.
2. Review the suggested current courses and adjust the selection.
3. Run the first complete sync.
4. Review suggested syllabus files or upload additional documents.
5. Review uncertain extracted dates and visible date conflicts.
6. Open the website dashboard to inspect deadlines, weekly workload, submission status, and materials.
7. Set notification timing and workload thresholds.
8. Receive updates while browsing Moodle and use “Sync all courses” to refresh the complete picture.

## First-version boundaries

- SDU Moodle only.
- Chrome only.
- English and Russian syllabus extraction.
- No required account or cross-device sync.
- No assignment submission, file upload to Moodle, or other Moodle modifications.
- No email notifications.
- Optional cloud AI is a separate opt-in from future cloud storage or sync.

## Questions still to resolve

- How the separate website securely receives and stores local extension data.
- Which SDU Moodle pages and activity types expose reliable deadlines and submission states.
- Exact document formats supported: PDF and which Word/Docs formats; whether scanned PDFs require OCR.
- How to identify duplicate assessments across Moodle and syllabuses.
- How personal date edits interact with later source changes.
- How semester start dates, breaks, and teaching-week numbering are configured.
- Default workload weights, warning thresholds, and notification lead times.
- How sync failures, expired sessions, unavailable courses, and stale data are displayed.
- Which cloud AI provider to use, what content is sent, and consent details.
- Dashboard interface language and design.
- Data deletion, export, backup, and storage limits.
- Release milestones and acceptance criteria.

## Development workflow

- Follow [AGENTS.md](../AGENTS.md) for project commands and dependency rules, and [process.md](process.md) for the working process.
- Tasks are tracked as [GitHub issues](https://github.com/Ramung55/MoodleHelper/issues); [tasks.md](tasks.md) is the local issue index. Work on one issue at a time.
- Read the issue's acceptance criteria before starting and before closing it. All issues now use [task-template.md](task-template.md), following the [PM role](team/pm.md), with Goal, Acceptance criteria, Out of scope, and Constraints sections.
- Commit regularly. When revising documents based on corrections, commit current work before making those revisions.
- Ask before adding a dependency. Dependency additions belong in `pyproject.toml`, as specified in AGENTS.md.

## Implemented toolchain decision

The TypeScript React/TanStack/Vite frontend in `frontend/` and the Python FastAPI backend in `backend/` are complementary implemented packages. Root `pyproject.toml`, `uv.lock`, and `tests/` use the existing AGENTS.md uv/pytest commands; `frontend/package.json` and `frontend/bun.lock` retain the frontend's Bun/Vite/Vitest commands. The default frontend HTTP adapter now calls the local backend through a same-origin development proxy. Exact paths, verified runtimes, commands, dependency approvals and remaining decisions are recorded in [architecture/toolchain.md](architecture/toolchain.md), resolving the earlier Python-versus-TypeScript ambiguity without replacing either package.

The backend now implements environment-configured file SQLite through explicitly approved SQLAlchemy, with atomic Snapshot transactions, versioned migrations, source replay and trusted startup namespace partitioning. [Storage operations](architecture/sqlite-storage.md) and the [milestone-3 checkpoint](milestone-3-checkpoint.md) record behavior and verification; #6 still requires independent QA. Backend authority supersedes the old extension-owned storage proposal. This does not claim authentication, live identity discovery, live collection, document-byte extraction or external AI. The extension/shared package and future credential-free collector handoff remain #51/#7/#9/#3.

## Current planning status

All 49 original GitHub issues were groomed one at a time, followed by seven linked planning/scope follow-ups (#50–#56). Focused backend and integration follow-ups were added as #57 and #58 where no existing issue owned that work. GitHub remains the source of truth for current issue state; [tasks.md](tasks.md) is the historical local index and [backlog-feasibility.md](backlog-feasibility.md) records the remaining dependency and blocker review.

Bootstrap [#1](https://github.com/Ramung55/MoodleHelper/issues/1), in-memory API [#57](https://github.com/Ramung55/MoodleHelper/issues/57) and frontend/API integration [#58](https://github.com/Ramung55/MoodleHelper/issues/58) are closed after independent QA. The [backend checkpoint](milestone-1-checkpoint.md) records the first gate; the [integration checkpoint](milestone-2-checkpoint.md) and final [QA PASS](https://github.com/Ramung55/MoodleHelper/issues/58#issuecomment-6397890196) record the second. Current engineering verification includes 91 backend tests, 49 frontend tests and a passing frontend production build; QA verified the real browser create/reload workflow and the escaped-identifier fix. This is not completion of the broader product backlog.

The mandatory order is in-memory backend PASS → frontend/API integration PASS → SQLite/SQLAlchemy persistence PASS → remaining feature implementation. SQLAlchemy approval and #50/#2/#5 prerequisites are resolved; #6 implementation is complete at engineer handoff and awaits independent QA. Milestone-4 features remain gated on that verdict. Grooming or documentation linkage does not count as implementation or QA PASS for other issues.
