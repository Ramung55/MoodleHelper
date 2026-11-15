#!/usr/bin/env bash
# One auto-deploy tick (#148), run by moodlehelper-auto-deploy@<target>.timer on the VM: deploys a
# new commit of the target's branch once its CI-published image exists, and never retries an attempted SHA.
#   dev:        origin/main       -> the dev clone (this clone's sibling <name>-dev), 127.0.0.1:8001
#   production: origin/production -> this clone, 127.0.0.1:8000 (moved only by the promote workflow)
# Usage: scripts/auto-deploy.sh dev|production. Runbook: _docs/oracle-deployment.md sections 6 and 10.
set -euo pipefail

# What actually runs, from /health: after a failed health check .env.release already names M.
running() {
  local release
  release=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/health" 2>/dev/null \
    | sed -n 's/.*"release": *"\([^"]*\)".*/\1/p' || true)
  echo "${release:+running release }${release:-health unreachable}"
}

main() {
  local target="${1:-}" branch port state_file=.git/moodlehelper-auto-deploy-attempted m attempted deployed now
  case "$target" in
    production) branch=production port=8000 ;;
    dev) branch=main port=8001 ;;
    *) echo "auto-deploy: give the target, dev or production, got '${target}'" >&2; exit 2 ;;
  esac
  cd "$(dirname "$0")/.."
  if [ "$target" = dev ] && ! cd "../$(basename "$PWD")-dev" 2>/dev/null; then
    echo "auto-deploy: no dev clone next to $PWD, nothing changed" >&2
    exit 1
  fi

  # One lock for both clones (shared with scripts/deploy.sh), so dev and production never deploy at once.
  exec 9>"$HOME/.moodlehelper-deploy.lock"
  if ! flock -n 9; then
    echo "auto-deploy: deploy in progress, skipping"
    exit 0
  fi
  if ! git fetch --quiet; then
    echo "auto-deploy: git fetch failed, nothing changed" >&2
    exit 1
  fi
  if ! m=$(git rev-parse --verify --quiet "origin/$branch"); then
    echo "auto-deploy: no origin/$branch yet, nothing to deploy"
    exit 0
  fi
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
  if MOODLE_HELPER_DEPLOY_LOCKED=1 scripts/deploy.sh "$m" "$target"; then
    echo "auto-deploy: deployed $m"
  else
    echo "auto-deploy: deploy of $m failed; now $(running)" >&2
    exit 1
  fi
}

main "$@"
