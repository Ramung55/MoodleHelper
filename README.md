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
The generated API description is at http://127.0.0.1:8000/openapi.json.
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

## API operations

Every success returns HTTP 200. Data mutations return the complete Snapshot;
document imports and material downloads use the wrappers from `openapi.yaml`.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/connection` | Reports fictional demo connection |
| GET | `/api/snapshot` | Reads complete dataset |
| PUT | `/api/snapshot` | Validates then atomically replaces dataset |
| PUT | `/api/tracked-courses` | Replaces tracked ids with a bare string array |
| PATCH | `/api/assessments/{assessmentId}/overlay` | Updates separate personal layer |
| POST | `/api/personal-events` | Creates a personal assessment |
| DELETE | `/api/personal-events/{id}` | Removes personal assessment and overlay |
| POST | `/api/sync` | Returns final simulated course sync outcomes |
| POST | `/api/documents/import` | Accepts filename-only JSON, simulates extraction |
| POST | `/api/candidates/{candidateId}/review` | Confirms, corrects, or rejects candidate |
| POST | `/api/materials/{id}/download` | Returns unsupported download capability |
| PUT | `/api/alerts` | Replaces alerts with a bare Alert array |
| PATCH | `/api/settings` | Shallow-merges settings |
| DELETE | `/api/local-data` | Clears records and tracked ids, retaining other settings |
| POST | `/api/demo/reset` | Restores fresh fictional sample data |
| GET | `/api/ai/availability` | Reports unavailable AI with a reason |

For example, create an event with JSON:

```json
{"courseId":"c-csc","title":"Study group","type":"other","date":{"kind":"week","week":8}}
```

PATCH omits unchanged properties; nested settings objects must be complete.
Explicit nulls are invalid. Unknown properties are ignored. Invalid requests
return 422 with `{"message":"..."}` and preserve the previous dataset.
HTTP 404, 405, and 500 responses also use the message envelope. Missing personal
delete/review ids are successful no-ops; unsupported imports/downloads remain
HTTP 200 domain outcomes. Personal deletion preserves imported assessments.

## Storage and deployment boundary

Use the localhost command above. The API follows the specification's
`security: []`: no login, tokens, accounts, authorization, or user isolation.
Each application instance owns one shared process-local fictional dataset.
Every client of that instance sees the same data. Restarting clears changes;
multiple workers have independent datasets, so run the default single worker.
No database, filesystem persistence, external AI, or live Moodle access is used.
No CORS permissions are enabled. Hosted deployment and authentication remain
undecided in #2; this implementation does not resolve that deployment design.

`backend/storage.py` defines a repository protocol and copy-on-write,
lock-protected implementation. Replacing this boundary can add persistence in
a future task. `create_app(store=...)` allows an isolated repository per test.
Services implement adapter behavior; routers only bind HTTP to services.

## Contract limitations and verification

The root OpenAPI remains authoritative and unchanged. Broader issue #5 asks
for invalid-date/unsafe-URL validation, but the current wire contract explicitly
permits arbitrary timestamp/timezone/URL strings and only a date-shaped regex.
This backend implements those exact constraints, including date-shaped strings
that are not calendar dates. It does not claim to complete #5.

Override clearing remains unresolved (#53): omission means unchanged and null
is rejected. Sync/import progress callbacks and cancellation have no HTTP
transport (#19/#21). Imports accept filenames, never file bytes (#24), and
produce explicitly mocked candidates. Sync is simulated, including a failing
physics course while preserving earlier data. Downloads require the future
extension; AI remains unavailable even when settings contain consent. No
content is transmitted. The frontend keeps its existing mock services.

The pytest suite checks all 16 operations, required fields, union/enum/bound
validation, atomic restore failures, CRUD, personal/source separation, app
isolation, error envelopes and credential-free access. It validates actual
requests/responses with JSON Schema against `openapi.yaml` and compares the
generated route/model contract for fields, requiredness and constraints.
The installed Starlette version emits one httpx TestClient deprecation warning;
tests pass using the approved httpx dependency without adding another package.
