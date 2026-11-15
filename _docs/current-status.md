# Current status

Date: 2026-11-15. Base commit: `dffbe8f` (`main`, after PR #145), plus branch
`feat/issue-146-ghcr-deploy`. Replaces the 2026-11-12 audit; the MVP verdict lives in
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
- **Known CI failure on `main`:** the `frontend` job at `dffbe8f` fails `bun run lint` on one
  Prettier error in `frontend/src/test/tailnet-origin.test.tsx:8`. Because `publish` needs
  `frontend`, no image is published until that is fixed.

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

Open: #146 only (this branch; its live criteria run on the VM after merge).

## Tests on this branch

`uv run pytest`: 1605 passed, 9 skipped (opt-in Compose and PostgreSQL tests), 2 warnings.
Frontend suites were not rerun for this change (no frontend files touched).
