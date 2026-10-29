"""Exercise actual Zod, YAML, Python models together with approved installed tools."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess

import pytest
from jsonschema import ValidationError as SchemaError
from pydantic import ValidationError

from backend import schemas
from backend.sample_data import build_sample_snapshot

ROOT = Path(__file__).parents[1]


def test_optional_calendar_new_group_zod_python_parity():
    calendar = dict(startDate="2027-01-04", endDate="2027-02-28", timezone="Asia/Qyzylorda", excludedWeekStarts=["2027-01-18"])
    value = build_sample_snapshot()
    value["settings"]["teachingCalendar"] = calendar
    assert schemas.Snapshot.model_validate(value).model_dump(by_alias=True, exclude_unset=True) == value
    assert zod("Snapshot", value) == {"success": True, "value": value}
    for changed in [None, {}, {**calendar, "startDate": "2027-02-29"}, {**calendar, "timezone": "XYZ"}, {**calendar, "excludedWeekStarts": ["2027-01-19"]}, {**calendar, "excludedWeekStarts": ["2027-01-18"] * 2}]:
        value["settings"]["teachingCalendar"] = changed
        with pytest.raises(ValidationError):
            schemas.Snapshot.model_validate(value)
        assert not zod("Snapshot", value)["success"]


def zod(model, value):
    result = subprocess.run(["node", str(ROOT / "tests/zod_model_probe.mjs")],
                            input=json.dumps({"model": model, "value": value}),
                            text=True, encoding="utf-8", capture_output=True, cwd=ROOT, check=True)
    return json.loads(result.stdout)


def test_full_snapshot_round_trip_all_current_entities(contract, contract_validator):
    value = build_sample_snapshot()
    assert all(value[k] for k in ("courses", "assessments", "overlays", "materials", "documents", "candidates", "sync", "changes", "alerts"))
    contract_validator(contract["components"]["schemas"]["Snapshot"], value)
    parsed = schemas.Snapshot.model_validate(value).model_dump(by_alias=True, exclude_unset=True)
    assert parsed == value
    assert zod("Snapshot", value) == {"success": True, "value": value}


@pytest.mark.parametrize("name,field", [("Assessment", "personal"), ("Overlay", "hidden"),
    ("Overlay", "completed"), ("Material", "syllabusSuggestion")])
def test_actual_zod_defaults_differ_from_required_wire(name, field, contract, contract_validator):
    group = {"Assessment": "assessments", "Overlay": "overlays", "Material": "materials"}[name]
    value = deepcopy(build_sample_snapshot()[group][0])
    del value[field]
    parsed = zod(name, value)
    assert parsed["success"] and parsed["value"][field] is False
    with pytest.raises(ValidationError):
        getattr(schemas, name).model_validate(value)
    with pytest.raises(SchemaError):
        contract_validator(contract["components"]["schemas"][name], value)
    metadata = getattr(schemas, name).model_json_schema()["properties"][field]
    assert metadata["default"] is False


@pytest.mark.parametrize("name,value", [("Course", {"id": "x", "code": "x", "name": "x", "color": 7, "current": True}),
    ("DateValue", {"kind": "week", "week": 0}), ("DateValue", {"kind": "date", "date": "tomorrow"}),
    ("SourceEvidence", {"source": "other", "date": {"kind": "unknown"}, "observedAt": "x"}),
    ("Overlay", {"assessmentId": "x", "hidden": False, "completed": True, "dateOverride": None})])
def test_representative_invalid_shapes_rejected_by_all_three(name, value, contract, contract_validator):
    assert not zod(name, value)["success"]
    from pydantic import TypeAdapter
    with pytest.raises(ValidationError):
        TypeAdapter(getattr(schemas, name)).validate_python(value)
    with pytest.raises(SchemaError):
        contract_validator(contract["components"]["schemas"][name], value)


def test_permissive_wire_strings_and_extra_key_difference(contract, contract_validator):
    value = {"source": "moodle", "date": {"kind": "exact", "iso": "arbitrary", "tz": "unknown zone"},
             "observedAt": "not timestamp", "url": "javascript:alert(1)", "extra": 42}
    contract_validator(contract["components"]["schemas"]["SourceEvidence"], value)
    expected = {k: v for k, v in value.items() if k != "extra"}
    assert schemas.SourceEvidence.model_validate(value).model_dump(exclude_unset=True) == expected
    assert zod("SourceEvidence", value) == {"success": True, "value": expected}
    day = {"kind": "date", "date": "2027-02-29"}
    assert zod("DateValue", day)["success"]
    assert schemas.CalendarDate.model_validate(day)
    contract_validator(contract["components"]["schemas"]["DateValue"], day)


def test_patch_omission_clear_and_alias_are_separate_from_snapshot():
    assert schemas.OverlayPatch.model_validate({}).model_fields_set == set()
    patch = schemas.OverlayPatch.model_validate({"dateOverride": None})
    assert patch.model_fields_set == {"dateOverride"}
    assert patch.model_dump(exclude_unset=True) == {"dateOverride": None}
    with pytest.raises(ValidationError):
        schemas.OverlayPatch.model_validate({"completed": None})
    value = {"id": "x", "assessmentId": "a1", "from": {"kind": "week", "week": 1},
             "to": {"kind": "unknown"}, "detectedAt": "anything"}
    parsed = schemas.DeadlineChange.model_validate(value)
    assert parsed.from_.week == 1
    assert parsed.model_dump(by_alias=True, exclude_unset=True) == value
    assert zod("DeadlineChange", value)["value"] == value


@pytest.mark.parametrize("status", ["current", "past", "unknown"])
def test_course_discovery_metadata_discriminators_round_trip_all_languages(status, contract, contract_validator):
    value = deepcopy(build_sample_snapshot())
    course = value["courses"][0]
    course["discovery"] = {"sourceCourseId": "9007199254740993123456789",
                           "sourceUrl": "https://moodle.sdu.edu.kz/course/view.php?id=9007199254740993123456789",
                           "title": {"kind": "known", "value": "Полное название курса"},
                           "termIndicators": {"kind": "known", "value": ["Осень 2026", "Term B"]},
                           "currentTermStatus": status}
    course["current"] = status == "current"
    for unknown in (False, True):
        if unknown:
            course["discovery"].update(title={"kind": "unknown"}, termIndicators={"kind": "unknown"})
        contract_validator(contract["components"]["schemas"]["Snapshot"], value)
        assert schemas.Snapshot.model_validate(value).model_dump(by_alias=True, exclude_none=True) == value
        assert zod("Snapshot", value) == {"success": True, "value": value}
    course["discovery"] = None
    with pytest.raises(ValidationError):
        schemas.Snapshot.model_validate(value)
    assert not zod("Snapshot", value)["success"]
    with pytest.raises(SchemaError):
        contract_validator(contract["components"]["schemas"]["Snapshot"], value)


@pytest.mark.parametrize("title,terms", [
    ({"kind": "known", "value": "Название"}, {"kind": "known", "value": ["Осень", "Term B"]}),
    ({"kind": "unknown"}, {"kind": "unknown"}),
])
def test_discovery_input_parity(title, terms, contract, contract_validator):
    value = {"observations": [{"sourceCourseId": "9007199254740993123456789",
        "sourceUrl": "https://moodle.sdu.edu.kz/course/view.php?id=9007199254740993123456789",
        "title": title, "termIndicators": terms}]}
    contract_validator(contract["components"]["schemas"]["CourseDiscoveryInput"], value)
    assert schemas.CourseDiscoveryInput.model_validate(value).model_dump() == value
    assert zod("CourseDiscoveryInput", value) == {"success": True, "value": value}


@pytest.mark.parametrize("patch", [
    {"title": None}, {"title": {"kind": "known"}},
    {"title": {"kind": "conflicting"}},
    {"termIndicators": {"kind": "known", "value": "Осень"}},
    {"termIndicators": {"kind": "known", "value": [3]}},
    {"currentTermStatus": "maybe"},
])
def test_invalid_discovery_discriminators_rejected_by_all_three(patch, contract, contract_validator):
    value = {"sourceCourseId": "1", "sourceUrl": "https://moodle.sdu.edu.kz/course/view.php?id=1",
             "title": {"kind": "unknown"}, "termIndicators": {"kind": "unknown"},
             "currentTermStatus": "unknown", **patch}
    assert not zod("CourseDiscovery", value)["success"]
    with pytest.raises(ValidationError):
        schemas.CourseDiscovery.model_validate(value)
    with pytest.raises(SchemaError):
        contract_validator(contract["components"]["schemas"]["CourseDiscovery"], value)

