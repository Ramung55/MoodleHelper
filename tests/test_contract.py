"""Verify actual HTTP responses and generated model schemas against the source.

The app generates its own OpenAPI; these checks do not substitute the source
document for generated schemas, so drift in handlers/models fails the suite.
"""

from copy import deepcopy
import json

import pytest

from backend import schemas


OPERATIONS = [
    ("get", "/api/bridge-context", None),
    ("get", "/api/connection", None),
    ("get", "/api/snapshot", None),
    ("put", "/api/snapshot", "snapshot"),
    ("put", "/api/tracked-courses", []),
    ("post", "/api/courses/discovery", {"observations": []}),
    ("patch", "/api/assessments/{assessmentId}/overlay", {"completed": True}),
    ("post", "/api/personal-events", {"courseId": "c-csc", "title": "Study", "type": "other", "date": {"kind": "unknown"}}),
    ("delete", "/api/personal-events/{id}", None),
    ("post", "/api/sync", None),
    ("post", "/api/documents/import", {"courseId": "c-csc", "fileName": "syllabus.pdf"}),
    ("post", "/api/candidates/{candidateId}/review", {"kind": "confirm"}),
    ("post", "/api/materials/{id}/download", None),
    ("put", "/api/alerts", []),
    ("patch", "/api/settings", {"semesterWeeks": 16}),
    ("delete", "/api/local-data", None),
    ("post", "/api/demo/reset", None),
    ("get", "/api/ai/availability", None),
]


def resolve(schema, document):
    if "$ref" not in schema:
        return schema
    target = document
    for part in schema["$ref"].removeprefix("#/").split("/"):
        target = target[part]
    return {**resolve(target, document), **{k: v for k, v in schema.items() if k != "$ref"}}


def canonical(schema, document):
    """Compare validation semantics, ignoring documentation-only metadata.

    The only anyOf unions here have disjoint literal discriminants, so they
    accept exactly the same values as the source oneOf unions.
    """
    if isinstance(schema, list):
        return [canonical(x, document) for x in schema]
    if not isinstance(schema, dict):
        return schema
    schema = resolve(schema, document)
    if isinstance(schema.get("type"), list):
        schema = {**{key: value for key, value in schema.items() if key != "type"},
                  "anyOf": [{"type": kind} for kind in schema["type"]]}
    result = {}
    for key, value in schema.items():
        if key in ("title", "description", "default", "discriminator", "$defs") or key.startswith("x-"):
            continue
        name = "oneOf" if key == "anyOf" else key
        result[name] = ({prop: canonical(child, document) for prop, child in value.items()}
                        if key == "properties" else canonical(value, document))
        if key in ("required", "enum", "oneOf", "anyOf") and isinstance(result[name], list):
            result[name] = sorted(result[name], key=lambda x: json.dumps(x, sort_keys=True))
    return result


@pytest.mark.parametrize("method,path,body", OPERATIONS)
def test_each_operation_request_and_response_contract_without_credentials(client, contract, contract_validator, method, path, body):
    operation = contract["paths"][path][method]
    assert operation["security"] == []
    url = path.replace("{assessmentId}", "a1").replace("{candidateId}", "k1").replace("{id}", "missing")
    if body == "snapshot":
        body = client.get("/api/snapshot").json()
    if body is not None:
        contract_validator(operation["requestBody"]["content"]["application/json"]["schema"], body)
    response = client.request(method, url, **({"json": body} if body is not None else {}))
    assert response.status_code == 200
    contract_validator(operation["responses"]["200"]["content"]["application/json"]["schema"], response.json())


