import concurrent.futures
import pytest
from sqlalchemy import URL
from backend.sqlite_store import SQLiteStore
from backend.synthetic_scan_authority import AuthorityUnavailable, SyntheticAuthority


def test_shared_authority_across_distinct_databases_and_restart(tmp_path):
    first = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'first.db')))
    second = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'second.db')))
    authority = SyntheticAuthority.provision(tmp_path / 'authority.db')
    restarted = SyntheticAuthority(authority.path, authority.marker)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            tokens = list(pool.map(lambda gate: gate.acquire(10000), [authority, restarted]))
        assert sum(token is not None for token in tokens) == 1
        token = next(token for token in tokens if token)
        # A restart, elapsed time, or another data store never frees occupancy.
        assert restarted.acquire(999999) is None
        assert not restarted.release_after_termination('wrong', 20000)
        assert authority.release_after_termination(token, 20000)
        assert restarted.acquire(19999) is None
        token = restarted.acquire(20000)
        assert token
        assert restarted.release_after_termination(token)
        assert authority.acquire(20999) is None
        assert authority.acquire(21000)
    finally:
        first.close()
        second.close()


def test_missing_or_replaced_authority_fails_closed(tmp_path):
    path = tmp_path / 'authority.db'
    authority = SyntheticAuthority.provision(path)
    path.unlink()
    with pytest.raises(AuthorityUnavailable):
        authority.acquire(10000)
    replacement = SyntheticAuthority.provision(path)
    with pytest.raises(AuthorityUnavailable):
        authority.acquire(10000)
    assert replacement.acquire(10000)


def test_retry_budget_survives_restart_and_owner_key_is_bound(tmp_path):
    authority = SyntheticAuthority.provision(tmp_path / 'authority.db')
    for index in range(3):
        reopened = SyntheticAuthority(authority.path, authority.marker)
        reservation = reopened.acquire(10000 + index*6000, 'job:page')
        assert reservation['failures'] == index
        assert not reopened.release_after_termination(reservation['token'], 0, 'other', True)
        assert reopened.release_after_termination(reservation['token'], 10000 + index*6000, 'job:page', True)
    assert SyntheticAuthority(authority.path, authority.marker).acquire(50000, 'job:page') == 'exhausted'
    other = authority.acquire(50000, 'other:page')
    assert other['failures'] == 0
    assert authority.release_after_termination(other['token'], 0, 'other:page', False)


def test_worker_death_does_not_release_authority(tmp_path):
    import subprocess
    import sys
    authority = SyntheticAuthority.provision(tmp_path / 'authority.db')
    program = (
        'import sys, time; '
        'from backend.synthetic_scan_authority import SyntheticAuthority; '
        'a=SyntheticAuthority(sys.argv[1],sys.argv[2]); '
        'print(a.acquire(10000),flush=True); time.sleep(60)'
    )
    worker = subprocess.Popen([sys.executable, '-c', program, str(authority.path), authority.marker],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        token = worker.stdout.readline().strip()
        assert token and token != 'None'
        worker.kill()
        worker.wait(timeout=10)
        reopened = SyntheticAuthority(authority.path, authority.marker)
        assert reopened.acquire(999999) is None
        # No termination acknowledgement exists, so the owner is retained.
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait(timeout=10)
        worker.stdout.close()
        worker.stderr.close()
