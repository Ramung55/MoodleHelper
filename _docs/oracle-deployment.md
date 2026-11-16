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
- **Upgrade:** normally a promotion (section 11). Copy an off-VM backup first (section 7);
  by hand, `scripts/deploy.sh <new sha>`.
- **Roll back:** `scripts/deploy.sh <older sha>`. Migrations run on startup and cannot be
  downgraded. After a schema change, first copy the backup taken before the upgrade out of
  the volume, because the rollback run overwrites it:
  `$C cp app:/data/pre-deploy.sqlite3 ./moodlehelper-pre-deploy.sqlite3`. Then run
  `deploy.sh <older sha>` and restore that file (or an off-VM backup) with the section 7
  restore.
- Old images stay on the VM; remove them manually with `docker image prune` when needed.
- `deploy.sh` and both auto-deploy timers below share one lock (`flock` on
  `~/.moodlehelper-deploy.lock`, the same file for the production and the dev clone), so only
  one deploy of either environment runs at a time. A manual `deploy.sh` while a deploy runs
  exits 1 with "another deploy is running"; run it again when that one finishes. Never run
  `deploy.sh` with `sudo`: a root-owned lock file makes every tick fail (fix:
  `sudo rm ~/.moodlehelper-deploy.lock`).
- `deploy.sh <sha>` (or `<sha> production`) needs `.env.production`; `deploy.sh <sha> dev`
  needs `.env.dev`. So each clone deploys only its own environment: in the wrong clone it
  exits 1 (`... is missing; is this the ... clone?`) before touching anything.

### Auto-deploy timers (#148)

Two instances of one systemd template on the VM run `scripts/auto-deploy.sh <target>` about
every 5 minutes. CI never reaches the VM: the VM pulls.

| Instance | Follows | Deploys | `/health` |
|---|---|---|---|
| `moodlehelper-auto-deploy@dev` | `origin/main` (every merge) | the dev clone `~/MoodleHelper-dev` with `deploy.sh <sha> dev` | `127.0.0.1:8001` |
| `moodlehelper-auto-deploy@production` | `origin/production` (moved only by the promote workflow, section 11) | `~/MoodleHelper` with `deploy.sh <sha> production` | `127.0.0.1:8000` |

