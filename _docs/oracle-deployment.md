# OCI Always Free deployment proposal

Prepared 2026-11-12. **Not deployed or approved for public use.** The files
`docker-compose.production.yaml`, `Caddyfile.oci`, and `.env.production.example`
are a reviewable starting point. No OCI resources have been inspected, created,
or modified. Do not expose the application until the security and live-Moodle
limitations below have been resolved and the owner approves deployment.

## Architecture and security gate

One existing eligible Ubuntu ARM64 A1 VM, if suitable and available, runs Docker
Compose: Caddy terminates HTTPS; FastAPI serves the frontend and API; PostgreSQL
stores the dataset on a named volume backed by the VM's boot volume. Only Caddy
publishes 80/443, and its bindings default to `127.0.0.1`. The app has no published
host port. PostgreSQL has no published port and joins only an internal database
network. Caddy and the app communicate on a separate internal network. The app
also has an outbound-capable network for existing opt-in AI provider calls.
Docker host administrators can access containers and data; Docker networks are
not an authorization boundary against the host.

**Blocking decision:** the approved application is a credential-free, local-only
single-user tool. Its process binding is obtainable by any API caller and is not
authentication. Caddy's proposed mandatory Basic authentication protects all
proxied routes with a separately managed bcrypt hash, but this is a new perimeter,
not approved application authentication; it has one shared identity, no logout,
account isolation, built-in rate limiting, or recovery process. HTTPS alone does
not authorize access. The proxy rewrites `Host` to `localhost` to satisfy the
backend's loopback-only host check, so proxy access control becomes critical.
Obtain a security review and a decision on authentication, rate limiting, secret
rotation and network access before changing the loopback binding or exposing real
student data. Test missing/invalid auth files, unauthorized access to every route,
and bypass attempts through both Docker and the host. A failed or missing
credential file must prevent Caddy from starting. Never remove the auth block as
a workaround. The sample has no working credentials.

**Confirmed functional blocker:** a Chromium test against the isolated full
Compose stack authenticated the page successfully but the dashboard's API requests
returned 401. The frontend explicitly uses `credentials: 'omit'`, so the browser
does not send its cached Basic credentials on those requests. A controlled request
using `same-origin` returned 200. Consequently the proposed Basic-auth stack is
not a working deployment for the current dashboard. An approved and independently
reviewed authentication and same-origin credential strategy is needed before any
deployment; do not remove the proxy gate or silently change the existing client
contract. The original application remains unchanged.

The Chrome extension and dashboard-origin allowlists currently target local
addresses, not this OCI domain. Live Moodle collection and active-account binding
remain unverified. Hosting the dashboard does not make that integration work and
changes the local-data privacy model; these decisions require separate approval.
The proposed stack defaults to demo data. Existing identity and AI environment
settings may be passed through explicitly only after the privacy and security
decisions are approved. External AI remains opt-in and can incur separate provider
charges; its durable cost ledger must use the persistent `/data` volume. Neither
real identity nor external AI is verified by the proxy test.

## Free-tier and cost checks before any provisioning

Inspect **Governance & Administration → Tenancy Management → Limits, Quotas and
Usage**, billing/usage, the home region, existing instances, storage, backups,
public addresses and network resources. Prefer reusing a suitable existing VM
without resizing, deleting or changing it. Confirm its image is marked **Always
Free Eligible**, that it is Ubuntu ARM64, and that capacity and the intended
changes fit the remaining tenancy limits. An out-of-capacity response is possible;
wait or consider another eligible availability domain in the home region. Do not
upgrade, purchase, provision a paid shape, or assume capacity exists.

