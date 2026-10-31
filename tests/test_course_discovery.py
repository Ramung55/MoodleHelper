"""Atomic source ownership, identity and legacy compatibility at the new boundary."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from backend.identity import collector_entity_key, namespace_key
from backend.main import create_app
from backend.sample_data import build_sample_snapshot
from backend.services import BackendService
from backend.sqlite_store import SQLiteStore


def observation(id="9007199254740993123456789", title="Полное название", terms=None):
    return {"sourceCourseId": id, "sourceUrl": f"https://moodle.sdu.edu.kz/course/view.php?id={id}",
            "title": {"kind": "known", "value": title},
            "termIndicators": {"kind": "known", "value": terms or ["Осень 2026", "Term 1"]}}


def ingest(client, observations):
    return client.post("/api/courses/discovery", json={"observations": observations})


def test_source_refresh_preserves_personal_and_unrelated_state(client):
    before = client.get("/api/snapshot").json()
    raw = observation()
    first = ingest(client, [raw]).json()
    new = first["courses"][-1]
    assert new["id"] == collector_entity_key(namespace_key(), "course", course_id=raw["sourceCourseId"])
    assert new["discovery"] == {**raw, "currentTermStatus": "unknown"}
    assert new["current"] is False and new["code"] == f"Course {raw['sourceCourseId']}"
    assert new["id"] not in first["settings"]["trackedCourseIds"]
    assert {k: v for k, v in first.items() if k != "courses"} == {k: v for k, v in before.items() if k != "courses"}
    assert ingest(client, [raw, raw]).json() == first
    ids = [new["id"], before["courses"][0]["id"], "legacy-unobserved-id"]
    client.put("/api/tracked-courses", json=ids)
    changed = observation(title="Updated full title", terms=["Весна 2027", "Term 2"])
    changed["title"] = {"kind": "unknown"}
    refreshed = ingest(client, [changed, observation("8", title="Updated full title")]).json()
    assert refreshed["settings"]["trackedCourseIds"] == ids
    assert refreshed["courses"][-2]["name"] == "Title unavailable"
    assert refreshed["courses"][-2]["discovery"]["title"] == {"kind": "unknown"}
    assert refreshed["courses"][-2]["code"] == new["code"]
    assert refreshed["courses"][-2]["color"] == new["color"]
    assert ingest(client, []).json() == refreshed
    assert ingest(client, [observation("9")]).json()["courses"][:-1] == refreshed["courses"]
    client.put("/api/tracked-courses", json=[])
    saved = client.get("/api/snapshot").json()
    assert client.post("/api/sync").json() == saved


@pytest.mark.parametrize("patch", [
    {"sourceCourseId": "01"}, {"sourceCourseId": 9}, {"sourceCourseId": "0"},
    {"sourceUrl": "https://moodle.sdu.edu.kz/course/view.php?id=9&x=1"},
    {"sourceUrl": "https://user@moodle.sdu.edu.kz/course/view.php?id=9"},
    {"title": {"kind": "known", "value": " "}},
    {"title": {"kind": "known", "value": " doubled  spaces "}},
    {"termIndicators": {"kind": "known", "value": []}},
    {"termIndicators": {"kind": "known", "value": ["good", ""]}},
    {"title": None}, {"termIndicators": {"kind": "empty"}},
])
def test_ingestion_rejects_entire_invalid_batch(client, patch):
    before = client.get("/api/snapshot").json()
    response = ingest(client, [observation("77"), {**observation("9"), **patch}])
    assert response.status_code == 422 and response.json()["message"]
    assert client.get("/api/snapshot").json() == before


def test_opaque_mapping_collision_and_conflicting_duplicates_roll_back(client):
    raw = observation("7")
    snapshot = client.get("/api/snapshot").json()
    mapped = {"id": "opaque/% custom", "code": "Keep", "name": "old", "color": 6,
              "current": False, "discovery": {**raw, "currentTermStatus": "unknown"}}
    snapshot["courses"].append(mapped)
    client.put("/api/snapshot", json=snapshot)
    saved = ingest(client, [observation("7", title="Refreshed")]).json()
    assert saved["courses"][-1] == {**mapped, "name": "Refreshed", "discovery": {**observation("7", title="Refreshed"), "currentTermStatus": "unknown"}}
    for broken in [
        saved["courses"] + [{**mapped, "id": "another"}],
        saved["courses"] + [{"id": collector_entity_key(namespace_key(), "course", course_id="8"), "code": "Other", "name": "Other", "color": 1, "current": False}],
    ]:
        before = {**saved, "courses": broken}
        client.put("/api/snapshot", json=before)
        assert ingest(client, [observation("99"), observation("7"), observation("8")]).status_code == 422
        assert client.get("/api/snapshot").json() == before
    client.put("/api/snapshot", json=saved)
    assert ingest(client, [raw, observation("7", title="Conflict")]).status_code == 422
    assert client.get("/api/snapshot").json() == saved


def test_metadata_roundtrip_legacy_strings_and_nonnullable(client, contract, contract_validator):
    legacy = client.get("/api/snapshot").json()
    legacy["courses"][0].update(name="", code="", id="", current=False)
    assert client.put("/api/snapshot", json=legacy).json() == legacy
    raw = observation()
    saved = ingest(client, [raw]).json()
    contract_validator(contract["components"]["schemas"]["Snapshot"], saved)
    assert client.put("/api/snapshot", json=saved).json() == saved
    invalid = deepcopy(saved)
    invalid["courses"][0]["discovery"] = None
    assert client.put("/api/snapshot", json=invalid).status_code == 422
    assert client.get("/api/snapshot").json() == saved


def test_two_file_store_writers_preserve_latest_whitelist_and_other_records(tmp_path):
    url = f"sqlite:///{(tmp_path / 'courses.sqlite3').as_posix()}"
    namespace = namespace_key("moodle", origin="https://moodle.sdu.edu.kz", profile_label="fixture", stable_user_id="42")
    first = SQLiteStore(url, namespace)
    second = SQLiteStore(url, namespace)
    api = BackendService(first)
    other = BackendService(second)
    try:
        initial = first.replace(build_sample_snapshot())
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(api.ingest_course_discovery, [observation("7")]),
                       pool.submit(other.set_tracked_courses, ["c-csc", "missing-legacy"]),
                       pool.submit(other.update_settings, {"timezone": "UTC"})]
            for result in futures:
                result.result()
        saved = first.read()
        assert saved["settings"]["trackedCourseIds"] == ["c-csc", "missing-legacy"]
        assert saved["settings"]["timezone"] == "UTC"
        assert saved["assessments"] == initial["assessments"]
        assert saved["courses"][-1]["id"] == collector_entity_key(namespace, "course", course_id="7")
    finally:
        first.close()
        second.close()
    reopened = SQLiteStore(url, namespace)
    try:
        assert reopened.read() == saved
        with TestClient(create_app(reopened)) as client:
            assert client.get("/api/snapshot").json() == saved
    finally:
        reopened.close()
