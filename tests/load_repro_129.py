"""TEST ONLY #129 synthetic load reproduction. Not collected by pytest; run by hand:

    uv run python -m tests.load_repro_129 [--port 8129] [--pollers 3] [--rounds 3]

Seeds a fresh file SQLite database in a new temp directory (outside the repo) with
8 fictional mapped courses, starts tests/live_scan_network_app.py under uvicorn on
127.0.0.1, bloats the Snapshot past 800 KB through real scan finishes, then runs
Sync all scans (claim, gate acquire, renew, finish) without and with dashboard-style
pollers (/api/queue/current, /api/snapshot, /api/connection every 500 ms).
Prints 503 counts and p50/max latency per scan call. Never opens Moodle.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from sqlalchemy import URL

from backend.identity import namespace_key
from backend.sample_data import build_sample_snapshot
from backend.sqlite_store import SQLiteStore
from tests.test_live_scan import ACCOUNT, completed, course_page, discovery, quiz_page, undiscovered, unavailable, ORIGIN

COURSES = [(f'c-l{i}', str(9100 + i)) for i in range(8)]


def seed(path):
    namespace = namespace_key('moodle', origin=ORIGIN, profile_label='live-scan-test', stable_user_id=ACCOUNT)
    store = SQLiteStore(URL.create('sqlite', database=str(path)), namespace)
    snapshot = build_sample_snapshot()
    for n, (course, source) in enumerate(COURSES):
        snapshot['courses'].append({'id': course, 'code': f'LDT {n}', 'name': f'Fictional load course {n}', 'color': 1,
                                    'current': True, 'discovery': discovery(source)})
    snapshot['settings']['trackedCourseIds'] = [c for c, _ in COURSES]
    store.replace(snapshot)
    store.close()


class Client:
    def __init__(self, base):
        self.base, self.binding = base, None

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header('Content-Type', 'application/json')
        if self.binding:
            request.add_header('X-Moodle-Helper-Bridge-Binding', self.binding)
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, payload = error.code, error.read()
        return status, (time.perf_counter() - started) * 1000, json.loads(payload or b'null')


def pages(source, count, offset):
    return [course_page(source), *[quiz_page(str(int(source) * 1000 + offset + i), source) for i in range(count)],
            unavailable('assignment', f'{ORIGIN}/mod/assign/view.php?id=990101'),
            undiscovered('calendar'), undiscovered('material'), undiscovered('submission')]


def scan(client, quizzes, stats, now):
    status, _, body = client.call('POST', '/api/sync')
    assert status == 200, (status, body)
    while True:
        status, ms, body = client.call('POST', '/api/scan/claim', {})
        stats['claim'].append((status, ms))
        if status != 200:
            continue
        if 'claim' not in body:
            if not body['unfinished']:
                return
            continue
        claim = body['claim']
        now[0] += 100_000
        status, ms, gate = client.call('POST', '/api/scan/gate/acquire', {'nowMs': now[0], 'instance': 'load'})
        stats['gate'].append((status, ms))
        if status == 200 and gate.get('state') == 'reserved':
            client.call('POST', '/api/scan/gate/release', {'token': gate['token'], 'notBeforeMs': 0})
        token = {k: claim[k] for k in ('generation', 'token')} | {'jobId': claim['job']['id']}
        status, ms, _ = client.call('POST', '/api/scan/renew', token)
        stats['renew'].append((status, ms))
        status, ms, body = client.call('POST', '/api/scan/finish', completed(claim, pages(claim['sourceCourseId'], quizzes, 0)))
        stats['finish'].append((status, ms))
        assert status in (200, 503), (status, body)


def poll(base, stop, counts):
    client = Client(base)
    while not stop.is_set():
        for path in ('/api/queue/current', '/api/snapshot', '/api/connection'):
            status, ms, _ = client.call('GET', path)
            counts.append((path, status, ms))
        stop.wait(0.5)


def report(label, stats):
    print(label)
    for name, samples in stats.items():
        ok = [ms for status, ms in samples if status != 503]
        print(f'  {name:7} n={len(samples):3} 503={sum(s == 503 for s, _ in samples):3} '
              f'p50={statistics.median(ok) if ok else 0:7.1f} ms max={max(ok) if ok else 0:7.1f} ms')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8129)
    parser.add_argument('--pollers', type=int, default=3)
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--quizzes', type=int, default=10)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix='moodlehelper-129-'))
    database = root / 'live-scan.sqlite3'
    seed(database)
    clock = root / 'clock.txt'
    clock.write_text('1000')  # fixed queue clock, as in tests/test_live_scan.py (fixture times are in 2028)
    server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'tests.live_scan_network_app:app', '--host', '127.0.0.1',
                               '--port', str(args.port), '--log-level', 'warning'],
                              env={**os.environ, 'LIVE_SCAN_TEST_DATABASE': str(database), 'LIVE_SCAN_TEST_CLOCK': str(clock)})
    base = f'http://127.0.0.1:{args.port}'
    try:
        client = Client(base)
        for _ in range(100):
            try:
                client.binding = client.call('GET', '/api/bridge-context')[2]['binding']
                break
            except OSError:
                time.sleep(0.2)
        now = [10_000]
        warm = {k: [] for k in ('claim', 'gate', 'renew', 'finish')}
        scan(client, 24, warm, now)  # bloat: 8 x 24 quiz records, about 900 KB (finish caps the Snapshot at 1 MiB)
        size = len(json.dumps(client.call('GET', '/api/snapshot')[2]).encode())
        print(f'database {database}\nSnapshot {size / 1024:.0f} KB, journal_mode', end=' ')
        import sqlite3
        with sqlite3.connect(database) as db:
            print(db.execute('PRAGMA journal_mode').fetchone()[0])
        quiet = {k: [] for k in warm}
        for _ in range(args.rounds):
            scan(client, args.quizzes, quiet, now)
        report('without pollers', quiet)
        busy, polled, stop = {k: [] for k in warm}, [], threading.Event()
        threads = [threading.Thread(target=poll, args=(base, stop, polled)) for _ in range(args.pollers)]
        for t in threads: t.start()
        try:
            for _ in range(args.rounds):
                scan(client, args.quizzes, busy, now)
        finally:
            stop.set()
            for t in threads: t.join()
        report(f'with {args.pollers} pollers', busy)
        for path in ('/api/queue/current', '/api/snapshot', '/api/connection'):
            hits = [(s, ms) for p, s, ms in polled if p == path]
            print(f'  poll {path:20} n={len(hits)} 503={sum(s == 503 for s, _ in hits)} '
                  f'p50={statistics.median(ms for _, ms in hits):.1f} ms max={max(ms for _, ms in hits):.1f} ms')
    finally:
        server.terminate()
        server.wait()


if __name__ == '__main__':
    main()
