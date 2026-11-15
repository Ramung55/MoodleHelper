# Current status

Date: 2026-11-15. Base commit: `61ecdfe` (`main`, after PR #149). Replaces the 2026-11-12 audit; the MVP verdict lives in
[mvp-verification.md](mvp-verification.md).

## Where things stand

- **Live on the OCI VM over Tailscale since #138.** One app container on `127.0.0.1:8000`,
  SQLite on the `app-data` volume, `tailscale serve` for HTTPS on `<machine>.<tailnet>.ts.net`,
  no public ingress. Runbook and evidence: [oracle-deployment.md](oracle-deployment.md).
- **CI** (`.github/workflows/ci.yml`): `backend`, `frontend` (lint, typecheck, tests) and
  `compose` (Compose integration and browser journey, saves the `tested-image` artifact) run
  on every push and PR. #146 replaces the dead AWS/ECS `deploy` job with `publish`, which
  pushes that tested image as `ghcr.io/ramung55/moodlehelper:<sha>` on pushes to `main` only.
- **Deploy and rollback** (#146): on the VM, `scripts/deploy.sh <full commit sha>` (runbook
  section 6). The VM no longer builds.
- **Auto-deploy** (#148): a systemd timer on the VM (`scripts/auto-deploy.sh`) deploys each
  new commit once its GHCR image exists, tries a SHA only once and leaves a manual rollback
  until the next new commit. Installed on the VM 2026-11-15; it deployed `61ecdfe` on its own
  (runbook section 8). Since 2026-11-16 the units are a template with two instances:
  `moodlehelper-auto-deploy@dev` follows `main` into the demo-only dev environment (runbook
  section 10), and `@production` follows the `production` branch.
- **Promotion** (2026-11-16): `.github/workflows/promote.yml` (manual, environment `production`
  with a required reviewer) checks that the image of the SHA dev reports exists and
  fast-forwards `production` to it (runbook section 11). Not yet set up on GitHub or the VM.
- **Lint:** `main` at `dffbe8f` failed `bun run lint` on one Prettier error in
  `frontend/src/test/tailnet-origin.test.tsx`; #146 reformats that file, so `frontend` passes
  and `publish` can run.

## History since #93

- #93-#96: account binding, live submission status, live update while browsing, recorded
  live SDU journey.
- #97, #98: lint in CI, reliable Windows test cleanup.
- #106-#114: end-to-end verification of deadlines, syllabus, calendar, personal deadlines,
  workload, optional AI, backup/restore/erase and the full student journey.
- #124-#129: live full sync, material download, submission status, fresh tabs, read-only
  queue calls without the SQLite write lock.
- #134-#138: Tailscale-only OCI deployment (Host check, hosted extension build, Compose
  files and runbook, live VM verification).

## Backlog

Open: none. #146 and #148 closed.

## Tests on this branch

`uv run pytest`: 1605 passed, 9 skipped (opt-in Compose and PostgreSQL tests), 2 warnings.
Frontend: the only frontend change is the Prettier reformat above; CI's `frontend` job
(lint, typecheck, tests) passes on this branch.
