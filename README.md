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

Open http://127.0.0.1:8000/docs (or http://localhost:8000/docs) for Swagger UI.

The backend answers only when the request's `Host` header is `127.0.0.1`,
`localhost` or `[::1]`, with any port or none (case-insensitive; so another
`--port` and the Vite proxy on 5173 work unchanged). Any other name, including a
LAN IP, `0.0.0.0`, `localhost.` or a DNS name that resolves to 127.0.0.1, gets
HTTP 400 before routing. This blocks DNS-rebinding pages; `X-Forwarded-Host` is ignored.
The generated API description is at http://127.0.0.1:8000/openapi.json.
No Moodle login, extension, frontend process, or external account is needed.
`uv.lock` pins the approved dependencies; `uv sync --locked` checks it unchanged.

## Toolchain decision and outstanding documentation

The backend uses FastAPI with uv/pytest and file-backed SQLite through the
explicitly approved SQLAlchemy dependency. Existing `AGENTS.md` commands apply.
The frontend retains its own `package.json`, Bun/Vite/Vitest commands, and
lockfile. Its design is preserved; `HttpAdapter` now binds its service contract
to FastAPI. The old DemoAdapter remains available for focused fixture tests.
The dependency-free `extension/` package builds the #7 Chrome shell; `shared/`
retains its empty browser ESM baseline. Chrome verification status is recorded below.