So a push to `main` deploys **dev** automatically; production changes only after a promotion.
Both instances run an **installed copy**, `/usr/local/lib/moodlehelper/auto-deploy.sh`, with
`MOODLE_HELPER_CLONE=/home/ubuntu/MoodleHelper` (service file), never the clone's checked-out
script: after the first promotion or a rollback the production clone can be at a commit whose
older script ignores the target and would deploy `main` to production (QA on #155).
`@dev` changes into the sibling clone `~/MoodleHelper-dev`. Each tick takes the shared lock,
runs `git fetch` in the target clone, reads the head of the target's branch (M) and writes one
`auto-deploy:` outcome line to the journal:

| Outcome | When | Effect |
|---|---|---|
| `up to date <M>` | M is the last attempted SHA and `/health` reports `release` M (or, with M not yet recorded, `.env.release` already names M; then M is recorded) | nothing |
| `already attempted <M>, now running release <sha>` or `... now health unreachable` | M was attempted before but `/health` does not report it (failed deploy, or a manual rollback since) | nothing, no retry |
| `waiting for image <M>` | `docker pull` of M fails: CI still running, CI failed, or GHCR/network unreachable | nothing recorded; next tick checks again |
| `clone modified, not deploying <M>` | `git diff --quiet HEAD --` fails | nothing recorded; repeats every tick until the clone is clean, then deploys |
| `no origin/production yet, nothing to deploy` | `@production` before the first promotion | nothing, exit 0 |
| `no dev clone next to <path>, nothing changed` | `@dev` without `~/MoodleHelper-dev` | exit 1 |
| `git fetch failed, nothing changed` | network | exit 1; next tick tries again |
| `deploy in progress, skipping` | the lock is held (manual `deploy.sh` or the other instance) | nothing recorded, exit 0 |
| `deployed <M>` | the image exists; M is recorded, then `scripts/deploy.sh M <target>` exits 0 (`/health` reports `release` M) | new release live |
| `deploy of <M> failed; now running release <sha>` or `... now health unreachable` | `deploy.sh M <target>` exits non-zero; the state comes from `/health` at that moment, never from `.env.release` | M is recorded, so it is **not** retried; exit 1 |

What a failed deploy leaves behind:

- **Integrity failure** (pre-deploy backup not `ok`): the old container keeps running,
  `.env.release` is unchanged, and the clone is checked out at M.
- **Health failure:** the new container may be running unhealthy (`restart: unless-stopped`)
  and `.env.release` names M.
- Recover with `scripts/deploy.sh <good sha> [dev]` in that clone.

Each timer reacts only to a **new commit on its branch**; it never moves the deployed SHA back.
So:

- **Rollback:** after a manual `scripts/deploy.sh <older sha>`, later ticks do not redeploy
  the branch head (it is already recorded), but the **next commit on that branch is deployed
  automatically** and replaces the rollback: for dev the next push to `main`, for production
  the next promotion. To keep a rollback, pause that instance first (below).
- **Retry a failed SHA:** the timer never retries. Run `scripts/deploy.sh <sha> [dev]`
  yourself, or delete that clone's state file so the next tick tries the branch head again.

**State file:** `.git/moodlehelper-auto-deploy-attempted` in each clone holds the last SHA
attempted for that environment. It is inside `.git`, so it is not tracked, not in the Docker
build context (`.dockerignore` `.git`) and not on a volume. Deleting it is safe: the next tick
behaves like the first tick.

**Install** (as the clone owner, who is in the `docker` group). The units assume user
`ubuntu` and the clone `/home/ubuntu/MoodleHelper`; edit `User=` and `ExecStart=` in the
service file if yours differ. Set up the dev clone first (section 10).

> **First tick:** with no state file, the first tick records M if `.env.release` already
> equals the branch head; otherwise it **deploys the branch head** as soon as its image
> exists. Before enabling `@production`, create `production` at the SHA production already
> runs (section 11, first promotion) and copy an off-VM backup (section 7).

Run them **from the dev clone** `~/MoodleHelper-dev` (section 10), which is at `main` and so
has the current script and units; the production clone may still be at an older commit.

```sh
cd ~/MoodleHelper-dev
sudo install -D -m 755 scripts/auto-deploy.sh /usr/local/lib/moodlehelper/auto-deploy.sh
sudo cp 'scripts/moodlehelper-auto-deploy@.service' 'scripts/moodlehelper-auto-deploy@.timer' /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moodlehelper-auto-deploy@dev.timer moodlehelper-auto-deploy@production.timer
```

**Migrating from the single #148 timer** (it followed `main` into production). Do this
**before this change merges**: the old timer's next tick would otherwise deploy the merge commit
to production, and every later tick exits 2 (`give the target`) until the new units are in:

```sh
sudo systemctl disable --now moodlehelper-auto-deploy.timer
sudo rm /etc/systemd/system/moodlehelper-auto-deploy.service /etc/systemd/system/moodlehelper-auto-deploy.timer
rm -f .git/moodlehelper-deploy.lock    # the old per-clone lock; the new one is ~/.moodlehelper-deploy.lock
```

**After** the dev environment (#154) and this change are merged into `main`, set up the dev
clone (section 10) and run the four install commands above. They cannot run earlier: before
the merge, `main` has neither `docker-compose.dev.yaml` nor the `@` unit files. Between the two
steps nothing deploys automatically; production keeps running its current release.

The old state file in `~/MoodleHelper` holds a `main` SHA; once `production` exists at the
running release, the first `@production` tick only records it (`... (already deployed), recorded`).

The installed copies do not change when a deploy checks out another commit; repeat the
four install commands (from an up-to-date dev clone) when a later commit changes
`scripts/auto-deploy.sh` or the unit files.

- **Logs:** `journalctl -u moodlehelper-auto-deploy@production.service` (or `@dev`; every
  tick; add `-f` to follow).
- **Next run:** `systemctl list-timers 'moodlehelper-auto-deploy@*'`.
- **Pause:** `sudo systemctl disable --now moodlehelper-auto-deploy@production.timer` (or
  `@dev`). **Resume:** `sudo systemctl enable --now moodlehelper-auto-deploy@production.timer`;
  the next tick deploys the branch head if it has moved since the last attempt.
- **Remove permanently:** `sudo systemctl disable --now moodlehelper-auto-deploy@dev.timer moodlehelper-auto-deploy@production.timer`,
  `sudo rm '/etc/systemd/system/moodlehelper-auto-deploy@.service' '/etc/systemd/system/moodlehelper-auto-deploy@.timer' /usr/local/lib/moodlehelper/auto-deploy.sh`,
  `sudo systemctl daemon-reload`.
- The service is `Type=oneshot`, so an instance never starts a tick while its previous one
  runs; the shared lock keeps the two instances and a manual `deploy.sh` from deploying at
  the same time.

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
| Env file | `.env.production` + `.env.release` | `.env.dev` (from `.env.dev.example`) + `.env.release` |
| Loopback port | `127.0.0.1:8000` | `127.0.0.1:8001` |
| Volume | `moodlehelper_app-data` | `moodlehelper-dev_app-data-dev` |
| URL (tailnet only) | `https://<machine>.<tailnet>.ts.net` | `https://<machine>.<tailnet>.ts.net:8443` |
| Data | the owner's real data | `MOODLE_HELPER_DATASET=demo`, fictional |
| Deploys | promotion (section 11), then `moodlehelper-auto-deploy@production` | every `main` push, `moodlehelper-auto-deploy@dev` |

**Demo only, by construction.** `docker-compose.dev.yaml` replaces the production
`environment` list with `!override`: the container gets only the tailnet name, port `8443`,
the release tag and `MOODLE_HELPER_DATASET=demo`. A `MOODLE_HELPER_MOODLE_ORIGIN`,
`GROQ_API_KEY`, AI or identity variable in `.env.dev` or the shell never reaches it, so dev
has no live Moodle origin, no AI and no real namespace. Never copy a production backup or
`.env.production` into dev.

**Why its own clone:** each deploy checks out its SHA in its clone. Dev runs ahead of
production, so the two clones are usually at different commits, and each keeps its own
`.env.release` and auto-deploy state file.

**Host check:** browsers send `Host: <machine>.<tailnet>.ts.net:8443` on a non-default port.
The backend accepts that one extra value only when `MOODLE_HELPER_TAILNET_PORT=8443` is set
(dev only); production leaves it unset and still rejects any `name:<port>`.

### Set up (once)

```sh
git clone https://github.com/Ramung55/MoodleHelper.git ~/MoodleHelper-dev
cd ~/MoodleHelper-dev
cp .env.dev.example .env.dev && chmod 600 .env.dev
# set MOODLE_HELPER_TAILNET_HOST (same name as production)
scripts/deploy.sh <full main commit sha> dev   # a commit with docker-compose.dev.yaml
D="docker compose -f docker-compose.production.yaml -f docker-compose.dev.yaml --env-file .env.dev --env-file .env.release"
$D ps
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8001
tailscale serve status
```

`tailscale serve status` lists both `https://<machine>.<tailnet>.ts.net` (proxy to `:8000`)
and `...:8443` (proxy to `:8001`). The 443 entry must stay unchanged. If the tailnet access
policy from section 4 is in place, add `tcp:8443` to the owner's grant, otherwise dev times
out from your devices. Then install the timers (section 6, "Auto-deploy timers").

### Deploys to dev

`moodlehelper-auto-deploy@dev` deploys every new `main` commit once its image exists. By
hand, from `~/MoodleHelper-dev`: `scripts/deploy.sh <sha> dev` (same checks, lock and
`/health` check as production, on port 8001). Dev's pre-deploy backup holds only demo data.
Check what dev runs with `curl -fsS http://127.0.0.1:8001/health` on the VM, or
`https://<machine>.<tailnet>.ts.net:8443/health` from a tailnet device.

**Deploy a branch to dev.** Actions → **CI and publish** → **Run workflow**, pick the branch
under "Use workflow from" (or `gh workflow run ci.yml --ref <branch>`). It runs the same
`backend`, `frontend` and `compose` jobs, and `publish` pushes that commit's tested image.
Pushes publish automatically only on `main`. When the run is green, take the branch head's
full SHA (`git rev-parse origin/<branch>`) and run `scripts/deploy.sh <sha> dev` in
`~/MoodleHelper-dev`. The branch needs `docker-compose.dev.yaml`, so it must be based on a
`main` that has it. `@dev` then logs `already attempted <main sha>, now running release <branch sha>`
and leaves it alone; the next push to `main` replaces it. A branch SHA cannot be promoted
(section 11).

**Image tags.** `publish` pushes each image twice:
`ghcr.io/ramung55/moodlehelper:<full sha>`, which `deploy.sh`, rollbacks and promotion use,
and a human-readable `YYYYMMDD-HHMMSS-<short sha>` (UTC publish time, for example
`20261116-101500-cf4c688`) for browsing the package page. A run for a commit whose full-SHA
tag already exists (a manual re-run on `main`) pushes nothing, so a tag never points at a
rebuilt image.

Dev data is demo data. Reset it from the dashboard
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

## 11. Promote dev to production

`main` deploys to dev (section 10). Production moves only when you promote the release dev
runs. `.github/workflows/promote.yml` (manual, `workflow_dispatch`) never rebuilds and
never reaches the VM. It only fast-forwards the `production` branch, and the VM's
`moodlehelper-auto-deploy@production` timer pulls that within about 5 minutes.

### One-time owner setup (GitHub)

1. **Environment:** Settings → Environments → **New environment** `production` → enable
   **Required reviewers**, add yourself, and turn **Prevent self-review** off (you are the
   only reviewer). Deployment branches: **Selected branches and tags**, add `main` (the
   workflow is dispatched from `main`).
2. **Deploy key** (the push needs it: `GITHUB_TOKEN` may not push a ref whose new commits
   change `.github/workflows`). On your own machine:
   `ssh-keygen -t ed25519 -N "" -C moodlehelper-promote -f moodlehelper-promote`.
   Add `moodlehelper-promote.pub` under Settings → Deploy keys → **Allow write access**.
   Add the private key as an **environment** secret of `production` named
   `PRODUCTION_DEPLOY_KEY` (not a repository secret, so only an approved promotion can read
   it). Then delete both local files.
3. Optional: a ruleset on `production` that blocks deletion and force pushes. Allow the
   deploy key to bypass it if the ruleset also restricts updates.

### Promote

1. Read dev's release from a tailnet device:
   `curl -fsS https://<machine>.<tailnet>.ts.net:8443/health` → `"release": "<sha>"`.
   Check dev at that release first.
2. Actions → **Promote dev to production** → **Run workflow** on `main`, `sha` = that full
   SHA (or `gh workflow run promote.yml --ref main -f sha=<sha>`).
3. Job `check` (no approval needed) rejects a SHA that is not 40 lowercase hex characters,
   is not on `main` (dev may be running a branch build, section 10), or has no image
   `ghcr.io/ramung55/moodlehelper:<sha>` (`docker manifest inspect`, anonymous: the package
   is public).
4. Job `promote` waits for your approval (environment `production`). Then it checks again
   that the SHA is on `main` and that `production` is its ancestor, and runs a plain
   `git push origin <sha>:refs/heads/production`, so a non-fast-forward is rejected.
5. On the VM, the next `@production` tick logs `auto-deploy: deployed <sha>`
   (`journalctl -u moodlehelper-auto-deploy@production.service`) after `deploy.sh`'s backup,
   `up` and `/health` check. Confirm with `https://<machine>.<tailnet>.ts.net/health`.

The promotion succeeds once `production` moves. A failed deploy on the VM does not show up
in Actions, only in the journal and `/health`. Like any other SHA, a promoted SHA is tried once
(section 6 table).

**First promotion:** promote the SHA production already runs
(`curl -fsS http://127.0.0.1:8000/health` on the VM) before enabling `@production`. The
first tick then only records it.

### Roll back production

`production` only fast-forwards, so a rollback happens on the VM:
`cd ~/MoodleHelper && scripts/deploy.sh <older sha>` (section 6, "Roll back"). The
`@production` timer does not undo it: the branch head is already attempted. The next
promotion of a newer SHA replaces the rollback. To fix forward, merge the fix to `main`,
check it on dev, and promote it.

## 12. Telemetry (OpenTelemetry over OTLP)

The backend sends traces, metrics and logs over OTLP/HTTP (`backend/telemetry.py`) **only if
`OTEL_EXPORTER_OTLP_ENDPOINT` is set**. Local runs, tests and CI need no collector. The owner
chose a hosted OTLP backend on 2026-11-16, so with telemetry on, this data **leaves the
tailnet**. Nothing else changes: the app still has no public port.

**What is sent (all of it):**

| Signal | Content |
|---|---|
| Resource (on everything) | `service.name=moodlehelper-backend`, `service.version=<MOODLE_HELPER_RELEASE>` (the commit SHA), `deployment.environment.name=dev\|prod`, OpenTelemetry SDK name/version |
| Traces | one server span per HTTP request, named `<METHOD> <route template>` (e.g. `GET /api/queue/runs/{runId}`), with only `http.request.method`, `http.route`, `http.response.status_code`; status `ERROR` on 5xx without a description |
| Metrics | histogram `http.server.request.duration` (seconds) with the same three labels; counter `moodlehelper.sync.runs.started` (new Moodle scan runs from Sync all or `/api/scan/runs`, not replays or demo syncs); gauge `moodlehelper.sync.runs.active` (scan runs not cancelled with a pending or running job, read from the queue at each export); counters `moodlehelper.personal_events.created` and `moodlehelper.personal_events.failures` (label `error.type` = exception class name only; 422 validation rejections show up in the HTTP histogram, not here) |
| Logs | only the `moodle_helper` logger: today the two `ai_extract ok/failed request=<opaque id> ...` lines |

**Never sent:** raw paths, query strings, headers, bodies, client addresses, exception
messages or stack traces, uvicorn's access log, outgoing Moodle or Groq calls, SQL. There is no
auto-instrumentation, only the hand-written middleware. Incoming `traceparent` headers are
ignored. `tests/test_telemetry.py` checks this with a secret in the path, query and a header.

**Environment:** `MOODLE_HELPER_ENVIRONMENT` must be `dev` or `prod`; any other value stops
startup, and it is required once the endpoint is set. The compose files set it
(`docker-compose.production.yaml`: `prod`, `docker-compose.dev.yaml`: `dev`).

**Enable** (hosted backend, for example Grafana Cloud → your stack → OpenTelemetry → OTLP
endpoint and an access-policy token with write scopes). Add to `.env.production`, and to
`.env.dev` for dev, both mode 600:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64 of instance-id:token>
```

Then recreate the container: `$C up -d --no-build --wait` (production) or `$D ...` (dev).
The exporters append `/v1/traces`, `/v1/metrics` and `/v1/logs` themselves. Never commit the
token or paste it into GitHub, logs or chat.

**Disable:** empty or remove `OTEL_EXPORTER_OTLP_ENDPOINT` and recreate the container.

**Cost on the 1 GB VM:** batch processors with bounded queues (2048 spans and log records),
metrics exported every 60 s, nothing logged per request. If the backend is unreachable,
exports fail in the background and are dropped; requests are not slowed (20 requests in
0.1 s against a dead endpoint, measured 2026-11-16). Shutdown then retries the final flush for
about 15 s, so `stop` and deploys take that much longer while the backend is unreachable;
the exporters log `Failed to export ...` (endpoint only, no request data) to stderr.

### 12.1 Dashboard and alert for personal event creation (#157)

`observability/` holds a Grafana Cloud (Free) dashboard and alert that count `POST
/api/personal-events` successes (2xx) and failures (5xx, which includes unhandled exceptions)
from the existing `http.server.request.duration` histogram. 4xx validation errors are counted
in neither. No new metric, attribute or data is sent.

| File | Format (Grafana docs) |
|---|---|
| `observability/personal-events-dashboard.json` | [dashboard JSON import](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/import-dashboards/), datasource as the `${DS_PROMETHEUS}` import input |
| `observability/personal-events-alert-rule.yaml` | [alerting file provisioning](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/), the same format as [Export](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/export-alerting-resources/) |
| `observability/owner-email-contact-point.yaml` | same file-provisioning / export format, type `email` |

There is **no notification policy file**: the rule uses simplified routing
(`notification_settings.receiver`), which sends it straight to the contact point without
touching the stack's policy tree.

**Label mapping (checked 2026-11-16,
[OTLP format considerations](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/)):**
Grafana Cloud promotes `deployment.environment.name` and `service.version` to series labels
**by default** (dots become underscores), so every series carries them. No stack setting and
no `target_info` join is needed. Changing the promoted list
([promote resource attributes](https://grafana.com/docs/grafana-cloud/send-data/otlp/promote-resource-attributes/))
is not used. The queries therefore use:

| OTel | Prometheus/Mimir |
|---|---|
| `http.server.request.duration` (histogram, `s`) | `http_server_request_duration_seconds_count` |
| `service.name=moodlehelper-backend` | `job="moodlehelper-backend"` (shared by dev and prod) |
| `deployment.environment.name` | `deployment_environment_name` (`dev` / `prod`) |
| `service.version` | `service_version` (commit SHA, or `local`) |
| `http.route`, `http.request.method`, `http.response.status_code` | `http_route`, `http_request_method`, `http_response_status_code` (string, e.g. `"500"`) |
| (not set by the backend) | `instance` / `service_instance_id`: a UUID Grafana Cloud adds, new for every process start |

Grafana Cloud's Asserts (knowledge graph) can also add `asserts_*` and `service` labels to
existing series mid-stream, which splits one counter into two series.

**Dashboard** (`uid: moodlehelper-personal-events`): variable `environment` (`dev`/`prod`,
single, default `prod`; a fixed list because the backend refuses any other value) and
`version` (`label_values(...{job="moodlehelper-backend", deployment_environment_name="$environment"},
service_version)`, "All" = `.*`, so it adds up every deployed SHA and `local`). Both stat
panels use the same counting as the alert (below) with `[$__range:1m]` and `offset $__range`
in place of 15m, and `sum()` over everything selected. With no traffic there is no series, so
both panels show **"No data"** (not an error).

**Alert** "Personal event creation failing" (folder `MoodleHelper`, group `personal-events`):

```promql
round(sum by (deployment_environment_name, service_version) ((increase((max by (deployment_environment_name, service_version, instance, http_response_status_code) (http_server_request_duration_seconds_count{job="moodlehelper-backend", http_route="/api/personal-events", http_request_method="POST", http_response_status_code=~"5.."}))[15m:1m]) and max by (deployment_environment_name, service_version, instance, http_response_status_code) (http_server_request_duration_seconds_count{job="moodlehelper-backend", http_route="/api/personal-events", http_request_method="POST", http_response_status_code=~"5.."} offset 15m)) or max_over_time((max by (deployment_environment_name, service_version, instance, http_response_status_code) (http_server_request_duration_seconds_count{job="moodlehelper-backend", http_route="/api/personal-events", http_request_method="POST", http_response_status_code=~"5.."}))[15m:1m])))
```

How it counts: `max by (..., instance, http_response_status_code)` merges the series that
Asserts relabeling split (same counter, so the larger value is the current one). For each
process that already existed 15m ago, `increase()` over a 1m subquery counts its failures in
the window; a process that started inside the window (new deploy or restart, so its counter
began at 0) counts its whole value via `max_over_time`. Then it sums per environment and
version and rounds.

Why not plain `increase(...[15m])`: in a live dev test (2026-11-16) six 5xx and two 2xx within
about 5 minutes gave 1 and 0. `increase()` ignores the first sample of a series, and every
deploy (new `service_version`) and restart (new `instance`) starts new series whose first
60 s export already held failures; Asserts then split the 5xx counter again (samples 2→3 on
the old series, 6 on the new one).

Condition `$A >= 3` (math expression B), evaluated every 1m, pending period 5m.

- Why: one student saves a few events a day. One 5xx, or two in a row, can be transient and
  never fires. Three failed saves within 15 minutes mean the owner retried and still could
  not save. The 5m pending period confirms it is not a single burst that a metric export or
  restart has already resolved. `round()` absorbs `increase()` extrapolation.
- Counter resets: a restart is a new `instance`, counted from 0 as above; `increase()` still
  handles a reset inside one series.
- Worst-case delay from the third failure to the email: about 60 s metric export + 1 m
  evaluation + 5 m pending (≈ 7 min), plus Grafana's notification group wait (30 s default).
- No data → **OK (Normal)**, so the alert stays quiet when nobody creates events. Execution
  error → **Error** (Grafana shows the rule as errored and notifies with an error alert).
- It fires per environment and version (`sum by`), so dev and prod alert separately. **Dev
  alerts go to the same email**; the subject and labels name the environment, and
  notifications are grouped by `environment`. To mute dev, add a silence with matcher
  `environment=dev`.
- Labels: `service`, `environment`, `version`, `owner` (placeholder `<owner>`, not an email),
  `severity=warning`. Annotations: `summary`, `description` (count, environment, version),
  `dashboard_url`, `runbook_url` (this section). The rule is linked to the dashboard
  (`dashboardUid`/`panelId`, Grafana's `__dashboardUid__`/`__panelId__`).

**Import** (Grafana Cloud UI). Grafana Cloud does not offer file provisioning, so the YAML
files are the reference: steps 3 and 4 enter the same values in the UI, then compare with the
UI's **Export**. Placeholders: `<your-stack>` (stack URL), `<PROMETHEUS_DATASOURCE_UID>`,
`<owner-email>`, `<owner>`.

1. **Labels (no setting needed).** In Explore, with the stack's Prometheus data source
   (usually `grafanacloud-<stack>-prom`), run
   `count by (deployment_environment_name, service_version) (http_server_request_duration_seconds_count{job="moodlehelper-backend"})`.
   Both labels should show values. If they do not, stop: the default promotion has changed.
2. **Dashboard.** Dashboards → New → Import → upload `personal-events-dashboard.json` →
   select the Prometheus data source for the `Prometheus` input → Import. Keep the uid
   `moodlehelper-personal-events`.
3. **Contact point.** Alerting → Contact points → Add contact point: name
   `MoodleHelper owner email`, integration Email, Addresses = your address in place of
   `<owner-email>`, "Single email" on → Save.
4. **Alert rule.** Alerting → Alert rules → New alert rule, using the values in
   `personal-events-alert-rule.yaml`: name; query A on the Prometheus data source (the UID
   that replaces `<PROMETHEUS_DATASOURCE_UID>`) in code mode with the query above (the long
   `round(sum by ... max_over_time(...)[15m:1m])))` text, pasted as one line), type
   Instant; replace the default expressions with Math `$A >= 3` as the alert condition;
   folder `MoodleHelper`, new evaluation group `personal-events` every 1m, pending period
   5m; under "Configure no data and error handling" No data = Normal, Error = Error; labels
   and annotations from the file (replace `<your-stack>` in `dashboard_url` and `<owner>`;
   in the UI type label templates as `{{ $labels.x }}`: the file writes them as
   `{{ $$labels.x }}` because Grafana's export escapes `$` in labels, not in annotations);
   link dashboard "MoodleHelper personal events", panel "Personal event creation failures";
   contact point `MoodleHelper owner email` (group by `alertname`, `grafana_folder`,
   `environment`) → Save. Then More → Export (YAML) and compare with the file: only UIDs and
   the replaced placeholders should differ.
5. **Routing.** Nothing to do: simplified routing (step 4) sends the rule to the contact
   point; no notification policy is created or changed.
6. **Test.** Contact point → Test → check the email arrives. Then create one personal event on
   dev and, after about a minute, set the dashboard to `environment=dev`: "Personal events
   created" shows 1 and failures show "No data". No 5xx is triggered on purpose.

**Privacy:** the dashboard and alert read only the metric listed under "What is sent"; nothing
new is sent. The alert email contains only service, environment, version, the failure count
and the dashboard link (plus Grafana's own rule and silence links), never request data.
Enter the owner email and any token only in the Grafana UI; never commit them or paste them
into GitHub, logs or chat. Keep real stack URLs, stack names and data source UIDs out of the
repo.
