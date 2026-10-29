from copy import deepcopy

import pytest

CALENDAR = dict(startDate="2027-01-04", endDate="2027-02-28", timezone="Asia/Qyzylorda", excludedWeekStarts=["2027-01-18"])


def test_calendar_replacement_omission_and_legacy_roundtrip(client):
    old = client.get("/api/snapshot").json()
    assert "teachingCalendar" not in old["settings"]
    assert client.put("/api/snapshot", json=old).json() == old
    saved = client.patch("/api/settings", json={"teachingCalendar": CALENDAR})
    assert saved.status_code == 200
    assert saved.json()["settings"]["teachingCalendar"] == CALENDAR
    retained = client.patch("/api/settings", json={"timezone": "legacy arbitrary zone"}).json()
    assert retained["settings"]["teachingCalendar"] == CALENDAR
    replacement = {**CALENDAR, "excludedWeekStarts": []}
    updated = client.patch("/api/settings", json={"teachingCalendar": replacement}).json()
    assert updated["settings"]["teachingCalendar"] == replacement
    assert client.put("/api/snapshot", json=updated).json() == updated


@pytest.mark.parametrize("change", [None, {}, {"startDate": "2027-02-29"}, {"endDate": "2027-01-01"}, {"endDate": "2027-03-01"}, {"timezone": "XYZ"}, {"excludedWeekStarts": ["2027-01-19"]}, {"excludedWeekStarts": ["2027-01-18"] * 2}, {"excludedWeekStarts": ["2027-03-01"]}, {"endDate": "2028-03-05"}, {"endDate": "2027-08-08", "excludedWeekStarts": []}, {"extra": True}])
def test_invalid_calendar_atomic_patch_and_restore(client, change):
    assert client.patch("/api/settings", json={"teachingCalendar": CALENDAR}).status_code == 200
    before = client.get("/api/snapshot").json()
    invalid = change if change is None or change == {} else {**CALENDAR, **change}
    assert client.patch("/api/settings", json={"teachingCalendar": invalid}).status_code == 422
    assert client.get("/api/snapshot").json() == before
    restore = deepcopy(before)
    restore["settings"]["teachingCalendar"] = invalid
    assert client.put("/api/snapshot", json=restore).status_code == 422
    assert client.get("/api/snapshot").json() == before


def test_reconciliation_uses_explicit_slots_not_legacy_arithmetic():
    from backend.reconciliation import compatible_dates
    settings = {"semesterStart": "2027-01-04", "timezone": "UTC"}
    week = {"kind": "week", "week": 3}
    day = lambda value: {"kind": "date", "date": value}
    assert not compatible_dates(week, day("2027-01-18"), settings)
    settings["teachingCalendar"] = {**CALENDAR, "timezone": "UTC"}
    assert not compatible_dates(week, day("2027-01-18"), settings)
    assert compatible_dates(week, day("2027-01-25"), settings)
    assert not compatible_dates({"kind": "week", "week": 8}, {"kind": "week", "week": 8}, settings)
    assert compatible_dates(week, {"kind": "exact", "iso": "2027-01-25T00:00:00Z", "tz": "UTC"}, settings)

