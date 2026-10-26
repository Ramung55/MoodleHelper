# Toolchain and package decision

2026-10-25, [#50](https://github.com/Ramung55/MoodleHelper/issues/50).

The existing TypeScript frontend and selected Python FastAPI backend are
complementary parts of the local application. The historical proposal to choose
between Python and TypeScript no longer describes the implemented repository.
This decision preserves `AGENTS.md`, its commands and its requirement to ask
before adding dependencies. It approves no new package or installation.

## Actual package inventory

| Boundary | Source/configuration | Dependency lock | Tests and runtime |
| --- | --- | --- | --- |
| Python backend | Root `pyproject.toml`; `backend/` with FastAPI app, schemas, routers, services and storage | Root `uv.lock` | Root `tests/`; pytest. Declared Python range `>=3.12,<3.15`, `.python-version` selects 3.13. Python 3.13.14 verified in milestone checks. Other versions in the declared range have not been tested here. |
| React dashboard | `frontend/`; `frontend/package.json`; TanStack Start/Router, TypeScript, Vite, React; `vite.config.ts`, `vitest.config.ts`, `tsconfig.json` | `frontend/bun.lock` | Vitest tests in `frontend/src/test/`; Vite production build. Node.js v24.20.0 and Bun 1.3.13 verified in this environment. The manifest has no `engines` or `packageManager` pin and no Node-version file; these observations are not a general compatibility guarantee. |
| Chrome extension | `extension/package.json`; empty `src/index.ts` | None needed (no dependencies) | Human-approved #51 private ESM package; Bun browser build to `dist/index.js`. Runnable Chrome shell remains #7. |
| Shared browser package | `shared/package.json`; empty `src/index.ts` | None needed (no dependencies) | Human-approved #51 private ESM package; Bun browser build to `dist/index.js`. Existing frontend domain types/services remain intact. |

uv 0.13.1 is the verified environment version. `.venv/`, frontend
`node_modules/` and build output are generated artifacts, not source packages.
The root repository now tracks ordinary frontend files rather than the former
Git link without `.gitmodules`; a fresh root checkout therefore includes the
application source. The pre-existing nested frontend Git history remains
locally on disk. Do not rewrite it or push to its separate Lovable-linked remote
as an implicit consequence of this application work.

## Exact commands and working directories

From the repository root, install the approved Python environment and run
the commands retained by `AGENTS.md`:

```powershell
uv sync
uv run pytest
uv run pytest tests/test_home.py
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

`uv sync --locked` additionally verifies that the committed lockfile remains
usable without resolving a replacement. Swagger UI is at
`http://127.0.0.1:8000/docs`; generated OpenAPI is at
`http://127.0.0.1:8000/openapi.json`. The application exports
`backend.main:app`. Use one localhost worker with the selected SQLite namespace.

In another terminal, starting from the root:

```powershell
cd frontend
bun install --frozen-lockfile
bun run test
bun run build
bun run dev --host 127.0.0.1 --port 5173
```

These scripts are the actual existing package-manifest commands: `test` runs
`vitest run`, `build` runs `vite build`, and `dev` runs `vite dev`. Bun consumes
the existing `bun.lock`; this decision does not replace it with a second
package-manager lockfile. The verified development application is available at
`http://127.0.0.1:5173`. The live integration tests require the root `.venv`
prepared by `uv sync`, start an ephemeral localhost Uvicorn process, and stop it
afterward. They do not require a separately started port-8000 server.

The host's default uv interpreter cache showed a query-helper failure during
this session. For that environment-specific problem, setting
`$env:UV_CACHE_DIR = Join-Path $PWD '.uv-cache'` at the root allowed the same uv
commands to pass. This is a local workaround, not a different project toolchain
or an instruction to commit a cache. Restricted process execution also required
tool approval in this environment; that is not an application dependency.

## Verified milestones and actual service selection

The human explicitly approved #51's exact two dependency-free manifests and
bounded layout on 2026-10-26; their approval is no longer pending. From the root,
after the existing frontend frozen install, run:

```powershell
bun run --cwd extension build
bun run --cwd shared build
bun ./frontend/node_modules/vitest/vitest.mjs run --config ./browser-workspace/vitest.config.mjs
```

Rebuild both artifacts before every smoke verification, including fresh checkouts.
The plain Node-environment configuration reuses frontend Vitest and imports actual
built empty ESM modules; it has no source/mock fallback or Chrome globals. Bun
transpilation is not a standalone TypeScript-check guarantee. No dependencies,
new lockfile, root workspace or unresolved empty-package layout are introduced;
future shared consumers and the runnable Chrome shell remain their owning issues.

1. In-memory backend: #1/#57 passed independent QA. The
   [milestone-1 checkpoint](../milestone-1-checkpoint.md) records installation,
   tests, startup, Swagger and generated/source contract checks.
2. Frontend/API integration: #58 passed independent QA after the escaped-ID
   correction. See the [milestone-2 checkpoint](../milestone-2-checkpoint.md)
   and [final QA PASS](https://github.com/Ramung55/MoodleHelper/issues/58#issuecomment-6397890196).
   Engineering's final suites were 91 backend tests and 49 frontend tests,
   plus a successful client/SSR/Nitro production build. Independent QA inspected
   the fix and verified the actual browser create/reload workflow. Separate
   legacy standalone TypeScript-check errors and one backend TestClient warning
   are documented; a passing build is not a claim that every optional static
   check is clean.
3. SQLite/SQLAlchemy persistence: implemented under #6, awaiting independent QA.
   The human approved SQLAlchemy>=2,<3 on 2026-10-25, superseding the earlier
   deferral. See [storage operations](sqlite-storage.md) and the
   [milestone-3 checkpoint](../milestone-3-checkpoint.md).
4. Remaining feature implementation: follows a passing persistence checkpoint;
   independent prerequisite documentation/triage can proceed during the gate.

`frontend/src/services/index.ts` now selects `HttpAdapter`, not DemoAdapter.
HTTP failures are shown through the existing UI flows rather than silently
falling back to fixtures. Vite proxies same-origin `/api` to
`http://127.0.0.1:8000`, so no CORS permission is needed for the documented local
development setup. A production host still needs an explicit API routing and
trust decision; no deployed proxy or public deployment is implied.

`openapi.yaml` is authoritative for the 16 operations. The expressly approved
#53/#58 nullable PATCH addition preserves override clearing over JSON while
omission still means unchanged. The current credential-free contract has
`security: []`; this decision does not add login, expose student data publicly,
or claim account isolation. Sync/import remain final-result simulations,
imports receive filenames rather than bytes, downloads are unsupported, and
AI remains unavailable. Broader feature issues remain open.

## Storage and remaining identity boundary

The FastAPI backend owns the durable Snapshot. Environment configuration selects
one immutable demo or Moodle origin/profile/stable-user namespace at startup;
restart reloads the selected partition. All local clients reaching that process
share it. No Moodle passwords, cookies or session tokens belong in dashboard
messages, snapshots or the database. Live identity discovery/handoff remains #9/#3.

The product's original extension-owned IndexedDB/Dexie proposal is superseded by
the explicit backend-authority and trusted startup namespace decisions in
[#2](https://github.com/Ramung55/MoodleHelper/issues/2) and
[#6](https://github.com/Ramung55/MoodleHelper/issues/6). SQLite now tests restart,
stable upsert, migration rollback, storage failures and namespace isolation.
Future extension caches/queues cannot be a competing data authority; permission,
collector transport and verified identity discovery remain #9/#3/#19. Website
storage never becomes authoritative for extension credentials. Public hosting
and authenticated accounts remain outside this local partitioning decision.

## Dependency approvals and issue boundaries

The user explicitly approved the backend's FastAPI and Uvicorn, with pytest,
httpx, PyYAML and jsonschema for verification. Existing frontend dependencies
and its lockfile are preserved. SQLAlchemy>=2,<3 plus ordinary locked transitive
dependencies is explicitly approved and installed through uv. WXT/Dexie or other
extension tooling, PDF/DOCX/OCR libraries/assets, and additional browser-test
packages still require explicit approval before addition. A proposed
stack, this document or a green test is not dependency approval.

- #1 is the completed historical backend bootstrap; its criteria and closed
  state remain intact.
- #7 owns the missing Chrome extension shell; Python commands do not replace
  its eventual browser build.
- #8 owns dashboard-shell verification against its original criteria, not a
  request to discard the existing implemented frontend.
- #51 preserves the existing frontend and adds only approved missing
  extension/shared setup. This decision does not claim its checks completed.

Each issue links this decision and retains its original functional acceptance
criteria. Only independent QA PASS permits the orchestrator to close an issue.
