# SQLite storage operations and recovery (#6)

The local backend owns authoritative application data. SQLAlchemy's synchronous
SQLite path uses Python's built-in sqlite3 driver; SQLAlchemy>=2,<3 is the only
new direct dependency. No server, Alembic, async driver or additional package is
required. The user approved that dependency on 2026-10-25; #58/#50/#2/#5 passed
independent QA before implementation (see the milestone-3 checkpoint).

## Startup and identity

`uv sync --locked`, then `uv run uvicorn backend.main:app --host 127.0.0.1 --port
8000 --workers 1` is the supported local startup. The default URL is SQLite at
`<repository root>/data/moodle-helper.sqlite3`. `MOODLE_HELPER_DATABASE_URL` accepts
`sqlite:///relative/path.sqlite3` or an absolute file URL such as
`sqlite:///C:/Users/hpram/MoodleHelperData/local.sqlite3` on Windows and
`sqlite:////home/user/moodle-helper/local.sqlite3` on POSIX. Relative paths always
resolve under the repository root, independent of the launch directory. Missing
parents are created recursively. Invalid paths or lack of directory/file write
permission fail visibly. Query options, other drivers/databases and `:memory:`
are rejected, with no fallback. Variables must be set in the process environment;
the app does not read `.env` automatically. Importing the app does no database I/O;
its lifespan opens and validates storage before the server accepts requests.

`MOODLE_HELPER_DATASET=demo` (also the default) selects canonical key `["demo"]`.
All Moodle identity variables must then be absent. Only a newly created demo row
gets samples. An existing empty row stays empty after restart. Moodle mode requires:

| Variable | Required value |
| --- | --- |
| MOODLE_HELPER_DATASET | `moodle` |
| MOODLE_HELPER_MOODLE_ORIGIN | exactly `https://moodle.sdu.edu.kz` |
| MOODLE_HELPER_PROFILE_LABEL | nonblank non-secret local profile label |
| MOODLE_HELPER_STABLE_USER_ID | nonblank stable Moodle user identifier |

For profile `personal`, user `42`, the key is the canonical JSON tuple
`["moodle","https://moodle.sdu.edu.kz","personal","42"]`. JSON tuple encoding
prevents delimiter collisions. A new Moodle partition has empty record arrays,
default complete settings and no tracked courses. Every persistent row lookup and
update uses the namespace primary key. The selected namespace has no setter and
is fixed when startup reads the trusted environment; later environment changes,
HTTP bodies and headers cannot switch it. Stop/configure/restart to switch. Invalid
or partial input stops startup rather than reusing demo or another account. No
password, cookie or session token is an identity component.

This proves configured data partitioning with labeled fixtures, not browser identity
discovery or authenticated isolation. All clients reaching one process share its
partition. Keep `security: []`, one localhost worker and the Vite same-origin proxy.
The extension collector/permission/identity handoff remains #9/#3, queues remain
#19, and public hosting/authentication requires separate decisions. Reset and local
data deletion preserve their existing meanings within the selected namespace:
reset explicitly restores fictional samples there; deletion clears arrays/tracked
courses but keeps other settings. Reset never changes the selected identity.

## Representation, stable source updates and transactions

`snapshots(namespace TEXT PRIMARY KEY, snapshot TEXT NOT NULL, revision INTEGER
NOT NULL DEFAULT 0)` stores a complete wire-validated Snapshot as JSON. A complete
aggregate preserves every current nested record, DateValue precision and optional
field without a lossy projection. `schema_version(id PRIMARY KEY CHECK(id=1),
version INTEGER NOT NULL)` records the file-wide schema version, currently **2**.
There is no caller-side filtering over unpartitioned data.

`SnapshotStore.read/replace/mutate` and `BackendService` remain the boundary. Each
replace/mutation is one explicit `BEGIN IMMEDIATE` read/modify/validate/update/commit
transaction. This includes compound import/review, personal deletion and settings
changes. SQLite serializes competing repository instances in the supported process;
sequential mutations reread current committed state. Commit/validation/executed-write
failures roll back. Input, callback and returned references cannot mutate saved data.
One transaction also covers migrations and first namespace initialization. NullPool
closes connections between operations; normal SQLite rollback-journal mode is used.

