from copy import deepcopy
import pytest
from pydantic import ValidationError
from backend import schemas
from backend.domain_validation import (validate_date, validate_record, validate_url,
    evidence_replay_key, merge_source_evidence)


@pytest.fixture
def collected():
    return {"id": "opaque-old-id", "activityId": "7001", "courseId": "101", "title": "Lab", "type": "assignment",
            "sources": [{"source": "moodle", "date": {"kind": "date", "date": "2028-02-29"},
                         "url": "https://moodle.sdu.edu.kz/mod/assign/view.php?id=7001", "observedAt": "2028-02-28T09:00:00Z"}],
            "submission": {"status": "unknown", "observedAt": "2028-02-28T09:00:00Z"}, "personal": False,
            "firstObservedAt": "2028-02-28T09:00:00Z", "lastObservedAt": "2028-02-28T09:00:00Z"}


def test_valid_collected_record_preserves_opaque_ids_unknown_submission_and_absence(collected):
    assert validate_record(schemas.Assessment, collected) == collected
    assert "availableFrom" not in validate_record(schemas.Assessment, collected)


@pytest.mark.parametrize("value", [{"kind": "date", "date": "2028-02-29"},
    {"kind": "exact", "iso": "2028-02-29T14:00+05:00", "tz": "Asia/Almaty"},
    {"kind": "exact", "iso": "2028-02-29T09:00:00.123Z", "tz": "UTC"},
    {"kind": "week", "week": 30}, {"kind": "unknown"}, {"kind": "unknown", "note": "unpublished"}])
def test_supported_date_precision_round_trips_without_invention(value):
    assert validate_date(value) == value


@pytest.mark.parametrize("value,field", [({"kind": "date", "date": "2027-02-29"}, "date.date"),
    ({"kind": "date", "date": "2028-04-31"}, "date.date"),
    ({"kind": "exact", "iso": "2028-02-29T14:00:00", "tz": "UTC"}, "date.iso"),
    ({"kind": "exact", "iso": "nonsense", "tz": "UTC"}, "date.iso"),
    ({"kind": "exact", "iso": "2028-02-29T14:00:00Z", "tz": "Mars/Unknown"}, "date.tz"),
    ({"kind": "week", "week": 31}, "week")])
def test_domain_rejects_invalid_dates_with_field_reason(value, field):
    with pytest.raises(ValueError, match=field):
        validate_date(value)


@pytest.mark.parametrize("url", ["javascript:alert(1)", "data:text/plain,hi", "file:///tmp/x", "http://example.org/x", "https://user:pw@example.org/x", "https://bad host/x", "https://-bad.example/x", "https://example.org:99999/x", "https:///x"])
def test_domain_url_policy(url):
    with pytest.raises(ValueError, match="url"):
        validate_url(url)


def test_general_https_is_not_restricted_to_moodle_but_moodle_is():
    validate_url("https://example.org/syllabus.pdf")
    validate_url("https://127.0.0.1/x")
    validate_url("https://moodle.sdu.edu.kz:443/course/view.php?id=101", moodle=True)
    for url in ["https://example.org/x", "https://moodle.sdu.edu.kz.evil.org/x", "https://moodle.sdu.edu.kz:444/x"]:
        with pytest.raises(ValueError, match="canonical Moodle"):
            validate_url(url, moodle=True)


@pytest.mark.parametrize("field", ["id", "courseId", "activityId"])
@pytest.mark.parametrize("value", ["", " "])
def test_owned_record_identifiers_are_nonempty(collected, field, value):
    collected[field] = value
    with pytest.raises(ValueError, match=field):
        validate_record(schemas.Assessment, collected)


def test_missing_required_identifier_is_actionable(collected):
    del collected["id"]
    with pytest.raises(ValidationError, match="id"):
        validate_record(schemas.Assessment, collected)


@pytest.mark.parametrize("field,value", [("date", {"kind": "date", "date": "2027-02-29"}), ("url", "javascript:alert(1)")])
def test_wire_can_accept_values_that_ingestion_rejects(collected, field, value):
    collected["sources"][0][field] = value
    assert schemas.Assessment.model_validate(collected)
    with pytest.raises(ValueError, match=field):
        validate_record(schemas.Assessment, collected)


