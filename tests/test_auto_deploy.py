"""Auto-deploy tick outcomes (#148) against stub git, docker, curl and flock on PATH.

No network, Docker or VM: a temp clone holds a copy of scripts/auto-deploy.sh and a stub
deploy.sh. The real-flock tests (shared lock, no deadlock, real deploy.sh) need util-linux
flock and python3, so they run on the CI Ubuntu runner and are skipped on Windows.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
OLD = "a" * 40
M = "b" * 40


def _bash():
    if os.name == "nt":  # Git Bash, not WSL's System32 bash.exe
        git = shutil.which("git")
        found = [p / "bin" / "bash.exe" for p in Path(git).resolve().parents] if git else []
        return next((str(b) for b in found if b.exists()), None)
    return shutil.which("bash")


BASH = _bash()
pytestmark = pytest.mark.skipif(BASH is None, reason="bash (Git Bash on Windows) not found")
REAL_FLOCK = sys.platform.startswith("linux") and shutil.which("flock") and shutil.which("python3")
needs_flock = pytest.mark.skipif(not REAL_FLOCK, reason="needs util-linux flock and python3 (CI Ubuntu runner)")

STUBS = {
    "git": """echo "git $*" >> "$STUB_LOG"
case "$1" in
  fetch) exit "${STUB_FETCH_RC:-0}" ;;
  rev-parse) echo "$STUB_MAIN" ;;
  diff) exit "${STUB_DIRTY:-0}" ;;
esac""",
    "docker": """echo "docker $*" >> "$STUB_LOG"
case " $* " in *" run "*) echo no-database ;; esac
exit "${STUB_PULL_RC:-0}\"""",
    "curl": """echo "curl $*" >> "$STUB_LOG"
[ "${STUB_HEALTH:-}" = from-release ] && STUB_HEALTH=$(sed -n 's/^MOODLE_HELPER_RELEASE=//p' .env.release)
[ -n "${STUB_HEALTH:-}" ] || exit 7
printf '{"status":"ok","release":"%s"}' "$STUB_HEALTH\"""",
    "flock": """echo "flock $*" >> "$STUB_LOG"
exit "${STUB_FLOCK_RC:-0}\"""",
}
STUB_DEPLOY = """echo "deploy.sh $1 locked=${MOODLE_HELPER_DEPLOY_LOCKED:-}" >> "$STUB_LOG"
exit "${STUB_DEPLOY_RC:-0}\""""


def _write(path, body):
    path.write_bytes(("#!/usr/bin/env bash\n" + body + "\n").encode())
    path.chmod(0o755)


@pytest.fixture
def clone(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / "scripts").mkdir()
    (tmp_path / "bin").mkdir()
    shutil.copyfile(ROOT / "scripts" / "auto-deploy.sh", tmp_path / "scripts" / "auto-deploy.sh")
    _write(tmp_path / "scripts" / "deploy.sh", STUB_DEPLOY)
    for name, body in STUBS.items():
        _write(tmp_path / "bin" / name, body)
    return tmp_path


def tick(clone, *, attempted=None, deployed=None, script="auto-deploy.sh", args=(), **stub):
    state = clone / ".git" / "moodlehelper-auto-deploy-attempted"
    if attempted:
        state.write_text(attempted + "\n")
    if deployed:
        (clone / ".env.release").write_text(f"MOODLE_HELPER_RELEASE={deployed}\n")
    log = clone / "calls.log"
    log.write_text("")
    env = {**os.environ, "STUB_LOG": log.as_posix(), "STUB_MAIN": M}
    env.pop("MOODLE_HELPER_DEPLOY_LOCKED", None)
    env.update({f"STUB_{k.upper()}": str(v) for k, v in stub.items()})
    # Prepend the stubs inside bash: Git Bash puts its own git first on PATH at startup.
    prepend = 'PATH="$(cygpath -u "$1" 2>/dev/null || echo "$1"):$PATH"; shift; exec bash "$@"'
    proc = subprocess.run([BASH, "-c", prepend, "_", str(clone / "bin"),
                           (clone / "scripts" / script).as_posix(), *args],
                          env=env, capture_output=True, text=True, timeout=60)
    out = (proc.stdout + proc.stderr).strip()
    recorded = state.read_text().strip() if state.exists() else None
    return proc.returncode, out, log.read_text(), recorded


def outcome(out):
    lines = [line for line in out.splitlines() if line.startswith("auto-deploy:")]
    assert len(lines) == 1, out
    return lines[0]


def test_nothing_new_does_no_pull_and_no_deploy(clone):
    rc, out, calls, recorded = tick(clone, attempted=M, deployed=M)
    assert rc == 0 and outcome(out) == f"auto-deploy: up to date {M}"
    assert "docker" not in calls and "deploy.sh" not in calls and recorded == M


def test_rollback_is_not_undone(clone):
    rc, out, calls, recorded = tick(clone, attempted=M, deployed=OLD)
    assert rc == 0 and outcome(out) == f"auto-deploy: already attempted {M}, deployed {OLD}"
    assert "docker" not in calls and "deploy.sh" not in calls and recorded == M


