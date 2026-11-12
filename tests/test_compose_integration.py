"""Opt-in end-to-end tests for the real Compose stack and its PostgreSQL volume."""
import base64
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
from uuid import uuid4

import httpx
import pytest
from backend.migrations import SCHEMA_VERSION

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(
    os.environ.get("MOODLE_HELPER_COMPOSE_TEST") != "1",
    reason="Set MOODLE_HELPER_COMPOSE_TEST=1 to run Docker Compose integration tests",
)


@pytest.fixture(scope="module")
def stack():
    # Every run gets its own project and volume; never remove a user's stack.
    project = "moodlehelper-test-" + uuid4().hex[:12]
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {**os.environ, "APP_PORT": str(port), "POSTGRES_USER": "sdip",
           "POSTGRES_PASSWORD": "test_only_password", "POSTGRES_DB": "sdip",
           "MOODLE_HELPER_DATABASE_URL": "postgresql://sdip:test_only_password@postgres:5432/sdip"}
    prefix = ["docker", "compose", "-f", str(ROOT / "docker-compose.yaml"), "-p", project]

    def compose(*args):
        return subprocess.run(prefix + list(args), cwd=ROOT, env=env, check=True,
                              capture_output=True, text=True, timeout=600)

    base = f"http://127.0.0.1:{port}"

    def wait_for_app():
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                if httpx.get(base + "/api/snapshot", timeout=2, trust_env=False).status_code == 200:
                    return
            except httpx.TransportError:
                pass
            time.sleep(0.5)
        raise AssertionError("App did not become ready; inspect Compose logs")

    try:
        compose("up", "-d", "--build", "--wait")
        wait_for_app()
        yield base, compose, wait_for_app
    finally:
        compose("down", "--volumes", "--remove-orphans")


def test_frontend_and_api_are_served(stack):
    base, compose, _ = stack
    with httpx.Client(base_url=base, timeout=10, trust_env=False) as client:
        home = client.get("/")
        assert home.status_code == 200
        assert "text/html" in home.headers["content-type"]
        asset = re.search(r'["\'](/assets/[^"\']+\.(?:js|css))', home.text)
        assert asset, "Frontend shell did not reference a built asset"
        assert client.get(asset.group(1)).status_code == 200
        assert client.get("/settings").status_code == 200
        assert client.get("/api/snapshot").status_code == 200
        missing = client.get("/api/does-not-exist")
        assert missing.status_code == 404
        assert missing.json() == {"message": "Not Found"}
        assert client.patch("/api/settings", json={"semesterWeeks": 9}).status_code == 409
        binding = client.get("/api/bridge-context").json()["binding"]
        assert client.patch("/api/settings", json={"semesterWeeks": 9},
                            headers={"X-Moodle-Helper-Bridge-Binding": binding}).status_code == 200
    result = compose("exec", "-T", "postgres", "psql", "-U", "sdip", "-d", "sdip",
                     "-Atc", "SELECT count(*) FROM snapshots")
    assert int(result.stdout.strip()) > 0


def test_postgres_data_survives_compose_recreation(stack):
    base, compose, wait_for_app = stack
    with httpx.Client(base_url=base, timeout=10, trust_env=False) as client:
        dataset = client.get("/api/local-context").json()["datasetId"]
        binding = client.get("/api/bridge-context").json()["binding"]
        changed = client.patch("/api/settings", json={"semesterWeeks": 9},
                               headers={"X-Moodle-Helper-Bridge-Binding": binding})
        assert changed.status_code == 200, changed.text
        assert changed.json()["settings"]["semesterWeeks"] == 9
    # Remove both containers, retaining only their named volume.
    compose("down")
    compose("up", "-d", "--wait")
    wait_for_app()
    with httpx.Client(base_url=base, timeout=10, trust_env=False) as client:
        assert client.get("/api/local-context").json()["datasetId"] == dataset
        assert client.get("/api/snapshot").json()["settings"]["semesterWeeks"] == 9


def test_database_schema_initialized_and_connected(stack):
    _, compose, _ = stack
    result = compose("exec", "-T", "postgres", "psql", "-U", "sdip", "-d", "sdip",
                     "-Atc", "SELECT version FROM schema_version WHERE id=1")
    assert int(result.stdout.strip()) == SCHEMA_VERSION
    result = compose("exec", "-T", "postgres", "psql", "-U", "sdip", "-d", "sdip",
                     "-Atc", "SELECT count(*) FROM local_datasets")
    assert int(result.stdout.strip()) >= 1


