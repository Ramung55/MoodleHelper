import json
import pytest
from backend.identity import (namespace_key, namespace_from_environment, validate_namespace,
                              collector_entity_key)


def test_namespaces_are_canonical_unambiguous_and_trusted_configuration_only():
    assert namespace_from_environment({}) == '["demo"]'
    base = dict(origin="https://moodle.sdu.edu.kz", profile_label="personal", stable_user_id="42")
    first = namespace_key("moodle", **base)
    assert validate_namespace(first) == ["moodle", base["origin"], "personal", "42"]
    assert len({first, namespace_key(), namespace_key("moodle", **{**base, "stable_user_id": "43"}),
                namespace_key("moodle", **{**base, "profile_label": "work"})}) == 4
    assert namespace_key("moodle", **{**base, "profile_label": 'a","b', "stable_user_id": "c"}) != namespace_key("moodle", **{**base, "profile_label": "a", "stable_user_id": 'b","c'})


@pytest.mark.parametrize("kwargs", [{"mode": "moodle"}, {"mode": "other"},
    {"mode": "demo", "stable_user_id": "42"},
    {"mode": "moodle", "origin": "https://evil.example", "profile_label": "x", "stable_user_id": "42"},
    {"mode": "moodle", "origin": "https://moodle.sdu.edu.kz", "profile_label": " ", "stable_user_id": "42"}])
def test_partial_or_invalid_identity_is_rejected(kwargs):
    with pytest.raises(ValueError):
        namespace_key(**kwargs)


@pytest.mark.parametrize("key", ['["moodle"]', '["demo", "extra"]', '{}', ' ["demo"]', '["moodle","https://moodle.sdu.edu.kz",42,"x"]'])
def test_invalid_namespace_keys(key):
    with pytest.raises(ValueError, match="namespace"):
        validate_namespace(key)


def test_labeled_future_collector_keys_do_not_use_titles_or_dates():
    ns = namespace_key()
    course = collector_entity_key(ns, "course", course_id="101")
    assignment = collector_entity_key(ns, "activity", course_id="101", module_type="assign", source_id="7001")
    quiz = collector_entity_key(ns, "activity", course_id="101", module_type="quiz", source_id="7001")
    resource = collector_entity_key(ns, "resource", course_id="101", module_type="resource", source_id="7001")
    assert len({course, assignment, quiz, resource}) == 4
    assert json.loads(assignment) == ["demo", "activity", "101", "assign", "7001"]
    assert assignment == collector_entity_key(ns, "activity", course_id="101", module_type="assign", source_id="7001")
    with pytest.raises(ValueError, match="source_id"):
        collector_entity_key(ns, "activity", course_id="101", module_type="assign")
    with pytest.raises(ValueError, match="course_id"):
        collector_entity_key(ns, "course", course_id="")
