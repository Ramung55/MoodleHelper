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


@pytest.mark.parametrize("user", ["student", "042", "0", "42 ", " 42", "1" * 20, "4.2"])
def test_startup_refuses_a_moodle_dataset_with_a_non_decimal_user_id(user):
    # #93: only the canonical numeric Moodle user id can match the signed-in account.
    env = {"MOODLE_HELPER_DATASET": "moodle", "MOODLE_HELPER_MOODLE_ORIGIN": "https://moodle.sdu.edu.kz",
           "MOODLE_HELPER_PROFILE_LABEL": "personal", "MOODLE_HELPER_STABLE_USER_ID": user}
    with pytest.raises(ValueError, match=r"numeric Moodle user id.*click your name, then Profile.*number after id= in the address bar"):
        namespace_from_environment(env)
    assert json.loads(namespace_from_environment({**env, "MOODLE_HELPER_STABLE_USER_ID": "4242"}))[3] == "4242"
    assert namespace_from_environment({}) == '["demo"]'
