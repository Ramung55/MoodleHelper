import json
import zipfile

import pytest

from tools import package_pilot as pp

MANIFEST = json.loads((pp.ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))


def make_dist(tmp_path, manifest=None, extra=None):
    dist = tmp_path / "dist"
    dist.mkdir()
    for name in pp.ALLOWED_FILES:
        refs = " ".join(pp.RUNTIME_REFERENCES.get(name, []))
        (dist / name).write_bytes(f"console.log(1); /* {refs} */".encode())
    (dist / "manifest.json").write_text(json.dumps(manifest or MANIFEST), encoding="utf-8")
    for name, data in (extra or {}).items():
        (dist / name).write_bytes(data)
    return dist


def test_source_manifest_passes_and_zip_is_deterministic(tmp_path):
    dist = make_dist(tmp_path)
    a = pp.package(dist, tmp_path / "a", "a" * 40, False, {})
    b = pp.package(dist, tmp_path / "b", "a" * 40, False, {})
    assert a.read_bytes() == b.read_bytes()
    with zipfile.ZipFile(a) as archive:
        assert sorted(archive.namelist()) == sorted(pp.ALLOWED_FILES)
    sums = (tmp_path / "a" / "SHA256SUMS").read_text()
    assert a.name in sums and "dist/manifest.json" in sums
    info = json.loads((tmp_path / "a" / "build-info.json").read_text())
    assert info["approved_https_dashboard_origin"] == "https://ramung55.github.io/MoodleHelper/"
    assert "Not yet live-validated" in info["label"]
    assert info["minimum_chrome_version"] == "109"
    assert info["dashboard"] == {
        "commit": "a" * 40,
        "build_command": "bun run --cwd frontend build:pages",
        "pages_workflow": ".github/workflows/pages.yml",
        "pages_run_id": "pending",
    }


def test_pages_run_id_is_recorded(tmp_path):
    pp.package(make_dist(tmp_path), tmp_path / "out", "b" * 40, False, {}, "41520591494")
    info = json.loads((tmp_path / "out" / "build-info.json").read_text())
    assert info["dashboard"]["pages_run_id"] == "41520591494"
    assert info["dashboard"]["commit"] == info["commit"] == "b" * 40


def test_source_manifest_matches_expected_scope():
    assert MANIFEST["permissions"] == pp.EXPECTED_PERMISSIONS
    assert MANIFEST["host_permissions"] == pp.EXPECTED_HOSTS
    assert MANIFEST["minimum_chrome_version"] == pp.EXPECTED_MIN_CHROME
    relay = {s["js"][0]: s["matches"] for s in MANIFEST["content_scripts"]}
    assert relay == pp.EXPECTED_MATCHES


@pytest.mark.parametrize("value", [None, "106", "120"])
def test_changed_minimum_chrome_version_is_refused(tmp_path, value):
    manifest = json.loads(json.dumps(MANIFEST))
    if value is None:
        del manifest["minimum_chrome_version"]
    else:
        manifest["minimum_chrome_version"] = value
    with pytest.raises(pp.PackageError, match="minimum_chrome_version"):
        pp.verify_dist(make_dist(tmp_path, manifest))


def test_extra_file_is_refused(tmp_path):
    with pytest.raises(pp.PackageError, match="extra"):
        pp.verify_dist(make_dist(tmp_path, extra={"index.js.map": b"{}"}))


def test_broadened_scope_is_refused(tmp_path):
    manifest = json.loads(json.dumps(MANIFEST))
    manifest["host_permissions"].append("<all_urls>")
    with pytest.raises(pp.PackageError, match="host_permissions"):
        pp.verify_dist(make_dist(tmp_path, manifest))


def test_missing_runtime_page_reference_is_refused(tmp_path):
    with pytest.raises(pp.PackageError, match="offscreen.html"):
        pp.verify_dist(make_dist(tmp_path, extra={"index.js": b"chrome.runtime.getURL('transfer.html')"}))


@pytest.mark.parametrize(
    "payload",
    [b'const password = "hunter22";', b"//# sourceMappingURL=index.js.map", b"C:\\Users\\someone"],
)
def test_forbidden_content_is_refused(tmp_path, payload):
    with pytest.raises(pp.PackageError):
        pp.verify_dist(make_dist(tmp_path, extra={"content.js": payload}))
