# Moodle Helper backend

The backend uses Python 3.12–3.14 (3.13 selected in `.python-version`),
FastAPI, uv, and pytest. Install [uv](https://docs.astral.sh/uv/) first.
The frontend remains its existing independent TypeScript package in `frontend/`.

From the repository root:

```powershell
uv sync
uv run pytest
uv run pytest tests/test_home.py
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000/docs for Swagger UI.
No Moodle login, extension, frontend process, or external account is needed.
`uv.lock` pins the approved dependencies; `uv sync --locked` checks it unchanged.

## Toolchain decision and outstanding documentation

The user's backend instruction selects FastAPI with uv/pytest and in-memory
storage. Existing `AGENTS.md` commands remain applicable to the backend.
The frontend retains its own `package.json`, npm/Vite/Vitest commands, and
lockfiles; this setup neither replaces it nor connects its mock services.
The extension/shared browser package layout remains unimplemented.

Issue [#50](https://github.com/Ramung55/MoodleHelper/issues/50) remains open:
`_docs/plan.md` still describes the frontend and backend choice as unresolved
and says no application code exists. That historical project specification,
AGENTS.md, and agent configurations are preserved as requested. This guide
records the current backend decision without claiming that #50 is complete.
