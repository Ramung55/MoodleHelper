# Milestone 3 — SQLite persistence checkpoint

## Prerequisites recorded before implementation

2026-10-26: #58 integration QA PASS and its committed checkpoint, #50 and #2
independent QA PASS, and #5 model/identity QA PASS are complete. #5's final
[independent verdict](https://github.com/Ramung55/MoodleHelper/issues/5#issuecomment-6405946935)
verified 175 backend tests and additional probes; the orchestrator closed #5.
The human explicitly approved `SQLAlchemy>=2,<3` through uv, including ordinary
locked transitive dependencies, on 2026-10-25. No other direct dependency is
approved. The orchestrator authorized #6 implementation after those gates.

## Implemented boundary

`45caf76` adds the modular environment configuration, SQLAlchemy SQLite repository,
transactional versioned migrations and storage error boundary. `fff2ff1` adds
memory/SQLite API parity plus persistence, migration, failure, namespace and actual
frontend server-restart tests. The final handoff commit adds startup error hardening,
three recovery regressions and this completed operational record.

The default startup uses `<repository root>/data/moodle-helper.sqlite3`. An explicit
file URL selects another location; relative paths are rooted predictably and missing
parents are created. Invalid/non-SQLite/memory URLs fail without fallback. Lifespan
startup opens storage; importing the app creates no files. One namespace is selected
from trusted environment, validated using #5, and immutable for the running process.
All records/settings share its namespace primary key. New demo rows seed once; new
Moodle rows start empty with default settings. Existing emptied data never reseeds.

The repository stores the complete validated Snapshot JSON, preserving all current
wire fields and four DateValue variants. Each replace, mutation and source upsert is
an explicit BEGIN IMMEDIATE transaction. Stable source IDs replay once; identical
evidence deduplicates without losing distinct provenance or changing personal overlays
or submission/completion ownership. Explicit full replacement/reset semantics remain.

Schema version 2 adds a write revision to the executable version-1 format. Both DDL
and data updates roll back on deliberately failed migration; retry succeeds. Future
schema versions fail closed. Runtime locked/read-only/full/unavailable errors return
actionable 503 message envelopes and preserve prior commits; startup failures stop
the server. URL/SQL parameters/Snapshot contents never enter HTTP error messages.

## Engineering verification on 2026-10-26

From repository root, using the existing host workaround:

```powershell
$env:UV_CACHE_DIR = Join-Path $PWD '.uv-cache'
uv sync --locked
uv run pytest -q
```

- Locked sync passed: 31 resolved packages, 30 installed packages checked. The only
  new direct dependency is the approved `SQLAlchemy>=2,<3`, locked to **2.1.6**.
- Final complete backend suite: **297 passed**, one existing Starlette/httpx
  TestClient deprecation warning, **12.22 seconds**. Source/generated OpenAPI remains
  unchanged. The API/contract fixture runs against both memory and isolated SQLite.
- `tests/test_sqlite_store.py` contains 34 focused cases, included in that whole-suite
  result. It covers complete fields/optional values/DateValues, saved-empty restart,
  source insert/replay/update, preserved overlays/personal records, detached references,
  two-instance sequential/concurrent mutation, three identities in one file, immutable
  environment selection and rejected request-driven switching. Validation failure and
  failure after an actual UPDATE roll back replace/review/import/settings/source upsert.
- Migration examples include successful version 1→2, failure after ALTER plus data
  write with verified version/column/records rollback and successful retry, read-only
  prior-version startup, future-version unchanged bytes, unknown tables preserved and
  corrupt Snapshot refusal. Actual SQLite exclusive locks, query-only read-only errors
  and page-limit SQLITE_FULL errors verify actionable API responses and preserved data;
  startup lock/path failures are recoverable. Query-only testing is deliberate because
  Windows filesystem read-only attributes alone do not reliably deny writes.

From `frontend/`:

```powershell
bun run test
bun run build
```

- Frontend suite: **52 passed across 5 files**, **15.02 seconds**.
- Build: **passed**, client + SSR + Nitro. Existing advisory messages about
  vite-tsconfig-paths, plugin timing and generated worker naming remain; no dependency
  or frontend design changes were made to suppress them.
- The real HttpAdapter workflow launches Uvicorn on an available localhost port with
  a temporary SQLite file and explicitly isolated demo environment. It creates a
  personal event, edits title/date/hidden/completed, changes settings, imports/reviews
  a candidate, stops the server and starts a distinct process against the same file.
  Entire Snapshot equality proves records/settings/overlays survive. It then deletes
  local data and repeats stop/start, proving an empty saved namespace stays empty.
- A second actual SQLite process holds an exclusive lock while HttpAdapter attempts
  a save; the real HTTP 503 becomes a useful adapter error, and the previous committed
  Snapshot reloads afterward. The dashboard error test passes a 503 envelope through
  HttpAdapter, verifies the error display and retained last successful data, and checks
  no success is reported. Existing escaped/Unicode ID and nullable overlay-reset
  integration tests run against SQLite unchanged.

The restricted host required execution approvals for uv/Bun tests and Git commits,
and network approval for the already authorized dependency. These are environment
permissions, not added application dependencies or user deployment authorization.

## Operations, limitations and QA gate

[README](../README.md) documents exact environment/startup commands.
[Storage operations and recovery](architecture/sqlite-storage.md) documents the
namespace tuple and account/profile stop/configure/restart mapping, representation,
schema/migration examples, stopped-file backups, permission/lock/full-disk recovery
and retry/location guidance. Architecture, toolchain, plan and backlog deferral
statements have been updated; historical earlier checkpoints remain historical.

The service remains one localhost process with credential-free `security: []` and
the same Vite proxy. Namespace partitioning is not authentication; clients reaching
one process share its selected namespace. No live Moodle identity discovery, collector
transport, queue, cross-source matching, public hosting, document bytes/downloads or
external AI is claimed. Those original feature issues remain open.

## Independent QA PASS

Independent QA verified commit `10ca3ce` and recorded **PASS for all 11 canonical
#6 criteria**, including actual server restart, in the
[authoritative verdict](https://github.com/Ramung55/MoodleHelper/issues/6#issuecomment-6406089710).
Its independently executed checks were:

- `UV_CACHE_DIR=<repo>/.uv-cache uv run pytest -q`: **297 passed**, one existing
  Starlette/httpx warning, **12.06 seconds**.
- `bun run test` from `frontend/`: **52 passed across 5 files**, **5.75 seconds**,
  including actual server restart and locked-database workflow.
- `uv run python -c <independent temporary-storage probe>`: **PASS** for a separate
  full-record/optional-field actual Uvicorn PUT/stop/start/GET equality check and
  safe driver-error classification without SQL-parameter leakage/misclassification.

QA changed no implementation files and did not close the issue. The persistence
QA gate is passed; the orchestrator may now close #6 and proceed in backlog order.
