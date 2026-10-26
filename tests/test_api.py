from copy import deepcopy
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.sample_data import build_sample_snapshot
from backend.storage import InMemoryStore


def snapshot(client):
    return client.get("/api/snapshot").json()


def event(**changes):
    return {"courseId": "c-csc", "title": "Study session", "type": "other", "date": {"kind": "week", "week": 8}, **changes}


def test_personal_crud_and_source_separation(client):
    before = snapshot(client)
    response = client.post("/api/personal-events", json=event())
    assert response.status_code == 200
    added = response.json()["assessments"][-1]
    id = added["id"]
    assert added["personal"] is True
    assert added["sources"][0]["source"] == "personal"
    assert added["sources"][0]["date"] == {"kind": "week", "week": 8}
    patched = client.patch(f"/api/assessments/{id}/overlay", json={"titleOverride": "Revised", "completed": True}).json()
    assert next(a for a in patched["assessments"] if a["id"] == id) == added
    assert next(o for o in patched["overlays"] if o["assessmentId"] == id)["completed"] is True
    deleted = client.delete(f"/api/personal-events/{id}").json()
    assert deleted["assessments"] == before["assessments"]
    assert all(o["assessmentId"] != id for o in deleted["overlays"])
    assert client.delete("/api/personal-events/missing").json() == deleted
    imported = client.delete("/api/personal-events/a1").json()
    assert imported["assessments"] == before["assessments"]


def test_unique_personal_ids(client):
    ids = [client.post("/api/personal-events", json=event()).json()["assessments"][-1]["id"] for _ in range(4)]
    assert len(set(ids)) == 4


@pytest.mark.parametrize("id", ["folder/item", "folder/100% ?# Пример", "", "/leading//trailing/"])
def test_encoded_identifiers_reach_all_identifier_routes(client, id):
    """Restored identifiers are arbitrary strings, not single URL segments."""
    data = client.post("/api/personal-events", json=event()).json()
    data["assessments"][-1]["id"] = id
    data["candidates"][0]["id"] = id
    data["materials"][0].update(id=id, accessible=True)
    assert client.put("/api/snapshot", json=data).status_code == 200
    encoded = quote(id, safe="")

    patched = client.patch(f"/api/assessments/{encoded}/overlay", json={"completed": True})
    assert patched.status_code == 200
    assert next(o for o in patched.json()["overlays"] if o["assessmentId"] == id)["completed"] is True
    reviewed = client.post(f"/api/candidates/{encoded}/review", json={"kind": "reject"})
    assert reviewed.status_code == 200
    assert next(c for c in reviewed.json()["candidates"] if c["id"] == id)["status"] == "rejected"
    downloaded = client.post(f"/api/materials/{encoded}/download")
    assert downloaded.status_code == 200
    assert "Chrome extension" in downloaded.json()["message"]
    deleted = client.delete(f"/api/personal-events/{encoded}")
    assert deleted.status_code == 200
    assert all(a["id"] != id for a in deleted.json()["assessments"])
    assert all(o["assessmentId"] != id for o in deleted.json()["overlays"])


def test_missing_encoded_identifiers_preserve_no_op_outcomes(client):
    before = snapshot(client)
    assert client.post("/api/candidates/missing%2Fencoded/review", json={"kind": "confirm"}).json() == before
    assert client.delete("/api/personal-events/missing%2Fencoded").json() == before
    outcome = client.post("/api/materials/missing%2Fencoded/download")
    assert outcome.status_code == 200
    assert outcome.json()["snapshot"] == before
    assert outcome.json()["supported"] is False


def test_overlay_baseline_priority_and_omission(client):
    before = snapshot(client)
    source = next(a for a in before["assessments"] if a["id"] == "a3")
    override = {"kind": "date", "date": "2026-11-30"}
    first = client.patch("/api/assessments/a3/overlay", json={"dateOverride": override, "overrideBase": {"kind": "unknown"}}).json()
    layer = next(o for o in first["overlays"] if o["assessmentId"] == "a3")
    assert layer["overrideBase"] == source["sources"][0]["date"]
    second = client.patch("/api/assessments/a3/overlay", json={"hidden": True}).json()
    assert next(o for o in second["overlays"] if o["assessmentId"] == "a3")["dateOverride"] == override
    assert second["assessments"] == before["assessments"]
    assert client.patch("/api/assessments/a3/overlay", json={}).status_code == 200


