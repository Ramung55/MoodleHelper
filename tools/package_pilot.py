"""Build a LOCAL, reviewable Chrome pilot package of the unpacked extension (#49).

Not a store/signed build and never published. Output goes to the gitignored
``pilot-package/`` directory:

  moodle-helper-extension-<version>-<commit>.zip   allowlisted dist/ files only
  SHA256SUMS                                        hashes of each file and the zip
  build-info.json                                   version/commit/tool versions/command

The zip is deterministic for identical dist/ bytes (sorted entries, fixed
timestamps and permissions). Usage: ``uv run python tools/package_pilot.py``
(add ``--skip-build`` to package an existing extension/dist).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "extension" / "dist"
OUT = ROOT / "pilot-package"
ALLOWED_FILES = frozenset(
    {
        "manifest.json",
        "index.js",
        "content.js",
        "dashboard-relay.js",
        "popup.html",
        "popup.js",
        "transfer.html",
        "transfer.js",
        "icon-128.png",
    }
)
EXPECTED_MATCHES = {
    "content.js": ["https://moodle.sdu.edu.kz/*"],
    "dashboard-relay.js": ["http://127.0.0.1:5173/*", "http://localhost:5173/*"],
}
EXPECTED_HOSTS = ["http://127.0.0.1:8000/*", "https://moodle.sdu.edu.kz/*"]
EXPECTED_PERMISSIONS = ["alarms", "downloads", "notifications"]
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
# Text that must never ship: secrets, private keys, credential-like assignments, local paths.
FORBIDDEN = [
    re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(rb"\bsk-[A-Za-z0-9]{20,}"),
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(rb"(?i)\b(password|passwd|api[_-]?key|secret)\s*[:=]\s*['\"][^'\"]{4,}['\"]"),
    re.compile(rb"(?i)[A-Z]:\\\\?Users\\\\?"),
    re.compile(rb"/home/[a-z]+/|/Users/[A-Za-z]+/"),
]


class PackageError(Exception):
    pass


def verify_dist(dist: Path) -> dict:
    """Check inventory, manifest references and scope, and forbidden content."""
    if not dist.is_dir():
        raise PackageError(f"missing build output {dist}")
    present = {p.relative_to(dist).as_posix() for p in dist.rglob("*") if p.is_file()}
    if present != ALLOWED_FILES:
        raise PackageError(
            f"unexpected inventory: extra={sorted(present - ALLOWED_FILES)} "
            f"missing={sorted(ALLOWED_FILES - present)}"
        )
    manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
    referenced = {manifest["background"]["service_worker"], manifest["action"]["default_popup"]}
    referenced |= set(manifest.get("icons", {}).values())
    matches: dict[str, list[str]] = {}
    for script in manifest.get("content_scripts", []):
        for js in script["js"]:
            referenced.add(js)
            matches[js] = script["matches"]
    for name in referenced:
        if name not in present:
            raise PackageError(f"manifest references missing file {name}")
    if matches != EXPECTED_MATCHES:
        raise PackageError(f"content script scope changed: {matches}")
    if manifest.get("host_permissions") != EXPECTED_HOSTS:
        raise PackageError(f"host_permissions changed: {manifest.get('host_permissions')}")
    if manifest.get("permissions") != EXPECTED_PERMISSIONS:
        raise PackageError(f"permissions changed: {manifest.get('permissions')}")
    for name in sorted(present):
        data = (dist / name).read_bytes()
        if name.endswith(".map") or b"sourceMappingURL" in data:
            raise PackageError(f"source map present in {name}")
        for pattern in FORBIDDEN:
            if pattern.search(data):
                raise PackageError(f"forbidden content {pattern.pattern!r} in {name}")
    return manifest


def write_zip(dist: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(ALLOWED_FILES):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (dist / name).read_bytes())


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run(*cmd: str, cwd: Path = ROOT) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def package(dist: Path, out: Path, commit: str, tree_dirty: bool, tools: dict) -> Path:
    manifest = verify_dist(dist)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*"):
        old.unlink()
    archive = out / f"moodle-helper-extension-{manifest['version']}-{commit[:7]}.zip"
    write_zip(dist, archive)
    lines = [f"{sha256(dist / n)}  dist/{n}" for n in sorted(ALLOWED_FILES)]
    lines.append(f"{sha256(archive)}  {archive.name}")
    (out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    info = {
        "label": "LOCAL PILOT REVIEW BUILD - Not yet live-validated; not signed, not a store build, not distributed",
        "extension_version": manifest["version"],
        "commit": commit,
        "working_tree_dirty": tree_dirty,
        "build_command": "bun run --cwd extension build",
        "package_command": "uv run python tools/package_pilot.py",
        "tools": tools,
        "files": sorted(ALLOWED_FILES),
        "permissions": manifest["permissions"],
        "host_permissions": manifest["host_permissions"],
        "approved_https_dashboard_origin": None,
    }
    (out / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return archive


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    if not args.skip_build:
        _run("bun", "run", "build", cwd=ROOT / "extension")
    commit = _run("git", "rev-parse", "HEAD")
    dirty = bool(_run("git", "status", "--porcelain", "--", "extension", "shared"))
    tools = {"bun": _run("bun", "--version"), "python": sys.version.split()[0]}
    try:
        archive = package(DIST, OUT, commit, dirty, tools)
    except PackageError as error:
        print(f"package refused: {error}", file=sys.stderr)
        return 1
    print((OUT / "SHA256SUMS").read_text(encoding="utf-8"), end="")
    print(f"wrote {archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
