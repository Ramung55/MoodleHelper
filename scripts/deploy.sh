#!/usr/bin/env bash
# Deploy or roll back the VM to the CI-published image of one commit (#146).
# Usage, from the clone on the VM: scripts/deploy.sh <full 40-hex commit sha>
# Runbook: _docs/oracle-deployment.md section 6.
set -euo pipefail

main() {
  local sha="${1:-}" image result
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "deploy: give the full 40-character lowercase commit SHA, got '${sha}'" >&2
    exit 2
  fi
  cd "$(dirname "$0")/.."
  local C="docker compose -f docker-compose.production.yaml --env-file .env.production --env-file .env.release"
  image="ghcr.io/ramung55/moodlehelper:$sha"

  if ! git diff --quiet HEAD --; then
    echo "deploy: the clone has modified tracked files; commit or discard them first" >&2
    exit 1
  fi
  git fetch --quiet
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
    echo "deploy: $sha is not a commit in this repository" >&2
    exit 1
  fi
  # Pull before stopping or checking out anything, so a missing image changes nothing.
  if ! docker pull --quiet "$image"; then
    echo "deploy: cannot pull $image (CI not finished, commit not on main or before #146, or package private)" >&2
    exit 1
  fi

  git checkout --quiet --detach "$sha"
  touch .env.release

  # WAL-safe backup with the new image, overwriting one fixed file on the volume.
  result=$(MOODLE_HELPER_RELEASE="$sha" $C run --rm --no-deps -T app /app/.venv/bin/python -c "
import os, sqlite3
p = '/data/moodle-helper.sqlite3'
if not os.path.exists(p):
    print('no-database')
else:
    s = sqlite3.connect(p); d = sqlite3.connect('/data/pre-deploy.sqlite3'); s.backup(d)
    print(d.execute('pragma integrity_check').fetchone()[0]); d.close(); s.close()
" | tail -n 1 | tr -d '\r')
  if [ "$result" = "no-database" ]; then
    echo "deploy: no database on the volume yet (fresh volume), backup skipped"
  elif [ "$result" = "ok" ]; then
    echo "deploy: backup /data/pre-deploy.sqlite3 integrity ok"
  else
    echo "deploy: backup integrity check failed: '$result'; nothing recreated" >&2
    exit 1
  fi

  printf 'MOODLE_HELPER_RELEASE=%s\n' "$sha" > .env.release
  $C up -d --no-build --wait
  if curl -fsS http://127.0.0.1:8000/health | python3 -c "import json, sys; h = json.load(sys.stdin); sys.exit(not (h.get('status') == 'ok' and h.get('release') == sys.argv[1]))" "$sha"; then
    echo "deploy: $sha is live"
  else
    echo "deploy: /health does not report status ok and release $sha" >&2
    exit 1
  fi
}

main "$@"