def test_overlay_explicit_null_clears_overrides(client):
    updated = client.patch("/api/assessments/a3/overlay", json={
        "titleOverride": "Revised",
        "dateOverride": {"kind": "date", "date": "2026-11-30"},
    }).json()
    assert next(o for o in updated["overlays"] if o["assessmentId"] == "a3")["overrideBase"]

    cleared = client.patch("/api/assessments/a3/overlay", json={
        "titleOverride": None,
        "dateOverride": None,
    }).json()
    layer = next(o for o in cleared["overlays"] if o["assessmentId"] == "a3")
    assert "titleOverride" not in layer
    assert "dateOverride" not in layer
    assert "overrideBase" not in layer


def test_latest_source_observation_baseline(client):
    data = snapshot(client)
    data["assessments"][0]["sources"] = [
        {"source": "moodle", "date": {"kind": "week", "week": 1}, "observedAt": "2026-01-01T00:00:00Z"},
        {"source": "moodle", "date": {"kind": "week", "week": 2}, "observedAt": "2026-02-01T00:00:00Z"},
        {"source": "syllabus", "date": {"kind": "week", "week": 3}, "observedAt": "2026-03-01T00:00:00Z"},
    ]
    client.put("/api/snapshot", json=data)
    result = client.patch("/api/assessments/a1/overlay", json={"dateOverride": {"kind": "unknown"}}).json()
    assert result["overlays"][-1]["overrideBase"] == {"kind": "week", "week": 2}


def test_tracking_alerts_and_settings_replacements(client):
    before = snapshot(client)
    assert client.put("/api/tracked-courses", json=[]).json()["settings"]["trackedCourseIds"] == []
    assert client.put("/api/tracked-courses", json=["c-math"]).json()["settings"]["trackedCourseIds"] == ["c-math"]
    settings = client.patch("/api/settings", json={"timezone": "arbitrary timezone", "weights": {"exam": -1, "assignment": 0, "quiz": 2, "other": 3}}).json()["settings"]
    assert settings["timezone"] == "arbitrary timezone"
    assert settings["weights"]["exam"] == -1
    assert settings["reminders"] == before["settings"]["reminders"]
    alert = {"id": "new", "kind": "deadline", "message": "Plan ahead", "deliveryKey": "new", "createdAt": "any string", "read": False}
    assert client.put("/api/alerts", json=[alert]).json()["alerts"] == [alert]
    assert client.put("/api/alerts", json=[]).json()["alerts"] == []


def test_restore_delete_and_reset(client):
    before = snapshot(client)
    data = deepcopy(before)
    data["settings"]["timezone"] = "Custom"
    data["overlays"] = []
    assert client.put("/api/snapshot", json=data).json() == data
    empty = client.delete("/api/local-data").json()
    assert all(value == [] for key, value in empty.items() if key != "settings")
    assert empty["settings"] == {**data["settings"], "trackedCourseIds": []}
    reset = client.post("/api/demo/reset").json()
    for field in ("courses", "assessments", "overlays", "materials", "documents", "candidates", "sync", "changes", "alerts"):
        assert reset[field]
    assert reset["settings"]["timezone"] == "Asia/Almaty"


def test_sync_final_results_preserve_data_and_untracked_state(client):
    before = snapshot(client)
    client.put("/api/tracked-courses", json=["c-csc", "c-phy"])
    response = client.post("/api/sync")
    assert response.status_code == 200
    result = response.json()
    states = {s["courseId"]: s for s in result["sync"]}
    assert states["c-csc"]["status"] == "ok"
    assert states["c-phy"]["status"] == "failed"
    assert states["c-phy"]["error"]
    assert states["c-math"] == next(s for s in before["sync"] if s["courseId"] == "c-math")
    assert result["assessments"] == before["assessments"]
    client.put("/api/tracked-courses", json=[])
    before_empty_sync = snapshot(client)
    assert client.post("/api/sync").json() == before_empty_sync


