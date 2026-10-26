"""Small transactional SQLite migrations; caller owns BEGIN/COMMIT/ROLLBACK."""
from sqlalchemy import Connection

SCHEMA_VERSION = 2


class MigrationError(RuntimeError):
    pass


def version_one_to_two(connection: Connection) -> None:
    # The prior format already stored all wire fields. Revision adds an internal
    # write counter without rewriting JSON, IDs, source evidence or overlays.
    connection.exec_driver_sql("ALTER TABLE snapshots ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")


MIGRATIONS = {1: version_one_to_two}


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
    if version > SCHEMA_VERSION:
        raise MigrationError("Database schema is newer than this application. Use the matching newer application or restore a compatible backup; no downgrade was performed.")
    if version < 1:
        raise MigrationError("Unsupported prior schema. Restore a supported backup; no reset was performed.")
    while version < SCHEMA_VERSION:
        MIGRATIONS[version](connection)
        version += 1
        connection.exec_driver_sql("UPDATE schema_version SET version=? WHERE id=1", (version,))
