"""TEST ONLY loopback host for the #20 live scan checks. Never imported by backend.main.

The trusted real (non-demo) namespace on an isolated, caller-owned file SQLite
database, with no injected collection provider: the same verified context the
configured backend uses. An optional clock file controls queue lease time so
tests can expire a crashed worker's claim. No Moodle request is made here.
"""
import os
from pathlib import Path
from sqlalchemy import URL
from backend.identity import namespace_key
from backend.main import create_app
from backend.sqlite_store import SQLiteStore

path = Path(os.environ['LIVE_SCAN_TEST_DATABASE'])
if not path.is_absolute() or path.name != 'live-scan.sqlite3':
    raise ValueError('An isolated live scan test database is required.')
clock = os.environ.get('LIVE_SCAN_TEST_CLOCK')
namespace = namespace_key('moodle', origin='https://moodle.sdu.edu.kz', profile_label='live-scan-test',
                          stable_user_id='987650')  # #93: the invented id of observed/m-cfg-user-id.txt
store = SQLiteStore(URL.create('sqlite', database=str(path)), namespace)
app = create_app(store, **({'queue_clock': lambda: int(Path(clock).read_text())} if clock else {}))
