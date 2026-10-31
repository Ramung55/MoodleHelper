# Decision: local-process authentication for the loopback backend (#64)

Status: decided, revision `65ffeb1` (branch `codex/backend-in-memory`). Decision and
documentation only; no code, config or test changed.

Context: `_docs/reviews/privacy-permissions.md` section 3 records the trust boundary: the
backend at `http://127.0.0.1:8000` is a credential-free localhost API and any local process
can read and write all data. This note decides whether to add authentication beyond that.

## Decision

**Keep the loopback trust boundary.**

Reasons:

1. A token does not stop the main remaining caller, a process running as the same OS user.
   That process can already open the SQLite file `data/moodle-helper.sqlite3`
   (`backend/database_config.py`, `DEFAULT_DATABASE`), read the browser profile (IndexedDB
   documents, the extension's storage, Moodle session cookies), and read any token file the
   user can read. A per-launch token would only move the secret, not protect it.
2. Other OS users are not a case this pilot has. It is a single-user, local-only,
   unpublished pilot (`_docs/pilot-49.md`). No shared machine is in scope.
3. The two caller classes that are realistic and cheap to exploit, web pages through
   cross-site POSTs and DNS rebinding, are already closed by #62 and #63.
4. A token touches every caller in the Affected callers table: two dashboard services
   (`http-adapter.ts`, `ai-gateway.ts`) and the Vite proxy, seven extension files plus the
   shared collection contract, 17 backend pytest files plus `conftest.py`, 7 dashboard vitest files,
   9 browser-workspace node tests, the e2e harness and specs, the OpenAPI document and its
   generator, and the pilot package. It also needs a pairing step with its own UX and
   failure paths. That cost buys no protection against reason 1.
5. A token would not fix port squatting (see threat (d)). Fixing that needs the client to
   authenticate the server, which is a different and larger design.

No implementation issue is filed, as the acceptance criteria require for this decision.

## Threat model

| Caller class | In scope? | Status |
|---|---|---|
| (a) Other processes running as the same OS user, including malware and other installed browser extensions with `127.0.0.1` host permissions | Considered; **accepted**, not mitigated | These run with the user's own rights. They can read the SQLite file and the browser profile directly, so a backend token adds little. |
| (b) Processes of other OS users on the same machine (loopback is shared across users) | **Out of scope** for the pilot | Single-user machine assumed. Reopens the decision if that changes (see below). |
| (c) Web pages in the user's browser via cross-site requests and DNS rebinding | **Already covered** | #62 (resolved in `d0744a1`): every non-GET needs `X-Moodle-Helper-Bridge-Binding`, else 409 before body parsing (`backend/main.py`, `bridge_precondition`), and no CORS grant to foreign origins, so a page cannot set the header or read responses. #63 (resolved in `ebe286f`): `LoopbackHostMiddleware` (`backend/main.py`) returns 400 for any Host other than `127.0.0.1`, `localhost` or `[::1]`, so a rebinding name cannot reach any route. |
| (d) A process that binds port 8000 before the backend starts and impersonates it | Considered; **accepted**, not mitigated | Clients never authenticate the server. A squatter receives the extension's and dashboard's writes and can serve fake data. A client-side token does not help: the squatter just accepts any token. |

## What the per-process binding protects, and what it does not

`app.state.bridge_binding` is a `uuid4().hex` made per process/store in `create_app`
(`backend/main.py`).

It protects:

- **Stale writes after restart.** A write carrying an old or no binding gets 409 before
  any parsing or service work (`bridge_precondition`, `backend/main.py`). Most routes answer
  `"Backend context changed. Reconnect."`; backup restore, erase and collection/queue/
  local-syllabus writes use their own 409 texts (e.g. `"... Reconnect and refresh the
  restore preview."`, `"... nothing was deleted."`, `"Collection context changed.
  Reconnect."`).
- **Cross-site simple POSTs.** A web page cannot add the custom header to a CORS-simple
  request, and the backend grants no CORS, so the page can neither send the header nor
  read the binding. Together these stop browser-borne writes.

It does not protect:

- **Reads.** Every GET route (snapshot, local-context, collection-context and others)
  answers any local caller. Any local caller can read all backend data.
- **Writes by a local process.** The binding is not a secret. `GET /api/bridge-context`
  (`backend/routers.py`, `bridge_context`) returns `{"version": "1", "binding": ...}` with no
  check, and `GET /api/collection-context` (`CollectionService.context`,
  `backend/collection.py`) also carries it. A local process fetches it and then calls any
  write, including `POST /api/local-data/erase`, `POST /api/demo/reset` and
  `POST /api/backups/restore`.
- **The dev proxy path.** The same is possible through the Vite dev server on
  `127.0.0.1:5173`, which proxies `/api` to `127.0.0.1:8000` (`frontend/vite.config.ts`).

## Options considered

### 1. Keep the loopback trust boundary (chosen)

- Pros: no code change; no new failure modes; no pairing UX; nothing for the pilot user to
  set up; #62 and #63 already cover browser pages.
- Cons: any same-user or other-user local process can read and write all backend data;
  port squatting is not detected.
- Effect on callers: none.

### 2. Per-launch secret token on reads and writes

The backend makes a random token at launch and requires it on every route, including
GETs. `/api/bridge-context` and the binding in `/api/collection-context` would have to stop
being the way to get it, since an unauthenticated route that hands out the token defeats
it. Ways the token could reach callers:

- **Dashboard (via Vite proxy):** the proxy could add the header server-side, reading the
  token from a file. Then the browser never sees it, but anything that can reach
  `127.0.0.1:5173` gets the same access, so the proxy becomes the hole. The dev server would
  need its own caller checks, which are out of scope here.
- **Chrome extension:** no file access. Options are a one-time pairing step (user copies a
  code from the backend console into the popup, stored in `chrome.storage.local`), or a
  native-messaging host that reads a token file (needs an installed host manifest and a
  registry entry on Windows).
- **File readable only by the current user:** helps against other OS users (b) only if the
  file ACLs are set correctly on Windows and Unix. Gives nothing against same-user
  processes (a), which can read the same file.
- **Launcher-injected value:** a launcher starts backend and dashboard with the token in
  the environment. Works for the dashboard; still needs pairing for the extension.

- Pros: closes (b) if the token store is per-user; stops casual same-user scripts that do
  not know where to look.
- Cons: does not stop (a) or (d); pairing UX and re-pairing after restarts; a new
  secret that must be kept out of logs, backups and URLs; every caller and test changes.
- Effect on callers: every row of the Affected callers table changes, including both dashboard services, the dashboard vitest files and the OpenAPI contract. No new dependency is needed for a
  plain header token (`secrets` is stdlib); a native-messaging host would be new packaging
  and would need asking first.

### 3. OS-level mechanisms

Examples: a Windows named pipe or Unix domain socket with OS ACLs, or per-user firewall
rules restricting port 8000 to the user's processes.

- Pros: the OS enforces who can connect; strong against (b); a socket path owned by the
  backend also makes squatting (d) harder.
- Cons: a browser extension cannot talk to a pipe or socket. It would need a
  native-messaging host as a relay, which is new installed software. The dashboard would
  need the Vite proxy (or another server) to relay too. Per-user firewall rules are
  OS-specific, need admin rights to set up, and are not portable. Still does nothing
  against (a). Likely needs new dependencies or packaging (needs asking first).
- Effect on callers: every caller's transport changes; the e2e harness and pilot package
  change substantially.

## Affected callers

Under the decision (keep the boundary), **none of these change**.

Found by grepping `bridge-context`, `collection-context`, `bridgeContext`,
`collectionContext` and `X-Moodle-Helper-Bridge-Binding` across `frontend/`, `extension/`,
`shared/`, `browser-workspace/`, `tools/`, `tests/` and the repository root (excluding
`node_modules`, build output and test artifacts). Under option 2 or 3 every row would change.

| Caller | Files | Changes? |
|---|---|---|
| Dashboard services | `frontend/src/services/http-adapter.ts` (fetches `/api/bridge-context`, caches it, one refetch-and-retry on the 409; erase, restore, local-syllabus and local-review writes fetch it fresh); `frontend/src/services/ai-gateway.ts` (fetches `/api/bridge-context` itself and sends the header on `POST /api/ai/extract`, not through `http-adapter.ts`) | No |
| Dashboard proxy | Vite proxy in `frontend/vite.config.ts` (`/api` → `127.0.0.1:8000`) | No |
| Dashboard vitest | `frontend/src/test/http-adapter.test.ts`, `ai-gateway.test.ts`, `backup-restore.test.ts`, `app-http-errors.test.tsx`, `page-refresh.test.ts`, `ai-fallback.test.tsx`, `mock-progress.test.tsx` | No |
| Chrome extension | `extension/src/dashboard-bridge.ts` (`BACKEND = "http://127.0.0.1:8000"`), `popup.ts`, `queue.ts`, `reminders.ts`, `synthetic-scan-worker.ts`, `transfer-entry.ts`, `collection-repository.ts` (gets the binding from `GET /api/collection-context`), `extension/manifest.json` (`host_permissions` `http://127.0.0.1:8000/*`) | No |
| Shared contract | `shared/src/collection.ts` (`collectionContext` operation, `binding` field on collection requests) | No |
| Backend pytest | `tests/conftest.py` and 17 test files: `test_ai_gateway.py`, `test_backup_restore.py`, `test_bridge_context.py`, `test_contract.py`, `test_host_allowlist_63.py`, `test_local_erase.py`, `test_local_review.py`, `test_local_syllabus.py`, `test_material_downloads.py`, `test_memory_app.py`, `test_page_refresh.py`, `test_privacy_review_48.py`, `test_queue.py`, `test_reminders.py`, `test_scan_queue_service.py`, `test_sync_availability.py`, `test_write_binding_62.py` (all via TestClient) | No |
| Browser-workspace node tests | `browser-workspace/bridge-security.test.ts`, `bridge-network.test.ts`, `extension-shell.test.ts`, `notification-delivery.test.ts`, `queue-lifecycle.test.ts`, `queue-network.test.ts`, `reminder-worker.test.ts`, `synthetic-scan-network.test.ts`, `synthetic-scan-restart.test.ts` | No |
| E2E harness | `browser-workspace/e2e/harness.ts` (starts uvicorn on `127.0.0.1:8000`), `journey.spec.ts`, `privacy-evidence.spec.ts` (read the binding from `/api/bridge-context`) | No |
| API contract and docs | `openapi.yaml` (documents `/api/bridge-context`, `/api/collection-context` and the header), `tools/define_collection_contract.py` (generates the collection part), `README.md`, `backend/README.md` | No |
| Pilot package (#49) | `tools/package_pilot.py`, `_docs/pilot-49.md`, gitignored `pilot-package/` (zip of `extension/dist`, so it carries the extension's callers above) | No |

## Edge cases

- **Backend restart mid-session:** the binding rotates; the dashboard's single
  refetch-and-retry on the 409 `"Backend context changed. Reconnect."`
  (`http-adapter.ts`, `STALE_BINDING`) keeps working unchanged; `ai-gateway.ts` and the
  one-shot writes in `http-adapter.ts` fetch the binding fresh per call, so they are unaffected.
- **Two dashboard tabs, or dashboard plus extension:** all callers share one process
  binding fetched independently, so they do not conflict; nothing changes.
- **`localhost` vs `127.0.0.1` vs `[::1]`:** `LoopbackHostMiddleware` accepts all three Host
  names; the extension only uses `127.0.0.1` (its only backend host permission); uvicorn
  listens on IPv4 `127.0.0.1`, so `[::1]` passes the Host check but has no listener.
- **Leaks into logs, backups/exports or URLs:** must not happen, and does not today. The
  binding travels only in a header; uvicorn access logs record paths, not headers; backups
  and exports hold the snapshot, not the binding; no caller puts it in a query string.
- **Dashboard via the Vite proxy:** the backend sees the proxy process as the TCP peer,
  not the browser; `changeOrigin: false` keeps the browser's loopback Host, so the Host
  check passes. Under this decision the backend does not identify callers, so this is fine.

## Residual risk

In plain words, after this decision:

- Any program running on your computer under your account can read everything the backend
  stores (courses, deadlines, planner, reminders) and can change, restore over, or erase it.
  It can also read the database file and your browser profile directly, without the backend.
- If someone else has an account on the same computer, their programs can do the same
  through the backend. The pilot assumes you are the only user.
- If another program grabs port 8000 before the backend starts, the dashboard and extension
  will talk to it as if it were Moodle Helper. It could see what they send and show fake
  data. Nothing detects this today. Starting the backend first, and the e2e harness's
  "port 8000 already in use" refusal, lower the chance but do not prevent it.
- Websites you visit cannot read or change this data: #62 and #63 block that.

## What would reopen this decision

- The app is used on machines shared by several OS users.
- The backend listens on any non-loopback interface (anything other than `127.0.0.1`).
- The app is packaged or distributed for other users, or published to the Chrome Web Store.
- An approved HTTPS dashboard origin (#49) needs a trusted HTTPS-to-loopback path.
- The backend starts holding secrets (for example Moodle tokens or AI provider keys) that
  are not already readable elsewhere by the same user.
- A native-messaging host or launcher is added for other reasons, making option 2 or 3
  much cheaper.