def test_generated_operations_and_schemas_match_authoritative_contract(client, contract):
    generated = client.get("/openapi.json").json()
    expected_operations = {(method, path) for path, ops in contract["paths"].items() for method in ops}
    actual_operations = {(method, path) for path, ops in generated["paths"].items() for method in ops}
    internal = {('get','/api/collection-context'),('post','/api/collection/visits'),('post','/api/collection/refresh'), ('post','/api/queue/runs'), ('get','/api/queue/runs/{runId}'), ('post','/api/queue/runs/{runId}/cancel'), ('post','/api/queue/claim'), ('post','/api/queue/renew'), ('post','/api/queue/finish')}
    internal |= {('get','/api/queue/current'), ('post','/api/queue/current'), ('post','/api/scan/runs'), ('get','/api/scan/runs/{runId}'), ('post','/api/scan/runs/{runId}/cancel'), ('post','/api/scan/claim'), ('post','/api/scan/renew'), ('post','/api/scan/finish'), ('get','/api/scan/jobs/{jobId}/pages')}
    internal |= {('post','/api/reconciliation/pairs'), ('post','/api/reconciliation/decisions')}
    internal |= {('post','/api/syllabus-revisions/preview'), ('post','/api/syllabus-revisions/confirm')}
    internal |= {('post','/api/syllabus-suggestions/dismissal')}
    internal |= {('get','/api/local-context')}
    internal |= {('post','/api/local-syllabus/route')}
    internal |= {('get','/api/reminders/plan'), ('post','/api/reminders/reconcile'), ('post','/api/reminders/dispatch')}
    internal |= {('post','/api/reminders/delivery-status'), ('post','/api/reminders/notification-target'), ('post','/api/alerts/update')}
    assert actual_operations == expected_operations == {(method, path) for method, path, _ in OPERATIONS} | internal
    assert len(actual_operations) == 49
    assert not generated["components"].get("securitySchemes")
    for method, path in expected_operations:
        expected = contract["paths"][path][method]
        actual = generated["paths"][path][method]
        assert actual["operationId"] == expected["operationId"]
        assert not actual.get("security")
        assert sorted(canonical(actual.get("parameters", []), generated), key=lambda p: (p["in"], p["name"])) == sorted(canonical(expected.get("parameters", []), contract), key=lambda p: (p["in"], p["name"]))
        assert ("requestBody" in actual) == ("requestBody" in expected)
        if "requestBody" in expected:
            assert actual["requestBody"]["required"] is True
            assert canonical(actual["requestBody"]["content"]["application/json"]["schema"], generated) == canonical(expected["requestBody"]["content"]["application/json"]["schema"], contract), (method, path, "request")
        assert canonical(actual["responses"]["200"]["content"]["application/json"]["schema"], generated) == canonical(expected["responses"]["200"]["content"]["application/json"]["schema"], contract), (method, path, "response")
        expected_error = contract["components"]["schemas"]["ProposedHttpError"]
        assert canonical(actual["responses"]["default"]["content"]["application/json"]["schema"], generated) == canonical(expected_error, contract)
        assert canonical(actual["responses"]["422"]["content"]["application/json"]["schema"], generated) == canonical(expected_error, contract)


def test_all_named_record_schemas_match_fields_enums_bounds_and_requiredness(client, contract):
    generated = client.get("/openapi.json").json()
    for name, expected in contract["components"]["schemas"].items():
        model = getattr(schemas, name, None)
        if model is None or not isinstance(model, type) or not issubclass(model, schemas.WireModel):
            continue  # union aliases are checked through their route schemas
        actual = model.model_json_schema(by_alias=True)
        doc = {"$defs": actual.get("$defs", {})}
        assert canonical(actual, doc) == canonical(expected, contract), name


def test_defaulted_required_booleans_remain_required_in_generated_contract(client, contract):
    generated = client.get("/openapi.json").json()
    for name, field in [("Assessment", "personal"), ("Overlay", "hidden"), ("Overlay", "completed"), ("Material", "syllabusSuggestion")]:
        actual = generated["components"]["schemas"][name]
        assert field in actual["required"]
        assert actual["properties"][field]["default"] is False


def test_error_payload_matches_declared_envelope(client, contract, contract_validator):
    error_schema = contract["components"]["schemas"]["ProposedHttpError"]
    for response in [client.patch("/api/settings", json={"semesterWeeks": 99}), client.get("/unknown"), client.get("/api/settings")]:
        contract_validator(error_schema, response.json())


@pytest.mark.parametrize("field", ["personal", "firstObservedAt", "courseId", "id", "sources"])
def test_restore_requires_contract_required_assessment_fields(client, field):
    before = client.get("/api/snapshot").json()
    broken = deepcopy(before)
    del broken["assessments"][0][field]
    assert client.put("/api/snapshot", json=broken).status_code == 422
    assert client.get("/api/snapshot").json() == before
