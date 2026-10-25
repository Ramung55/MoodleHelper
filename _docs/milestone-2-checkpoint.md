# Milestone 2 — frontend/backend integration checkpoint

2026-10-25. Implementation: `579ad6f`, with the approved nullable overlay reset
addition in `d3884b2`. `dfa85f2` subsequently changes only a frontend README line.
The follow-up fix committed with this record addresses QA failure
[6397824843](https://github.com/Ramung55/MoodleHelper/issues/58#issuecomment-6397824843).

## Implemented boundary

The default frontend service is HttpAdapter. All 16 operations use the local
FastAPI contract, including full Snapshot results, inline import/download
outcomes, final-only callbacks, validation and useful request errors. The Vite
development server proxies same-origin `/api` calls to `127.0.0.1:8000`.
Failures retain the last successful state and do not show success confirmations.
The existing design, forms, routes and personal/source separation remain.

The documented #53/#58 contract addition uses explicit nulls to clear optional
overlay fields while omission continues to mean unchanged. Cleared optional
keys do not appear as null in Snapshot responses.

The root repository now tracks frontend source as ordinary files, correcting
the prior Git link without submodule configuration. The nested frontend Git
history remains on disk; no push to its separate remote was performed.

## Independent QA evidence before the routing fix

The primary QA agent independently reported `npm test`: 48 passed;
`npm run build`: passed; `uv sync --locked`: passed; `uv run pytest`: 86 passed.
The browser QA agent then opened `http://127.0.0.1:5173`, created
“QA browser integration 2026-10-25” through the Personal event form, verified
the deadline row, reloaded, and verified it remained. It inspected the rendered
layout and truthful local-backend wording. QA changed no implementation files.

Final review correctly reported FAIL rather than closing #58: the actual proxy
returned 404 for an encoded slash in a candidate identifier, and this required
checkpoint had not yet been committed. Those earlier green suites were not
treated as proof of escaped-ID interoperability.

## QA-failure fix and engineering verification

All four identifier routes now use path converters so restored identifiers
containing slashes remain valid. Generated OpenAPI paths, parameter names and
schemas remain unchanged. Backend regressions cover existing IDs, empty IDs,
slashes, percent signs, query/fragment characters, Unicode and missing-ID
outcomes. A live frontend regression restores identifiers containing literal
`%2F` as well as slashes and other reserved characters, then exercises overlay,
review, download and deletion through an actual Uvicorn process. This catches
both route failures and incorrect decoding; mocked fetch assertions alone do
not provide that evidence.

Engineering reran the complete suites after the fix:

- Root, with `UV_CACHE_DIR` set to the ignored project `.uv-cache` directory:
  `uv run pytest` — **91 passed**, one existing Starlette/httpx deprecation
  warning. The suite includes generated/source OpenAPI parity checks.
- `frontend/`: `bun run test` — **49 passed** across five files, including
  three tests that start and stop an actual FastAPI server.
- `frontend/`: `bun run build` — **passed** for client, SSR and Nitro output.

The existing manually running backend was identified by its workspace Uvicorn
command before being restarted with the fix. It is available on localhost
port 8000; the frontend remains on port 5173. Restarting the in-memory backend
clears the earlier QA event, as documented for this milestone.

Independent QA must recheck the routing fix and this committed record before
the orchestrator closes [#58](https://github.com/Ramung55/MoodleHelper/issues/58).
Its final issue verdict is the authoritative completion evidence; this
engineering record does not substitute for that verdict.

## Remaining boundaries

The backend is still in-memory and shared by clients of one local process.
SQLAlchemy approval is deferred; SQLite persistence has not begun. No external
account, live Moodle collection, file-byte extraction, actual download or
external AI capability is claimed. Broader #53 criteria remain open.
Separate legacy standalone TypeScript-check errors are recorded by the original
engineering handoff; the production build passes. No new dependency was added.

Use the exact two-process startup commands in the root README. Milestone 3
cannot start before this checkpoint passes independent QA and its dependency
and architecture prerequisites are resolved.
