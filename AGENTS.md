# Agent guidance

MoodleHelper helps SDU students track Moodle deadlines, assessments, materials and workload. Its React/TanStack dashboard in `frontend/` uses a local FastAPI backend in `backend/`; the Chrome extension in `extension/` collects Moodle information, and shared browser contracts live in `shared/`. The backend uses persistent storage, SQLite by default. Moodle access is read-only; preserve the privacy and consent decisions in the specifications.

## Run and test

From the repository root, install backend dependencies with `uv sync`, run the backend with `uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000`, and run its suite with `uv run pytest` (or `uv run pytest tests/test_home.py` for one file). Use uv for backend dependency management; dependencies belong in `pyproject.toml` and must not be added without asking.

From `frontend/`, use `bun install --frozen-lockfile`, then `bun run dev --host 127.0.0.1 --port 5173`; run frontend tests with `bun run test`. The development server proxies API requests to the backend. See `README.md` for extension builds, browser tests, configuration and further commands. Run tests appropriate to the change and report failures or tests you could not run.

## Documents to read

- All tasks: this file, `_docs/process.md`, the issue and its acceptance criteria, and relevant project specifications. The product scope is `_docs/plan.md`; detailed specifications, decisions and contracts are under `_docs/`, including `_docs/architecture/`.
- Grooming: `_docs/task-template.md` and `_docs/team/pm.md`.
- Implementation: `_docs/team/software-engineer.md` and the relevant specifications, architecture decisions and contracts. For API changes, read root `openapi.yaml` and related contract documentation.
- QA: `_docs/team/qa-engineer.md`, the issue, relevant specifications and test instructions; check the actual implementation independently.

## Issue workflow

Work on one GitHub issue at a time. Follow the orchestrator lifecycle in `_docs/process.md`: groom before implementation, implement and test, then obtain independent QA against every acceptance criterion. The engineer does not close issues; the orchestrator closes only after QA passes. Read acceptance criteria before starting and before closing. Preserve existing decisions and commit regularly. Do not change issue scope, create follow-ups, post comments or close issues when contrary to the user's instructions.