def test_manual_deploy_got_there_first_only_records(clone):
    rc, out, calls, recorded = tick(clone, attempted=OLD, deployed=M)
    assert rc == 0 and M in outcome(out) and "up to date" in outcome(out)
    assert "docker" not in calls and "deploy.sh" not in calls and recorded == M


def test_first_tick_without_state_when_already_deployed_only_records(clone):
    rc, out, calls, recorded = tick(clone, deployed=M)
    assert rc == 0 and "up to date" in outcome(out)
    assert "deploy.sh" not in calls and recorded == M


def test_waiting_for_image_records_nothing(clone):
    rc, out, calls, recorded = tick(clone, attempted=OLD, deployed=OLD, pull_rc=1)
    assert rc == 0 and outcome(out) == f"auto-deploy: waiting for image {M}"
    assert f"docker pull --quiet ghcr.io/ramung55/moodlehelper:{M}" in calls
    assert "deploy.sh" not in calls and recorded == OLD


def test_fetch_failure_exits_nonzero_and_changes_nothing(clone):
    rc, out, calls, recorded = tick(clone, attempted=OLD, deployed=OLD, fetch_rc=128)
    assert rc != 0 and outcome(out) == "auto-deploy: git fetch failed, nothing changed"
    assert "docker" not in calls and "deploy.sh" not in calls and recorded == OLD


def test_modified_clone_is_not_deployed_and_not_recorded(clone):
    for _ in range(2):  # the line repeats on every tick until the clone is clean
        rc, out, calls, recorded = tick(clone, attempted=OLD, deployed=OLD, dirty=1)
        assert rc == 0 and outcome(out) == f"auto-deploy: clone modified, not deploying {M}"
        assert "docker" not in calls and "deploy.sh" not in calls and recorded == OLD


def test_new_image_is_recorded_then_deployed_under_the_held_lock(clone):
    rc, out, calls, recorded = tick(clone, attempted=OLD, deployed=OLD)
    assert rc == 0 and outcome(out) == f"auto-deploy: deployed {M}"
    assert f"deploy.sh {M} locked=1" in calls and recorded == M


def test_first_tick_without_state_deploys_main(clone):
    rc, out, calls, recorded = tick(clone, deployed=OLD)
    assert rc == 0 and outcome(out) == f"auto-deploy: deployed {M}" and recorded == M


@pytest.mark.parametrize("health, state", [(OLD, f"running release {OLD}"), ("", "health unreachable")])
def test_failed_deploy_reports_running_state_and_is_not_retried(clone, health, state):
    rc, out, calls, recorded = tick(clone, attempted=OLD, deployed=OLD, deploy_rc=1, health=health)
    assert rc != 0 and outcome(out) == f"auto-deploy: deploy of {M} failed; now {state}"
    assert recorded == M
    # deploy.sh rewrote .env.release before its health check failed; the next tick does not retry.
    rc, out, calls, _ = tick(clone, deployed=M if health else OLD)
    assert rc == 0 and "deploy.sh" not in calls and "docker" not in calls


def test_lock_held_skips_and_records_nothing(clone):
    rc, out, calls, recorded = tick(clone, attempted=OLD, deployed=OLD, flock_rc=1)
    assert rc == 0 and outcome(out) == "auto-deploy: deploy in progress, skipping"
    assert "git" not in calls and recorded == OLD


def _hold_lock(clone):
    import fcntl

    fd = os.open(clone / ".git" / "moodlehelper-deploy.lock", os.O_WRONLY | os.O_CREAT)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


@pytest.fixture
def real_deploy(clone):
    (clone / "bin" / "flock").unlink()
    shutil.copyfile(ROOT / "scripts" / "deploy.sh", clone / "scripts" / "deploy.sh")
    (clone / "scripts" / "deploy.sh").chmod(0o755)
    return clone


@needs_flock
def test_real_lock_held_skips_tick_and_rejects_manual_deploy(real_deploy):
    fd = _hold_lock(real_deploy)
    try:
        rc, out, calls, recorded = tick(real_deploy, attempted=OLD, deployed=OLD)
        assert rc == 0 and outcome(out) == "auto-deploy: deploy in progress, skipping"
        assert recorded == OLD
        rc, out, calls, _ = tick(real_deploy, script="deploy.sh", args=(M,))
        assert rc != 0 and "another deploy is running" in out and "git" not in calls
    finally:
        os.close(fd)


@needs_flock
def test_tick_runs_real_deploy_without_deadlock(real_deploy):
    rc, out, calls, recorded = tick(real_deploy, attempted=OLD, deployed=OLD, health="from-release")
    assert rc == 0, out
    assert f"deploy: {M} is live" in out and outcome(out) == f"auto-deploy: deployed {M}"
    assert (real_deploy / ".env.release").read_text() == f"MOODLE_HELPER_RELEASE={M}\n"
    assert recorded == M
