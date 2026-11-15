#!/usr/bin/env bash
# One auto-deploy tick (#148), run by moodlehelper-auto-deploy.timer on the VM: deploys a new
# origin/main commit once its CI-published image exists, and never retries an attempted SHA.
# Runbook: _docs/oracle-deployment.md section 6.
set -euo pipefail

# What actually runs, from /health: after a failed health check .env.release already names M.
running() {
  local release
  release=$(curl -fsS --max-time 5 http://127.0.0.1:8000/health 2>/dev/null \
    | sed -n 's/.*"release": *"\([^"]*\)".*/\1/p' || true)
  echo "${release:+running release }${release:-health unreachable}"
}

main() {
  cd "$(dirname "$0")/.."
  local state_file=.git/moodlehelper-auto-deploy-attempted m attempted deployed now

  exec 9>.git/moodlehelper-deploy.lock
  if ! flock -n 9; then
    echo "auto-deploy: deploy in progress, skipping"
    exit 0
  fi
  if ! git fetch --quiet; then
    echo "auto-deploy: git fetch failed, nothing changed" >&2
    exit 1
  fi
  m=$(git rev-parse origin/main)
  attempted=$(cat "$state_file" 2>/dev/null || true)
  deployed=$(sed -n 's/^MOODLE_HELPER_RELEASE=//p' .env.release 2>/dev/null || true)

  if [ "$m" = "$attempted" ]; then
    now=$(running)
    if [ "$now" = "running release $m" ]; then
      echo "auto-deploy: up to date $m"
    else
      echo "auto-deploy: already attempted $m, now $now"
    fi
    exit 0
  fi
  if [ "$m" = "$deployed" ]; then
    printf '%s\n' "$m" > "$state_file"
    echo "auto-deploy: up to date $m (already deployed), recorded"
    exit 0
  fi
  if ! git diff --quiet HEAD --; then
    echo "auto-deploy: clone modified, not deploying $m" >&2
    exit 0
  fi
  if ! docker pull --quiet "ghcr.io/ramung55/moodlehelper:$m" >/dev/null 2>&1; then
    echo "auto-deploy: waiting for image $m"
    exit 0
  fi

  printf '%s\n' "$m" > "$state_file"
  if MOODLE_HELPER_DEPLOY_LOCKED=1 scripts/deploy.sh "$m"; then
    echo "auto-deploy: deployed $m"
  else
    echo "auto-deploy: deploy of $m failed; now $(running)" >&2
    exit 1
  fi
}

main "$@"