def test_existing_postgres_schema_is_upgraded_without_data_loss(stack):
    # A second, uniquely named Compose project owns the old-schema database;
    # never rewrite the main fixture's database or an existing user volume.
    base, _, _ = stack
    saved = httpx.get(base + "/api/snapshot", timeout=10, trust_env=False).json()
    encoded = base64.b64encode(json.dumps(saved, ensure_ascii=False).encode("utf-8")).decode("ascii")
    project = "moodlehelper-migration-test-" + uuid4().hex[:12]
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {**os.environ, "APP_PORT": str(port), "POSTGRES_USER": "sdip",
           "POSTGRES_PASSWORD": "test_only_password", "POSTGRES_DB": "sdip",
           "MOODLE_HELPER_DATABASE_URL": "postgresql://sdip:test_only_password@postgres:5432/sdip"}
    prefix = ["docker", "compose", "-f", str(ROOT / "docker-compose.yaml"), "-p", project]

    def compose(*args):
        return subprocess.run(prefix + list(args), cwd=ROOT, env=env, check=True,
                              capture_output=True, text=True, timeout=600)

    try:
        compose("up", "-d", "--wait", "postgres")
        sql = ("CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL); "
               "CREATE TABLE snapshots (namespace TEXT PRIMARY KEY, snapshot TEXT NOT NULL); "
               "INSERT INTO schema_version VALUES (1,1); "
               "INSERT INTO snapshots VALUES ('[\"demo\"]', convert_from(decode('" + encoded + "','base64'),'UTF8'));")
        compose("exec", "-T", "postgres", "psql", "-U", "sdip", "-d", "sdip",
                "-v", "ON_ERROR_STOP=1", "-c", sql)
        compose("up", "-d", "--build", "--wait", "app")
        deadline = time.monotonic() + 45
        response = None
        while time.monotonic() < deadline:
            try:
                response = httpx.get(f"http://127.0.0.1:{port}/api/snapshot", timeout=2, trust_env=False)
                if response.status_code == 200:
                    break
            except httpx.TransportError:
                pass
            time.sleep(0.5)
        assert response is not None, "Migrated app did not become ready"
        assert response.status_code == 200
        assert response.json() == saved
        version = compose("exec", "-T", "postgres", "psql", "-U", "sdip", "-d", "sdip",
                          "-Atc", "SELECT version FROM schema_version WHERE id=1")
        assert int(version.stdout.strip()) == SCHEMA_VERSION
    finally:
        compose("down", "--volumes", "--remove-orphans")


def test_api_contract_crud_and_errors(stack, contract, contract_validator):
    base, _, _ = stack

    def validate_response(method, path, response, status="200"):
        schema = contract["paths"][path][method]["responses"][status]["content"]["application/json"]["schema"]
        contract_validator(schema, response.json())

    with httpx.Client(base_url=base, timeout=10, trust_env=False) as client:
        snapshot = client.get("/api/snapshot")
        assert snapshot.status_code == 200
        validate_response("get", "/api/snapshot", snapshot)
        initial_weeks = snapshot.json()["settings"]["semesterWeeks"]
        course = snapshot.json()["courses"][0]["id"]
        binding = client.get("/api/bridge-context").json()["binding"]
        headers = {"X-Moodle-Helper-Bridge-Binding": binding}
        payload = {"courseId": course, "title": "Compose integration event",
                   "type": "other", "date": {"kind": "unknown"}}
        create_path = "/api/personal-events"
        contract_validator(contract["paths"][create_path]["post"]["requestBody"]["content"]["application/json"]["schema"], payload)
        created = client.post(create_path, json=payload, headers=headers)
        assert created.status_code == 200, created.text
        validate_response("post", create_path, created)
        event = next(item for item in created.json()["assessments"] if item["title"] == payload["title"])
        event_id = event["id"]
        overlay_path = "/api/assessments/{assessmentId}/overlay"
        patch = {"completed": True}
        contract_validator(contract["paths"][overlay_path]["patch"]["requestBody"]["content"]["application/json"]["schema"], patch)
        updated = client.patch(f"/api/assessments/{event_id}/overlay", json=patch, headers=headers)
        assert updated.status_code == 200, updated.text
        validate_response("patch", overlay_path, updated)
        assert any(item["assessmentId"] == event_id and item["completed"] for item in updated.json()["overlays"])
        deleted = client.delete(f"/api/personal-events/{event_id}", headers=headers)
        assert deleted.status_code == 200, deleted.text
        validate_response("delete", "/api/personal-events/{id}", deleted)
        assert all(item["id"] != event_id for item in deleted.json()["assessments"])

        # Binding is a process write guard, not a user authentication mechanism.
        for bad_headers in ({}, {"X-Moodle-Helper-Bridge-Binding": "stale"}):
            denied = client.patch("/api/settings", json={"semesterWeeks": 10}, headers=bad_headers)
            assert denied.status_code == 409
            contract_validator(contract["components"]["schemas"]["ProposedHttpError"], denied.json())
        invalid = client.patch("/api/settings", json={"semesterWeeks": 99}, headers=headers)
        assert invalid.status_code == 422
        contract_validator(contract["components"]["schemas"]["ProposedHttpError"], invalid.json())
        assert client.get("/api/snapshot", headers={"Host": "attacker.example"}).status_code == 400
        preflight = client.options("/api/settings", headers={"Origin": "https://attacker.example",
                                   "Access-Control-Request-Method": "PATCH",
                                   "Access-Control-Request-Headers": "X-Moodle-Helper-Bridge-Binding"})
        assert preflight.status_code == 400
        assert "access-control-allow-origin" not in preflight.headers
        assert client.get("/api/snapshot").json()["settings"]["semesterWeeks"] == initial_weeks
