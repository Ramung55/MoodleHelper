# Privacy and permissions review (#48)

Tested revision: `422bd3a` (branch `codex/backend-in-memory`), source plus emitted `extension/dist`.
Method: source inspection, emitted-manifest comparison, backend TestClient probes
(`tests/test_privacy_review_48.py`), existing closed-bridge suites
(`browser-workspace/*.test.ts`, 124/124 passed). No production code or config was changed.
No live SDU contact, real accounts, provider keys or paid calls were used.

Evidence kinds are kept separate: **SRC** source inspection, **NODE** Node/TestClient or
vitest network mock, **BROWSER** real browser capture. Nothing here is BROWSER evidence.

## 1. Permission and origin inventory

`extension/manifest.json` and `extension/dist/manifest.json` are identical (pinned by
`test_manifest_matches_reviewed_inventory`). MV3, `minimum_chrome_version` 106.
No `optional_permissions`, `externally_connectable` or `web_accessible_resources`.
The gate's starting inventory (only `alarms`, only the loopback host) is now outdated:
#39 and #41 landed.

| Entry | Source | Feature / necessity | Caller and route bound | Evidence |
|---|---|---|---|---|
| `alarms` | manifest.json:37 | queue/reminder reconcile wake-ups (#39, #55) | worker only | NODE reminder-worker, queue-lifecycle tests pass |
| `notifications` | manifest.json:39 | optional OS alerts for dashboard alerts (#39, `_docs/notifications-39.md:8`) | `extension/src/reminders.ts:163-168`, fixed options, backend-derived text | NODE notification-delivery tests pass |
| `downloads` | manifest.json:38 | single explicit PDF save (#41) | `extension/src/transfer-entry.ts:18-21` | NODE material-transfer tests pass |
| host `http://127.0.0.1:8000/*` | manifest.json:33 | local backend | worker fetches with `credentials:"omit"`, `redirect:"error"` (`collection-repository.ts:39`, `transfer-entry.ts:24-25`) | NODE bridge-network, queue-network |
| host `https://moodle.sdu.edu.kz/*` | manifest.json:34 | privileged GET of one backend-registered pluginfile URL | regex `material-transfer.ts:9` + origin check `:71`, `GET`, `redirect:"error"`, `no-referrer` `:83`, redirect = sign-in `:87` | NODE material-transfer |
| content script SDU | manifest.json:15 | read-only page collection | top-frame + origin check `page-refresh.ts:101`; collectors read DOM only (`moodle-courses.ts:3`) | NODE scan tests |
| content script dashboard | manifest.json:23-24 | bridge relay | equals `APPROVED_ORIGINS` (`shared/src/bridge.ts:7`), pinned by `test_bridge_allowlist_equals_dashboard_content_script_matches` | NODE bridge-security |

No unused or wildcard grants found. No approved HTTPS dashboard origin (dev-only HTTP origins;
#49 must decide the packaged origin). Ordinary-link navigation to Moodle (e.g. `loginUrl`,
`moodle-access.ts:63`) is user navigation, not a privileged fetch. Local assets: pdf.js worker is
a bundled `?url` import (`frontend/src/services/extract-pdf.ts:2`); OCR core/lang paths are
built from `window.location.origin` (`local-ocr-worker.ts:9,33-34`); grep found no CDN host in
`frontend/src`. Future provider destination: none (AI inactive, section 4).

## 2. Request trace (criterion 2) - PARTIAL / UNVERIFIED

SRC: every Moodle request in `extension/src` is a GET (collectors read the DOM; the single
`fetcher` call to SDU is `method:"GET"`, `material-transfer.ts:83`); no POST/PUT to
`moodle.sdu.edu.kz` exists. Backend writes go only to 127.0.0.1:8000 (expected local API writes,
not Moodle mutations). NODE: the vitest network suites mock `fetch` and assert routes.
**UNVERIFIED**: no automated real-browser capture of a full synthetic fixture journey
(scan, PDF/DOCX/OCR review, reminders, download) was run; it needs the #47 Playwright harness with
the unpacked extension. Backend-side capture alone cannot prove browser-wide absence.

## 3. Bridge and backend negative paths

Bridge (NODE, `browser-workspace/bridge-security.test.ts`, passing): sender checks
`dashboard-bridge.ts:54-62` (runtime id, `frameId===0`, tab id, sender origin/tab URL must match
an approved origin); window relay checks `e.origin === win.location.origin` (`:375`); closed
schemas and 1 MiB bound (`shared/src/bridge.ts:8,25-29`); unknown/malformed/oversized/spoofed and
late messages covered by the existing suite.

Backend (NODE, `test_privacy_review_48.py`): all non-GET routes under ai, backups/restore,
local-data/erase, reminders, material-downloads, queue, scan, collection, local-syllabus return
409 without the process binding before body parsing (`backend/main.py:90-135`). No CORS grant to
foreign origins on reads or preflight. Binding (`app.state.bridge_binding`, `main.py:60`) and
lifecycle epochs are stale-write fences, **not authorization**: `/api/bridge-context`
(`routers.py:45-47`) hands the binding to any local client.

Trust boundary (documented, not a finding): the backend is a credential-free localhost API; any
local process can read and write all data. The window allowlist does not protect against that.

Findings beyond that boundary (browser pages are not local processes):
- **F1 High** - `POST /api/demo/reset` (and `POST /api/sync`) accept unbound CORS-simple
  requests (`text/plain`, foreign `Origin`) -> 200; reset replaces the whole snapshot
  (`routers.py:222`, `services.py:343`). Any website can wipe local data. -> #62, unresolved.
- **F2 Medium** - no Host-header validation; `Host: attacker.example:8000` -> 200
  (`main.py`, no TrustedHostMiddleware). DNS rebinding gives a remote page read access and the
  binding. -> #63, unresolved.
- DELETE routes (`DELETE /api/local-data`, `routers.py:216`) need a preflight, which returns 405
  with no ACAO, so browsers block them cross-origin; they remain within the local-process boundary.

## 4. Document content, AI, logs, backup

- Document content (#24): dashboard renders excerpts via React text nodes; the only
  `innerHTML`-style use outside tests is `components/ui/chart.tsx` (static CSS from config, no
  document text). SRC only; **UNVERIFIED** in a real browser with a malicious synthetic excerpt
  (needs #47 harness).
- AI (#43/#44): `AiGateway` default mode is inactive (`ai_gateway.py:335-348`); provider is
  chosen only at trusted construction (`main.py:32-33`); availability reports unavailable
  (`test_ai_provider_inactive_by_default`). No HTTP client is imported by `ai_gateway.py`. Live
  consent/retention cannot be verified: no provider exists, so it is **unavailable**, not a pass.
- Logging: gateway logs only request id, code and count (`ai_gateway.py:415,419`). Error handlers
  return `str(error)` of internal exceptions (`main.py:200,204,245,249,267`); messages reviewed in
  source are fixed strings; no payload echo found. Synthetic-secret log/backup probe:
  **UNVERIFIED** beyond the existing #45/#55/#56 suites (`tests/test_backup_restore.py`,
  `tests/test_local_erase.py`).
- Backup/restore/erase: restore is bound and size-limited before parse (`main.py:117-135`);
  erase is bound (probe). Backups contain the full structured snapshot by design.

## 5. Findings table

| ID | Severity | Revision | Location | Repro | Issue | Status |
|---|---|---|---|---|---|---|
| F1 | High | 422bd3a | `routers.py:222` / `main.py:90` | strict xfail `test_finding_f1_*` | #62 | unresolved |
| F2 | Medium | 422bd3a | `main.py` (no Host check) | strict xfail `test_finding_f2_*` | #63 | unresolved |

Known limitations cited, not duplicated: #3 live SDU compatibility, #7 Chrome URL policy,
#20 verified scan. Unmet / UNVERIFIED: criterion 2 browser trace, criterion 4 browser
inertness and synthetic-secret log probe. #48 stays open until these and QA are done.
