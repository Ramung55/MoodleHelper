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
- The image builds and the Compose file runs on local x86_64 (section 9).
- **The VM no longer builds** (#146). CI pushes the image it tested to
  `ghcr.io/ramung55/moodlehelper:<full commit sha>` on every push to `main`, and
  `scripts/deploy.sh` pulls it (section 6). A native build on the VM took 5 minutes with
  swap (#138); keep the swap file below for headroom, not for builds.

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

Install Docker Engine and the Compose plugin (`sudo apt-get install docker.io docker-compose-v2`, verified in #138, or Docker's official Ubuntu repository).
Clone the repository in a dedicated directory (no deployment keys or CI access to the
tailnet are needed: the VM pulls).

```sh
cp .env.production.example .env.production && chmod 600 .env.production
# set MOODLE_HELPER_TAILNET_HOST to the exact <machine>.<tailnet>.ts.net name (lowercase,
# no scheme/port/trailing dot). Optional AI: MOODLE_HELPER_AI_PROVIDER=groq, GROQ_API_KEY,
# MOODLE_HELPER_AI_LEDGER_PATH=/data/ai-ledger.sqlite3 (must be on /data). Optional
# identity: MOODLE_HELPER_DATASET, MOODLE_HELPER_STABLE_USER_ID, ... (see README).
scripts/deploy.sh <full 40-character commit sha on main>
C="docker compose -f docker-compose.production.yaml --env-file .env.production --env-file .env.release"
$C ps
```

`.env.release` holds the deployed tag (`MOODLE_HELPER_RELEASE=<sha>`). `deploy.sh` writes
it; every `$C` command in this runbook reads it, so `exec`, `stop`, `run` and `up -d --wait`
keep the deployed image and never rebuild. Do not edit it by hand.

`.env.production` and `.env.release` are Git-ignored (`.gitignore` `.env.*`) and excluded from
the Docker build context (`.dockerignore` `**/.env.*`); check with
`git check-ignore -v .env.production .env.release`.
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

### Deploy and roll back (#146)

`scripts/deploy.sh <sha>` deploys any commit on `main` from #146's merge onward (older
commits have no image and are rejected). In order, it rejects a non-40-hex SHA and a clone
with modified tracked files, runs `git fetch`, rejects a SHA that is not a commit, and pulls
the image (fails if CI has not finished, the commit is not on `main`, or the package is
private). Only then does it `git checkout --detach <sha>` (detached HEAD is normal), take
the pre-deploy backup `/data/pre-deploy.sqlite3` (section 7; stops unless integrity is `ok`,
skipped on a fresh volume), write `.env.release` and run `$C up -d --no-build --wait`. It
exits 0 only if `/health` reports `status` `ok` and `release` `<sha>`. Any rejection before
the `up` leaves the running container as it was.

- **One-time owner step:** after the first `main` push publishes, GitHub → profile →
  Packages → `moodlehelper` → Package settings → Change visibility → **Public**. The VM
  pulls anonymously.
- **One-time bootstrap** (clone still at an older commit without `deploy.sh`):
  `git fetch && git checkout --detach <sha> && scripts/deploy.sh <sha>`.
- **Upgrade:** copy an off-VM backup first (section 7), then `scripts/deploy.sh <new sha>`.
- **Roll back:** `scripts/deploy.sh <older sha>`. Migrations run on startup and cannot be
  downgraded. After a schema change, first copy the backup taken before the upgrade out of
  the volume, because the rollback run overwrites it:
  `$C cp app:/data/pre-deploy.sqlite3 ./moodlehelper-pre-deploy.sqlite3`. Then run
  `deploy.sh <older sha>` and restore that file (or an off-VM backup) with the section 7
  restore.
- Old images stay on the VM; remove them manually with `docker image prune` when needed.
- `deploy.sh` and the auto-deploy timer below share one lock (`flock` on
  `.git/moodlehelper-deploy.lock`). A manual `deploy.sh` while a deploy runs exits 1 with
  "another deploy is running"; run it again when that one finishes. Never run `deploy.sh` with
  `sudo`: a root-owned lock file makes every tick fail (fix: `sudo rm .git/moodlehelper-deploy.lock`).

### Auto-deploy timer (#148)

A systemd timer on the VM runs `scripts/auto-deploy.sh` about every 5 minutes. CI never
reaches the VM: the VM pulls. Each tick takes the shared lock, runs `git fetch`, reads
`origin/main` (M) and writes one `auto-deploy:` outcome line to the journal:

| Outcome | When | Effect |
|---|---|---|
| `up to date <M>` | M is the last attempted SHA and `/health` reports `release` M (or, with M not yet recorded, `.env.release` already names M; then M is recorded) | nothing |
| `already attempted <M>, now running release <sha>` or `... now health unreachable` | M was attempted before but `/health` does not report it (failed deploy, or a manual rollback since) | nothing, no retry |
| `waiting for image <M>` | `docker pull` of M fails: CI still running, CI failed, or GHCR/network unreachable | nothing recorded; next tick checks again |
| `clone modified, not deploying <M>` | `git diff --quiet HEAD --` fails | nothing recorded; repeats every tick until the clone is clean, then deploys |
| `git fetch failed, nothing changed` | network | exit 1; next tick tries again |
| `deploy in progress, skipping` | the lock is held (manual `deploy.sh`) | nothing recorded, exit 0 |
| `deployed <M>` | the image exists; M is recorded, then `scripts/deploy.sh M` exits 0 (`/health` reports `release` M) | new release live |
| `deploy of <M> failed; now running release <sha>` or `... now health unreachable` | `deploy.sh M` exits non-zero; the state comes from `/health` at that moment, never from `.env.release` | M is recorded, so it is **not** retried; exit 1 |

What a failed deploy leaves behind:

- **Integrity failure** (pre-deploy backup not `ok`): the old container keeps running,
  `.env.release` is unchanged, and the clone is checked out at M.
- **Health failure:** the new container may be running unhealthy (`restart: unless-stopped`)
  and `.env.release` names M.
- Recover with `scripts/deploy.sh <good sha>`.

The timer reacts only to a **new `main` commit**; it never moves the deployed SHA back to
`main`. So:

- **Rollback:** after a manual `scripts/deploy.sh <older sha>`, later ticks do not redeploy
  the current `main` (it is already recorded), but the **next commit pushed to `main` is
  deployed automatically** and replaces the rollback. To keep a rollback past new pushes,
  pause the timer first (below).
- **Retry a failed SHA:** the timer never retries. Run `scripts/deploy.sh <sha>` yourself, or
  delete the state file so the next tick tries `main` again.

**State file:** `.git/moodlehelper-auto-deploy-attempted` in the clone holds the last
attempted SHA. It is inside `.git`, so it is not tracked, not in the Docker build context
(`.dockerignore` `.git`) and not on the `app-data` volume. Deleting it is safe: the next tick
behaves like the first tick.

**Install** (as the clone owner, who is in the `docker` group). The units assume user
`ubuntu` and the clone `/home/ubuntu/MoodleHelper`; edit `User=` and `ExecStart=` in the
service file if yours differ.

> **First tick:** with no state file, the first tick records M if `.env.release` already
> equals `origin/main`; otherwise it **deploys `origin/main`** as soon as its image exists.
> Deploy the SHA you want with `scripts/deploy.sh` and copy an off-VM backup (section 7)
> before enabling the timer.

```sh
sudo cp scripts/moodlehelper-auto-deploy.service scripts/moodlehelper-auto-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moodlehelper-auto-deploy.timer
```

The installed copies do not change when a deploy checks out another commit; repeat the
three commands if a later commit changes the unit files.

- **Logs:** `journalctl -u moodlehelper-auto-deploy.service` (every tick; add `-f` to follow).
- **Next run:** `systemctl list-timers moodlehelper-auto-deploy.timer`.
- **Pause:** `sudo systemctl disable --now moodlehelper-auto-deploy.timer`. **Resume:**
  `sudo systemctl enable --now moodlehelper-auto-deploy.timer`; the next tick deploys `main`
  if it has moved since the last attempt.
- **Remove permanently:** `sudo systemctl disable --now moodlehelper-auto-deploy.timer`,
  `sudo rm /etc/systemd/system/moodlehelper-auto-deploy.service /etc/systemd/system/moodlehelper-auto-deploy.timer`,
  `sudo systemctl daemon-reload`.
- The service is `Type=oneshot`, so a tick never starts while the previous one runs; the
  shared lock keeps a tick and a manual `deploy.sh` from deploying at the same time.

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

**Restore (tested, section 9):** stop the app, write the backup into the volume with the
same backup API as UID 10001, start again:

```sh
$C stop app
$C run --rm --no-deps -v "$PWD/moodlehelper-YYYY-MM-DD.sqlite3:/restore.sqlite3:ro" app /app/.venv/bin/python -c "import sqlite3; s=sqlite3.connect('file:/restore.sqlite3?immutable=1', uri=True); d=sqlite3.connect('/data/moodle-helper.sqlite3'); s.backup(d); print(d.execute('pragma integrity_check').fetchone()[0]); d.close(); s.close()"
$C up -d --wait
```

`immutable=1` is needed: the backup keeps WAL mode, and SQLite cannot create its `-shm`
file next to a read-only mounted file (`attempt to write a readonly database`).
Test a restore after the first deployment and after upgrades, not only when you need it.

`scripts/deploy.sh` also writes `/data/pre-deploy.sqlite3` (same backup API, overwritten on
every deploy). It stays on the VM's volume, so it does not replace off-VM backups.

## 8. Live verification on the VM (#138, 2026-11-15)

Names are placeholders: `<name>` = `<machine>.<tailnet>.ts.net`. VM: OCI
`VM.Standard.E2.1.Micro` (x86_64, 1 GB) + 2 GB swap file, Ubuntu 24.04 Minimal,
Tailscale 1.104.7, Docker 29.1.3 and Compose 2.40.3 from Ubuntu's `docker.io` and
`docker-compose-v2` packages. Revision: `8068cdc` (branch `feat/issue-138-frontend-tailnet`).

| Check | Result |
|---|---|
| Native image build on the VM (`$C build`, with swap) | succeeded in 5 min; `linux/arm64` not applicable to this VM (still unverified) |
| `$C up -d --wait`; `curl http://127.0.0.1:8000/health` | healthy; only `127.0.0.1:8000->8000` published |
| `sudo tailscale serve --bg --https=443 http://127.0.0.1:8000` | `https://<name> (tailnet only)` |
| Dashboard `https://<name>/` from a tailnet PC | 200, Let's Encrypt certificate (verify result 0); API 200; owner used it in Chrome with no CORS/401 errors |
| Live mode (`MOODLE_HELPER_DATASET=moodle`, origin, profile label, stable user id in `.env.production`) | connection state "Real dataset" |
| Hosted extension (built outside the repo with `MOODLE_HELPER_BACKEND_ORIGIN=https://<name>`), loaded unpacked by the owner | popup opened the hosted dashboard; two live read-only syncs wrote 8 courses (8 tracked, one scanned with full coverage) to the VM |
| Packet capture on the VM during a sync (loopback :8000 and all traffic to Moodle's IP, 7 min) | 585 requests: no `Cookie` header and no `MoodleSession`, `sesskey`, `wstoken`, `token=` or `Authorization:`; 0 packets between the VM and Moodle. Captures shredded afterwards |
| Foreign `Host: attacker.example` | 400 |
| Preflight and GET with `Origin: https://ramung55.github.io` (with Private-Network header) | no `Access-Control-Allow-Origin` (preflight 405) |
| POST `/api/sync` without the binding header | 409 (#62) |
| `$C restart`, then VM reboot | same 8 courses, tracked list and last-sync time; app healthy, serve config and swap persisted |
| WAL-safe backup (section 7) and `scp` off the VM | integrity `ok` on the VM and on the off-VM copy |
| Restore (section 7) of that backup | integrity `ok`; data identical afterwards |
| Dashboard backup export (Settings) | JSON file downloaded on the owner's PC |
| Tailscale turned off on the owner's PC | dashboard unreachable; popup shows "Connect this device to Tailscale, then reconnect." |
| Public IP TCP 22/80/443/8000 from outside the tailnet | closed or time out |
| Tailnet ACL denial for another user/device | **untested** (owner decision): the tailnet has one user and no shared nodes, so there is no second identity to test with, and editing the policy risks losing Tailscale SSH |

**Auto-deploy timer (#148), installed 2026-11-15 with the owner's go-ahead.** Off-VM backup
first (section 7, `integrity ok`). Clone checked out at `c695db3` (PR #149 head), units
installed with the section 6 commands, one tick started by hand:
`auto-deploy: up to date f4554ba… (already deployed), recorded`. PR #149 merged as `61ecdfe`;
the next scheduled tick (16:31 UTC, about 5 minutes later) logged
`deploy: backup /data/pre-deploy.sqlite3 integrity ok`, `deploy: 61ecdfe… is live` and
`auto-deploy: deployed 61ecdfe…`; `/health` reports `{"status":"ok","release":"61ecdfe…"}`
and `.env.release` names `61ecdfe…`.

Live data needs the four identity settings from the README in `.env.production`; without
them the backend runs the demo dataset and the dashboard shows "Sync all courses (demo)".
`docker compose cp` run with `sudo` leaves the backup root-owned; run `$C` without `sudo`
(user in the `docker` group) or `sudo chown` the file before `scp`.

## 9. Local verification (#137, 2026-11-15, Windows x86_64, Docker 29.7.2)

With `.env.production` copied from the example (`example-vm.example-tailnet.ts.net`) and
`C="docker compose -p mh137 -f docker-compose.production.yaml --env-file .env.production"`:

| Step | Result |
|---|---|
| `$C config --quiet` | succeeded |
| `$C up -d --build --wait` | built, container healthy |
| `curl -H 'Host: example-vm.example-tailnet.ts.net' http://127.0.0.1:8000/health` | 200 (`127.0.0.1:8000` also 200) |
| same with `Host: attacker.example` | 400 |
| `POST /api/personal-events` "Sentinel137" (binding header) | 200, in `/api/snapshot` |
| `$C down`, `$C up -d --wait` | healthy, `/health` 200, sentinel still present |
| backup snippet (section 7) + `$C cp` | printed `ok`, 188 KB file copied out |
| delete sentinel, `$C stop app`, restore snippet, `$C up -d --wait` | printed `ok`, sentinel back, `/health` 200 |
| `git check-ignore -v .env.production` | matched `.gitignore` `.env.*` |

The first restore attempt without `immutable=1` failed with `attempt to write a readonly
database`; the runbook command was fixed and the rerun passed. Afterwards: `$C down`, test
volume `mh137_app-data` removed, `.env.production` deleted. No Tailscale, OCI or real data.

## 10. Dev environment (same VM, demo data only)

A second, independent copy of the app on `mh-vm` for trying a commit before it reaches
production. Production (sections 6-9) is unchanged and stays the only environment with real
SDU data. No new OCI resources, no public ingress, no IaC.

| | Production | Dev |
|---|---|---|
| Compose project | `moodlehelper` (clone directory name) | `moodlehelper-dev` (`name:` in `docker-compose.dev.yaml`) |
| Clone | `~/MoodleHelper` | `~/MoodleHelper-dev` |
| Env file | `.env.production` + `.env.release` | `.env.dev` (from `.env.dev.example`) |
| Loopback port | `127.0.0.1:8000` | `127.0.0.1:8001` |
| Volume | `moodlehelper_app-data` | `moodlehelper-dev_app-data-dev` |
| URL (tailnet only) | `https://<machine>.<tailnet>.ts.net` | `https://<machine>.<tailnet>.ts.net:8443` |
| Data | the owner's real data | `MOODLE_HELPER_DATASET=demo`, fictional |
| Deploys | `scripts/deploy.sh`, auto-deploy timer | manual `up` below; never the timer |

**Demo only, by construction.** `docker-compose.dev.yaml` replaces the production
`environment` list with `!override`: the container gets only the tailnet name, port `8443`,
the release tag and `MOODLE_HELPER_DATASET=demo`. A `MOODLE_HELPER_MOODLE_ORIGIN`,
`GROQ_API_KEY`, AI or identity variable in `.env.dev` or the shell never reaches it, so dev
has no live Moodle origin, no AI and no real namespace. Never copy a production backup or
`.env.production` into dev.

**Why its own clone:** `scripts/deploy.sh` and the timer check out other commits in
`~/MoodleHelper`, and a rollback to a commit before this section would delete
`docker-compose.dev.yaml` there. The dev clone moves only when you move it.

**Host check:** browsers send `Host: <machine>.<tailnet>.ts.net:8443` on a non-default port.
The backend accepts that one extra value only when `MOODLE_HELPER_TAILNET_PORT=8443` is set
(dev only); production leaves it unset and still rejects any `name:<port>`.

### Set up (once)

```sh
git clone https://github.com/Ramung55/MoodleHelper.git ~/MoodleHelper-dev
cd ~/MoodleHelper-dev
cp .env.dev.example .env.dev && chmod 600 .env.dev
# set MOODLE_HELPER_TAILNET_HOST (same name as production) and MOODLE_HELPER_RELEASE to a
# full main commit SHA whose CI image exists
D="docker compose -f docker-compose.production.yaml -f docker-compose.dev.yaml --env-file .env.dev"
git checkout --detach "$(grep ^MOODLE_HELPER_RELEASE= .env.dev | cut -d= -f2)"
$D pull && $D up -d --no-build --wait
curl -fsS http://127.0.0.1:8001/health
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8001
tailscale serve status
```

`tailscale serve status` lists both `https://<machine>.<tailnet>.ts.net` (proxy to `:8000`)
and `...:8443` (proxy to `:8001`). The 443 entry must stay unchanged. If the tailnet access
policy from section 4 is in place, add `tcp:8443` to the owner's grant, otherwise dev times
out from your devices.

### Deploy another commit to dev

Set `MOODLE_HELPER_RELEASE=<sha>` in `.env.dev`, then from `~/MoodleHelper-dev`:

```sh
git fetch && git checkout --detach <sha> && $D pull && $D up -d --no-build --wait
curl -fsS http://127.0.0.1:8001/health   # reports release <sha>
```

There is no pre-deploy backup: dev data is demo data. Reset it from the dashboard
(Settings → Reset demo), or delete the dev volume (below).

### Stop or remove dev

- Stop: `$D stop`. Start again: `$D up -d --no-build --wait`.
- Unserve: `sudo tailscale serve --https=8443 off`. Check with `tailscale serve status`
  that the 443 entry is still there.
- Remove dev completely: `$D down --volumes` from `~/MoodleHelper-dev`. **Only with `$D`:**
  `--volumes` there removes `moodlehelper-dev_app-data-dev` only. Never run it with the
  production `$C` (section 6). Then `rm -rf ~/MoodleHelper-dev`.

**Limits:** the hosted extension and the dashboard's Tailscale-origin checks
(`isTailnetOrigin`, extension allowlist) know only the port-less production origin. Dev is
for the dashboard and API with demo data; no extension, sync or Moodle collection runs
against it. Both containers share the VM's 1 GB RAM (about 70 MB each, measured
2026-11-16).
