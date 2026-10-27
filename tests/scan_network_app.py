"""Synthetic-only HTTP harness with a controlled queue lease clock."""
import os
from pathlib import Path
from sqlalchemy import URL
from backend.collection import SyntheticCollectionContext
from backend.main import create_app
from backend.sqlite_store import SQLiteStore

path = Path(os.environ['SCAN_TEST_DATABASE'])
clock = Path(os.environ['SCAN_TEST_CLOCK'])
if not path.is_absolute() or path.name != 'synthetic-scan.sqlite3':
    raise ValueError('An isolated synthetic scan database is required.')
store = SQLiteStore(URL.create('sqlite', database=str(path)))
app = create_app(store, collection_provider=SyntheticCollectionContext(store.namespace), queue_clock=lambda:int(clock.read_text()))
