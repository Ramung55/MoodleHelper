"""Opt-in collected-domain validation. Never changes permissive wire/API behavior."""
from copy import deepcopy
from datetime import date, datetime
import ipaddress
import json
import re
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import TypeAdapter

from backend import schemas
from backend.identity import MOODLE_ORIGIN, stable_identifier


def validate_instant(value: str, field: str) -> None:
    try:
        if not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]"
            r"(?::[0-5][0-9](?:\.[0-9]+)?)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])",
            value,
        ):
            raise ValueError
        # Enforce offset components before parsing: fromisoformat normalizes
        # invalid minutes such as +05:99 into a different valid offset.
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError(f"{field}: must be a valid ISO instant and include an explicit timezone offset or Z") from None


def validate_timezone(value: str, field: str) -> None:
    # Windows commonly has no IANA database. These product identifiers are
    # recognized names only: we never infer offsets or convert timestamps.
    if value in {"UTC", "Asia/Almaty", "Asia/Qyzylorda"}:
        return
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValueError(f"{field}: unknown timezone or validation data unavailable locally; use UTC/Asia/Almaty/Asia/Qyzylorda or install system IANA data") from None


def validate_date(value: dict, field: str = "date") -> dict:
    parsed = TypeAdapter(schemas.DateValue).validate_python(value)
    if parsed.kind == "date":
        try:
            date.fromisoformat(parsed.date)
        except ValueError:
            raise ValueError(f"{field}.date: must be a real calendar day") from None
    elif parsed.kind == "exact":
        validate_instant(parsed.iso, f"{field}.iso")
        validate_timezone(parsed.tz, f"{field}.tz")
    return parsed.model_dump(by_alias=True, exclude_unset=True)


def validate_url(value: str, field: str = "url", *, moodle: bool = False) -> None:
    try:
        if any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
            raise ValueError("must not contain whitespace, control characters or backslashes")
        url = urlsplit(value)
        if url.scheme != "https":
            raise ValueError("must use HTTPS")
        if url.username is not None or url.password is not None:
            raise ValueError("must not contain URL credentials")
        host = url.hostname
        if not host:
            raise ValueError("must have a valid hostname")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            labels = host.encode("idna").decode("ascii").split(".")
            if len(host) > 253 or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in labels):
                raise ValueError("must have a valid DNS hostname or IP")
        port = url.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("must have a valid port")
        if moodle and (host != urlsplit(MOODLE_ORIGIN).hostname or port not in (None, 443)):
            raise ValueError(f"must use canonical Moodle origin {MOODLE_ORIGIN}")
    except (ValueError, UnicodeError) as exc:
        raise ValueError(f"{field}: {exc}") from None


IDENTIFIERS = {"id", "activityId", "courseId", "assessmentId", "documentId", "matchAssessmentId", "deliveryKey"}
INSTANTS = {"iso", "observedAt", "availableFrom", "firstObservedAt", "lastObservedAt", "lastCheckedAt", "downloadedAt", "importedAt", "lastSuccessAt", "detectedAt", "createdAt"}


def validate_record(model: type[schemas.WireModel], value: dict) -> dict:
    """Validate one wire-shaped owned record semantically, preserving omissions.

    Record references must be nonempty; target existence is a storage/ingestion
    transaction concern. Snapshot validates reference *shapes*, not existence.
    """
    result = model.model_validate(value).model_dump(by_alias=True, exclude_unset=True)

    def walk(node, path=""):
        if isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, f"{path}[{i}]")
        elif isinstance(node, dict):
            if node.get("kind") in {"exact", "date", "week", "unknown"}:
                validate_date(node, path or "date")
            for key, item in node.items():
                field = f"{path}.{key}" if path else key
                if key in IDENTIFIERS:
                    stable_identifier(item, field)
                elif key == "trackedCourseIds":
                    for i, identifier in enumerate(item):
                        stable_identifier(identifier, f"{field}[{i}]")
                elif key in INSTANTS:
                    validate_instant(item, field)
                elif key in {"tz", "timezone"}:
                    validate_timezone(item, field)
                elif key == "semesterStart":
                    validate_date({"kind": "date", "date": item}, field)
                elif key == "url":
                    validate_url(item, field, moodle=node.get("source") == "moodle")
                walk(item, field)
    walk(result)
    return result


def evidence_replay_key(evidence: dict) -> str:
    """All present wire evidence fields participate; there is no source-ID field."""
    value = validate_record(schemas.SourceEvidence, evidence)
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def merge_source_evidence(existing: list[dict], incoming: list[dict]) -> list[dict]:
    """Pure comparison helper only, not a storage upsert implementation."""
    result, seen = [], set()
    for evidence in [*existing, *incoming]:
        key = evidence_replay_key(evidence)
        if key not in seen:
            result.append(deepcopy(evidence))
            seen.add(key)
    return result
