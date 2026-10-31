# Chrome pilot package (#49) — LOCAL REVIEW BUILD

**Status: Not yet live-validated.** Not signed, not a store build, not published or
distributed. No approved HTTPS dashboard origin exists. Issue #49 stays open until all
six original criteria pass.

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

- `dist/` holds exactly the nine allowlisted files (manifest, `index.js`, `content.js`,
  `dashboard-relay.js`, `popup.html/js`, `transfer.html/js`, `icon-128.png`);
- every manifest reference exists, and permissions/host/content-script scope equal the
  reviewed values below;
- no source maps, private keys, token-like strings, credential assignments or local user
  paths appear in any file.

Output in gitignored `pilot-package/`: `moodle-helper-extension-<version>-<commit7>.zip`,
`SHA256SUMS`, `build-info.json` (version, commit, dirty flag, tool versions, commands,
`approved_https_dashboard_origin: null`). The zip uses sorted entries and fixed
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

Minimum Chrome version: 106 (`minimum_chrome_version`). Only the Playwright-bundled
Chromium (#47) has been exercised; no specific stable Chrome version is verified.

Permissions in the emitted manifest:

| Permission / scope | Why |
|---|---|
| `alarms` | reminder/queue worker wake-ups |
| `downloads` | explicit, user-started material downloads |
| `notifications` | OS reminder notifications (depends on OS/Chrome notification settings) |
| host `http://127.0.0.1:8000/*` | local backend |
| host + content script `https://moodle.sdu.edu.kz/*` | read Moodle pages you visit |
| content script `http://127.0.0.1:5173/*`, `http://localhost:5173/*` | dashboard relay |

Prerequisites: the backend `uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000`
and the dashboard `bun run --cwd frontend dev` (port 5173). Removing or disabling the
extension stops scans, reminders and the relay. Dashboard-origin browser data (IndexedDB
documents) stays until you clear site data, and backend SQLite stays until you erase it.

**BLOCKED (AC2):** the exact approved HTTPS dashboard origin is missing. The owner has
not supplied a URL (PM update 2026-10-29). The allowlist stays localhost-only, with no
placeholder or wildcard.

## 3. Dashboard deployment

The frontend is TanStack Start with Nitro's node-server preset (`bun run --cwd frontend
build`, output in `frontend/.output/`). The Vite dev proxy `/api` → `127.0.0.1:8000` is
development-only and is not a production route or authentication. The backend is a
single-user localhost store and must not be exposed publicly.

**BLOCKED (AC3):** HTTPS hosting, trusted HTTPS→loopback design, and fresh-install
connection evidence all wait on the origin decision. Production direct-route and
deep-link checks for /deadlines, /planner, /syllabus, /materials, /settings and /alerts
have not been recorded in this package yet; QA must still verify them.

## 4. Privacy summary

- Structured records (courses, deadlines, planner) live in the backend SQLite file under
  `data/` (gitignored). Imported PDF/DOCX/OCR text and evidence live in the dashboard
  origin's IndexedDB in the browser profile, not in the backend, and are never uploaded.
- Export, restore and erase behaviour is as documented in `_docs/backup-export-45.md`,
  `_docs/backup-restore-55.md` and `_docs/local-erase-56.md`. Erase does not remove
  downloaded files on disk or Chrome download history.
- Workers run only while Chrome and the backend run. Missed alarms catch up only as far as
  `_docs/notifications-39.md` describes.
- No AI provider is configured, so nothing is sent (#42–#44 mock only).
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
- #41 optional material downloads: open.
- #42, #44: AI is mock-only; no real provider, consent or cost.
- #46 first-run onboarding: open.
- #48: privacy review findings are unresolved; see the issue for severity and repro.
- #64: loopback backend local-process authentication is undecided (#48 trust boundary).

Tested: backend pytest suite, frontend vitest, extension vitest, and the #47 fixture
Chromium journey (synthetic data). Untested: live Moodle, real Chrome stable, the HTTPS
dashboard, and multi-user use. There is no promise of complete deadlines, reliable
full-sync success, full corruption detection, perfect OCR or date parsing, or AI.