Oracle currently lists 1,500 A1 OCPU-hours and 9,000 GB-hours per month (the
Always Free tenancy allowance is stated as 2 OCPUs and 12 GB continuously),
200 GB combined boot/block storage, five volume backups, and 10 TB monthly
outbound transfer. These are shared allowances, not additional resources for
this project. Verify actual Console limits and usage before acting; Oracle's own
page gives conflicting minimum boot-volume figures in different sections, so
use the Console's current value. Idle Always Free instances can be reclaimed.
[Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Expected OCI cost is **$0 only if** every selected resource and usage stays within
the applicable Always Free allowances. It is not guaranteed: this tenancy's
account type, region, existing usage and selected configuration are unknown.
Domain registration, paid DNS, excess transfer, backups or other selected services
may cost extra. Verify pricing and enable cost alerts before provisioning; OCI
budgets alert but do not stop charges.
[Oracle cost guidance](https://docs.oracle.com/en/solutions/oci-best-practices/track-and-manage-usage-and-cost1.html)

## ARM64 compatibility report

On 2026-11-12, registry manifest inspection found `linux/arm64` variants for
`node:22-bookworm-slim`, `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`,
`postgres:16-alpine` and `caddy:2-alpine`. Tags are mutable; recheck and pin
reviewed image digests before release. The frozen frontend dependency installation
and Python dependency installation completed under ARM64 emulation. An ARM64
backend-stage image built and imported FastAPI application and native dependencies
including psycopg, cryptography and pydantic-core under emulation.

The complete `docker buildx build --platform linux/arm64 --load .` did **not**
finish: Vite's frontend transformation stalled for several minutes under x86
emulation and the build was interrupted. This does not prove native ARM failure,
but it leaves the final image, frontend, all runtime dependencies and the full
Compose stack unverified on ARM64. No ARM compatibility fix was justified by
that result. The Dockerfile installs an unpinned Bun version, another reproducibility
risk. Complete a native ARM64 build and isolated Compose/browser test on approved
hardware before deployment; do not treat image manifests as end-to-end proof.

Local x86 Compose QA used an isolated, temporary test stack and test credentials.
Caddy rejected unauthenticated dashboard/API/docs requests, accepted explicitly
authenticated requests, rejected missing and malformed credentials, and the startup wrapper
rejected an empty credential file. The app and database had no host-published
ports. A subsequent real browser test found the credential incompatibility described
above. These checks used local test TLS, not public certificate issuance or a native ARM
deployment. The proxy health check establishes that its TLS port is listening,
not that a public certificate is valid or authorization is correct.

## OCI Console and firewall actions (after approval only)

1. Inventory the existing VM, VCN/subnet, public IP, storage, security lists and
   network security groups; do not modify or delete unrelated resources. Verify
   remaining Always Free quota and the instance's architecture and capacity.
2. If an eligible VM exists, review its current workload, available disk/memory,
   backups and change window. If none exists, check home-region A1 capacity and
   the Always Free label before seeking approval for any creation.
3. Set DNS A/AAAA records only to addresses actually assigned to the approved VM;
   remove an AAAA record if IPv6 is not configured. Caddy's public certificate
   requires an actual domain, correct DNS and externally reachable TCP 80/443.
   The example domain is deliberately nonfunctional. Without a domain, keep the
   service private; do not fall back to unauthenticated public HTTP.
   [Caddy HTTPS documentation](https://caddyserver.com/docs/quick-starts/reverse-proxy)
4. After the access gate is reviewed, permit TCP 80 and 443 in the applicable
   OCI security list/NSG and preserve required egress. Restrict TCP 22 to trusted
   administrator IPs; do not expose TCP 8000 or 5432. Check *both* OCI network
   rules and the OS firewall. Oracle warns against enabling UFW on OCI Ubuntu
   images because required boot-volume rules can be lost; inspect the existing
   image-specific iptables rules, preserve them and arrange Console recovery.
   Docker's published-port rules also affect host firewall behavior. Do not run
   blanket firewall reset commands. [OCI Compute known issues](https://docs.oracle.com/en-us/iaas/Content/Compute/known-issues.htm)

## Configuration and proposed deployment procedure

Use a dedicated checkout of an approved commit on the VM; the present workspace
contains extensive uncommitted work and is not an immutable release. Install
Docker Engine and Compose from their official Ubuntu ARM64 instructions after
reviewing the VM. No deployment automation or external registry is required.
Back up the existing database and verify restoration before migrations. The app
performs versioned migrations on startup; do not automatically import or overwrite
local SQLite data. A separate approved export/restore plan is required for that.

Create `.env.production` from `.env.production.example` locally on the VM with
restrictive permissions. Replace all placeholders. Generate a unique URL-safe
database password and put the same value in `POSTGRES_PASSWORD` and the database
URL; percent-encode URL-special characters if used. Do not paste secrets into
GitHub, command history, logs or support requests. Compose environment variables
and Docker configuration are visible to privileged host users; use host access
controls and a reviewed secret-management plan. `.env.production` and
`.oci-secrets/` are Git- and Docker-context-ignored; verify before committing.
The example is not a valid production secret.

Create `.oci-secrets/caddy-users` with restrictive permissions. Each line must be
`username bcrypt_hash`; generate the hash interactively with
`docker run --rm -it caddy:2-alpine caddy hash-password` and put the hash, not the
plaintext password, into the file. Keep the plaintext outside the repository and
out of shell history. Verify the actual Caddy version's command before use. The
file is mounted read-only and required; no default user is provided. Test the
perimeter on isolated, non-student data before approving it.

Only after security and deployment approval, review the rendered configuration
without sharing its output (it contains secrets), choose whether to set
`OCI_BIND_ADDRESS=0.0.0.0`, and run:

```sh
docker compose --env-file .env.production -f docker-compose.production.yaml config --quiet
docker compose --env-file .env.production -f docker-compose.production.yaml up -d --build --wait
docker compose --env-file .env.production -f docker-compose.production.yaml ps
docker compose --env-file .env.production -f docker-compose.production.yaml logs --tail=100
```

Confirm anonymous requests to the dashboard, `/docs`, `/api/snapshot`,
`/api/bridge-context` and mutation endpoints are denied; confirm authorized
access, trusted TLS, static assets, API, PostgreSQL persistence and backups. A
health check only establishes service readiness, not authentication or correctness.
Review logs before sharing. `docker compose ... down` retains named volumes;
never use `down --volumes` for a live database.

## GitHub, rollback and remaining verification

No OCI API keys, deployment keys, GitHub secrets or CI deployment are required for
the proposed manual review. The existing AWS deploy job is disabled; CI tests may
still run. Do not add an automatic OCI deployment, SSH key or registry secret until
the access design and deployment workflow are separately approved. Review the
actual uncommitted diff and ensure no secrets are staged before making a release.

For rollback, record the previous image/commit and configuration, take and test a
database backup before upgrade, stop traffic, and restore the prior image only if
its schema is compatible. If a migration changed the schema, restore the verified
matching backup instead of assuming a code rollback can downgrade it. Preserve
Caddy certificate volumes and the database volume. The single VM and local volume
are a single point of failure; plan off-VM encrypted backups and test restoration
without assuming free backup capacity or cost. Public exposure, live extension
integration, actual OCI quota, ARM runtime and certificate issuance are not proven
by this proposal.