@pytest.mark.parametrize("name", ["schedule.pdf", "SYLLABUS.DOCX"])
def test_import_and_review_correction(client, name):
    response = client.post("/api/documents/import", json={"courseId": "c-csc", "fileName": name})
    assert response.status_code == 200
    result = response.json()
    assert result["result"] == {"ok": True}
    document = result["snapshot"]["documents"][-1]
    candidate = result["snapshot"]["candidates"][-1]
    assert document["mocked"] is True and document["status"] == "done" and document["progress"] == 100
    assert candidate["documentId"] == document["id"]
    correction = {"kind": "correct", "title": "Midterm", "date": {"kind": "week", "week": 10}, "type": "exam"}
    result = client.post(f"/api/candidates/{candidate['id']}/review", json=correction).json()
    assert result["candidates"][-1]["status"] == "corrected"
    assert result["assessments"][-1]["sources"][0]["date"] == correction["date"]
    assert result["assessments"][-1]["title"] == "Midterm"


@pytest.mark.parametrize("name", ["legacy.doc", "notes.txt", "no-extension"])
def test_unsupported_import_is_inline_failure_without_mutation(client, name):
    before = snapshot(client)
    response = client.post("/api/documents/import", json={"courseId": "c-csc", "fileName": name})
    assert response.status_code == 200
    assert response.json()["result"]["ok"] is False
    assert response.json()["result"]["reason"]
    assert response.json()["snapshot"] == before == snapshot(client)


def test_confirm_attach_reject_and_missing_review(client):
    before = snapshot(client)
    confirmed = client.post("/api/candidates/k1/review", json={"kind": "confirm"}).json()
    assert len(confirmed["assessments"]) == len(before["assessments"]) + 1
    assert confirmed["assessments"][-1]["sources"][0]["source"] == "syllabus"
    attached = client.post("/api/candidates/k2/review", json={"kind": "confirm"}).json()
    assert len(attached["assessments"]) == len(confirmed["assessments"])
    original = next(a for a in before["assessments"] if a["id"] == "a2")
    merged = next(a for a in attached["assessments"] if a["id"] == "a2")
    assert merged["sources"][:-1] == original["sources"]
    assert merged["sources"][-1]["source"] == "syllabus"
    rejected = client.post("/api/candidates/k1/review", json={"kind": "reject"}).json()
    assert rejected["candidates"][0]["status"] == "rejected"
    assert rejected["assessments"] == attached["assessments"]
    assert client.post("/api/candidates/missing/review", json={"kind": "confirm"}).json() == rejected


@pytest.mark.parametrize("id,phrase", [("m1", "extension"), ("m2", "not accessible"), ("missing", "not accessible")])
def test_download_capability(client, id, phrase):
    before = snapshot(client)
    response = client.post(f"/api/materials/{id}/download")
    assert response.status_code == 200
    assert response.json()["supported"] is False
    assert phrase in response.json()["message"]
    assert response.json()["snapshot"] == before


def test_ai_unavailable_even_after_opt_in(client):
    client.patch("/api/settings", json={"ai": {"enabled": True, "consentGiven": True}})
    assert client.get("/api/ai/availability").json()["available"] is False


@pytest.mark.parametrize("path,body", [
    ("/api/settings", {"semesterWeeks": 0}), ("/api/settings", {"semesterWeeks": 31}),
    ("/api/settings", {"semesterWeeks": True}), ("/api/settings", {"semesterWeeks": "15"}),
    ("/api/settings", {"semesterStart": "10/25/2026"}), ("/api/settings", {"timezone": None}),
    ("/api/settings", {"weights": {"exam": 3}}), ("/api/settings", {"ai": {"enabled": True}}),
    ("/api/settings", {"reminders": {"enabled": "false", "hoursBefore": 1, "busyWeek": True}}),
    ("/api/settings", []), ("/api/settings", None),
    ("/api/assessments/a1/overlay", {"dateOverride": None, "overrideBase": {"kind": "unknown"}}),
    ("/api/assessments/a1/overlay", {"hidden": "true"}),
])
def test_invalid_patch_is_atomic(client, path, body):
    before = snapshot(client)
    response = client.patch(path, json=body)
    assert response.status_code == 422
    assert response.json()["message"]
    assert snapshot(client) == before


