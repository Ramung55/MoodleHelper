"""Explicit SYNTHETIC #18 loopback harness. Never imported by ordinary runtime.

Requires a caller-owned isolated SQLite path; no Moodle account/envelope access.
"""
import os
from pathlib import Path
from sqlalchemy import URL
from backend.collection import SyntheticCollectionContext
from backend.main import create_app
from backend.sqlite_store import SQLiteStore

path=Path(os.environ['MOODLE_HELPER_COLLECTION_TEST_DATABASE'])
if not path.is_absolute() or path.name!='synthetic-collection.sqlite3':
    raise ValueError('An isolated synthetic collection test database is required.')
store=SQLiteStore(URL.create('sqlite',database=str(path)))
app=create_app(store,collection_provider=SyntheticCollectionContext(store.namespace))
