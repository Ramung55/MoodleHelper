# In-memory backend

From the repository root, using the existing approved dependencies:

```powershell
uv sync --locked
uv run uvicorn backend.memory:app --host 127.0.0.1 --port 8000 --workers 1
```

Swagger UI: <http://127.0.0.1:8000/docs>. Generated schemas:
<http://127.0.0.1:8000/openapi.json>. The ASGI factory is also available as
`uv run uvicorn backend.memory:create_app --factory --host 127.0.0.1 --port 8000`.
Run `uv run pytest` and `uv run pytest tests/test_home.py` from the root.

This entry point starts a fresh isolated `InMemoryStore` at each application
lifespan. It never opens a database, ignores database and Moodle namespace
configuration, and loses all changes on restart. Use one localhost worker:
workers have independent datasets. All clients reaching that worker share its
fictional sample data. No account, login or authorization is specified by
`openapi.yaml` (`security: []`). Process binding headers are context preconditions,
not credentials. Do not expose this shared local dataset publicly.

The existing `backend.main:app` remains the separate SQLite-backed entry point.
No persistence, dependency, frontend service or UI changes are part of this work.

## Available operations

The unchanged authoritative contract currently declares 42 operations. These
24 operations use the existing modular routers, schemas, services and memory
repository (with the dataset identity limitation below):

| Method | Path |
| --- | --- |
| GET | `/api/connection` |
| GET | `/api/bridge-context` |
| GET | `/api/local-context` |
| GET, PUT | `/api/snapshot` |
| POST | `/api/courses/discovery` |
| PUT | `/api/tracked-courses` |
| PATCH | `/api/assessments/{assessmentId}/overlay` |
| POST | `/api/personal-events` |
| DELETE | `/api/personal-events/{id}` |
| POST | `/api/sync` |
| POST | `/api/documents/import` |
| POST | `/api/candidates/{candidateId}/review` |
| POST | `/api/materials/{id}/download` |
| PUT | `/api/alerts` |
| PATCH | `/api/settings` |
| DELETE | `/api/local-data` |
| POST | `/api/demo/reset` |
| GET | `/api/ai/availability` |
| POST | `/api/reconciliation/pairs` |
| POST | `/api/reconciliation/decisions` |
| POST | `/api/syllabus-revisions/preview` |
| POST | `/api/syllabus-revisions/confirm` |
| POST | `/api/syllabus-suggestions/dismissal` |

Success responses use HTTP 200 and the declared Snapshot or wrapper schema.
Invalid requests use HTTP 422 and `{ "message": "..." }`; stale supplied process
bindings use 409. Personal event CRUD and overlays preserve source observations;
replacement is validated atomically. Missing personal deletion/review IDs retain
the contract's no-op behavior. Reset creates fresh samples; local deletion retains
non-course settings. The existing comprehensive request/response contract and CRUD
tests run against both memory and SQLite, supplemented by entry-point tests.

Sync and filename-only imports are explicitly simulated; imports receive no file
bytes. Downloads truthfully return `supported: false`; AI is unavailable and sends
no content. These are existing contract outcomes, not live Moodle capabilities.

## Contract limitations approved for this memory mode

The present OpenAPI contract has progressed beyond historical issue
[#57](https://github.com/Ramung55/MoodleHelper/issues/57), which was already closed
after independent QA. The user selected keeping that contract unchanged and
reporting durable features as blocked. This entry point does **not** fulfill the
complete current-contract definition of done:

* Fifteen durable operations remain registered and documented, but valid requests
  with the required current binding return HTTP 503 with
  `{ "message": "Queue requires file-backed SQLite storage." }`. They do not
  mutate the memory Snapshot. Missing/stale bindings still fail first with 409;
  malformed requests with a current binding still fail validation with 422.

  | Method | Path |
  | --- | --- |
  | GET, POST | `/api/queue/current` |
  | POST | `/api/queue/runs` |
  | GET | `/api/queue/runs/{runId}` |
  | POST | `/api/queue/runs/{runId}/cancel` |
  | POST | `/api/queue/claim` |
  | POST | `/api/queue/renew` |
  | POST | `/api/queue/finish` |
  | POST | `/api/scan/runs` |
  | GET | `/api/scan/runs/{runId}` |
  | POST | `/api/scan/runs/{runId}/cancel` |
  | POST | `/api/scan/claim` |
  | POST | `/api/scan/renew` |
  | POST | `/api/scan/finish` |
  | GET | `/api/scan/jobs/{jobId}/pages` |

* The three collection operations are registered but collection is disabled:
  GET `/api/collection-context` reports `mode: disabled`; POST
  `/api/collection/visits` and `/api/collection/refresh` cannot ingest data and
  return the existing context rejection for otherwise valid requests. This
  entry point supplies no synthetic provider or verified live Moodle identity.
* GET `/api/local-context` returns a random dataset ID stable only within one
  lifespan. It changes on restart, unlike the persistent identity described by
  the current contract. Durable queue recovery, persistent insertion order and
  persistent dataset identity fundamentally require storage beyond memory.

No specification was silently changed, no duplicate issue was created, and no
unrelated persistence, collector, frontend or backlog acceptance is claimed.
