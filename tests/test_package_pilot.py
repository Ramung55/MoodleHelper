import json
import zipfile

import pytest

from tools import package_pilot as pp

MANIFEST = json.loads((pp.ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))


def make_dist(tmp_path, manifest=None, extra=None):
    dist = tmp_path / "dist"
    dist.mkdir()
    for name in pp.ALLOWED_FILES:
        (dist / name).write_bytes(b"console.log(1);")
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
    assert info["approved_https_dashboard_origin"] is None
    assert "Not yet live-validated" in info["label"]


def test_extra_file_is_refused(tmp_path):
    with pytest.raises(pp.PackageError, match="extra"):
        pp.verify_dist(make_dist(tmp_path, extra={"index.js.map": b"{}"}))


def test_broadened_scope_is_refused(tmp_path):
    manifest = json.loads(json.dumps(MANIFEST))
    manifest["host_permissions"].append("<all_urls>")
    with pytest.raises(pp.PackageError, match="host_permissions"):
        pp.verify_dist(make_dist(tmp_path, manifest))


@pytest.mark.parametrize(
    "payload",
    [b'const password = "hunter22";', b"//# sourceMappingURL=index.js.map", b"C:\\Users\\someone"],
)
def test_forbidden_content_is_refused(tmp_path, payload):
    with pytest.raises(pp.PackageError):
        pp.verify_dist(make_dist(tmp_path, extra={"index.js": payload}))
