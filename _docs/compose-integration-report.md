# Compose integration test report

Date: 2026-11-10. Tests used independently named disposable Compose projects,
test credentials, loopback ports and test-only PostgreSQL volumes; the existing
MoodleHelper stack and data were not used. Test resources were removed by their
harnesses.

| Requested area | Evidence | Result / limit |
| --- | --- | --- |
| Startup | Compose builds and starts the app after PostgreSQL is healthy; HTTP readiness is polled | Pass |
| Frontend | Shell, referenced static asset and client-side route; separate Chromium navigation | Pass |
| FastAPI and PostgreSQL | Snapshot API, PostgreSQL snapshot and dataset rows | Pass |
| Migrations | Fresh schema version and a separately seeded version-1 database upgraded with its snapshot preserved | Pass; migration failure rollback is not exercised by this Compose suite |
| Authentication and authorization | Missing/stale process binding, foreign Host and CORS preflight rejected | Pass for implemented guards; there is no application account login or user authorization |
| API and contract | Snapshot read, personal-event create/delete and overlay update validated against OpenAPI; settings update | Pass for exercised operations, not all 64 operations |
| Persistence | Settings and dataset identity survive container recreation; Chromium repeats a settings check | Pass |
| Errors | Unknown API route, invalid settings and binding rejection | Pass for exercised cases |

Commands: `MOODLE_HELPER_COMPOSE_TEST=1 uv run pytest tests/test_compose_integration.py -q`
(PowerShell: set `$env:MOODLE_HELPER_COMPOSE_TEST = '1'` first) completed with
**5 passed, 1 existing Starlette deprecation warning**, exit 0. Independent QA
repeated that suite with the same result. `node e2e/compose.cjs` passed the Chromium
dashboard and persistence journey, exit 0. These tests do not prove live Moodle
collection, extension connectivity, external AI provider behavior, every API route,
or production security. See the README for setup and browser installation.
