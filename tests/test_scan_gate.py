import concurrent.futures
from sqlalchemy import URL
from backend.scan_gate import ScanGate
from backend.sqlite_store import SQLiteStore


def test_gate_is_file_wide_and_stays_closed_after_restart(tmp_path):
    url = URL.create('sqlite', database=str(tmp_path / 'gate.db'))
    a, b = SQLiteStore(url), SQLiteStore(url)
    try:
        gates = [ScanGate(a), ScanGate(b)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            tokens = list(pool.map(lambda gate: gate.acquire(10000), gates))
        assert sum(token is not None for token in tokens) == 1
        token = next(token for token in tokens if token)
        a.close()
        a = SQLiteStore(url)
        assert ScanGate(a).acquire(1000000) is None
        assert not ScanGate(a).release_after_termination('wrong')
        assert ScanGate(b).release_after_termination(token, 15000)
        assert ScanGate(a).acquire(14999) is None
        new = ScanGate(a).acquire(15000)
        assert new
        assert ScanGate(a).release_after_termination(new)
        assert ScanGate(b).acquire(15999) is None
        assert ScanGate(b).acquire(16000)
    finally:
        a.close()
        b.close()
