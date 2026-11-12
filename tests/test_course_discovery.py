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
            futures = [pool.submit(api.ingest_course_discovery, [observation("7")], "42"),
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


# #84: course code from the first shortname segment and status from the requested classification.
def enrolled(id, code="DEMO101", classification="inprogress", title=None):
    raw = observation(id, title=title or f"Fictional Course {id}", terms=["In progress"])
    if code is not None:
        raw["code"] = {"kind": "known", "value": code} if code != "unknown" else {"kind": "unknown"}
    if classification is not None:
        raw["classification"] = classification
    return raw


def by_source(snapshot):
    return {c["discovery"]["sourceCourseId"]: c for c in snapshot["courses"] if "discovery" in c}


def test_inprogress_observation_gives_code_and_current_status(client):
    saved = ingest(client, [enrolled("9001"), enrolled("9002", "DEMO202"), enrolled("9003", "DEMO303")]).json()
    courses = by_source(saved)
    assert [courses[i]["code"] for i in ("9001", "9002", "9003")] == ["DEMO101", "DEMO202", "DEMO303"]
    for course in courses.values():
        assert course["current"] is True and course["discovery"]["currentTermStatus"] == "current"
        assert course["discovery"]["classification"] == "inprogress"
        assert course["id"] not in saved["settings"]["trackedCourseIds"]
    assert courses["9001"]["discovery"]["code"] == {"kind": "known", "value": "DEMO101"}


@pytest.mark.parametrize("code", ["unknown", None])
def test_unknown_or_absent_code_keeps_the_fallback(client, code):
    course = by_source(ingest(client, [enrolled("9001", code)]).json())["9001"]
    assert course["code"] == "Course 9001"
    assert course["current"] is True and course["discovery"]["currentTermStatus"] == "current"


def test_without_classification_a_new_course_stays_uncertain(client):
    course = by_source(ingest(client, [enrolled("9001", classification=None)]).json())["9001"]
    assert course["code"] == "DEMO101"
    assert course["current"] is False and course["discovery"]["currentTermStatus"] == "unknown"
    assert "classification" not in course["discovery"]


def test_later_runs_keep_last_code_status_and_selection(client):
    first = by_source(ingest(client, [enrolled("9001"), enrolled("9002", "DEMO202"), enrolled("9003", "DEMO303")]).json())
    tracked = [first["9002"]["id"], first["9003"]["id"]]
    client.put("/api/tracked-courses", json=tracked)
    before = client.get("/api/snapshot").json()
    # An empty but valid response changes nothing.
    assert ingest(client, []).json() == before
    # Only 9001 returned, now with an unknown code: 9002/9003 keep everything, 9001 keeps DEMO101.
    after = ingest(client, [enrolled("9001", "unknown")]).json()
    courses = by_source(after)
    assert after["settings"]["trackedCourseIds"] == tracked
    assert courses["9001"]["code"] == "DEMO101"
    assert courses["9001"]["discovery"]["code"] == {"kind": "known", "value": "DEMO101"}
    for source in ("9002", "9003"):
        assert courses[source] == by_source(before)[source]
        assert courses[source]["current"] is True and courses[source]["discovery"]["currentTermStatus"] == "current"
    # An observation without code or classification (older caller) keeps the last code and status.
    older = by_source(ingest(client, [enrolled("9002", None, None, title="Renamed")]).json())["9002"]
    assert older["code"] == "DEMO202" and older["name"] == "Renamed"
    assert older["current"] is True and older["discovery"]["currentTermStatus"] == "current"
    # A new known code replaces the old one.
    assert by_source(ingest(client, [enrolled("9002", "DEMO222")]).json())["9002"]["code"] == "DEMO222"


def test_caller_cannot_set_current_status_or_tracking(client):
    plain = ingest(client, [enrolled("9001", classification=None)]).json()
    client.delete("/api/local-data")
    client.post("/api/demo/reset")
    forged = {**enrolled("9001", classification=None), "current": True, "currentTermStatus": "current",
              "trackedCourseIds": ["x"], "settings": {"trackedCourseIds": ["x"]}}
    body = {"observations": [forged], "trackedCourseIds": ["x"], "current": True, "currentTermStatus": "current"}
    saved = client.post("/api/courses/discovery", json=body).json()
    assert by_source(saved)["9001"] == by_source(plain)["9001"]
    assert saved["settings"]["trackedCourseIds"] == plain["settings"]["trackedCourseIds"]


@pytest.mark.parametrize("patch", [
    {"classification": "past"}, {"classification": "INPROGRESS"}, {"classification": ""}, {"classification": 1},
    {"code": {"kind": "known", "value": "DEMO101-1-redacted-2028-1"}}, {"code": {"kind": "known", "value": ""}},
    {"code": {"kind": "known", "value": " DEMO101"}}, {"code": {"kind": "known", "value": "D" * 65}},
    {"code": {"kind": "empty"}}, {"code": None}, {"classification": None},
])
def test_invalid_code_or_classification_is_rejected_and_nothing_saved(client, patch):
    before = client.get("/api/snapshot").json()
    response = ingest(client, [enrolled("77"), {**enrolled("9"), **patch}])
    assert response.status_code == 422
    assert client.get("/api/snapshot").json() == before


def test_new_fields_round_trip_through_snapshot_restore(client, contract, contract_validator):
    saved = ingest(client, [enrolled("9001")]).json()
    contract_validator(contract["components"]["schemas"]["Snapshot"], saved)
    assert client.put("/api/snapshot", json=saved).json() == saved
