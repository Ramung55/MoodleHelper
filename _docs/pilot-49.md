# Chrome pilot package (#49) — LOCAL REVIEW BUILD

**Status: Not yet live-validated.** Not signed, not a store build, not published or
distributed. The approved HTTPS dashboard origin is `https://ramung55.github.io/MoodleHelper/`
(owner approval, 2026-11-01), but GitHub Pages is **not enabled**, so nothing is published.
Issue #49 stays open until all six original criteria pass.

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
  reviewed values below;
- no source maps, private keys, token-like strings, credential assignments or local user
  paths appear in any file.

Output in gitignored `pilot-package/`: `moodle-helper-extension-<version>-<commit7>.zip`,
`SHA256SUMS`, `build-info.json` (version, commit, dirty flag, tool versions, commands,
`approved_https_dashboard_origin: "https://ramung55.github.io/MoodleHelper/"`). The zip uses sorted entries and fixed
timestamps, so identical `dist/` bytes give an identical zip. Bit-identical `dist/`
across machines is not claimed. Version stays `0.0.0`, and no release tag exists.

The runtime package holds no third-party code apart from what Bun bundles from
`extension/src` and `shared/`. PDF.js, OCR assets (`_docs/ocr-asset-inventory.json`) and
Playwright are dashboard-side or test-only, so they are not in the extension zip.

## 2. Install (local only)

1. Run `uv run python tools/package_pilot.py`, or unzip the package into an empty folder.
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick
   `<repo>/extension/dist` (absolute path) or the unzipped folder.
3. Pin Moodle Helper from the puzzle menu and open the popup from the action button.
4. After a rebuild, click **Reload** on the extension card.

Minimum Chrome version: 109 (`minimum_chrome_version`; raised from 106 for the `offscreen`
permission, owner decision 2026-11-02, #20). Only the Playwright-bundled
Chromium (#47) has been exercised; no specific stable Chrome version is verified.

Permissions in the emitted manifest:

| Permission / scope | Why |
|---|---|
| `alarms` | reminder/queue worker wake-ups |
| `downloads` | explicit, user-started material downloads |
| `notifications` | OS reminder notifications (depends on OS/Chrome notification settings) |
| `offscreen` | one offscreen document (`offscreen.html`) parses fetched SDU pages for the read-only Sync all scan; the service worker has no DOMParser (#20) |
| host `http://127.0.0.1:8000/*` | local backend |
| host + content script `https://moodle.sdu.edu.kz/*` | read Moodle pages you visit; Sync all reads selected course pages and their quiz pages, one request at a time (#20) |
| content script `http://127.0.0.1:5173/*`, `http://localhost:5173/*` | dashboard relay (development) |
| content script `https://ramung55.github.io/MoodleHelper/*` | dashboard relay (approved HTTPS dashboard) |

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
  the site to reach local devices; allow it once.
- **Deploy (not done):** publish `frontend/.output/public/` as the Pages site of
  `Ramung55/MoodleHelper`, for example with a GitHub Actions Pages workflow. Enabling Pages
  makes the dashboard code public, so the owner must approve it first.

Verified on 2026-11-02 with the built output served locally under `/MoodleHelper/`:
`/MoodleHelper/deadlines` loaded every asset from `/MoodleHelper/assets/`, and with no
backend at that origin it showed the "Local data could not be loaded" error state with Retry.
**Not yet verified:** a fresh install against the real Pages origin connecting to the local
backend and extension. That needs Pages enabled.

## 4. Privacy summary

- Structured records (courses, deadlines, planner) live in the backend SQLite file under
  `data/` (gitignored). Imported PDF/DOCX/OCR text and evidence live in the dashboard
  origin's IndexedDB in the browser profile, not in the backend, and are never uploaded.
- Export, restore and erase behaviour is as documented in `_docs/backup-export-45.md`,
  `_docs/backup-restore-55.md` and `_docs/local-erase-56.md`. Erase does not remove
  downloaded files on disk or Chrome download history.
- Workers run only while Chrome and the backend run. Missed alarms catch up only as far as
  `_docs/notifications-39.md` describes.
- AI is off unless the operator configures the free-tier Gemini provider (#42–#44). When it
  is on, only excerpts the student approves are sent, after a consent screen that states
  Google's free-tier data use.
- Installing grants no Moodle account. The extension only reads pages you are logged in
  to, and it does not prove login.

## 5. SDU smoke record

**UNVERIFIED — access unavailable** (#3, #4). No authorized live SDU page has been
inspected, and collectors are synthetic-fixture only. The #47 fixture journey is not live
evidence. No credentials were requested or used.

## 6. Known limitations / blocked issues

- #3, #4: no live SDU access or compatibility evidence; collectors are unverified.
- #14 quiz dates, #16 submission status: open.
- #20 Sync-all wiring and #21 progress/freshness display: open, so full sync is not trusted.
- #41 optional material downloads: on for PDFs in the real dataset (owner decision
  2026-11-02). One explicit **Download PDF** click saves one PDF from
  `https://moodle.sdu.edu.kz` with the student's own Chrome session, through the #20
  request authority (one Moodle request at a time, 30 s per request). Demo, synthetic
  and in-memory data still answer "not available yet". A login page, a resource that
  opens as a Moodle page, EPUB/DOCX/PPTX and folder entries are never saved (#85 covers
  other formats). The live Chrome check (issue #41, steps 1–6) is still to be run by the
  owner; until #83 lands, the real dataset has no SDU PDF materials to download.
- #42, #44: free-tier Gemini provider implemented but not yet run against the real API.
- Reminder notification clicks still open the development dashboard
  (`APPROVED_ORIGINS[0]`, `http://127.0.0.1:5173`), not the Pages dashboard.
- #46 first-run onboarding: open.
- #48: privacy review findings are unresolved; see the issue for severity and repro.
- #64: loopback backend local-process authentication is undecided (#48 trust boundary).

Tested: backend pytest suite, frontend vitest, extension vitest, and the #47 fixture
Chromium journey (synthetic data). Untested: live Moodle, real Chrome stable, the HTTPS
dashboard, and multi-user use. There is no promise of complete deadlines, reliable
full-sync success, full corruption detection, perfect OCR or date parsing, or AI.
