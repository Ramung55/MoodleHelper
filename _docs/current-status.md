# Current status audit

Audit date: 2026-11-08. This is a preliminary audit of the current working tree, not a release certification. The repository has extensive pre-existing tracked changes and untracked files; HEAD is `3f65ec6` (PostgreSQL storage support). The changed tree, rather than HEAD alone, determines current behavior. No application files were intentionally changed during this audit.

## Architecture and component assessment

| Component | Status | Evidence and limits |
| --- | --- | --- |
| Dashboard | PARTIAL | React/TanStack frontend under `frontend/src`, with routes for deadlines, planner, materials, alerts and settings. Many files have uncommitted changes; current operation was not verified. |
| Frontend–backend integration | PARTIAL | `frontend/src/services/index.ts` selects `HttpAdapter` and explicitly says HTTP errors surface without fixture fallback. The adapter and integration tests exist, but a running end-to-end connection was not verified in this audit. |
| FastAPI backend | PARTIAL | `backend/main.py`, routers, schemas and services implement substantial API functionality. Tests could not run in this environment. |
| API contract | PARTIAL | `openapi.yaml` and `tests/test_contract.py` exist; the latter compares operations and schemas and exercises responses, with a list of internal operations. No passing test result was obtained, so conformance is unverified. |
| Storage | PARTIAL | `backend/database_config.py` defaults to file-backed SQLite at `data/moodle-helper.sqlite3` and accepts PostgreSQL URLs; memory fallback is rejected. Persistence is designed in, but restart behavior was not independently tested here. Browser-local document storage also exists. |
| Moodle collection and extension | PARTIAL | Extension source includes course, assignment, quiz, calendar, material and submission collectors, scan coordination and queues. `_docs/plan.md` explicitly says live SDU Moodle compatibility remains unverified. README describes synthetic/mock paths; these are not proof of live collection. |
| Syllabus extraction, review and AI | PARTIAL | Frontend services include PDF, DOCX, OCR, local review and AI gateway; backend includes local syllabus and AI modules. Their full acceptance criteria and real provider behavior were not verified. |
| Planning, reminders, materials and backups | PARTIAL | Dedicated frontend, backend and test modules exist for these features. Existence alone does not establish complete behavior. |
| Local startup | PARTIAL | README documents `uv sync`, `uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000` and frontend/extension workflows. Startup was not established: the configured Python interpreter could not launch. |

## GitHub issues

Actual open and closed counts and the individual issue states are **unknown**. `gh issue list --state all --limit 500 --json number,title,state,body` failed with `error connecting to api.github.com`. Consequently no closed issue is independently certified against its acceptance criteria, and no list of open issues can responsibly be provided. Git history contains references to issues #42, #44, #86 and #87, but a commit reference does not establish current issue state or acceptance. Historical counts should not be treated as current counts.

## Tests and limitations

- `uv run pytest -q` failed before collection: `.venv/Scripts/python.exe` could not be launched (exit 101). No tests passed or failed as a result of this attempt; the application itself has not been shown broken by this environment error.
- Frontend, extension, browser and contract tests were not run. Tests exist for API contracts, SQLite, PostgreSQL, live scan, frontend HTTP integration and browser journeys; their presence is not a current passing result.
- This preliminary review did not exhaustively read all specifications, source files, acceptance criteria or issue history. It cannot identify every missing or broken requirement, nor establish that any major component is complete.

## Known gaps and blockers

1. Live SDU Moodle compatibility is explicitly unverified in the project scope. Synthetic scans and fixtures cannot settle it.
2. GitHub connectivity prevents current backlog counts and issue-by-issue verification.
3. The Python environment prevents backend tests and local startup verification. Avoid replacing the existing environment without first diagnosing its interpreter and preserving local data.
4. Contract conformance, frontend/backend communication and persistence across restart remain unverified in the current working tree.
5. The extensive dirty working tree makes attribution to commits difficult; preserve the existing changes while auditing.

## Recommended next actions

First restore access to GitHub and a working project Python environment, without changing application code or overwriting the existing work. Then enumerate every open and closed issue and map each acceptance criterion to current code and test evidence; run the backend, frontend and extension suites, contract checks, and a local restart/integration journey. Finally validate the actual read-only flow against SDU Moodle with an authorized session and update this report with results and concrete failures. This evidence-gathering pass is the recommended next step before selecting implementation work.
