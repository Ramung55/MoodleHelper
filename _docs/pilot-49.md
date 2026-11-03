# Chrome pilot package (#49) — LOCAL REVIEW BUILD

**Status: Not yet live-validated.** The extension package is not signed, not a store build,
and not published or distributed. The approved HTTPS dashboard origin is
`https://ramung55.github.io/MoodleHelper/` (owner approval 2026-11-01, reconfirmed 2026-11-02).
GitHub Pages **is enabled** with owner approval and serves the dashboard there (§3).
Issue #49 stays open until all six original criteria pass. AC3 (fresh-install connection
from the live Pages site) and AC5 (extension-path SDU smoke check) are owner-only Chrome
steps and are **UNVERIFIED / pending** (§3, §5).

## 1. Build the package

Pinned inputs: `frontend/bun.lock`/`uv.lock` as committed; verified with Bun 1.3.13, Node 24.20.0,
Python 3.13.14. From the repository root:

```
uv sync
bun install --cwd frontend      # existing lockfile only
uv run python tools/package_pilot.py
```

The script rebuilds `extension/dist` (`bun run --cwd extension build`, which deletes
stale output first), then refuses to package unless:

- `dist/` holds exactly the eleven allowlisted files (manifest, `index.js`, `content.js`,
  `dashboard-relay.js`, `popup.html/js`, `transfer.html/js`, `offscreen.html/js`, `icon-128.png`);
- every manifest reference exists, and permissions/host/content-script scope equal the
  reviewed values in §2;
- the worker still opens `offscreen.html` and `transfer.html` by path, and each extension
  page still loads its own script (these pages are not named in the manifest);
- `minimum_chrome_version` is `109`;
- no source maps, private keys, token-like strings, credential assignments or local user
  paths appear in any file.

Output in gitignored `pilot-package/`: `moodle-helper-extension-<version>-<commit7>.zip`,
`SHA256SUMS` and `build-info.json`. `build-info.json` records the label "Not yet
live-validated", the extension version, `minimum_chrome_version` (109), `commit`,
`working_tree_dirty`, tool versions, the build and package commands, the file list,
permissions, hosts, `approved_https_dashboard_origin: "https://ramung55.github.io/MoodleHelper/"`
and a `dashboard` block (see "Dashboard version" below). The zip uses sorted entries and
fixed timestamps, so identical `dist/` bytes give an identical zip. Bit-identical `dist/`
across machines is not claimed. Version stays `0.0.0`, and no release tag exists.

The runtime package holds no third-party code apart from what Bun bundles from
`extension/src` and `shared/`. PDF.js, OCR assets (`_docs/ocr-asset-inventory.json`) and
Playwright are dashboard-side or test-only, so they are not in the extension zip. The
package holds no student data: the extension ships code and one icon only, and the scan
above refuses keys, tokens, credentials and local user paths.

**Dashboard version.** The dashboard embeds no version string. Its version is the commit it
was built from plus the GitHub Pages run that deployed it. `build-info.json` records
`dashboard.commit` (always the packaged `commit`), `dashboard.build_command`
(`bun run --cwd frontend build:pages`), `dashboard.pages_workflow`
(`.github/workflows/pages.yml`) and `dashboard.pages_run_id`. The run id is `"pending"`
until Pages has deployed that same commit; then rebuild with
`uv run python tools/package_pilot.py --pages-run-id <run id>`.

| Recorded 2026-11-03 | Commit | Pages run |
|---|---|---|
| Last Pages deploy | `35067a2` | 41520591494 (success, 2026-11-02) |
| This package (local HEAD, unpushed) | the `commit` in `build-info.json` | **pending**: needs the owner-approved push |

The owner's AC3/AC5 check must use an extension zip and a Pages deploy from the **same
commit**: compare `build-info.json` `commit` with the Pages run's head SHA.

## 2. Install (local only)

1. Run `uv run python tools/package_pilot.py`, or unzip the package into an empty folder.
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick
   `<repo>/extension/dist` (absolute path) or the unzipped folder.
3. Pin Moodle Helper from the puzzle menu and open the popup from the action button.
4. After a rebuild, click **Reload** on the extension card.

