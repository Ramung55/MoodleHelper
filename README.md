# Moodle Helper local application

The backend uses Python 3.12–3.14 (3.13 selected in `.python-version`),
FastAPI, uv, and pytest. Install [uv](https://docs.astral.sh/uv/) first.
The existing TypeScript frontend in `frontend/` uses the local API by default.

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
The frontend retains its own `package.json`, Bun/Vite/Vitest commands, and
lockfile. Its design is preserved; `HttpAdapter` now binds its service contract
to FastAPI. The old DemoAdapter remains available for focused fixture tests.
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
Only the three optional overlay fields accept null as a clear command;
all other explicit nulls are invalid. Unknown properties are ignored. Invalid requests
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
No CORS permissions are enabled; the frontend development server proxies `/api`
to FastAPI on the same browser origin. Hosted deployment and authentication remain
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

The justified #53/#58 contract addition preserves overlay reset over JSON:
omission means unchanged; `titleOverride: null` removes the title, and
`dateOverride: null` removes both date and baseline. `overrideBase: null`
clears the baseline. A clear-date command with a nonnull baseline is rejected
atomically. Snapshot fields remain nonnullable and cleared keys are absent.
The HTTP adapter serializes explicitly present JavaScript undefined override
keys as null. Broader #53 product requirements remain independently tracked.
Sync/import progress callbacks and cancellation have no HTTP
transport (#19/#21). Imports accept filenames, never file bytes (#24), and
produce explicitly mocked candidates. Sync is simulated, including a failing
physics course while preserving earlier data. Downloads require the future
extension; AI remains unavailable even when settings contain consent. No
content is transmitted. The frontend shows these same truthful capability outcomes.

The pytest suite checks all 16 operations, required fields, union/enum/bound
validation, atomic restore failures, CRUD, personal/source separation, app
isolation, error envelopes and credential-free access. It validates actual
requests/responses with JSON Schema against `openapi.yaml` and compares the
generated route/model contract for fields, requiredness and constraints.
The installed Starlette version emits one httpx TestClient deprecation warning;
tests pass using the approved httpx dependency without adding another package.

## Run the full application

Use Python/uv as above and Node.js 22.12+ with Bun 1.3+ for the existing frontend.
In terminal 1, from the repository root:

```powershell
uv sync --locked
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

In terminal 2, from the repository root:

```powershell
cd frontend
bun install --frozen-lockfile
bun run dev --host 127.0.0.1 --port 5173
```

Open http://127.0.0.1:5173. The Vite server forwards `/api` to
http://127.0.0.1:8000; requests need no credentials. Keep both processes running.
Browser reload reads server state. Backend restart restores fictional sample
data until the separately approved persistence milestone is implemented.
Do not expose either development server publicly. A production build succeeds,
but a deployed host must separately proxy `/api`; no hosting is configured here.

Run frontend checks from `frontend/`:

```powershell
bun run test
bun run build
```

`http-live.test.ts` starts a real FastAPI child process on an available localhost
port using the uv-managed `.venv`, exercises the HTTP adapter, and stops it.
Run `uv sync` first. Other frontend tests cover all 16 mappings and UI error
preservation. No mocked request is used for the live integration tests.

The root repository tracks frontend source as ordinary files so a fresh root
checkout contains the full application. The pre-existing nested frontend Git
history is preserved locally, and its unrelated remote is never pushed by this
integration. Future application work should be committed from the root.