The [toolchain decision](_docs/architecture/toolchain.md) records the implemented
frontend/backend boundaries, verified commands and passing integration checkpoint;
the project plan agrees with those facts. SQLite persistence is implemented
under [#6](https://github.com/Ramung55/MoodleHelper/issues/6), awaiting independent
QA. See the [storage operations guide](_docs/architecture/sqlite-storage.md)
and [milestone-3 checkpoint](_docs/milestone-3-checkpoint.md).

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

Every non-GET request (POST, PUT, PATCH, DELETE) must send the current process
binding in `X-Moodle-Helper-Bridge-Binding`, read from `GET /api/bridge-context`.
An absent or stale binding returns 409 `{"message":"Backend context changed. Reconnect."}`
before the body is read or anything is stored; the binding changes on every backend
restart. Cross-site pages cannot set this header, so they cannot change data. Swagger
`/docs` still loads, but "Try it out" on a write (for example `POST /api/demo/reset`)
returns 409 unless you fill in the header parameter. For example:

```sh
BINDING=$(curl -s http://127.0.0.1:8000/api/bridge-context | python -c "import sys,json;print(json.load(sys.stdin)['binding'])")
curl -X POST -H "X-Moodle-Helper-Bridge-Binding: $BINDING" http://127.0.0.1:8000/api/demo/reset
```

Create an event with JSON (and the same header):

```json
{"courseId":"c-csc","title":"Study group","type":"other","date":{"kind":"week","week":8}}
```

PATCH omits unchanged properties; nested settings objects must be complete.
Only the three optional overlay fields accept null as a clear command;
all other explicit nulls are invalid. Unknown properties are ignored. Invalid requests
return 422 with `{"message":"..."}` and preserve the previous dataset.
HTTP 404, 405, 500 and storage-unavailable 503 responses also use the message envelope. Missing personal
delete/review ids are successful no-ops; unsupported imports/downloads remain
HTTP 200 domain outcomes. Personal deletion preserves imported assessments.

## Storage and deployment boundary

Use the localhost command above. The API follows the specification's
`security: []`: no login, tokens, accounts, authorization, or user isolation.
Each process selects one immutable dataset namespace at startup. Every client
reaching that process sees its selected data. Restarting with the same database
and identity preserves changes. Run one worker bound to localhost. The default
reserved demo namespace initializes fictional samples only once. Explicit Moodle
namespaces start empty, with default settings. No live Moodle collection or
external AI is implemented; configured identity is partitioning, not authentication.
No CORS permissions are enabled; the frontend development server proxies `/api`
to FastAPI on the same browser origin. Hosted deployment and authentication remain
undecided in #2; this implementation does not resolve that deployment design.

`backend/storage.py` defines the repository protocol and explicit memory store;
`backend/sqlite_store.py` implements SQLAlchemy transactions and namespace-scoped
persistence. `create_app(store=InMemoryStore())` retains isolated memory injection.
Services implement adapter behavior; routers bind HTTP to services.

Without configuration, the SQLite file is `data/moodle-helper.sqlite3` under the
repository root, independent of the current working directory. Missing parent
directories are created; permission or path failures stop startup. Set an explicit
file URL before the production/local startup command to choose another location:

```powershell
$env:MOODLE_HELPER_DATABASE_URL = 'sqlite:///C:/Users/hpram/MoodleHelperData/local.sqlite3'
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Use a writable local path of your choice. Relative SQLite paths resolve against
the repository root. Non-SQLite, memory, credential-bearing or query-option URLs
are rejected; there is no silent memory fallback and no automatic `.env` loading.
Omit `MOODLE_HELPER_DATASET` or set it to `demo`, with all Moodle identity variables
unset. For a separately configured identity, set all four values before startup:

```powershell
$env:MOODLE_HELPER_DATASET = 'moodle'
$env:MOODLE_HELPER_MOODLE_ORIGIN = 'https://moodle.sdu.edu.kz'
$env:MOODLE_HELPER_PROFILE_LABEL = 'personal'
$env:MOODLE_HELPER_STABLE_USER_ID = '42'
```

These are labeled fixture/example identifiers, not discovered browser identity.
Switch accounts/profiles by stopping, configuring and restarting. Partial identity
configuration fails; request headers/bodies cannot select a namespace. All records,
settings, overlays, reset and local-data deletion remain in the selected partition.
See [migration, backup and failure recovery](_docs/architecture/sqlite-storage.md)
before changing applications or database locations. Save failures return actionable
503 errors; the dashboard retains its last successful data and displays the error.

## Contract limitations and verification

The root OpenAPI remains authoritative, with the documented reset addition. Broader issue #5 asks
for invalid-date/unsafe-URL validation, and the current wire contract explicitly
permits arbitrary timestamp/timezone/URL strings and only a date-shaped regex.
This backend implements those exact constraints, including date-shaped strings
that are not calendar dates. #5 completed separate opt-in ingestion checks and
identity helpers; HTTP and full-Snapshot restore retain wire compatibility.

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

Use Python/uv as above. Node.js v24.20.0 and Bun 1.3.13 are verified versions for the existing frontend and browser packages, not an untested compatibility range.
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
Browser reload reads server state. Backend restart reloads the same selected
namespace from SQLite without reseeding saved or deliberately emptied data.
Do not expose either development server publicly. A production build succeeds,
but a deployed host must separately proxy `/api`; no hosting is configured here.

In Deadlines, **Personal event** creates a course-associated event with a date,
exact time or teaching week. Exact times use the timezone configured in Settings,
independent of the browser timezone; nonexistent local times show a field error.
Personal edits keep the same event identifier and separate original source facts.
Deletion asks for confirmation. Failed saves retain the entered values for retry.
Personal events persist in SQLite across reopening, backend restart and the
existing simulated sync; this does not claim live Moodle collection.

On **Syllabus review**, import a local PDF or DOCX, then choose **Extract text** to inspect
English/Russian text and source evidence locally. PDF evidence is page-grouped. Image-only
pages show **OCR needed**. Extraction is session-local, cancellable and limited to
100 pages; it creates no assessments. See [PDF extraction limits and evidence](_docs/pdf-extraction-25.md).
DOCX evidence retains original body paragraph/table/row/cell references without
inventing pages. See [DOCX support and limits](_docs/docx-extraction-26.md).
After extraction, **Find assessments** previews deterministic English/Russian
mentions with original row evidence. All proposals remain unconfirmed and dates
are unknown until the separate date/review workflow. See [detector scope](_docs/assessment-mentions-28.md).
**Interpret explicit dates** then previews supported dates using only optional
document/course date order, stated timezone and explicit semester bounds that you
supply. Ambiguous or missing information stays unresolved, and every result stays
unconfirmed. See [date grammar and context rules](_docs/syllabus-dates-29.md).

For scanned PDFs, expand **OCR selected scanned PDF pages**, select original page
numbers and English/Russian/both, then start local OCR. Defaults are 20 pages,
120 DPI and 60 seconds/page; limits, cancellation and incomplete/review-needed
results are visible. The approved local worker/models are prepared automatically
before frontend dev/tests/build. No OCR/AI account or content upload is needed.
See [OCR setup, limits, asset hashes and verification boundary](_docs/local-ocr-27.md).

Run frontend checks from `frontend/`:

```powershell
bun run test
bun run build
```

## Empty browser packages (#51 historical checkpoint)

The human explicitly approved the two private, dependency-free manifests and
bounded layout in #51; approval is no longer pending. `frontend/` remains the
integrated dashboard, with its existing TypeScript, Vite, Vitest and lockfile.
Backend uv/pytest remain unchanged. No package install or new lockfile was needed
for `extension/` or `shared/`; at that checkpoint both entries contained only `export {}`.
No unresolved layout blocker remains for this approved empty baseline.

From a fresh repository-root checkout, with the verified runtimes installed:

```powershell
uv sync --locked
cd frontend
bun install --frozen-lockfile
bun run test
bun run build
cd ..
bun run --cwd extension build
bun run --cwd shared build
bun ./frontend/node_modules/vitest/vitest.mjs run --config ./browser-workspace/vitest.config.mjs
```

Always rebuild both artifacts before the smoke check, including after a clean
checkout. It imports the actual `dist/index.js` files in Node, without Chrome
globals or permissions, and checks that both modules are empty. Missing or
unloadable artifacts fail; there is no source or mock fallback. This checks the
browser build/import boundary only. Bun transpilation does not establish a clean
standalone TypeScript check. #7 owns Manifest V3, permissions and Chrome loading;
no runnable extension or new collection/storage capability is introduced here.

Generated `dist/`, `node_modules/`, caches and local environment files are ignored;
the source entries, manifests, smoke configuration and test are tracked.

Engineering verification on 2026-10-26 used a fresh local clone of commit
`943afca`, Node.js v24.20.0, Bun 1.3.13, uv 0.13.1 and Python 3.13.14.
The local uv-cache workaround documented in the toolchain guide was used.

| Command (working directory) | Exit/result |
| --- | --- |
| `uv sync --locked` (root) | 0; existing lock installed |
| `bun install --frozen-lockfile` (`frontend/`) | 0; 515 packages installed, lock unchanged |
| `uv run pytest` (root) | 0; 297 passed, one existing TestClient deprecation warning |
| `uv run pytest tests/test_home.py` (root) | 0; 1 passed, same warning |
| `bun run test` (`frontend/`) | 0; 52 passed in 5 files |
| `bun run build` (`frontend/`) | 0; client, SSR and Nitro build completed |
| `bun run --cwd extension build` (root) | 0; emitted `extension/dist/index.js` |
| `bun run --cwd shared build` (root) | 0; emitted `shared/dist/index.js` |
| `bun ./frontend/node_modules/vitest/vitest.mjs run --config ./browser-workspace/vitest.config.mjs` (root) | 0; 2 passed |

The smoke also exited 1 with ENOENT when the extension artifact was temporarily
absent; rebuilding both restored 2 passing checks. Frontend build warnings about
existing tsconfig-paths and inlineDynamicImports settings remain. No frontend
files/configuration or existing lockfiles changed. Representative
`extension/dist/index.js`, `shared/dist/index.js`,
`extension/node_modules/example/index.js`, `shared/.env.local`,
`browser-workspace/.cache/data`, `frontend/.env` and `.uv-cache/example` paths
were verified ignored with `git check-ignore --no-index`; source/manifests,
smoke files and existing locks were verified tracked with `git ls-files`.
These are historical engineering results; #51 subsequently passed independent
[QA](https://github.com/Ramung55/MoodleHelper/issues/51#issuecomment-6406195559).

## Chrome shell (#7)

The extension now builds a Manifest V3 module worker (`index.js`), classic
isolated content script (`content.js`), blank `popup.html`, and `manifest.json`
into `extension/dist/`. The only static match is exactly
`https://moodle.sdu.edu.kz/*`, with default top-frame, document-idle injection.
There are no privileged API permissions or additional host grants. The content
script prints only the fixed diagnostic `Moodle Helper: empty content shell loaded`.
The worker is inert. There is no collection, page reading, credential handling,
network request, storage, timer or dashboard bridge. Existing dashboard detection
does not establish compatibility with this shell.

Use verified Bun 1.3.13 and Node v24.20.0. From the root, install existing test
dependencies with `bun install --frozen-lockfile` in `frontend/`, then return
to the root and run:

```powershell
bun run --cwd extension build
bun run --cwd shared build
bun ./frontend/node_modules/vitest/vitest.mjs run --config ./browser-workspace/vitest.config.mjs
```

No extension/shared dependency installation, new dependency or lockfile is needed.
The extension build replaces only its resolved `extension/dist/`, removes stale
assets and removes partial output on build/copy failure. Both builds must run
before tests: they import the actual built worker/shared ESM modules without
Chrome globals, validate exact emitted assets/scope, and run the classic script
with forbidden page/network/storage capabilities. These tests do not prove Chrome loading.

To load manually in Chrome, open `chrome://extensions`, enable Developer mode,
choose **Load unpacked**, and select the absolute directory
`C:\Users\hpram\Desktop\MoodleHelper\extension\dist` for this checkout
(use your own checkout's absolute `extension/dist/` elsewhere). Record the Chrome
version at `chrome://version`, extension card/ID and any Errors. Open Extensions
in the toolbar, optionally pin Moodle Helper, and click its action to open the
empty popup. Right-click the popup and Inspect to check Console, Network and
Application storage. On the extension card inspect the service worker; an inactive
idle worker is normal, but inspecting it must wake it without errors.

Visit `https://moodle.sdu.edu.kz/login/index.php` without signing in. In page
DevTools Sources → Content scripts and the Console execution-context selector,
identify this extension's `content.js` and its fixed diagnostic. Visit
`https://example.com/` and verify the extension's content source/context is absent.
Inspect extension Details → Site access and record that only the exact SDU scope
is available. Do not broaden access or bypass a certificate warning to finish a check.

Rebuild, click Reload on `chrome://extensions`, reopen the popup and inspect
extension, worker and popup errors again. Observe extension-context Network with
preserve log while reopening/reloading, and Application storage for absence of
saved records. Distinguish page-owned requests/storage from extension activity.
Record no new permission prompt/grant on reload. Keep version, URLs, actions,
extension ID and precise observations/screenshots in the
[#7 evidence note](_docs/extension-shell-evidence.md). An unreachable public SDU
page or unavailable browser inspection blocks browser acceptance; automated
checks cannot substitute for it.

`http-live.test.ts` starts a real FastAPI child process on an available localhost
port using the uv-managed `.venv` and an isolated temporary SQLite file, exercises
the HTTP adapter, stops/restarts the process, and verifies complete persisted data.
Run `uv sync` first. Other frontend tests cover all 16 mappings and UI error
preservation. No mocked request is used for the live integration tests.

Backend API/contract tests run against both explicit memory and temporary SQLite
stores. `uv run pytest tests/test_sqlite_store.py` additionally checks migration
rollback/retry, future versions, all current fields, source replay, namespaces,
atomic writes and real SQLite locked/read-only/full failures.

The root repository tracks frontend source as ordinary files so a fresh root
checkout contains the full application. The pre-existing nested frontend Git
history is preserved locally, and its unrelated remote is never pushed by this
integration. Future application work should be committed from the root.

## Dashboard shell previews (#8)

Use the existing approved setup (`uv sync --locked` at root, then
`bun install --frozen-lockfile` in `frontend/` on a fresh checkout). For shell
previews, only the frontend needs to run; stop the backend to inspect them without
any saved student data. No Moodle login, account or extension is required.
From `frontend/`, run `bun run dev --host 127.0.0.1 --port 5173`.

Each link below is a fresh direct URL. Navigation retains the chosen preview,
including Weekly planner and Alerts, while each page retains its own heading.

| Page | Loading | Empty | Recoverable error |
| --- | --- | --- | --- |
| Overview | [loading](http://127.0.0.1:5173/?shellState=loading) | [empty](http://127.0.0.1:5173/?shellState=empty) | [error](http://127.0.0.1:5173/?shellState=error) |
| Deadlines | [loading](http://127.0.0.1:5173/deadlines?shellState=loading) | [empty](http://127.0.0.1:5173/deadlines?shellState=empty) | [error](http://127.0.0.1:5173/deadlines?shellState=error) |
| Syllabus review | [loading](http://127.0.0.1:5173/syllabus?shellState=loading) | [empty](http://127.0.0.1:5173/syllabus?shellState=empty) | [error](http://127.0.0.1:5173/syllabus?shellState=error) |
| Materials | [loading](http://127.0.0.1:5173/materials?shellState=loading) | [empty](http://127.0.0.1:5173/materials?shellState=empty) | [error](http://127.0.0.1:5173/materials?shellState=error) |
| Settings | [loading](http://127.0.0.1:5173/settings?shellState=loading) | [empty](http://127.0.0.1:5173/settings?shellState=empty) | [error](http://127.0.0.1:5173/settings?shellState=error) |

**Retry** on a simulated error replaces the query with `shellState=empty` on the
same route without reloading or calling the API. **Exit preview** removes the
switch and mounts the normal HTTP application on the same route. Removing the
query manually also exits. Values are case-sensitive; invalid, missing, empty
or repeated-array values select normal mode. Production ignores the switch.
There is no automatic preview after backend failure or missing extension.

The explicitly labeled preview renders only the shell and placeholder, outside
`AppProvider`. It mounts no real route controls (including Settings availability
checks), adapter, extension detection, storage or alert-persistence effects.
No persistent DemoAdapter/browserKV is involved. Normal mode retains
HttpAdapter, the existing integrated screens and SQLite backend ownership.
A real startup error offers Retry, which performs initialization again; repeated
failure retains feedback and successful recovery clears it without fixtures.

Main navigation uses native links with a current-page marker. The skip link
focuses main content, which is named for the selected section. Route navigation
focuses main; the narrow-screen toggle exposes its expanded state and controlled
navigation. Existing focus-visible outlines are retained. Actual browser
keyboard order, painted focus, layout and hydration still require the manual
verification described in the [evidence note](_docs/issue-8-verification.md).

For the supported local production shell server, from `frontend/`:

```powershell
bun run build
$env:HOST = '127.0.0.1'
$env:PORT = '4174'
node .output/server/index.mjs
```

The existing Nitro integration now selects its Node server preset for this local
entry. Lovable's configured production preset override remains owned by its
existing plugin. The inherited `bun run preview` command currently asks TanStack
for `dist/server/server.js`, which Nitro does not emit; use the Node entry above.
This verifies a local production shell, not a deployed public site. The Vite
development `/api` proxy remains unchanged; this standalone production server
has no configured backend proxy, so full production API operation is not claimed.
A deployment still needs its own same-origin `/api` routing.

With both servers running in separate terminals, repeat the HTTP checks from
`frontend/` (no backend is needed):

```powershell
node src/test/verify-shell-http.mjs http://127.0.0.1:5173 http://127.0.0.1:4174
bun run test
```

The HTTP checker makes 100 real direct/refresh route requests, checks headings,
selected links, development/production state boundaries, unknown-route 404s and
production client entry assets. Router DOM tests separately exercise actual
shell/provider/router rendering and handlers. Neither establishes real browser
hydration, Tab/Shift+Tab order, Enter activation, painted focus or mobile layout.

### Explicit teaching calendar

Local syllabus extraction can explicitly retain original browser evidence and route derived metadata to the local backend. [The confidence decision table and privacy boundary](_docs/confidence-routing-31.md) explain automatic acceptance, review, immutable replay and source lookup; no original file/text upload is introduced.

Settings → Explicit teaching calendar saves both inclusive semester boundaries, the calendar timezone and excluded full-week start dates after showing a draft preview. Legacy/sample semester values do not establish a verified map. Teaching weeks pause across excluded seven-day slots; week-only source evidence retains its original precision. See [_docs/teaching-calendar-30.md](_docs/teaching-calendar-30.md) for supported wording, validation, the break example and timezone runtime limits. [Partial holidays and explicit irregular ranges](_docs/irregular-calendar-52.md) retain uncertain numbering until individual ranges are supplied and recalculate workload through the same mapper.

### Resumable mock queue

The extension has a synthetic queue worker backed by the local SQLite database. It does not contact Moodle or change the Snapshot. The fixed `/api/queue` endpoints in `openapi.yaml` create and inspect runs, cancel them, and claim, renew or finish jobs. Writes require the current `/api/bridge-context` binding. Course IDs must already exist in the active startup-selected dataset. Starts accept 1–100 unique IDs and a bounded idempotency key; repeating the key with the same IDs returns the same run. Overlapping active courses share a job. A later run can scan again after a terminal job.

Set `MOODLE_HELPER_QUEUE_CONCURRENCY` before starting the backend to an integer from `1` to `4` (default `1`). SQLite enforces the limit across workers. Claims expire after 60 seconds and the worker renews every 20 seconds. The MV3 worker registers startup and alarm listeners synchronously and uses one persistent, one-minute Chrome alarm to discover directly created runs and retry unfinished work; it does not depend on remaining alive between wakes. On backend restart it obtains a new process binding, and expired claims can be reclaimed. An interrupted unfinished job may execute again, but the result and completion transition are committed together, once per job. A cancelled run cannot accept a late sole-demand result; a shared job continues for any other active run. Failed mock jobs record `mock_failure` without exception text and do not block unrelated jobs.

Run the backend with the existing project commands (`uv sync`, then `uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000`) and build the extension with `bun run --cwd extension build`. Automated interruption checks use the production queue service, real loopback HTTP, a temporary SQLite file, and a controlled mock executor and clock. They do not establish live Chrome interruption behavior or Moodle compatibility.

## Automated fixture browser journey (#47)

Approved dev dependency: `@playwright/test` 1.64.1 (frontend devDependency) with its
matching bundled Chromium (Chrome for Testing 156.0.8078.4, revision 1248) only — no
Firefox/WebKit/headless-shell, no global tooling. One-time setup from `frontend/`:

```sh
bun install --frozen-lockfile
bun run test:e2e:install   # Chromium into the ignored frontend/.playwright-browsers (~440 MB)
```

The browser goes in a project-local ignored folder because the default
`%LOCALAPPDATA%\ms-playwright` copy failed to start on the verified Windows machine
("side-by-side configuration is incorrect"). The Playwright config sets
`PLAYWRIGHT_BROWSERS_PATH` to this folder.

Run from `frontend/` (ports 8000, 5173 and 4174 must be free; the harness never reuses
an existing server, which could hold real data):

```sh
bun run test:e2e          # builds extension/dist, then runs every spec; exit 0 = all passed
bun run test:e2e:broken   # deliberately broken journey; exit 0 only if the failure is detected
```

If a sandboxed agent shell blocks starting Chromium (`spawn UNKNOWN`), run the commands
in an ordinary terminal.

What it does (fixture mode, all synthetic):

- Vite dev starts on `127.0.0.1:5173` (Playwright `webServer`). Each spec file starts
  its own uvicorn on `127.0.0.1:8000` with a fresh TEMP SQLite file under
  `browser-workspace/e2e/.run/<spec>-*`, using the `demo` dataset. Your normal
  `data/moodle-helper.sqlite3` is never used.
- Chromium starts with a fresh persistent profile and only the built unpacked
  `extension/dist`. `--host-resolver-rules` blocks every hostname except loopback. Any
  non-local request fails the run. The Lovable design's Google Fonts requests are
  aborted locally and counted, so the system font fallback is used.
- `journey.spec.ts` (#47) walks through these named steps: saving the tracked-course
  selection and reopening it; an explicit teaching calendar; real local DOCX extraction
  (`frontend/src/test/fixtures/extraction-bilingual.docx`) with evidence kept and
  routing; the committed `teaching-weeks.docx` fixture, whose four week-only or
  unresolved proposals go to review through the real policy, where confirming
  "Exam Week 6" creates exactly one event; a draft submission next to your own completion mark; the reopened badge;
  the Moodle/syllabus conflict showing both dates; a separate personal completion
  check; weekly planner counts and weighted estimates compared with values derived from
  the fixture; a mock run started from the dashboard with progress per course; a
  genuine MV3 worker stop (DevTools `ServiceWorker.stopAllWorkers`) followed by
  reconnecting, a new bridge `workerGeneration` and the same durable run completing
  from SQLite; a partial failed sync, where a test-only hook acting as a second queue
  worker over the real HTTP queue API fails one course job while the extension
  completes the other two (run `failed · 2/3`, saved data and course timestamps
  unchanged); and a backend outage in the middle of a run, after which saved records,
  overlays, candidates, course timestamps and "No successful full sync yet." are
  unchanged once it recovers. The mock executor is synthetic and never claims a live
  full sync.
- `dashboard-shell.spec.ts` (#8 evidence) checks direct open and refresh plus
  client-side hydration on the five routes, in normal mode, in all 15 preview URLs
  with no backend and no API requests, and against the production
  `.output/server/index.mjs` (skipped unless `bun run build` has run). It also covers
  the unknown-route 404, the skip link, real Tab/Shift+Tab/Enter with a painted focus
  check, the narrow 375 px toggle, and keyboard Retry/Exit preview.
- `extension-shell.spec.ts` (#7 evidence) checks that the unpacked build loads, the
  worker stops and wakes, and the popup page opens without errors. It checks the
  content-script isolated world on a **local fixture** page served for
  `https://moodle.sdu.edu.kz/login/index.php` (intercepted, no network), and that no
  extension context appears on an unrelated local site. Granted origins must equal the
  manifest declarations. It reloads through `chrome://extensions` Developer mode and
  checks that no grant is added. The popup is opened as an extension tab, not the
  toolbar popup.

- `document-import.spec.ts` (#24 evidence) imports a valid PDF (through the real PDF.js
  browser worker) and a valid DOCX into chosen courses, stored in IndexedDB. It covers
  a same-course duplicate, declining (cancelled) and accepting a cross-course
  association, the queued/parsing/complete/failed states, and Retry. A simulated
  QuotaExceededError is injected into IndexedDB writes by test code only, then Retry
  succeeds. The records survive a real browser restart of the same profile. A network
  capture across the whole context shows no request carrying document bytes or
  multipart content.

Results: list output, an HTML report (never auto-opened), `results.json`, and, on
failure, a screenshot, trace and error context under
`browser-workspace/e2e/.artifacts/{normal,broken}/`. All of these are ignored.
`show-trace` opens a trace. Specs use no retries.
