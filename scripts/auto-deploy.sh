#!/usr/bin/env bash
# One auto-deploy tick (#148), run by moodlehelper-auto-deploy.timer on the VM: deploys a new
# origin/main commit once its CI-published image exists, and never retries an attempted SHA.
# Runbook: _docs/oracle-deployment.md section 6.
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."
  local state=.git/moodlehelper-auto-deploy-attempted m attempted deployed release

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
  attempted=$(cat "$state" 2>/dev/null || true)
  deployed=$(sed -n 's/^MOODLE_HELPER_RELEASE=//p' .env.release 2>/dev/null || true)

  if [ "$m" = "$attempted" ]; then
    if [ "$m" = "$deployed" ]; then
      echo "auto-deploy: up to date $m"
    else
      echo "auto-deploy: already attempted $m, deployed ${deployed:-none}"
    fi
    exit 0
  fi
  if [ "$m" = "$deployed" ]; then
    printf '%s\n' "$m" > "$state"
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

  printf '%s\n' "$m" > "$state"
  if MOODLE_HELPER_DEPLOY_LOCKED=1 scripts/deploy.sh "$m"; then
    echo "auto-deploy: deployed $m"
  else
    # Ask the running app, not .env.release: deploy.sh has rewritten it before its /health check.
    release=$(curl -fsS --max-time 5 http://127.0.0.1:8000/health 2>/dev/null \
      | sed -n 's/.*"release": *"\([^"]*\)".*/\1/p' || true)
    echo "auto-deploy: deploy of $m failed; now ${release:+running release }${release:-health unreachable}" >&2
    exit 1
  fi
}

main "$@"
