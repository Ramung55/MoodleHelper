# OCI deployment over Tailscale (runbook)

Rewritten 2026-11-15 for #137. Decision and reasoning:
[decisions/oci-tailscale-private-deployment.md](decisions/oci-tailscale-private-deployment.md).
Single user (the owner), private tailnet only, no public port, no application login.
Deployment on the real VM and end-to-end checks are #138; nothing here has been run on the
VM yet except the `tailscale serve` evidence from #134.

Shape: one app container (FastAPI serving the built dashboard and the API, SQLite on a named
`/data` volume) publishes only `127.0.0.1:8000`. `tailscaled` on the VM terminates HTTPS
for `<machine>.<tailnet>.ts.net` with `tailscale serve` and proxies to it. The OCI security
list has no ingress rules. Files: `docker-compose.production.yaml`, `.env.production.example`.

**Rejected proposal:** the earlier Caddy + Basic-auth stack (`Caddyfile.oci`, PostgreSQL,
`.oci-secrets/caddy-users`) was deleted in #137. It did not work with the dashboard (every
`/api` call got 401 because the frontend uses `credentials: "omit"`) and put one shared
password on a public port. See the ADR's options table. Do not reintroduce it.

## 1. Always Free and cost checks (before creating or changing anything)

Inspect **Governance & Administration → Tenancy Management → Limits, Quotas and Usage**,
billing/usage, the home region, existing instances, storage, backups, public addresses and
network resources. Confirm the image and shape are marked **Always Free Eligible** and the
change fits the remaining limits. Do not upgrade, purchase or provision a paid shape.

