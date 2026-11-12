"""Trusted startup-only database and identity selection."""
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Mapping

from sqlalchemy.engine import make_url, URL
from sqlalchemy.exc import ArgumentError

from backend.identity import namespace_from_environment

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = PROJECT_ROOT / "data" / "moodle-helper.sqlite3"


@dataclass(frozen=True)
class DatabaseConfig:
    url: URL
    namespace: str

    @classmethod
    def from_environment(cls, env: Mapping[str, str]):
        namespace = namespace_from_environment(env)
        raw = env.get("MOODLE_HELPER_DATABASE_URL")
        return cls(database_url(raw), namespace)


def file_database_url(value: str | URL | None) -> URL:
    try:
        url = make_url(value) if value is not None else URL.create("sqlite", database=str(DEFAULT_DATABASE))
        if (url.drivername != "sqlite" or url.host or url.username or url.password
                or not url.database or url.database == ":memory:" or url.query):
            raise ValueError
        path = Path(url.database)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        return URL.create("sqlite", database=str(path.resolve()))
    except (ValueError, TypeError, ArgumentError) as exc:
        raise ValueError("MOODLE_HELPER_DATABASE_URL must be a file-backed sqlite:/// URL without credentials or query options; no memory fallback.") from exc


def database_url(value: str | URL | None) -> URL:
    try:
        url = make_url(value) if value is not None else None
        if url is not None and url.drivername in ("postgresql", "postgres", "postgresql+psycopg"):
            if not url.host or not url.database:
                raise ValueError("PostgreSQL URL must include a host and database.")
            return url.set(drivername="postgresql+psycopg")
        return file_database_url(value)
    except ArgumentError as exc:
        raise ValueError("MOODLE_HELPER_DATABASE_URL must be a file-backed SQLite URL or a PostgreSQL URL.") from exc
