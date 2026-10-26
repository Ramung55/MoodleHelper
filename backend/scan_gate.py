"""Internal, fail-closed scan request gate; no network transport is enabled."""
import secrets
from backend.sqlite_store import SQLiteStore

class ScanGate:
    def __init__(self, store):
        if not isinstance(store, SQLiteStore):
            raise ValueError('Scan gate requires file-backed SQLite.')
        self.store = store

    def acquire(self, now_ms):
        if not isinstance(now_ms, int) or isinstance(now_ms, bool) or not 0 <= now_ms <= 2**63-1001:
            raise ValueError('Invalid time.')
        with self.store._transaction() as c:
            row = c.exec_driver_sql('SELECT owner,last_start,not_before FROM scan_request_gate WHERE id=1').one()
            if row.owner is not None or now_ms < max(row.not_before, row.last_start + 1000):
                return None
            token = secrets.token_urlsafe(32)
            c.exec_driver_sql('UPDATE scan_request_gate SET owner=?,last_start=? WHERE id=1', (token, now_ms))
            return token

    def release_after_termination(self, token, not_before_ms=0):
        """Caller must prove request termination before calling; no timeout unlocks."""
        if not isinstance(not_before_ms, int) or isinstance(not_before_ms, bool) or not 0 <= not_before_ms <= 2**63-1:
            raise ValueError('Invalid time.')
        with self.store._transaction() as c:
            row = c.exec_driver_sql('SELECT owner,not_before FROM scan_request_gate WHERE id=1').one()
            if not isinstance(token, str) or row.owner is None or not secrets.compare_digest(row.owner, token):
                return False
            c.exec_driver_sql('UPDATE scan_request_gate SET owner=NULL,not_before=? WHERE id=1', (max(row.not_before, not_before_ms),))
            return True
