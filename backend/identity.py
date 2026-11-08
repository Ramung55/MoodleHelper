"""Trusted dataset identities and future collector key rules; no HTTP integration."""
import json
from collections.abc import Mapping

MOODLE_ORIGIN = "https://moodle.sdu.edu.kz"


def stable_identifier(value: str | None, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field}: must be a nonempty stable identifier")
    return value


def namespace_key(mode: str = "demo", *, origin: str | None = None,
                  profile_label: str | None = None, stable_user_id: str | None = None) -> str:
    if mode == "demo":
        if any(v is not None for v in (origin, profile_label, stable_user_id)):
            raise ValueError("namespace: demo cannot include Moodle identity configuration")
        parts = ["demo"]
    elif mode == "moodle":
        if origin != MOODLE_ORIGIN:
            raise ValueError(f"origin: must equal canonical {MOODLE_ORIGIN}")
        parts = [mode, origin, stable_identifier(profile_label, "profile_label"),
                 stable_identifier(stable_user_id, "stable_user_id")]
    else:
        raise ValueError("mode: must be demo or moodle")
    return json.dumps(parts, ensure_ascii=True, separators=(",", ":"))


def namespace_from_environment(env: Mapping[str, str]) -> str:
    """Explicit mapping only; caller decides when to read trusted environment."""
    return namespace_key(env.get("MOODLE_HELPER_DATASET", "demo"),
                         origin=env.get("MOODLE_HELPER_MOODLE_ORIGIN"),
                         profile_label=env.get("MOODLE_HELPER_PROFILE_LABEL"),
                         stable_user_id=env.get("MOODLE_HELPER_STABLE_USER_ID"))


def validate_namespace(key: str) -> list[str]:
    try:
        parts = json.loads(key)
        if not isinstance(parts, list):
            raise ValueError
        if parts == ["demo"]:
            canonical = namespace_key()
        elif len(parts) == 4 and parts[0] == "moodle":
            canonical = namespace_key(parts[0], origin=parts[1], profile_label=parts[2], stable_user_id=parts[3])
        else:
            raise ValueError
        if canonical != key:
            raise ValueError
    except (TypeError, ValueError) as exc:
        raise ValueError("namespace: expected a canonical complete dataset key") from exc
    return parts


def collector_entity_key(namespace: str, entity: str, *, course_id: str,
                         module_type: str | None = None, source_id: str | None = None) -> str:
    """Proposed collectors use labeled stable IDs, never title/date matching."""
    parts = validate_namespace(namespace) + [entity, stable_identifier(course_id, "course_id")]
    if entity in ("activity", "resource"):
        parts += [stable_identifier(module_type, "module_type"), stable_identifier(source_id, "source_id")]
    elif entity != "course" or module_type is not None or source_id is not None:
        raise ValueError("entity: expected course, or activity/resource with module_type and source_id")
    return json.dumps(parts, ensure_ascii=True, separators=(",", ":"))