Minimum Chrome version: 109 (`minimum_chrome_version`; raised from 106 for the `offscreen`
permission, owner decision 2026-11-02, #20). The packager refuses any other value. Only the
Playwright-bundled Chromium (#47) has been exercised by agents; no specific stable Chrome
version is verified. The owner records the version from `chrome://version` in the AC3 check.

Permissions in the emitted manifest:

| Permission / scope | Why |
|---|---|
| `alarms` | reminder/queue worker wake-ups |
| `downloads` | explicit, user-started PDF downloads (#41) |
| `notifications` | OS reminder notifications (depends on OS/Chrome notification settings) |
| `offscreen` | one offscreen document (`offscreen.html`) parses fetched SDU pages for the read-only scans; the service worker has no DOMParser (#20) |
| host `http://127.0.0.1:8000/*` | local backend |
| host + content script `https://moodle.sdu.edu.kz/*` | read Moodle pages you visit, and the read-only requests listed below |
| content script `http://127.0.0.1:5173/*`, `http://localhost:5173/*` | dashboard relay (development) |
| content script `https://ramung55.github.io/MoodleHelper/*` | dashboard relay (approved HTTPS dashboard) |

That is 4 permissions, 2 hosts and 3 relay matches; the packager refuses any change.

What the extension requests from SDU. Every request goes through the one #20 request
authority (one Moodle request at a time) and uses the student's own Chrome session; no
credentials are stored.

- **Find my SDU courses** (#82): `GET /my/courses.php` for the page's session key, then the
  read-only Moodle web service `core_course_get_enrolled_courses_by_timeline_classification`
  (`inprogress`) via `POST /lib/ajax/service.php`, paged, at most 4 pages. Only the course id,
  link, cleaned title, term indicator and the course code (#84, first shortname segment)
  are kept.
- **Setup sign-in check** (#46): exactly one `GET /my/courses.php`. Only the page's `<body>`
  id and classes are classified, and nothing is stored.
- **Sync all** (#20, #83): for each **selected** course only, the course page
  `/course/view.php?id=…`, the quiz and assignment pages found on it, and the upcoming
  calendar `/calendar/view.php?view=upcoming` once per course job. Resource, URL and folder
  links are recorded from the course page without being requested.
- **Download PDF** (#41): one explicit click fetches one file from `https://moodle.sdu.edu.kz`
  and hands it to Chrome's download manager. Nothing is fetched automatically.

**Local network access prompt.** The Pages dashboard calls the local backend at
`http://127.0.0.1:8000` directly. Chrome may show a "local network access" prompt asking to
let `ramung55.github.io` reach devices on your local network. Allow it, or the dashboard
shows "Local data could not be loaded".

Prerequisites: the backend `uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000`,
and either the dev dashboard `bun run --cwd frontend dev` (port 5173) or the hosted
dashboard at `https://ramung55.github.io/MoodleHelper/`. Removing or disabling the
extension stops scans, reminders and the relay. Dashboard-origin browser data (IndexedDB
documents) stays until you clear site data, and backend SQLite stays until you erase it.
The dev and hosted dashboards are different origins, so their IndexedDB data is separate.

**Approved HTTPS origin (AC2):** `https://ramung55.github.io/MoodleHelper/`. It is the same
value in the manifest relay match, `APPROVED_ORIGINS` in `shared/src/bridge.ts` (origin
`https://ramung55.github.io`), the backend CORS allowlist (`DASHBOARD_ORIGIN` in
`backend/main.py`) and `build-info.json`. The extension trusts a Pages sender only over
https and only under `/MoodleHelper/`. A GitHub Pages origin covers every project page of
the `ramung55` account, so the backend CORS grant also admits other `ramung55.github.io`
pages; the owner controls all of them.

## 3. Dashboard deployment

The frontend is TanStack Start. `bun run --cwd frontend build` keeps the Nitro node-server
output for local production checks. The Vite dev proxy `/api` → `127.0.0.1:8000` is
development-only and is not a production route or authentication. The backend is a
single-user localhost store and must not be exposed publicly.

**GitHub Pages build:** `bun run --cwd frontend build:pages` sets `MOODLE_HELPER_PAGES=1`.
That uses Vite base `/MoodleHelper/` (which also becomes the router basepath) and SPA mode
with every route prerendered. Output is `frontend/.output/public/`:

- **Asset paths:** every script, style and the OCR assets load from `/MoodleHelper/…`.
  `scripts/finish-pages.mjs` fails the build if `index.html`, `deadlines/index.html` or
  `settings/index.html` does not reference `/MoodleHelper/assets/`.
- **Deep links:** `/deadlines`, `/planner`, `/syllabus`, `/materials`, `/settings`, `/alerts`
  and `/setup` each have a prerendered `index.html`. Pages redirects `/deadlines` to
  `/deadlines/`, and the shell matches both forms. Any other path gets `404.html`, a copy
  of the SPA shell, so the client router renders it. `.nojekyll` is added so `_shell.html`
  is published.
- **HTTPS → loopback:** on `https://ramung55.github.io` the dashboard calls
  `http://127.0.0.1:8000` directly (`frontend/src/services/api-base.ts`); elsewhere it keeps
  same-origin `/api`. The backend sends CORS headers only for that exact origin (no
  credentials), answers Chrome's Private Network Access preflight, and keeps the loopback
  Host check (#63) and the bridge-binding write checks. Chrome may ask the user to allow
  the site to reach local devices (§2); allow it once.
- **Deploy (enabled, owner-approved 2026-11-02, 5aab953):** `.github/workflows/pages.yml`
  runs on pushes to `codex/backend-in-memory` (allowed in the `github-pages` environment),
  runs `bun install --frozen-lockfile` and `bun run build:pages` in `frontend/` and publishes
  `frontend/.output/public/`. Last deploy: run **41520591494** at commit **`35067a2`**
  (success, 2026-11-02). Local HEAD is ahead and unpushed, so the live site does not yet
  match this package.
- **Pending (owner):** approve the push that redeploys Pages from the packaged commit, then
  record the new run id here and in `build-info.json` (`--pages-run-id`). Agents do not push
  or deploy.

Verified on 2026-11-02: the built output served locally under `/MoodleHelper/`, and the live
site `https://ramung55.github.io/MoodleHelper/deadlines`, loaded every asset from
`/MoodleHelper/assets/`, called `http://127.0.0.1:8000/api/*` directly and, with no backend
reachable, showed the "Local data could not be loaded" error state with Retry. Against the
real local backend, a preflight from `https://ramung55.github.io` returned 200 with
`Access-Control-Allow-Origin` and `Access-Control-Allow-Private-Network: true`; one from
another origin returned 400.

**AC3 fresh-install connection: UNVERIFIED (pending the owner's Chrome).** Agents' browsers
cannot load extensions and block page-to-loopback requests. Backend log lines showing the
owner's installed worker reaching the backend (2026-11-02) do not show the page origin and
are not AC3 evidence. Owner steps (issue #49, "Owner Chrome steps"): record the Chrome
version (109 or later); load `extension/dist` or the unzipped package in a fresh profile;
start the backend; open `https://ramung55.github.io/MoodleHelper/deadlines` and allow local
network access. Pass: data is shown (not "Local data could not be loaded"), the popup or
Settings shows the extension connected, and a refresh of `/MoodleHelper/settings` still
loads. Record a screenshot without personal data, or backend log lines with an
`Origin: https://ramung55.github.io` request.

## 4. Privacy summary

- Structured records (courses, deadlines, planner) live in the backend SQLite file under
  `data/` (gitignored). Imported PDF/DOCX/OCR text and evidence live in the dashboard
  origin's IndexedDB in the browser profile, not in the backend, and are never uploaded.
- **Course code (#84):** discovered courses store only the first segment of the Moodle
  shortname (for example `DEMO101`). The rest of the shortname, which includes an
  instructor-login segment, is never sent to the backend, stored or logged. The instructor
  name is stripped from course titles.
- **Submission status (#81):** the backend can store an assignment's submission state
  (submitted, not submitted, draft, reopened or unknown), its wording, source link and
  observed time, with the latest attempt kept separate from the last confirmed status and a
  stale flag, in the backend Snapshot's collection layer. No grades or submission text are
  stored. No live collector sends submission status yet (the submission collector is not
  dispatched until #20 enables it), so in practice nothing is stored.
- **Downloaded PDFs (#41):** a Download PDF click saves the file through Chrome's download
  manager into your normal downloads folder. Moodle Helper keeps only a transfer record
  (`material_transfers`) and the material's `downloadedAt`. Erase removes those records but
  **not** the file on disk or its entry in Chrome's download history; delete those yourself.
  Exports never include downloaded file bytes.
- Export, restore and erase behaviour is as documented in `_docs/backup-export-45.md`,
  `_docs/backup-restore-55.md` and `_docs/local-erase-56.md`. Erase does not remove
  downloaded files on disk, Chrome download history or exported backup files.
- Workers run only while Chrome and the backend run. Missed alarms catch up only as far as
  `_docs/notifications-39.md` describes.
- AI is off unless the operator configures the free-tier Gemini provider (#42–#44). When it
  is on, only excerpts the student approves are sent, after a consent screen that states
  Google's free-tier data use. The pilot key is currently rejected with `403
  PERMISSION_DENIED`, so in practice nothing is sent (#42 and #44 are deferred by the owner).
- Installing grants no Moodle account. The extension only reads pages you are logged in
  to, and it does not prove login.

## 5. SDU smoke record

**Package label: Not yet live-validated** (also in `build-info.json`).

**Source-page evidence** (read-only, by the student with consent): see
`_docs/compatibility/sdu-moodle.md`, the page variant matrix and **Addendum 6** (re-check
2026-11-02, commit 48c3363). English interface; observed on 2026-11-01 and again on
2026-11-02:

| Page variant | Outcome |
|---|---|
| Course page, `format-topics` (8 of 8 enrolled courses) | Observed, unchanged |
| Quiz view, finished attempt (3 of 3); one attempt without a "Marks" infobox; two with a quiz-password note | Observed. The #14 parse logic returned `complete` on all 3 quiz pages and the course page, and `signed_out` without credentials |
| Assignment, "Submitted for grading" (5) and "No submissions have been made yet" (14) | Observed. No draft or reopened status was available |
| Material `mod/resource`: 4 of 14 redirect to a file (2 PDF, 2 EPUB), 10 stay an HTML page | Observed |
| `pluginfile.php` without a session | Login page with HTTP 200, so it must be treated as signed out |
| Draft/reopened submissions, cut-offs, overrides, restricted activities, folders with files, RU/KK interface | **UNVERIFIED** (not available in the account) |

No names, grades, file names or credentials were kept.

**Extension-path smoke check** (the installed extension running Find my SDU courses and
Sync all on SDU): **UNVERIFIED, pending the owner's Chrome.** No agent has run the
installed extension against SDU, and the #47 fixture journey is not live evidence. Owner
step (issue #49, AC5): signed in to SDU yourself, open one course, one assignment and one
quiz page, run Find my SDU courses and Sync all once, and record each page variant, date,
language and result (complete, partial or signed_out) with no names, grades or
credentials. If this cannot be done, this record stays UNVERIFIED, which the original AC5
allows.

## 6. Known limitations / open issues

Status as of 2026-11-03. "Repo checks passed" means QA passed the repository checks; the
issue stays open until its owner Chrome steps are run.

- [#20](https://github.com/Ramung55/MoodleHelper/issues/20) Sync all wiring: repo checks
  passed; owner Chrome check pending. Full sync is not yet trusted live.
- [#82](https://github.com/Ramung55/MoodleHelper/issues/82) Find my SDU courses: repo checks
  passed; owner Chrome check pending.
- [#83](https://github.com/Ramung55/MoodleHelper/issues/83) assignment, calendar and material
  collectors on observed pages: repo checks passed; owner Chrome check pending.
- [#41](https://github.com/Ramung55/MoodleHelper/issues/41) Download PDF: repo checks passed;
  owner Chrome steps 1–6 pending. PDFs only. Demo, synthetic and in-memory data answer "not
  available yet". A login page, a resource that opens as a Moodle page, EPUB/DOCX/PPTX and
  folder entries are never saved.
- [#21](https://github.com/Ramung55/MoodleHelper/issues/21) sync progress and freshness: repo
  checks passed; owner Chrome check pending.
- [#46](https://github.com/Ramung55/MoodleHelper/issues/46) first-run onboarding: repo checks
  passed; owner Chrome steps pending.
- [#85](https://github.com/Ramung55/MoodleHelper/issues/85) non-PDF and folder downloads:
  needs an owner decision before any work.
- [#42](https://github.com/Ramung55/MoodleHelper/issues/42),
  [#44](https://github.com/Ramung55/MoodleHelper/issues/44) cloud AI: deferred by the owner
  (2026-11-02). The free-tier key is rejected with `403 PERMISSION_DENIED`, so no real AI
  extraction runs.
- [#48](https://github.com/Ramung55/MoodleHelper/issues/48) privacy review (closed): findings
  F1 and F2 are resolved. Its QA required a re-trace of the browser request log once #20 and
  #41 landed, because real collectors and `pluginfile` fetches were disabled when it was
  traced. **That re-trace is still pending.** No new issue was opened; it is tracked here.
- Reminder notification clicks still open the development dashboard
  `http://127.0.0.1:5173` (`APPROVED_ORIGINS[0]` in `shared/src/bridge.ts`, used by
  `extension/src/reminders.ts`), not the Pages dashboard.
- Submission status (#81) is stored by the backend but not yet collected live (§4).
- The live Pages deploy (`35067a2`) is behind this package's commit until the owner approves
  the push (§1, §3).

Tested: backend pytest suite, frontend vitest, extension vitest, and the #47 fixture
Chromium journey (synthetic data). Untested: the installed extension against live Moodle,
real Chrome stable, a fresh install connecting from the live Pages site (AC3), and
multi-user use. There is **no promise of complete deadline coverage**, reliable full-sync
success, full corruption detection, perfect OCR or date parsing, or a working AI service.