@pytest.mark.parametrize("body", [
    {}, event(title=None), event(type="test"), event(courseId=1), event(date={"kind": "week", "week": 0}),
    event(date={"kind": "week", "week": 31}), event(date={"kind": "week", "week": 1.5}),
    event(date={"kind": "exact", "iso": "time"}), event(date={"kind": "other"}),
    event(date={"kind": "date", "date": "2026-1-2"}), event(date={"kind": "unknown", "note": None}),
])
def test_invalid_personal_event_is_atomic(client, body):
    before = snapshot(client)
    response = client.post("/api/personal-events", json=body)
    assert response.status_code == 422
    assert set(response.json()) == {"message"}
    assert snapshot(client) == before


@pytest.mark.parametrize("body", [{}, {"kind": "correct"}, {"kind": "accept"}, {"kind": None}])
def test_invalid_review_is_atomic(client, body):
    before = snapshot(client)
    assert client.post("/api/candidates/k1/review", json=body).status_code == 422
    assert snapshot(client) == before


@pytest.mark.parametrize("method,path,body", [
    ("put", "/api/tracked-courses", {}), ("put", "/api/tracked-courses", [1]),
    ("put", "/api/alerts", [{}]), ("put", "/api/snapshot", {}),
    ("post", "/api/documents/import", {"courseId": "c-csc"}),
])
def test_invalid_other_inputs(client, method, path, body):
    before = snapshot(client)
    assert getattr(client, method)(path, json=body).status_code == 422
    assert snapshot(client) == before


def test_invalid_json_and_http_errors(client):
    before = snapshot(client)
    response = client.patch("/api/settings", content="{", headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and set(response.json()) == {"message"}
    assert snapshot(client) == before
    assert client.get("/api/missing").status_code == 404
    assert client.get("/api/missing").json() == {"message": "Not Found"}
    assert client.get("/api/settings").status_code == 405
    assert set(client.get("/api/settings").json()) == {"message"}


def test_restore_validation_covers_nested_constraints_and_no_partial_write(client):
    before = snapshot(client)
    for collection, field, invalid in [("courses", "color", 7), ("documents", "progress", -1), ("candidates", "confidence", 2), ("assessments", "sources", [])]:
        broken = deepcopy(before)
        broken[collection][0][field] = invalid
        assert client.put("/api/snapshot", json=broken).status_code == 422
        assert snapshot(client) == before


def test_contract_permitted_values_are_not_overconstrained(client):
    for date in ({"kind": "date", "date": "2026-99-99"}, {"kind": "exact", "iso": "not a timestamp", "tz": "custom"}, {"kind": "week", "week": 1.0}, {"kind": "unknown"}):
        assert client.post("/api/personal-events", json=event(title="", courseId="", date=date, ignored="extra")).status_code == 200
    result = client.patch("/api/settings", json={"timezone": "X", "unknown": None}).json()
    assert result["settings"]["timezone"] == "X" and "unknown" not in result["settings"]


def test_app_and_store_instances_are_independent_and_return_copies(client):
    original = snapshot(client)
    store = InMemoryStore(original)
    copy = store.read()
    copy["courses"].clear()
    assert store.read() == original
    original["courses"].clear()
    assert store.read()["courses"]
    client.delete("/api/local-data")
    with TestClient(create_app(InMemoryStore())) as other:
        assert snapshot(other)["courses"]
    with TestClient(create_app(store)) as injected:
        assert snapshot(injected) == store.read()


def test_store_transaction_failure_retains_previous_value():
    store = InMemoryStore()
    before = store.read()
    with pytest.raises(ValueError):
        store.mutate(lambda s: s.update(courses=[{}]))
    assert store.read() == before
    with pytest.raises(ValueError):
        store.replace({})
    assert store.read() == before


def test_internal_error_envelope_has_no_exception_details():
    class BrokenStore(InMemoryStore):
        def read(self):
            raise RuntimeError("private internal detail")
    with TestClient(create_app(BrokenStore()), raise_server_exceptions=False) as client:
        response = client.get("/api/snapshot")
    assert response.status_code == 500
    assert response.json() == {"message": "Internal server error."}
