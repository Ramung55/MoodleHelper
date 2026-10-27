"""Real file-backed durability, isolation, failure and migration regressions."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import URL, event, text

from backend import migrations
from backend.database_config import DatabaseConfig, DEFAULT_DATABASE, PROJECT_ROOT
from backend.identity import namespace_key
from backend.main import create_app
from backend.sample_data import build_sample_snapshot
from backend.services import BackendService
from backend.sqlite_store import SQLiteStore, StorageError
from backend.storage import InMemoryStore


def url(path):
    return URL.create("sqlite", database=str(path))


@pytest.fixture
def store(tmp_path):
    store = SQLiteStore(url(tmp_path / "state.sqlite3"))
    yield store
    store.close()


def reopened(store):
    return SQLiteStore(store.url, store.namespace)


def full_snapshot():
    data = build_sample_snapshot()
    data["assessments"][0].update(activityId="7001", availableFrom="2028-02-29T01:02:03.123456+05:00")
    data["assessments"][0]["sources"][0]["url"] = "https://moodle.sdu.edu.kz/mod/assign/view.php?id=7001"
    data["overlays"][0].update(titleOverride="Личный заголовок / %2F", dateOverride={"kind": "date", "date": "2028-02-29"},
                               overrideBase={"kind": "week", "week": 9}, hidden=True)
    data["materials"][0]["downloadedAt"] = "2028-02-29T00:00:00Z"
    data["documents"][0]["error"] = "retained diagnostic"
    data["candidates"][0]["reason"] = "verify source"
    data["sync"][0]["error"] = "retained partial error"
    data["settings"]["ai"] = {"enabled": True, "consentGiven": True}
    return data


def test_all_snapshot_fields_and_dates_survive_reopening_and_no_reseed(store):
    data = full_snapshot()
    assert {e["date"]["kind"] for a in data["assessments"] for e in a["sources"]} == {"exact", "date", "week", "unknown"}
    assert store.replace(data) == data
    store.close()
    again = reopened(store)
    assert again.read() == data
    # Deletion is a saved empty dataset, not an invitation to seed again.
    empty = BackendService(again).delete_local_data()
    again.close()
    final = reopened(store)
    assert final.read() == empty
    assert not final.read()["courses"]
    final.close()


def test_returned_input_and_callback_references_cannot_mutate_saved_values(store):
    data = full_snapshot()
    returned = store.replace(data)
    data["settings"]["semesterWeeks"] = 2
    returned["settings"]["semesterWeeks"] = 3
    retained = []
    store.mutate(lambda snapshot: retained.append(snapshot))
    retained[0]["settings"]["semesterWeeks"] = 4
    loaded = store.read()
    assert loaded["settings"]["semesterWeeks"] == 15
    loaded["settings"]["semesterWeeks"] = 5
    assert reopened(store).read()["settings"]["semesterWeeks"] == 15


def test_sequential_and_concurrent_instances_do_not_lose_mutations(store):
    other = reopened(store)
    store.mutate(lambda s: s["settings"].update(semesterWeeks=16))
    other.mutate(lambda s: s["settings"]["ai"].update(enabled=True))
    assert store.read()["settings"]["semesterWeeks"] == 16
    assert store.read()["settings"]["ai"]["enabled"] is True
    def add(i):
        repository = store if i % 2 else other
        repository.mutate(lambda s: s["settings"]["trackedCourseIds"].append(f"concurrent-{i}"))
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(add, range(12)))
    ids = store.read()["settings"]["trackedCourseIds"]
    assert all(ids.count(f"concurrent-{i}") == 1 for i in range(12))
    other.close()


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_stable_source_upsert_replays_evidence_without_touching_personal_data(kind, tmp_path):
    data = full_snapshot()
    repository = InMemoryStore(data) if kind == "memory" else SQLiteStore(url(tmp_path / "upsert.sqlite3"))
    repository.replace(data)
    original_overlay = deepcopy(data["overlays"])
    original_personal = deepcopy([a for a in data["assessments"] if a["personal"]])
    incoming = deepcopy(data["assessments"][0])
    incoming.update(title="Changed Moodle title", lastObservedAt="2028-03-01T00:00:00Z")
    incoming["submission"] = {"status": "submitted", "observedAt": "2028-03-01T00:00:00Z", "evidence": "Observed submission"}
    extra = {"source": "syllabus", "date": {"kind": "week", "week": 10}, "observedAt": "2028-03-01T00:00:00Z", "excerpt": "Separate syllabus"}
    incoming["sources"].extend([extra, deepcopy(extra)])
    updated = repository.upsert_source("assessments", incoming)
    replayed = repository.upsert_source("assessments", deepcopy(incoming))
    assert updated == replayed
    assert len([a for a in replayed["assessments"] if a["id"] == incoming["id"]]) == 1
    assert len(replayed["assessments"][0]["sources"]) == 2
    assert replayed["overlays"] == original_overlay
    assert [a for a in replayed["assessments"] if a["personal"]] == original_personal
    incoming["sources"][-1]["observedAt"] = "2028-03-02T00:00:00Z"
    assert len(repository.upsert_source("assessments", incoming)["assessments"][0]["sources"]) == 3
    new_source = deepcopy(incoming)
    new_source["id"] = "stable/new / Пример"
    repository.upsert_source("assessments", new_source)
    inserted = repository.upsert_source("assessments", new_source)
    assert len([a for a in inserted["assessments"] if a["id"] == new_source["id"]]) == 1
    assert inserted["overlays"] == original_overlay
    for collection in ("courses", "materials"):
        record = deepcopy(data[collection][0])
        record["name" if collection == "courses" else "title"] = "Updated source"
        repository.upsert_source(collection, record)
        repository.upsert_source(collection, record)
        assert len(repository.read()[collection]) == len(data[collection])
    if kind == "sqlite":
        assert reopened(repository).read() == repository.read()
        repository.close()


def test_source_upsert_rejects_personal_collision_and_invalid_domain_record_atomically(store):
    original = store.read()
    incoming = deepcopy(original["assessments"][0])
    incoming["id"] = "p1"
    with pytest.raises(ValueError, match="personal"):
        store.upsert_source("assessments", incoming)
    incoming["id"] = "new"
    incoming["sources"][0]["observedAt"] = "not an instant"
    with pytest.raises(ValueError, match="observedAt"):
        store.upsert_source("assessments", incoming)
    assert reopened(store).read() == original


@pytest.mark.parametrize("operation", ["replace", "mutate", "upsert"])
def test_validation_failure_never_changes_committed_state(store, operation):
    original = store.read()
    with pytest.raises((ValidationError, ValueError)):
        if operation == "replace":
            bad = deepcopy(original)
            bad["settings"]["semesterWeeks"] = 99
            store.replace(bad)
        elif operation == "mutate":
            store.mutate(lambda s: s["settings"].update(semesterWeeks=99))
        else:
            store.upsert_source("courses", {**original["courses"][0], "color": 99})
    assert reopened(store).read() == original


@pytest.mark.parametrize("operation", ["replace", "review", "import", "settings", "upsert"])
def test_failure_after_executed_update_rolls_back_complete_compound_operation(store, operation):
    original = store.read()
    def mid_write(connection, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE snapshots"):
            raise sqlite3.OperationalError("simulated injected mid-write failure")
    event.listen(store.engine, "after_cursor_execute", mid_write)
    try:
        with pytest.raises(StorageError):
            service = BackendService(store)
            if operation == "replace":
                changed = deepcopy(original)
                changed["alerts"] = []
                store.replace(changed)
            elif operation == "review":
                service.review("k2", {"kind": "confirm"})
            elif operation == "import":
                service.import_document("c-csc", "example.pdf")
            elif operation == "settings":
                service.update_settings({"semesterWeeks": 17})
            else:
                store.upsert_source("courses", {**original["courses"][0], "name": "Changed"})
    finally:
        event.remove(store.engine, "after_cursor_execute", mid_write)
    assert reopened(store).read() == original


def prior_database(path, data, version=1):
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)")
        connection.execute("INSERT INTO schema_version VALUES(1,?)", (version,))
        connection.execute("CREATE TABLE snapshots(namespace TEXT PRIMARY KEY,snapshot TEXT NOT NULL)")
        connection.execute("INSERT INTO snapshots VALUES(?,?)", (namespace_key(), json.dumps(data)))


def test_executable_prior_version_migration_preserves_every_field_and_overlay(tmp_path):
    path = tmp_path / "prior.sqlite3"
    original = full_snapshot()
    prior_database(path, original)
    store = SQLiteStore(url(path))
    assert store.read() == original
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT version FROM schema_version").fetchone() == (5,)
        assert connection.execute("SELECT revision FROM snapshots").fetchone() == (0,)
    BackendService(store).update_settings({"semesterWeeks": 17})
    assert reopened(store).read()["settings"]["semesterWeeks"] == 17
    store.close()


def test_failing_executed_ddl_migration_rolls_back_then_can_be_retried(tmp_path, monkeypatch):
    path = tmp_path / "prior.sqlite3"
    original = full_snapshot()
    prior_database(path, original)
    real_migration = migrations.MIGRATIONS[1]
    def failing(connection):
        real_migration(connection)
        connection.exec_driver_sql("UPDATE snapshots SET snapshot='invalid JSON'")
        raise RuntimeError("deliberate failure after DDL and data write")
    monkeypatch.setitem(migrations.MIGRATIONS, 1, failing)
    with pytest.raises(StorageError, match="rolled back"):
        SQLiteStore(url(path))
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT version FROM schema_version").fetchone() == (1,)
        assert json.loads(connection.execute("SELECT snapshot FROM snapshots").fetchone()[0]) == original
        assert "revision" not in [r[1] for r in connection.execute("PRAGMA table_info(snapshots)")]
    monkeypatch.setitem(migrations.MIGRATIONS, 1, real_migration)
    assert SQLiteStore(url(path)).read() == original


def test_future_schema_fails_closed_without_changing_file(tmp_path):
    path = tmp_path / "future.sqlite3"
    prior_database(path, full_snapshot(), version=999)
    before = path.read_bytes()
    with pytest.raises(StorageError, match="newer"):
        SQLiteStore(url(path))
    assert path.read_bytes() == before


def test_unversioned_existing_tables_are_preserved(tmp_path):
    path = tmp_path / "unknown.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE important(value TEXT)")
    before = path.read_bytes()
    with pytest.raises(StorageError, match="Unversioned"):
        SQLiteStore(url(path))
    assert path.read_bytes() == before


def test_namespace_isolation_for_reads_writes_source_reset_delete_and_restart(tmp_path):
    path = tmp_path / "shared.sqlite3"
    keys = [namespace_key("moodle", origin="https://moodle.sdu.edu.kz", profile_label=p, stable_user_id=u)
            for p, u in [("personal", "42"), ("personal", "43"), ("work", "42")]]
    repositories = [SQLiteStore(url(path), key) for key in keys]
    assert all(not s.read()["courses"] and not s.read()["settings"]["trackedCourseIds"] for s in repositories)
    for i, repository in enumerate(repositories):
        data = full_snapshot()
        data["settings"]["semesterWeeks"] = 10 + i
        data["overlays"][0]["titleOverride"] = f"personal {i}"
        repository.replace(data)
    second_before = repositories[1].read()
    third_before = repositories[2].read()
    first = repositories[0]
    first.upsert_source("courses", {**first.read()["courses"][0], "name": "namespace one only"})
    BackendService(first).update_overlay("a1", {"hidden": False})
    BackendService(first).update_settings({"semesterWeeks": 20})
    assert repositories[1].read() == second_before
    assert repositories[2].read() == third_before
    BackendService(first).reset_demo()
    assert repositories[1].read() == second_before
    assert repositories[2].read() == third_before
    BackendService(first).delete_local_data()
    for repository in repositories:
        repository.close()
    assert not SQLiteStore(url(path), keys[0]).read()["courses"]
    assert SQLiteStore(url(path), keys[1]).read() == second_before
    assert SQLiteStore(url(path), keys[2]).read() == third_before
    with sqlite3.connect(path) as connection:
        assert set(r[0] for r in connection.execute("SELECT namespace FROM snapshots")) == set(keys)


@pytest.mark.parametrize("error_kind", ["locked", "readonly", "full"])
def test_real_sqlite_errors_use_503_envelope_and_keep_prior_commit(store, error_kind):
    original = store.read()
    locker = None
    callback = None
    if error_kind == "locked":
        locker = sqlite3.connect(store.url.database)
        locker.execute("BEGIN EXCLUSIVE")
    elif error_kind == "readonly":
        def callback(dbapi, record):
            dbapi.execute("PRAGMA query_only=ON")
    else:
        def callback(dbapi, record):
            pages = dbapi.execute("PRAGMA page_count").fetchone()[0]
            dbapi.execute(f"PRAGMA max_page_count={pages}")
    if callback:
        event.listen(store.engine, "connect", callback)
    try:
        with TestClient(create_app(store)) as client:
            response = client.patch("/api/settings", json={"timezone": "x" * 100_000} if error_kind == "full" else {"semesterWeeks": 16})
        assert response.status_code == 503
        message = response.json()["message"]
        assert {"locked": "locked", "readonly": "read-only", "full": "full"}[error_kind] in message
        assert "retry" in message and "No save was confirmed" in message
        assert set(response.json()) == {"message"}
    finally:
        if locker:
            locker.rollback()
            locker.close()
        if callback:
            event.remove(store.engine, "connect", callback)
    assert reopened(store).read() == original


def test_startup_unavailable_path_and_unwritable_parent_are_actionable(tmp_path):
    directory = tmp_path / "a-directory"
    directory.mkdir()
    with pytest.raises(StorageError, match="location"):
        SQLiteStore(url(directory))
    parent_file = tmp_path / "not-a-directory"
    parent_file.write_text("keep this content")
    with pytest.raises(StorageError, match="permissions"):
        SQLiteStore(url(parent_file / "state.sqlite3"))
    assert parent_file.read_text() == "keep this content"


def test_startup_lock_is_actionable_and_recoverable(store):
    original = store.read()
    with sqlite3.connect(store.url.database) as connection:
        connection.execute("BEGIN EXCLUSIVE")
        with pytest.raises(StorageError, match="locked"):
            SQLiteStore(store.url, timeout=0.01)
        connection.rollback()
    assert reopened(store).read() == original


def test_readonly_migration_keeps_prior_schema_and_records(tmp_path, monkeypatch):
    from backend import sqlite_store
    path = tmp_path / "readonly-prior.sqlite3"
    original = full_snapshot()
    prior_database(path, original)
    real_create_engine = sqlite_store.create_engine
    def readonly_engine(*args, **kwargs):
        engine = real_create_engine(*args, **kwargs)
        event.listen(engine, "connect", lambda dbapi, _: dbapi.execute("PRAGMA query_only=ON"))
        return engine
    monkeypatch.setattr(sqlite_store, "create_engine", readonly_engine)
    with pytest.raises(StorageError, match="read-only"):
        SQLiteStore(url(path))
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT version FROM schema_version").fetchone() == (1,)
        assert json.loads(connection.execute("SELECT snapshot FROM snapshots").fetchone()[0]) == original
        assert "revision" not in [r[1] for r in connection.execute("PRAGMA table_info(snapshots)")]


def test_corrupt_saved_snapshot_fails_without_reseeding(store):
    with sqlite3.connect(store.url.database) as connection:
        connection.execute("UPDATE snapshots SET snapshot='invalid JSON' WHERE namespace=?", (store.namespace,))
    with pytest.raises(StorageError, match="backup"):
        reopened(store)
    with sqlite3.connect(store.url.database) as connection:
        assert connection.execute("SELECT snapshot FROM snapshots WHERE namespace=?", (store.namespace,)).fetchone() == ("invalid JSON",)


def test_config_predictable_default_relative_path_nested_parent_and_immutable_namespace(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    config = DatabaseConfig.from_environment({})
    assert Path(config.url.database) == DEFAULT_DATABASE
    relative = DatabaseConfig.from_environment({"MOODLE_HELPER_DATABASE_URL": "sqlite:///data/relative.sqlite3"})
    assert Path(relative.url.database) == PROJECT_ROOT / "data" / "relative.sqlite3"
    nested = SQLiteStore(url(tmp_path / "new" / "nested" / "state.sqlite3"))
    assert Path(nested.url.database).is_file()
    with pytest.raises(AttributeError):
        nested.namespace = namespace_key()
    nested.close()


@pytest.mark.parametrize("value", ["postgresql://user:secret@host/db", "sqlite://", "sqlite:///:memory:", "sqlite:///state.db?mode=ro", "not-a-url", "sqlite+pysqlite:///state.db"])
def test_invalid_database_configuration_never_falls_back_or_exposes_secret(value):
    with pytest.raises(ValueError, match="file-backed") as exc:
        DatabaseConfig.from_environment({"MOODLE_HELPER_DATABASE_URL": value})
    assert "secret" not in str(exc.value)


def test_trusted_lifespan_configuration_and_request_identity_cannot_switch_dataset(tmp_path, monkeypatch):
    monkeypatch.setenv("MOODLE_HELPER_DATABASE_URL", str(url(tmp_path / "startup.sqlite3")))
    monkeypatch.setenv("MOODLE_HELPER_DATASET", "moodle")
    monkeypatch.setenv("MOODLE_HELPER_MOODLE_ORIGIN", "https://moodle.sdu.edu.kz")
    monkeypatch.setenv("MOODLE_HELPER_PROFILE_LABEL", "personal")
    monkeypatch.setenv("MOODLE_HELPER_STABLE_USER_ID", "42")
    with TestClient(create_app()) as client:
        namespace = client.app.state.service.store.namespace
        response = client.patch("/api/settings", headers={"X-Namespace": namespace_key()}, json={"semesterWeeks": 17, "namespace": namespace_key()})
        assert response.status_code == 200
        assert response.json()["courses"] == []
        monkeypatch.setenv("MOODLE_HELPER_STABLE_USER_ID", "43")
        assert client.app.state.service.store.namespace == namespace
        assert client.get("/api/snapshot").json()["settings"]["semesterWeeks"] == 17
    with TestClient(create_app()) as second:
        assert second.get("/api/snapshot").json()["settings"]["semesterWeeks"] == 15
    monkeypatch.delenv("MOODLE_HELPER_STABLE_USER_ID")
    with pytest.raises(ValueError, match="stable_user_id"):
        with TestClient(create_app()):
            pass