def test_evidence_replay_preserves_distinct_provenance_and_personal_layer(collected):
    source = collected["sources"][0]
    assert evidence_replay_key(source) == evidence_replay_key(dict(reversed(list(source.items()))))
    alternatives = [{**source, "source": "syllabus"}, {**source, "observedAt": "2028-02-28T10:00:00Z"},
                    {**source, "excerpt": "different facts"}, {**source, "location": "page 2"},
                    {**source, "date": {"kind": "week", "week": 8}}]
    overlay = {"assessmentId": collected["id"], "titleOverride": "My title", "dateOverride": {"kind": "week", "week": 7},
               "overrideBase": {"kind": "date", "date": "2028-02-29"}, "hidden": True, "completed": False}
    original = deepcopy(overlay)
    collected["sources"] = merge_source_evidence([source], [source, *alternatives])
    collected["submission"]["status"] = "submitted"
    assert len(collected["sources"]) == 6
    assert overlay == original and not overlay["completed"]
    collected["sources"][0]["excerpt"] = "local mutation"
    assert "excerpt" not in source

@pytest.mark.parametrize("model,value,field", [
    (schemas.Overlay, {"assessmentId": "", "hidden": False, "completed": False}, "assessmentId"),
    (schemas.ExtractionCandidate, {"id": "k1", "documentId": "", "courseId": "c1", "title": "x", "type": "other", "date": {"kind": "unknown"}, "rawDateText": "", "language": "en", "confidence": 0.5, "excerpt": "", "location": "", "status": "pending"}, "documentId"),
    (schemas.Alert, {"id": "x", "kind": "sync", "message": "x", "deliveryKey": "", "createdAt": "2028-02-28T09:00:00Z", "read": False}, "deliveryKey"),
    (schemas.CourseSyncState, {"courseId": "", "status": "never", "coverage": "none", "progress": 0}, "courseId")])
def test_other_owned_records_validate_required_identity_fields(model, value, field):
    with pytest.raises(ValueError, match=field):
        validate_record(model, value)


def test_complete_sample_is_a_valid_domain_snapshot():
    from backend.sample_data import build_sample_snapshot
    value = build_sample_snapshot()
    assert validate_record(schemas.Snapshot, value) == value


def test_timezone_data_failure_is_actionable_without_mislabeling_known_names(monkeypatch):
    from backend import domain_validation
    def absent(name):
        raise domain_validation.ZoneInfoNotFoundError(name)
    monkeypatch.setattr(domain_validation, "ZoneInfo", absent)
    domain_validation.validate_timezone("Asia/Almaty", "tz")
    with pytest.raises(ValueError, match="validation data unavailable locally"):
        domain_validation.validate_timezone("Europe/Paris", "tz")

@pytest.mark.parametrize("instant", ["2028-02-29T23:59:59Z", "2028-02-29T00:00+00:00",
    "2028-02-29T09:00:00-00:00", "2028-02-29T09:00:00+05:30",
    "2028-02-29T09:00:00-03:45", "2028-02-29T09:00:00+23:59",
    "2028-02-29T09:00:00-23:59"])
def test_exact_instant_valid_offset_boundaries_preserve_input(instant):
    value = {"kind": "exact", "iso": instant, "tz": "UTC"}
    assert validate_date(value) == value


@pytest.mark.parametrize("instant", ["2028-02-29T09:00:00+05:99", "2028-02-29T09:00:00+00:60",
    "2028-02-29T09:00:00-00:60", "2028-02-29T09:00:00+24:00",
    "2028-02-29T09:00:00-24:00", "2028-02-29T09:00:00+99:00",
    "2027-02-29T09:00:00Z", "2028-04-31T09:00:00Z", "2028-00-01T09:00:00Z",
    "2028-02-29T24:00:00Z", "2028-02-29T09:60:00Z", "2028-02-29T09:00:60Z",
    "2028-02-29T09:00:00+05:00:30", "2028-02-29T09:00:00+0500"])
def test_exact_instant_rejects_component_overflow_without_tightening_wire(instant):
    value = {"kind": "exact", "iso": instant, "tz": "UTC"}
    assert schemas.ExactDate.model_validate(value).iso == instant
    with pytest.raises(ValueError, match="date.iso: must be a valid ISO instant"):
        validate_date(value)
