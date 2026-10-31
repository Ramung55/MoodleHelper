"""SQLAlchemy-backed, namespace-scoped complete Snapshot transactions."""
import json
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool
from pydantic import ValidationError

from backend.database_config import file_database_url
from backend.identity import namespace_key, validate_namespace
from backend.migrations import upgrade, MigrationError
from backend.sample_data import build_sample_snapshot
from backend.storage import InMemoryStore, SourceUpserts, expected_epoch, check_epoch


class StorageError(RuntimeError):
    """Safe actionable message suitable for the existing HTTP error envelope."""


def storage_failure(error: Exception) -> StorageError:
    # SQLAlchemy's outer exception includes statement parameters (Snapshot
    # content). Classify only the driver's message, never user text or secrets.
    detail = str(getattr(error, "orig", error)).lower()
    if "locked" in detail or "busy" in detail:
        reason = "Database is locked. Stop other writers and retry."
    elif "readonly" in detail or "read-only" in detail or "permission" in detail:
        reason = "Database is read-only or inaccessible. Check file and parent-directory write permissions and retry."
    elif "full" in detail or "space" in detail:
        reason = "Database save failed because storage is full. Free disk space and retry."
    else:
        reason = "Database is unavailable. Check the configured database location and directory permissions, then retry."
    return StorageError(reason + " No save was confirmed. Stop the backend before copying the database for backup or recovery; never delete it to retry.")


def initial_snapshot(namespace: str) -> dict:
    snapshot = build_sample_snapshot()
    if namespace != namespace_key():
        for key in snapshot:
            if key != "settings":
                snapshot[key] = []
        snapshot["settings"]["trackedCourseIds"] = []
    return snapshot


class SQLiteStore(SourceUpserts):
    def __init__(self, database_url=None, namespace: str = namespace_key(), *, timeout: float = 1.0):
        validate_namespace(namespace)
        self._namespace = namespace
        self.url = file_database_url(database_url)
        self.engine = create_engine(self.url, poolclass=NullPool,
                                    connect_args={"check_same_thread": False, "timeout": timeout})
        try:
            Path(self.url.database).parent.mkdir(parents=True, exist_ok=True)
            with self._transaction() as connection:
                try:
                    upgrade(connection)
                except MigrationError:
                    raise
                except (SQLAlchemyError, sqlite3.Error, OSError):
                    raise
                except Exception as exc:
                    raise MigrationError("Database migration failed and was rolled back. Stop the backend, keep a backup of the unchanged prior database, and retry with the previous application or select a new database location.") from exc
                saved = connection.execute(text("SELECT snapshot FROM snapshots WHERE namespace=:namespace"), self._key).scalar_one_or_none()
                if saved is None:
                    data = self._validated(initial_snapshot(namespace))
                    connection.execute(text("INSERT INTO snapshots(namespace,snapshot,revision) VALUES(:namespace,:snapshot,0)"),
                                       {**self._key, "snapshot": json.dumps(data, ensure_ascii=False, allow_nan=False)})
                else:
                    self._decode(saved)
                connection.execute(text("INSERT OR IGNORE INTO local_datasets(namespace,dataset_id) VALUES(:namespace,:dataset_id)"),
                                   {**self._key, "dataset_id": str(uuid4())})
        except MigrationError as exc:
            self.close()
            raise StorageError(str(exc)) from exc
        except (OSError, SQLAlchemyError, sqlite3.Error) as exc:
            self.close()
            raise storage_failure(exc) from exc

    @property
    def namespace(self):
        return self._namespace

    @property
    def dataset_id(self):
        try:
            with self.engine.connect() as connection:
                return connection.execute(text("SELECT dataset_id FROM local_datasets WHERE namespace=:namespace"), self._key).scalar_one()
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc

    @property
    def _key(self):
        return {"namespace": self.namespace}

    _validated = staticmethod(InMemoryStore._validated)

    def _decode(self, value: str) -> dict:
        try:
            return self._validated(json.loads(value))
        except (ValueError, ValidationError) as exc:
            raise StorageError("Stored Snapshot is invalid. Stop the backend and restore a known backup or select a new database location; existing data was preserved.") from exc

    @contextmanager
    def _transaction(self):
        # Explicit BEGIN makes DDL transactional even with sqlite3's legacy
        # transaction mode, and prevents read/modify/write lost updates.
        with self.engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            try:
                if expected_epoch.get() is not None:
                    # #56: transaction-local fence; erase/restore hold the same write lock.
                    check_epoch(connection.execute(text("SELECT COALESCE((SELECT epoch FROM data_lifecycle WHERE namespace=:namespace),0)"), self._key).scalar_one())
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def read(self) -> dict:
        try:
            with self.engine.connect() as connection:
                saved = connection.execute(text("SELECT snapshot FROM snapshots WHERE namespace=:namespace"), self._key).scalar_one()
                return self._decode(saved)
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc

    def replace(self, snapshot: dict) -> dict:
        validated = self._validated(snapshot)
        return self._write(lambda _: validated)

    def mutate(self, operation: Callable[[dict], None]) -> dict:
        def change(snapshot):
            operation(snapshot)
            if 'reconciliation' in snapshot:
                from backend.reconciliation import project_sources
                project_sources(snapshot, self.namespace)
            return self._validated(snapshot)
        return self._write(change)

    def _write(self, operation):
        try:
            with self._transaction() as connection:
                saved = connection.execute(text("SELECT snapshot FROM snapshots WHERE namespace=:namespace"), self._key).scalar_one()
                snapshot = operation(self._decode(saved))
                connection.execute(text("UPDATE snapshots SET snapshot=:snapshot,revision=revision+1 WHERE namespace=:namespace"),
                                   {**self._key, "snapshot": json.dumps(snapshot, ensure_ascii=False, allow_nan=False)})
            # Decode a separate object so callbacks and caller-owned values can
            # never retain a reference to committed state.
            return self._validated(snapshot)
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc

    def close(self):
        self.engine.dispose()
