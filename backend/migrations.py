"""Small transactional SQLite migrations; caller owns BEGIN/COMMIT/ROLLBACK."""
from sqlalchemy import Connection

SCHEMA_VERSION = 5


class MigrationError(RuntimeError):
    pass


def version_one_to_two(connection: Connection) -> None:
    # The prior format already stored all wire fields. Revision adds an internal
    # write counter without rewriting JSON, IDs, source evidence or overlays.
    connection.exec_driver_sql("ALTER TABLE snapshots ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")


def version_two_to_three(connection: Connection) -> None:
    connection.exec_driver_sql("""CREATE TABLE queue_runs (
        namespace TEXT NOT NULL, id TEXT NOT NULL, idem TEXT NOT NULL,
        course_ids TEXT NOT NULL, created INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,id), UNIQUE(namespace,idem))""")
    connection.exec_driver_sql("""CREATE TABLE queue_jobs (
        namespace TEXT NOT NULL, id TEXT NOT NULL, course_id TEXT NOT NULL,
        created INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
        token TEXT, expires INTEGER, error_code TEXT,
        PRIMARY KEY(namespace,id))""")
    connection.exec_driver_sql("CREATE UNIQUE INDEX queue_active_course ON queue_jobs(namespace,course_id) WHERE state IN ('pending','running')")
    connection.exec_driver_sql("CREATE INDEX queue_claim_order ON queue_jobs(namespace,state,created,id)")
    connection.exec_driver_sql("""CREATE TABLE queue_links (
        namespace TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(namespace,run_id,job_id),
        FOREIGN KEY(namespace,run_id) REFERENCES queue_runs(namespace,id),
        FOREIGN KEY(namespace,job_id) REFERENCES queue_jobs(namespace,id))""")
    connection.exec_driver_sql("CREATE INDEX queue_job_links ON queue_links(namespace,job_id,run_id)")
    connection.exec_driver_sql("""CREATE TABLE queue_results (
        namespace TEXT NOT NULL, job_id TEXT NOT NULL, id TEXT NOT NULL, summary TEXT NOT NULL,
        PRIMARY KEY(namespace,job_id), UNIQUE(namespace,id),
        FOREIGN KEY(namespace,job_id) REFERENCES queue_jobs(namespace,id))""")


def version_three_to_four(connection: Connection) -> None:
    connection.exec_driver_sql("""CREATE TABLE scan_request_gate (
        id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT,
        last_start INTEGER NOT NULL, not_before INTEGER NOT NULL)""")
    connection.exec_driver_sql("INSERT INTO scan_request_gate(id,owner,last_start,not_before) VALUES(1,NULL,-1000,0)")


def version_four_to_five(connection: Connection) -> None:
    connection.exec_driver_sql("ALTER TABLE queue_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'mock' CHECK(kind IN ('mock','scan'))")
    connection.exec_driver_sql("ALTER TABLE queue_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'mock' CHECK(kind IN ('mock','scan'))")
    connection.exec_driver_sql("""CREATE TABLE scan_coverage (
        namespace TEXT NOT NULL, job_id TEXT NOT NULL, reasons TEXT NOT NULL,
        PRIMARY KEY(namespace,job_id), FOREIGN KEY(namespace,job_id) REFERENCES queue_jobs(namespace,id))""")
    connection.exec_driver_sql("""CREATE TABLE scan_pages (
        namespace TEXT NOT NULL, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        page TEXT NOT NULL, PRIMARY KEY(namespace,job_id,ordinal),
        FOREIGN KEY(namespace,job_id) REFERENCES queue_jobs(namespace,id))""")


MIGRATIONS = {1: version_one_to_two, 2: version_two_to_three, 3: version_three_to_four, 4: version_four_to_five}


def upgrade(connection: Connection) -> None:
    tables = set(connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").scalars())
    if "schema_version" not in tables:
        if tables:
            raise MigrationError("Unversioned database: stop and restore a known backup or select a new database location; existing tables were preserved.")
        connection.exec_driver_sql("CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)")
        connection.exec_driver_sql("CREATE TABLE snapshots (namespace TEXT PRIMARY KEY, snapshot TEXT NOT NULL)")
        connection.exec_driver_sql("INSERT INTO schema_version(id,version) VALUES(1,1)")
    rows = connection.exec_driver_sql("SELECT id,version FROM schema_version").all()
    if len(rows) != 1 or rows[0][0] != 1:
        raise MigrationError("Invalid schema version metadata. Stop and restore a known backup; no reset was performed.")
    version = rows[0][1]
    if not isinstance(version, int):
        raise MigrationError("Invalid schema version metadata. Stop and restore a known backup; no reset was performed.")
    if version > SCHEMA_VERSION:
        raise MigrationError("Database schema is newer than this application. Use the matching newer application or restore a compatible backup; no downgrade was performed.")
    if version < 1:
        raise MigrationError("Unsupported prior schema. Restore a supported backup; no reset was performed.")
    while version < SCHEMA_VERSION:
        MIGRATIONS[version](connection)
        version += 1
        connection.exec_driver_sql("UPDATE schema_version SET version=? WHERE id=1", (version,))

