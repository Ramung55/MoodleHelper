# Current status

Audit date: 2026-11-12. Commit audited: `e63ac3d` (`main`, after PR #91), on Windows 11 with Docker 29.7.2. The working tree had no content changes; 59 files differed only in line endings. This report replaces the 2026-11-08 preliminary audit. It records test results, not a criterion-by-criterion acceptance audit of each closed issue. The MVP verdict in [mvp-verification.md](mvp-verification.md) remains **FAIL** for the live-Moodle reasons below.

## Test results

All suites were run one at a time. Running them in parallel caused timeouts in earlier audits.

| Suite | Command | Result |
| --- | --- | --- |
| Backend | `uv run pytest` | **PASS**: 1497 passed, 9 skipped (Compose and PostgreSQL opt-in tests, run separately below), 2 warnings |
| Frontend unit/component | `bun run test` (`frontend/`) | **PASS**: 78 files, 1525 tests |
| Frontend typecheck | `bun run typecheck` (`frontend/`) | **PASS** |
| Frontend lint | `bun run lint` (`frontend/`) | **FAIL**: 3 Prettier formatting errors, 26 warnings (see Findings) |
| Frontend build | `bun run build` (`frontend/`) | **PASS** |
| Extension and shared builds | `bun run --cwd extension build`, `bun run --cwd shared build` | **PASS** |
| Browser workspace | `bun ./frontend/node_modules/vitest/vitest.mjs run --config ./browser-workspace/vitest.config.mjs` | **PASS with one harness error**: 18 files, 307 tests passed; `queue-network.test.ts` cleanup hit `EBUSY` (see Findings). That file passed alone (4/4). |
| Browser E2E | `bun run test:e2e` (`frontend/`) | **PASS**: 38 passed. The intermittent "Start mock run" failure from 2026-11-09 did not occur. |
| Deliberately broken E2E | `bun run test:e2e:broken` (`frontend/`) | **PASS**: failure detected with screenshot and trace, as designed |
| Compose integration | `MOODLE_HELPER_COMPOSE_TEST=1 uv run pytest tests/test_compose_integration.py` | **PASS**: 5 passed |
| Compose browser journey | `node e2e/compose.cjs` | **PASS**: workflow and persistence across container restart |
| PostgreSQL | `MOODLE_HELPER_TEST_POSTGRES_URL=… uv run pytest tests/test_postgres.py` against a disposable `postgres:16` container on loopback, removed afterwards | **PASS**: 5 passed |
| GitHub CI on `main` | `.github/workflows/ci.yml` at `e63ac3d` | **PASS**: backend, frontend and compose jobs. Deploy is disabled (`if: false`). Pages deploy succeeded. |

Not run: live SDU Moodle, a real external AI provider (Groq), and actual Chrome notification delivery.

## Findings

1. **Lint fails on formatting only.** Prettier reports 3 errors in lines added for the stale-submission hint: `frontend/src/components/mh/AssessmentSheet.tsx:365`, `frontend/src/test/deadline-list.test.tsx:84` and `frontend/src/test/page-refresh.test.ts:1287`. `eslint --fix` resolves them. CI does not run lint, so this went unnoticed.
2. **Windows test cleanup is fragile.** `browser-workspace/queue-network.test.ts` deletes its temporary SQLite directory right after stopping uvicorn. On Windows the file can still be locked, which gives `EBUSY` and an unexpected worker exit after all tests passed. The cleanup should retry or wait for the process to exit.
3. **Leftover Docker resources from an earlier aborted run.** Containers `moodlehelper-e2e-4a128395…-app-1` (created) and `…-postgres-1` (running) and volume `moodlehelper-e2e-4a128395…_postgres-data` were created at 15:55 on 2026-11-12, before this audit. This audit did not remove them. The `moodlehelper-*` stack from 2026-11-10 is separate and was also left untouched.
4. **Expected noise in E2E logs.** `QuotaExceededError` comes from the deliberate quota-failure case in `document-import.spec.ts`, which passes. `ECONNREFUSED 127.0.0.1:8000` comes from specs that run the dashboard without a backend.
5. **Pydantic warning.** `UnsupportedFieldAttributeWarning` (`alias='body'` on `Field()` without effect) appears in `tests/test_syllabus_revision.py`. It is harmless today but signals a field definition that does not do what it appears to.

## Component status

| Component | Status | Evidence |
| --- | --- | --- |
| Dashboard (frontend) | Working against fixtures and the local backend | Unit, typecheck, build and 38 E2E specs pass |
| FastAPI backend and contract | Working | 1497 tests, including contract tests against `openapi.yaml` and Zod model parity |
| Storage | Working | SQLite in the main suite; PostgreSQL and Compose persistence across restart pass |
| Extension | Builds; fixture and synthetic flows pass | Browser workspace and E2E extension-shell specs |
| Live Moodle collection | **Not verified** | Collectors pass on fixtures and observed HTML. No live end-to-end journey was run in this audit. |
| Live submission status | **Disabled by design** | `extension/src/page-refresh.ts:142` registers `submission` as unavailable until the active Moodle account is bound. Backend ingestion rejects verified-mode submission observations. |
| Hosted deployment | **Not approved** | No application authentication; see [oracle-deployment.md](oracle-deployment.md). CI deploy disabled. |

## Backlog

GitHub has 85 issues, all closed, and no open pull requests. The remaining MVP gaps have no issues yet:

- binding collected data to the active Moodle account (account isolation);
- live submission status, which depends on account binding;
- live update while browsing (visited-page refresh) on real SDU pages;
- an authorized read-only live SDU journey with recorded evidence;
- lint formatting errors and adding lint to CI;
- the Windows cleanup in `queue-network.test.ts`;
- authentication, if hosted deployment is wanted at all.

## Next step

Create GitHub issues for the gaps above using `_docs/task-template.md`, groom them, and continue with the orchestrator lifecycle in `_docs/process.md`.
