"""Integration checks; set MOODLE_HELPER_TEST_POSTGRES_URL to a disposable database."""
import os
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from backend.sqlite_store import SQLiteStore
from backend.scan_gate import ScanGate
try:
    from backend.sync_queue import QueueService
except ModuleNotFoundError as exc:
    if exc.name != "backend.sync_queue":
        raise
    from backend.queue import QueueService

URL = os.environ.get("MOODLE_HELPER_TEST_POSTGRES_URL")
requires_postgres = pytest.mark.skipif(not URL, reason="PostgreSQL test database not configured")


@requires_postgres
def test_postgres_persistence_queue_and_locking():
    a, b = SQLiteStore(URL), SQLiteStore(URL)
    try:
        assert a.dataset_id == b.dataset_id
        assert a.read() == b.read()
        course = a.read()["courses"][0]["id"]
        queue = QueueService(a)
        from uuid import uuid4
        run = queue.start(uuid4().hex, [course])
        assert run["courseIds"] == [course]
        queue.current()
        gates = [ScanGate(a), ScanGate(b)]
        with a._transaction() as connection:
            last = connection.exec_driver_sql("SELECT last_start, not_before FROM scan_request_gate WHERE id=1").one()
        now = max(10000, last.last_start + 1000, last.not_before)
        with ThreadPoolExecutor(max_workers=2) as pool:
            tokens = list(pool.map(lambda gate: gate.acquire(now), gates))
        assert sum(token is not None for token in tokens) == 1
        assert gates[0].release_after_termination(next(token for token in tokens if token))
        a.mutate(lambda snapshot: None)
        assert a.read() == b.read()
    finally:
        a.close()
        b.close()

@requires_postgres
def test_postgres_backup_restore():
    from fastapi.testclient import TestClient
    from backend.main import create_app
    from uuid import uuid4
    from test_backup_restore import backup_of, headers, incoming, request_body
    store = SQLiteStore(URL)
    try:
        with TestClient(create_app(store), base_url="http://localhost") as client:
            data = incoming(client)
            body = request_body(client, backup_of(client, data), key=uuid4().hex)
            response = client.post("/api/backups/restore", json=body, headers=headers(client))
            assert response.status_code == 200, response.text
            assert client.get("/api/snapshot").json()["settings"]["semesterWeeks"] == 9
    finally:
        store.close()


def test_postgres_url_configuration():
    from backend.database_config import DatabaseConfig
    config = DatabaseConfig.from_environment({"MOODLE_HELPER_DATABASE_URL": "postgresql://user:secret@host/db"})
    assert config.url.drivername == "postgresql+psycopg"
    assert config.url.host == "host"
    assert "secret" not in str(config.url)


@pytest.fixture
def isolated_postgres_schema():
    """Each integration test owns only its randomly named temporary schema."""
    if not URL:
        pytest.skip("PostgreSQL test database not configured")
    admin_url = make_url(URL).set(drivername="postgresql+psycopg")
    admin = create_engine(admin_url)
    name = "moodlehelper_test_" + uuid4().hex
    with admin.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{name}"')
    scoped_url = admin_url.update_query_dict({"options": f"-csearch_path={name}"})
    try:
        yield scoped_url
    finally:
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{name}" CASCADE')
        admin.dispose()


def test_postgres_prior_schema_migration_rolls_back_then_preserves_data(isolated_postgres_schema, monkeypatch):
    from backend import migrations
    from backend.identity import namespace_key
    from backend.sqlite_store import StorageError, initial_snapshot

    url = isolated_postgres_schema
    engine = create_engine(url)
    namespace = namespace_key()
    saved = json.dumps(initial_snapshot(namespace), ensure_ascii=False)
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)")
        connection.exec_driver_sql("CREATE TABLE snapshots (namespace TEXT PRIMARY KEY, snapshot TEXT NOT NULL)")
        connection.exec_driver_sql("INSERT INTO schema_version VALUES (1, 1)")
        connection.execute(text("INSERT INTO snapshots VALUES (:namespace, :snapshot)"),
                           {"namespace": namespace, "snapshot": saved})

    original = migrations.MIGRATIONS[2]

    def fail_after_ddl(connection):
        original(connection)
        raise RuntimeError("injected migration failure")

    with monkeypatch.context() as patch:
        patch.setitem(migrations.MIGRATIONS, 2, fail_after_ddl)
        with pytest.raises(StorageError):
            SQLiteStore(url)
    with engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT version FROM schema_version").scalar_one() == 1
        assert connection.execute(text("SELECT snapshot FROM snapshots WHERE namespace=:namespace"),
                                  {"namespace": namespace}).scalar_one() == saved
        assert connection.exec_driver_sql("SELECT to_regclass('queue_runs')").scalar_one() is None
        columns = connection.exec_driver_sql("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='snapshots'").scalars().all()
        assert "revision" not in columns

    store = SQLiteStore(url)
    try:
        assert store.read() == json.loads(saved)
        with engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT version FROM schema_version").scalar_one() == migrations.SCHEMA_VERSION
    finally:
        store.close()
        engine.dispose()


def test_postgres_api_crud_and_store_restart(isolated_postgres_schema):
    from fastapi.testclient import TestClient
    from backend.main import create_app

    url = isolated_postgres_schema
    store = SQLiteStore(url)
    try:
        with TestClient(create_app(store), base_url="http://localhost") as client:
            binding = client.get("/api/bridge-context").json()["binding"]
            headers = {"X-Moodle-Helper-Bridge-Binding": binding}
            course = client.get("/api/snapshot").json()["courses"][0]["id"]
            created = client.post("/api/personal-events", headers=headers, json={
                "courseId": course, "title": "Database verification", "type": "other", "date": {"kind": "unknown"}
            })
            assert created.status_code == 200, created.text
            event = next(row for row in created.json()["assessments"] if row["title"] == "Database verification")
            event_id = event["id"]
            updated = client.patch(f"/api/assessments/{event_id}/overlay", headers=headers, json={"completed": True})
            assert updated.status_code == 200, updated.text
            assert any(row["assessmentId"] == event_id and row["completed"] for row in updated.json()["overlays"])
        store.close()
        store = SQLiteStore(url)
        with TestClient(create_app(store), base_url="http://localhost") as client:
            snapshot = client.get("/api/snapshot").json()
            assert any(row["id"] == event_id for row in snapshot["assessments"])
            assert any(row["assessmentId"] == event_id and row["completed"] for row in snapshot["overlays"])
            binding = client.get("/api/bridge-context").json()["binding"]
            removed = client.delete(f"/api/personal-events/{event_id}", headers={"X-Moodle-Helper-Bridge-Binding": binding})
            assert removed.status_code == 200, removed.text
            assert all(row["id"] != event_id for row in removed.json()["assessments"])
    finally:
        store.close()
