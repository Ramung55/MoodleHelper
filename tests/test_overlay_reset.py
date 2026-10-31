from copy import deepcopy


def test_override_baseline_uses_known_syllabus_when_latest_moodle_is_unknown(client):
    snapshot = client.get("/api/snapshot").json()
    snapshot["assessments"][0]["sources"] = [
        {"source": "moodle", "date": {"kind": "date", "date": "2026-10-01"}, "observedAt": "2026-10-01T00:00:00Z"},
        {"source": "moodle", "date": {"kind": "unknown"}, "observedAt": "2026-10-02T00:00:00Z"},
        {"source": "syllabus", "date": {"kind": "week", "week": 8}, "observedAt": "2026-10-01T00:00:00Z"},
    ]
    assert client.put("/api/snapshot", json=snapshot).status_code == 200
    result = client.patch("/api/assessments/a1/overlay", json={"dateOverride": {"kind": "week", "week": 9}})
    assert result.status_code == 200
    assert next(o for o in result.json()["overlays"] if o["assessmentId"] == "a1")["overrideBase"] == {"kind": "week", "week": 8}


def test_overlay_set_retain_clear_restores_latest_source(client):
    before = client.get("/api/snapshot").json()
    initial = client.patch("/api/assessments/a1/overlay", json={"titleOverride": "My title", "dateOverride": {"kind": "week", "week": 12}}).json()
    overlay = next(o for o in initial["overlays"] if o["assessmentId"] == "a1")
    assert overlay["overrideBase"] == before["assessments"][0]["sources"][0]["date"]
    retained = client.patch("/api/assessments/a1/overlay", json={"hidden": True}).json()
    assert next(o for o in retained["overlays"] if o["assessmentId"] == "a1")["dateOverride"] == {"kind": "week", "week": 12}
    changed_source = deepcopy(retained)
    changed_source["assessments"][0]["sources"][0]["date"] = {"kind": "week", "week": 13}
    client.put("/api/snapshot", json=changed_source)
    cleared = client.patch("/api/assessments/a1/overlay", json={"titleOverride": None, "dateOverride": None}).json()
    assert next(o for o in cleared["overlays"] if o["assessmentId"] == "a1") == {"assessmentId": "a1", "hidden": True, "completed": True}
    assert cleared["assessments"] == changed_source["assessments"]


def test_contradictory_reset_is_atomic_and_snapshot_stays_nonnullable(client):
    client.patch("/api/assessments/a1/overlay", json={"dateOverride": {"kind": "week", "week": 8}})
    before = client.get("/api/snapshot").json()
    response = client.patch("/api/assessments/a1/overlay", json={"dateOverride": None, "overrideBase": {"kind": "week", "week": 4}})
    assert response.status_code == 422
    assert client.get("/api/snapshot").json() == before
    broken = deepcopy(before)
    broken["overlays"][0]["titleOverride"] = None
    assert client.put("/api/snapshot", json=broken).status_code == 422
    assert client.get("/api/snapshot").json() == before


def test_null_baseline_clear_and_nonnull_date_recalculation(client):
    initial = client.patch("/api/assessments/a1/overlay", json={"dateOverride": {"kind": "week", "week": 8}}).json()
    old_baseline = initial["overlays"][-1]["overrideBase"]
    cleared = client.patch("/api/assessments/a1/overlay", json={"overrideBase": None}).json()
    assert "overrideBase" not in cleared["overlays"][-1]
    recalculated = client.patch("/api/assessments/a1/overlay", json={"dateOverride": {"kind": "week", "week": 9}, "overrideBase": None}).json()
    assert recalculated["overlays"][-1]["overrideBase"] == old_baseline