`upsert_source(collection, record)` supports courses, assessments and materials,
scoped by the configured namespace and stable record `id`. It validates opt-in
ingestion semantics using #5, updates the existing record once, and merges assessment
evidence using canonical comparison of every present SourceEvidence field. There
is no separate evidence ID. Identical replay is idempotent; changed observation
time, date, provenance or source survives in input order. Existing first-observed
time is retained; incoming latest source facts/submission observations update the
assessment. Personal events cannot be overwritten by source upsert; overlays
(title/date/baseline/hidden/completed) and unrelated personal records are untouched.
Existing material downloadedAt remains personal/local metadata. For future collectors,
#5's `collector_entity_key` encodes namespace, entity, stable course ID, module type
and stable activity/resource ID; titles/dates never supply identity. Existing opaque
wire IDs remain unchanged. This is repository replay, not cross-source matching (#33),
collector transport or an HTTP endpoint. Explicit PUT Snapshot replaces the whole
partition, including overlays; reset retains its explicit replacement semantics.

## Migration and recovery

Version 1 is the same namespace + JSON Snapshot table without `revision`. At startup,
the executable 1→2 migration adds the nonnull counter with default 0, then updates
the version in the same explicit SQLite transaction. JSON, IDs, optional fields and
overlays are not rewritten. Even SQLite DDL is transactional because BEGIN occurs
before DDL; a failed migration rolls back both executed ALTER and data changes. An
unsupported future version fails closed with instructions to use the matching
application; it never resets, downgrades or deletes data. Unknown/unversioned existing
tables are also preserved and rejected.

Executable prior-version example and failure/retry demonstration, from root:

```powershell
uv run pytest tests/test_sqlite_store.py::test_executable_prior_version_migration_preserves_every_field_and_overlay
uv run pytest tests/test_sqlite_store.py::test_failing_executed_ddl_migration_rolls_back_then_can_be_retried
uv run pytest tests/test_sqlite_store.py::test_future_schema_fails_closed_without_changing_file
```

Before changing application versions or manually relocating storage, stop the backend
and all other writers, then copy the SQLite file to a separate known backup location.
Wait for the process to exit; do not copy a changing file or delete journal files.
Restart against the intended URL and confirm the expected namespace. A failed migration
reports rollback: keep the unchanged prior file, retry the prior compatible application
or restore the stopped-file backup. If using a separate new location, keep the original
for recovery; a fresh location intentionally creates a fresh partition. For a future
schema, upgrade the application or choose a compatible backup, never edit the version
number to force a downgrade. Corrupt JSON fails with backup/location guidance rather
than reseeding. These are operator recovery instructions; product export/restore
workflows remain #45/#55/#56.

Runtime storage failures return HTTP **503** with the existing `{ "message": "..." }`
envelope; successful saves are never reported. The dashboard keeps its last successful
state and displays the message through the existing error flow. Startup failures stop
Uvicorn before requests are accepted. Messages never include the configured URL,
SQL parameters or Snapshot contents. The original driver message alone selects guidance:

| Failure | Recovery |
| --- | --- |
| locked/busy | Stop competing writers, wait for their transaction to finish, retry. The bounded SQLite wait is 1 second. |
| read-only / permission denied | Check the file **and parent directory** write permissions, or stop and copy to an approved writable location and update the URL. Windows read-only attributes alone do not reliably remove SQLite write permission. |
| full disk / failed write | Free space for database/journal files, retain the original, then retry. Never clear/reset data to make a save succeed. |
| unavailable / invalid path | Check that the location is a writable local file path, not a directory or child of a regular file; fix permissions/location and restart if startup failed. |

Focused tests use actual SQLite EXCLUSIVE locks, `PRAGMA query_only=ON` for portable
SQLite read-only failures, and `PRAGMA max_page_count` to induce a real SQLITE_FULL
write error. They verify the prior commit after reopening. An additional failure after
an executed UPDATE proves rollback for replace, source upsert and compound review/import/
settings operations. The read-only probe avoids false assumptions about Windows chmod.

## Verification commands

```powershell
uv sync --locked
uv run pytest
uv run pytest tests/test_sqlite_store.py
cd frontend
bun run test
bun run build
```

The existing backend API/contract/escaped-ID/nullable-reset fixture runs against both
explicit memory and temporary file-backed SQLite. Dedicated tests cover all current
Snapshot fields, four DateValue variants, optional provenance/status fields, saved-empty
restart, three configured identities in one file, immutable identity, replay, migration,
failure rollback and two-instance sequential/concurrent mutations. The real frontend
HttpAdapter test starts Uvicorn on an ephemeral port with its own temporary database,
creates/edits/imports/reviews, stops and starts a different server process against the
same file, compares the entire Snapshot, then repeats after deletion. Its independent
SQLite lock helper also checks the actual HTTP save failure. UI tests verify 503 message
display/retention through HttpAdapter. No frontend design or API contract changes.
