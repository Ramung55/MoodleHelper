# Decision: private single-user deployment on OCI over Tailscale

Status: **accepted by the owner 2026-11-15** (approach, plus the follow-up decisions in
[Owner decisions](#owner-decisions-2026-11-15)). Documentation only: no
code, config, OCI resource or tailnet was created or changed. Implementation, security
review and QA are still required before any real student data goes on the VM.

Naming: "option A" in this note is the owner's label for the Tailscale deployment. It is
**not** option A of [oracle-architecture-options.md](../oracle-architecture-options.md)
(local-only, no Oracle). In that document's terms this is option B (hosted backend for one
user) with access method 3 (private network, no public login).

Inputs: [oracle-deployment.md](../oracle-deployment.md), [plan.md](../plan.md),
[local-process-auth.md](local-process-auth.md) (#64),
[privacy-permissions.md](../reviews/privacy-permissions.md) (#48 and the #114 addendum),
`Caddyfile.oci`, `docker-compose.production.yaml`, `backend/main.py`,
`frontend/src/services/api-base.ts`, `extension/src/dashboard-bridge.ts`,
`extension/manifest.json`, `shared/src/bridge.ts`. Checked against `main` `d7736dd`.

## Context

The backend is a credential-free API whose trust boundary is "whoever can reach it"
(#64). Today that is loopback. #62 (binding header on every non-GET) and #63
(`LoopbackHostMiddleware`, exact loopback Host only) stop web pages in the user's browser.

The Caddy Basic-auth proposal (`Caddyfile.oci`) puts a public HTTPS perimeter in front of
that API. It was tested and **does not work with the dashboard**: the frontend sends every
API call with `credentials: "omit"`, so the browser never resends the cached Basic
credentials and every `/api` call gets 401 ([oracle-deployment.md](../oracle-deployment.md)).
Making it work means changing the client credential contract and accepting Basic auth as
the only authentication on a public port.

The owner wants the dashboard and backend on their own Oracle Always Free ARM VM, used only
by themselves, reachable only over Tailscale, with no public ports.

## Decision

Run the existing app on the VM bound to loopback, and reach it only through the owner's
tailnet:

- The app (uvicorn) listens on `127.0.0.1:8000` on the VM (Compose publishes
  `127.0.0.1:8000:8000`, or uvicorn runs under systemd with `--host 127.0.0.1`). The
  backend serves the built dashboard itself (`backend/static`, as the `Dockerfile` already
  does), so dashboard and API share one origin.
- `tailscaled` on the VM terminates HTTPS with `tailscale serve` (Tailscale-issued
  certificate for `<machine>.<tailnet>.ts.net`) and proxies to `127.0.0.1:8000`. It listens
  only on the tailnet interface. No Caddy, no Basic auth, no public DNS record.
- The OCI security list / NSG has **no ingress rules at all**, including TCP 22. Admin
  access is Tailscale SSH; OCI Console serial connection stays as the recovery path.
  Tailscale needs only egress (UDP 41641 and HTTPS to the coordination/DERP servers).
- The tailnet ACL lets only the owner's own user reach the VM's port 443. No shared
  nodes, no other users, no `autogroup:member` grant.

The trust boundary becomes "the owner's devices on the owner's tailnet" instead of "this
computer". That is the same kind of boundary as #64, extended to a few devices, and it
needs no application authentication.

## Options compared

| | Tailscale private (chosen) | Caddy + Basic auth (proposal) |
|---|---|---|
| Public exposure | None. No public port, no public DNS A record | TCP 80/443 open to the internet; Caddy and the app are attack surface for everyone |
| Who can connect | Devices the owner enrolled in their tailnet, filtered by ACL | Anyone who can guess or steal one shared password |
| Authentication | Device identity (WireGuard keys) + Tailscale account login with its 2FA | One shared Basic identity: no logout, no rate limit, no lockout, no recovery |
| Works with the current dashboard | Yes. `credentials: "omit"` stays; there are no browser credentials to send | **No.** Every API call gets 401 unless the frontend switches to `same-origin` credentials |
| Client credential contract | Unchanged | Changes (hosted mode with `credentials: "same-origin"`), plus a CSRF review because the browser then has ambient credentials |
| #62 / #63 protections | Carry over unchanged (see Security below) | Host check is defeated by design: Caddy rewrites `Host` to `localhost`, so the proxy becomes the only gate |
| TLS | Tailscale cert for the `ts.net` name (also inside WireGuard) | Public Let's Encrypt cert, needs a domain and open TCP 80 |
| Extra parts to run | `tailscaled` on the VM and on each client device | Caddy container, bcrypt user file, domain and DNS |
| Access from a device without Tailscale | Not possible (phones/laptops must run Tailscale) | Any browser |
| Third parties | Tailscale coordination server sees device metadata, not traffic; DERP relays carry encrypted traffic | Domain registrar/DNS provider; certificate authority |
| Cost | Tailscale Personal plan is free for this size (recheck current limits); OCI as below | Domain may cost money; OCI as below |
| New code | Small (Host allowlist entry, extension origin, build config) | Same plus frontend credentials mode and a real auth layer before it is safe |

Option rejected: **Caddy Basic auth**. It does not work with the current client, and making
it work trades a no-credential client for a single shared password on a public port.
Never remove `basic_auth` from `Caddyfile.oci` as a shortcut; that file stays a rejected
proposal, not a fallback.

## What must change

None of this is implemented. Each item names the code it touches.

### 1. Backend Host check (`backend/main.py`, `LoopbackHostMiddleware`)

Today any Host other than `127.0.0.1`, `localhost`, `[::1]` gets 400.

- **First verify** what Host `tailscale serve` forwards to the backend. If it forwards
  the incoming `<machine>.<tailnet>.ts.net`, the backend rejects it.
- Add **one exact host name** taken from trusted startup configuration (for example an
  environment variable read in `create_app`, like the database URL), matched with
  `fullmatch` like the loopback names. Keep loopback names (the Compose health check uses
  `127.0.0.1`). Never a wildcard, suffix match or `*.ts.net`.
- Do **not** copy the Caddy approach of rewriting `Host` to `localhost` in the proxy:
  that hides the real Host from the check and turns the proxy into the only DNS-rebinding
  defence.
- Tests: extend `tests/test_host_allowlist_63.py` with the configured name accepted, and
  look-alikes rejected (`<name>.attacker.example`, trailing dot, other `ts.net` names,
  name unset means loopback only).

### 2. CORS (`backend/main.py`, `CORSMiddleware`)

Dashboard and API are same-origin on the VM, so no CORS grant is needed for the hosted
dashboard. `allow_credentials=False` stays. The existing `DASHBOARD_ORIGIN`
(`https://ramung55.github.io`) grant with `allow_private_network=True` would let the Pages
build read the VM API from a tailnet device. **Decided:** the hosted deployment registers
no CORS grant (one origin to reason about); the local setup keeps the Pages grant unchanged.
Selected by the same startup configuration as the Host name (hosted mode = name set).

### 3. Frontend credentials and API base (`frontend/src/services/`)

- **Credentials: no change.** `credentials: "omit"` in `http-adapter.ts`,
  `ai-gateway.ts` and `ai-fallback.ts` stays. Tailscale authenticates the device, not the
  browser request, so there is nothing to send. This is the main reason the 401 blocker
  does not apply.
- API base: `apiBase()` (`api-base.ts`) already returns `""` (same-origin `/api`) for any
  origin other than the Pages origin, so the dashboard served from the VM works unchanged.
  Add a test case for a `ts.net` origin in `frontend/src/test/api-base.test.ts`.
- Secure context: the `ts.net` origin is HTTPS, so browser APIs that need a secure context
  keep working. Plain `http://` over the tailnet is not an option for that reason.

### 4. Extension origins (`extension/`, `shared/`)

The extension still reads Moodle in the owner's browser with the owner's session; the VM
never contacts Moodle. Only where it writes changes.

| What | Today | Change |
|---|---|---|
| Backend address | `BACKEND = "http://127.0.0.1:8000"` (`extension/src/dashboard-bridge.ts`), used by `collection-repository.ts`, `page-visit.ts`, `popup.ts`, `queue.ts`, `reminders.ts`, transfer code | `https://<machine>.<tailnet>.ts.net`, set at build time |
| `host_permissions` (`extension/manifest.json`) | `http://127.0.0.1:8000/*`, `https://moodle.sdu.edu.kz/*` | Replace the loopback entry with `https://<machine>.<tailnet>.ts.net/*` in the hosted build |
| Dashboard relay content script matches (`manifest.json`) | `127.0.0.1:5173`, `localhost:5173`, `ramung55.github.io/MoodleHelper/*` | Add `https://<machine>.<tailnet>.ts.net/*` |
| `APPROVED_ORIGINS` (`shared/src/bridge.ts`) | dev origins + `https://ramung55.github.io` | Add the `ts.net` origin; must stay equal to the relay matches |
| Popup dashboard link (`DASHBOARD_URL`, `popup.ts`) | build define `__MOODLE_HELPER_DASHBOARD_URL__` (`extension/build.ts`) already exists | Set it to the `ts.net` URL in the hosted build |
| Popup start help (`START_COMMAND`, `popup.ts`) | tells the user to run uvicorn locally | Hosted build shows "connect Tailscale" instead |
| Permission probe (`permissions.contains({origins:[BACKEND+'/*']})`) | loopback | follows `BACKEND` automatically |

- Pinned tests to update: `test_manifest_matches_reviewed_inventory` and
  `test_bridge_allowlist_equals_dashboard_content_script_matches`
  (`tests/test_privacy_review_48.py`), the browser-workspace bridge tests, and the #48
  inventory in `privacy-permissions.md` (new addendum).
- The machine and tailnet name end up in the built extension and, with HTTPS enabled, in
  public Certificate Transparency logs (Tailscale publishes cert names). Use a
  non-identifying machine name (not your name or student number). **Decided:** the name is
  never committed. It is injected at build time for the extension (like the dashboard URL)
  and at startup for the backend. The hosted build generates its manifest; the local build
  and its source-equals-dist manifest pin stay unchanged.
- **Decided: two extension builds.** The local build is unchanged. The hosted build differs
  only in the items in the table above. `test_privacy_review_48.py` keeps the local pin and
  adds a check that a hosted dist manifest equals its own reviewed inventory, with the
  injected name as the only variable part (recorded as a #48 addendum).
- When the device is off the tailnet, every extension call fails; the existing
  `BACKEND_UNAVAILABLE` path covers it.

### 5. Deployment files

- New Compose file (or an edited `docker-compose.production.yaml`) without the `caddy`
  service and without published 80/443; the app publishes only `127.0.0.1:8000`.
- Database: **decided: SQLite** on the `/data` volume, the tested default (WAL since
  #129). No PostgreSQL container; backups use the existing backup export or a consistent
  copy of the SQLite file (WAL-aware, not a plain copy of a live file).
- `.env.production.example`: remove `SITE_DOMAIN`, `OCI_BIND_ADDRESS` and the Caddy secret;
  add the allowed Host name.
- Rewrite the procedure in `oracle-deployment.md` for Tailscale (install `tailscaled`,
  `tailscale up`, enable HTTPS certificates and MagicDNS in the admin console, `tailscale
  serve --bg 443 http://127.0.0.1:8000`, ACL, Tailscale SSH, then remove OCI ingress
  rules). Recheck the exact `tailscale serve` syntax against the installed version.
- `Caddyfile.oci` and the `.oci-secrets/caddy-users` steps: mark as rejected or delete.

## Security notes

- **#62 still holds.** Cross-site pages in the owner's browser can send CORS-simple POSTs
  to the `ts.net` URL, but cannot add `X-Moodle-Helper-Bridge-Binding`, so writes get 409.
  There are no cookies or Basic credentials, so there is nothing ambient to ride on.
- **#63 still holds, and matters more.** A page can make `attacker.example` resolve to the
  VM's `100.x` tailnet address (DNS rebinding). The exact Host check rejects it. This is
  why the Host check must gain one exact name and must not be bypassed by a rewriting proxy.
- **Reads.** Any process on any of the owner's tailnet devices can read and write all data,
  as any local process could under #64. Accepted because the tailnet holds only the owner's
  devices. Shared or compromised tailnet devices widen it; the ACL limits which devices
  can reach port 443.
- **Port squatting (#64 threat d)** is harder: clients now authenticate the server by its
  TLS certificate.
- **Backend secrets.** `GROQ_API_KEY` moves into the VM environment. This is a #64 reopen
  condition ("backend starts holding secrets"); keep `.env.production` mode 600 and out of
  Git, as `oracle-deployment.md` already says.
- **Optional, not required:** `tailscale serve` adds `Tailscale-User-Login` headers; the
  backend could require the owner's login. Skip unless the tailnet ever has another user.

## Privacy

- **Data leaves the device.** `plan.md` says "Data stays on the student's device by
  default". With this deployment the owner's snapshot (courses, deadlines, planner,
  reminders) lives on an Oracle VM. That is an owner decision for the owner's own data, and
  this note records it; it is not a default for other students and does not change the
  product scope.
- **Moodle session stays in the browser.** The extension still fetches Moodle with
  `credentials: "include"` in the owner's Chrome. Cookies and tokens are never sent to the
  VM; the backend never calls Moodle (its only outbound HTTP is the opt-in AI gateway).
  Material downloads still run through `chrome.downloads`, so files land on the device,
  not the VM.
- **Document excerpts** extracted locally stay in the browser (IndexedDB), as #48 recorded;
  only the structured results the dashboard already sends to the backend go to the VM.
- **Oracle** can technically access the boot volume (provider trust). OCI encrypts volumes
  at rest with Oracle-managed keys.
- **Tailscale** sees device names, IPs and connection metadata, not app traffic.
- **Backups and erase.** Backup export/restore and local erase work unchanged through the
  dashboard. Off-VM backups are the owner's responsibility; Always Free instances that sit
  idle can be reclaimed by Oracle (a single-user app is usually under the idle threshold),
  which would lose the data without one.

## OCI and cost

Unchanged from [oracle-deployment.md](../oracle-deployment.md): check Always Free limits,
image eligibility, A1 capacity and budget alerts in the Console before creating anything.
No public IP is needed for the app; one is still useful for Tailscale to make direct
connections, and an ephemeral one is free. ARM64 end-to-end build and browser test on the
VM remain unverified.

## Owner decisions 2026-11-15

1. The `ts.net` name is injected at build/startup time and never committed. The hosted
   build generates its manifest; `test_privacy_review_48.py` keeps the local manifest pin
   and checks the hosted dist against its own reviewed inventory (section 4).
2. The hosted deployment drops the GitHub Pages CORS grant; the local setup keeps it
   (section 2).
3. SQLite on the VM (section 5).
4. Two extension builds: local (unchanged) and hosted (section 4).

Order: the first step verifies on the real VM which Host header `tailscale serve`
forwards. No Host-check change is made before that evidence exists.

## What would reopen this decision

- Any user other than the owner, or any shared tailnet node, needs access.
- A public port, public DNS record or Tailscale Funnel is enabled.
- The app is offered to other students as a hosted service (that is option C).
- Tailscale's free plan or terms stop fitting.