Oracle lists (recheck; shared tenancy allowances, not per project): 2 AMD
`VM.Standard.E2.1.Micro` instances, A1 Flex up to 4 OCPU / 24 GB total (when capacity
exists), 200 GB combined boot/block storage, five volume backups, 10 TB monthly outbound
transfer. Use the Console's current values.
[Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Expected cost is **$0 only if** everything stays within Always Free. Enable a budget alert;
OCI budgets alert but do not stop charges.
[Oracle cost guidance](https://docs.oracle.com/en/solutions/oci-best-practices/track-and-manage-usage-and-cost1.html)
Tailscale Personal plan is free at this size (recheck limits).

**Idle reclamation:** Oracle may reclaim Always Free instances it considers idle (low CPU,
network and memory use over 7 days). A single-user app is usually under that threshold.
Reclamation loses the VM and its volume, so off-VM backups (section 7) are mandatory, not
optional.

## 2. The current VM and image architecture

The VM is `VM.Standard.E2.1.Micro`: **x86_64, 1 GB RAM**, Ubuntu 24.04 Minimal (A1 ARM was
out of capacity, #134). Consequences:

- `linux/arm64` **does not apply** to this VM. An ARM64 image build is **unverified** (an
  emulated build in 2026-11 stalled in the frontend stage); recheck only if the VM moves to A1.
- The same Dockerfile built and ran on local x86_64 in earlier work; the Compose run of this
  file is still to be done (section 9).
- **Building on a 1 GB VM is a risk** (the Vite/bun frontend stage can run out of memory).
  Add a 2 GB swap file before building on the VM (below). A native build on the VM is to
  be verified in #138. If it still fails, build locally and copy the image instead:

  ```sh
  # on your x86_64 machine, from the approved commit
  docker build -t moodlehelper-app:release .
  docker save moodlehelper-app:release | ssh ubuntu@<machine> docker load
  ```

  then on the VM add `image: moodlehelper-app:release` next to `build: .` and start with
  `up -d --no-build`.

Swap file (persistent across reboots):

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## 3. Machine name

The machine name and tailnet name appear in the HTTPS certificate, which is published in
public **Certificate Transparency logs**, and in the hosted extension build. Use a
non-identifying machine name (not your name, student number or "moodle"). **Never commit
the real name** anywhere in this repository: it lives only in `.env.production` on the VM
and in the environment of your local hosted extension build. All docs use placeholders.

## 4. Tailscale on the VM

1. Install `tailscaled` with Tailscale's official Linux instructions
   (`https://tailscale.com/download/linux`; review the script or use their apt repository).
2. `sudo tailscale up --ssh` and log in with the owner's account. Rename the machine in the
   admin console if needed (section 3).
3. Admin console → DNS: enable **MagicDNS** and **HTTPS Certificates**.
4. After the app is running (section 6), serve it. Exact command, verified on Tailscale
   1.104.7 in #134 (recheck `tailscale serve --help` if the version differs):

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:8000
   tailscale serve status
   ```

   Serve passes the client's `Host` through unchanged and listens only on the tailnet; the
   backend's Host check accepts exactly `MOODLE_HELPER_TAILNET_HOST` plus loopback (#135).
   Never use Tailscale **Funnel** (that would make it public).

5. Tailnet access policy: only the owner reaches the VM on 443, plus SSH for the owner.
   Tag the VM (`tag:moodlehelper`) in the admin console and replace the default
   allow-all policy with something like (placeholders; keep any rules your other devices
   need, and remove the default `"*"` grant):

   ```json
   {
     "tagOwners": { "tag:moodlehelper": ["owner@example.com"] },
     "grants": [
       { "src": ["owner@example.com"], "dst": ["tag:moodlehelper"], "ip": ["tcp:443"] }
     ],
     "ssh": [
       { "action": "check", "src": ["owner@example.com"], "dst": ["tag:moodlehelper"], "users": ["ubuntu"] }
     ]
   }
   ```

   Use the policy editor's preview/tests to check that another user or device is denied.
   No shared nodes, no `autogroup:member` grant to the VM.

## 5. Remove OCI ingress (only after recovery paths work)

1. Confirm **Tailscale SSH** works: `ssh ubuntu@<machine>` from a tailnet client.
2. Confirm the **OCI serial console** (Cloud Shell connection) opens a session. This is the
   recovery path if Tailscale breaks.
3. Only then delete **all** ingress rules from the subnet's security list (including
   TCP 22) and confirm the VM has no NSG allowing ingress. Keep egress: Tailscale needs
   UDP 41641 and HTTPS to its coordination and DERP servers, and the opt-in AI gateway needs
   HTTPS to Groq. An ephemeral public IP is free and helps direct connections.
4. From outside the tailnet, TCP 22/80/443/8000 on the public IP must time out or be closed.

Both recovery paths and the empty ingress list were confirmed on 2026-11-15 (#134).

**No UFW.** Do not enable UFW on OCI Ubuntu images: the image ships iptables rules that
the instance needs (for example for boot-volume/iSCSI and metadata access) and UFW can
remove them, making the VM unbootable or unreachable. The OCI security list is the network
filter here. Do not flush or reset iptables; Docker adds its own rules for the
`127.0.0.1:8000` port, which stays loopback-only.
[OCI Compute known issues](https://docs.oracle.com/en-us/iaas/Content/Compute/known-issues.htm)

## 6. Deploy the app

Install Docker Engine and the Compose plugin from Docker's official Ubuntu instructions.
Clone the repository at the approved commit in a dedicated directory (no deployment keys or
CI deployment are needed).

```sh
cp .env.production.example .env.production && chmod 600 .env.production
# set MOODLE_HELPER_TAILNET_HOST to the exact <machine>.<tailnet>.ts.net name (lowercase,
# no scheme/port/trailing dot). Optional AI: MOODLE_HELPER_AI_PROVIDER=groq, GROQ_API_KEY,
# MOODLE_HELPER_AI_LEDGER_PATH=/data/ai-ledger.sqlite3 (must be on /data). Optional
# identity: MOODLE_HELPER_DATASET, MOODLE_HELPER_STABLE_USER_ID, ... (see README).
C="docker compose -f docker-compose.production.yaml --env-file .env.production"
$C config --quiet
$C up -d --build --wait
$C ps
curl -fsS http://127.0.0.1:8000/health
```

`.env.production` is Git-ignored (`.gitignore` `.env.*`) and excluded from the Docker build
context (`.dockerignore` `**/.env.*`); check with `git check-ignore -v .env.production`.
The `GROQ_API_KEY` is a backend secret: keep the file mode 600 and never paste it into
GitHub, logs or chat. Data uses the image default
`MOODLE_HELPER_DATABASE_URL=sqlite:////data/moodle-helper.sqlite3` on the `app-data` volume.

Then serve it (section 4, step 4) and open `https://<machine>.<tailnet>.ts.net` from a
tailnet device.

**Hosted extension:** build it on your own machine with the same origin (README, "Hosted
build (#136)"):
`$env:MOODLE_HELPER_BACKEND_ORIGIN = "https://<machine>.<tailnet>.ts.net"; bun run --cwd extension build`.

**Never run `docker compose ... down --volumes`** (or `docker volume rm`, `docker system
prune --volumes`) on the VM: it deletes the database. `down` keeps the volume.

Upgrade: take and copy off a backup (section 7), `git pull` the approved commit,
`$C up -d --build --wait`. Migrations run on startup and cannot be downgraded; to roll back
after a schema change, restore the matching backup with the previous image.

## 7. Backups and restore

Keep backups **off the VM** (idle reclamation, single disk). Two methods:

1. **Dashboard backup export** (Settings → backup): downloads to the device you use; keep
   it somewhere safe. Restore through the same dashboard screen.
2. **WAL-safe SQLite copy.** The database runs in WAL mode, so never copy the live
   `moodle-helper.sqlite3` file alone. The image has no `sqlite3` CLI; use Python's backup
   API inside the container (consistent while the app runs):

   ```sh
   $C exec app /app/.venv/bin/python -c "import sqlite3; s=sqlite3.connect('/data/moodle-helper.sqlite3'); d=sqlite3.connect('/data/backup.sqlite3'); s.backup(d); print(d.execute('pragma integrity_check').fetchone()[0]); d.close(); s.close()"
   $C cp app:/data/backup.sqlite3 ./moodlehelper-$(date +%F).sqlite3
   $C exec app rm /data/backup.sqlite3
   ```

   It prints `ok`. Copy the file off the VM from a tailnet device, then delete it on the VM:
   `scp ubuntu@<machine>:~/MoodleHelper/moodlehelper-YYYY-MM-DD.sqlite3 .`
   The file holds your personal data: store it encrypted.

**Restore:** stop the app, write the backup into the volume with the
same backup API as UID 10001, start again:

```sh
$C stop app
$C run --rm --no-deps -v "$PWD/moodlehelper-YYYY-MM-DD.sqlite3:/restore.sqlite3:ro" app /app/.venv/bin/python -c "import sqlite3; s=sqlite3.connect('/restore.sqlite3'); d=sqlite3.connect('/data/moodle-helper.sqlite3'); s.backup(d); d.close(); s.close()"
$C up -d --wait
```

Test a restore after the first deployment and after upgrades, not only when you need it.

## 8. Remaining verification (#138)

Native image build on the 1 GB VM (with swap), the app behind `tailscale serve` from a
tailnet browser, the hosted extension against the VM, ACL denial for other users/devices,
public-IP port checks, and a backup/restore on the VM.

## 9. Local verification (#137, 2026-11-15, Windows x86_64)

Done: with `.env.production` copied from the example (`example-vm.example-tailnet.ts.net`),
`docker compose -f docker-compose.production.yaml --env-file .env.production config --quiet`
succeeded; `git check-ignore` matched `.env.production` (`.gitignore` `.env.*`); the backup
and restore Python snippets were run with plain Python against a WAL-mode SQLite file
(integrity `ok`, restore brought back the backed-up row). `tests/test_oci_config.py` pins
the Compose and env-example shape.

**Not done:** Docker Desktop would not start on the test machine, so `up --build`, health,
data persistence across `down`/`up`, the Host 200/400 checks and the snippets inside the
container were **not** run. Do them before or in #138:

```sh
$C up -d --build --wait
curl -s -o /dev/null -w '%{http_code}
' -H 'Host: example-vm.example-tailnet.ts.net' http://127.0.0.1:8000/health  # 200
curl -s -o /dev/null -w '%{http_code}
' -H 'Host: attacker.example' http://127.0.0.1:8000/health                 # 400
# write something (README: binding header), then: $C down && $C up -d --wait, and check it is still there
```
