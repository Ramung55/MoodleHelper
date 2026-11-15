"""#129: read-only GETs use a SQLite read transaction in WAL mode, so a held writer
lock (another process's BEGIN IMMEDIATE) neither delays nor fails them, and a held
reader never delays the scan writes. File databases only; no Moodle request."""
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import URL

from backend.sqlite_store import SQLiteStore, StorageError
from backend.sync_queue import QueueInvalid, QueueService
from tests.test_live_scan import Live, completed, full_scan, seeded

INVALID = 'Stored Snapshot is invalid.'
WALL_CLOCK = {'serverTime', 'nextWakeAt'}  # #151: the plan's only fields that vary between two identical reads


@pytest.fixture
def live(tmp_path):
    now = [datetime(2026, 11, 15, 10, 59, 59, 600000, tzinfo=timezone.utc)]  # 0.4 s before a second boundary
    harness = Live(seeded(tmp_path), [1000], reminder_clock=lambda: now[0])
    harness.now = now
    yield harness
    harness.close()


def comparable(path, body):
    return {k: v for k, v in body.items() if k not in WALL_CLOCK} if path == '/api/reminders/plan' else body


def prepared(live):
    """A scan run with one finished job, a mock run and a transfer row, all committed."""
    assert live.post('/api/sync').status_code == 200
    claim = live.post('/api/scan/claim', {}).json()['claim']
    assert live.post('/api/scan/finish', completed(claim, full_scan(claim['sourceCourseId'], ['990201']))).status_code == 200
    mock = QueueService(live.store).start('mock-129', ['c-phy'])
    with live.store.engine.connect() as c:
        scan_run = c.exec_driver_sql("SELECT id FROM queue_runs WHERE kind='scan'").scalar_one()
    service = live.client.app.state.material_downloads
    with service.rows.transaction(live.store) as rows:
        rows.put({'namespace': live.store.namespace, 'datasetId': live.store.dataset_id, 'idempotencyKey': 'k-129',
                  'transferId': 't-129', 'attemptId': 'a-129', 'generation': 0, 'materialId': 'm1', 'state': 'queued',
                  'cancelRequested': False, 'descriptorIssued': False, 'createdAt': '2028-03-05T10:00:00.000Z',
                  'updatedAt': '2028-03-05T10:00:00.000Z'})
    return ['/api/queue/current', '/api/snapshot', f"/api/queue/runs/{mock['id']}", f'/api/scan/runs/{scan_run}',
            f"/api/scan/jobs/{claim['job']['id']}/pages", '/api/reminders/plan', '/api/material-downloads',
            '/api/material-downloads/t-129']


def test_reads_return_last_commit_at_once_while_another_writer_holds_the_lock(live):
    paths = prepared(live)
    headers = live.h()
    before = {p: live.client.get(p, headers=headers).json() for p in paths}
    live.now[0] += timedelta(seconds=1.5)  # crosses a second boundary between the pre-lock and locked reads
    writer = sqlite3.connect(live.store.url.database, isolation_level=None)
    try:
        writer.execute('BEGIN IMMEDIATE')
        writer.execute('UPDATE queue_runs SET cancelled=1')  # uncommitted: never visible
        held = time.perf_counter()
        for path in paths:
            started = time.perf_counter()
            response = live.client.get(path, headers=headers)
            assert response.status_code == 200, (path, response.json())
            assert time.perf_counter() - started < 0.2, path
            assert comparable(path, response.json()) == comparable(path, before[path]), path
        time.sleep(max(0, 2 - (time.perf_counter() - held)))  # the lock outlives the 1 s busy timeout
        assert live.client.get('/api/queue/current').status_code == 200
    finally:
        writer.rollback()
        writer.close()


def test_the_plan_comparison_ignores_only_the_wall_clock(live):
    path = '/api/reminders/plan'
    first = live.client.get(path, headers=live.h()).json()
    live.now[0] += timedelta(seconds=1.5)
    second = live.client.get(path, headers=live.h()).json()
    assert first['serverTime'] != second['serverTime'] and comparable(path, first) == comparable(path, second)
    for key, changed in [('generation', 'other'), ('items', first['items'] + [{'id': 'extra'}])]:
        assert comparable(path, {**second, key: changed}) != comparable(path, first), key


def test_a_held_reader_never_delays_scan_writes(live):
    assert live.post('/api/sync').status_code == 200
    with live.store._read_transaction() as reader:
        reader.exec_driver_sql('SELECT count(*) FROM queue_jobs').scalar_one()  # pins a read snapshot
        for path, body in [('/api/scan/claim', {}), ('/api/scan/gate/acquire', {'nowMs': 10_000, 'instance': 'a'})]:
            started = time.perf_counter()
            response = live.post(path, body)
            assert response.status_code == 200 and time.perf_counter() - started < 1, path
            if path == '/api/scan/claim':
                claim = response.json()['claim']
        started = time.perf_counter()
        response = live.post('/api/scan/finish', completed(claim, full_scan(claim['sourceCourseId'], [])))
        assert response.status_code == 200 and time.perf_counter() - started < 1
    assert live.client.get(f"/api/scan/jobs/{claim['job']['id']}/pages").status_code == 200


def mode(path):
    with closing(sqlite3.connect(path)) as db:
        return db.execute('PRAGMA journal_mode').fetchone()[0]


def test_new_and_existing_rollback_files_switch_to_wal_with_data_unchanged(tmp_path):
    path = tmp_path / 'wal.sqlite3'
    url = URL.create('sqlite', database=str(path))
    store = SQLiteStore(url)
    assert mode(path) == 'wal'
    store.mutate(lambda s: s['settings'].update(semesterWeeks=14))
    store.close()
    with closing(sqlite3.connect(path)) as db:
        assert db.execute('PRAGMA journal_mode=DELETE').fetchone()[0] == 'delete'
    with closing(sqlite3.connect(path)) as db:
        before = db.execute('SELECT snapshot FROM snapshots').fetchall()
    store = SQLiteStore(url)
    assert mode(path) == 'wal' and store.read()['settings']['semesterWeeks'] == 14
    store.close()
    with closing(sqlite3.connect(path)) as db:
        assert db.execute('SELECT snapshot FROM snapshots').fetchall() == before
    SQLiteStore(url).close()
    assert mode(path) == 'wal'


def test_current_reads_only_tracked_ids_and_keeps_its_errors(tmp_path):
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'current.sqlite3')))
    queue = QueueService(store)
    assert queue.current()['courseIds'] == sorted(store.read()['settings']['trackedCourseIds'])
    with store._transaction() as c:
        c.exec_driver_sql("UPDATE snapshots SET snapshot=json_set(snapshot,'$.settings.trackedCourseIds',json('[]'))")
    assert queue.current() == {'courseIds': []}
    many = '[' + ','.join(f'"c{i}"' for i in range(101)) + ']'
    with store._transaction() as c:
        c.exec_driver_sql(f"UPDATE snapshots SET snapshot=json_set(snapshot,'$.settings.trackedCourseIds',json('{many}'))")
    with pytest.raises(QueueInvalid):
        queue.current()
    for corrupt in ['{not json', '{"settings":{}}', '{"settings":{"trackedCourseIds":[1]}}']:
        with store._transaction() as c:
            c.exec_driver_sql('UPDATE snapshots SET snapshot=?', (corrupt,))
        with pytest.raises(StorageError, match=INVALID):
            queue.current()
    store.close()
