"""Durable, fail-closed scan request gate (#20).

The extension's in-memory single-flight authority owns the live Moodle request;
this one SQLite row holds the durable pacing it must respect: the last request
start, the retry not-before deadline (never shortened) and per-request retryable
failure counts. A held gate is released only after the caller proved the fetch
settled. After a service-worker restart, a gate still held by a previous worker
instance may be reclaimed only once ``last_start + REQUEST_LIMIT_MS`` has passed,
because every live request is aborted at that hard time limit.
"""
import secrets
from sqlalchemy.exc import SQLAlchemyError
import sqlite3

from backend.sqlite_store import SQLiteStore, storage_failure

SPACING_MS = 1000
REQUEST_LIMIT_MS = 30000
MAX_FAILURES = 3
MAX_TIME = 9007199254740991


class ScanGate:
    def __init__(self, store):
        if not isinstance(store, SQLiteStore):
            raise ValueError('Scan gate requires file-backed SQLite.')
        self.store = store

    def _tx(self, action):
        try:
            with self.store._transaction() as c:
                return action(c)
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc

    @staticmethod
    def _time(value):
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_TIME:
            raise ValueError('Invalid time.')
        return value

    @staticmethod
    def _key(value):
        if value is not None and (not isinstance(value, str) or not 1 <= len(value) <= 8192):
            raise ValueError('Invalid request key.')
        return value

    def reserve(self, now_ms, instance=None, request_key=None):
        """Return {'state': 'reserved'|'busy'|'exhausted', ...}; never waits."""
        self._time(now_ms); self._key(request_key)
        if instance is not None and (not isinstance(instance, str) or not 1 <= len(instance) <= 128):
            raise ValueError('Invalid instance.')
        def action(c):
            row = c.exec_driver_sql('SELECT owner,last_start,not_before,owner_instance FROM scan_request_gate WHERE id=1').one()
            if row.owner is not None:
                # Only a different, restarted worker may reclaim, and only after the
                # previous request's hard time limit; unknown owners stay closed.
                stale = (instance is not None and row.owner_instance is not None and row.owner_instance != instance
                         and now_ms >= row.last_start + REQUEST_LIMIT_MS)
                if not stale:
                    return {'state': 'busy'}
            if now_ms < max(row.not_before, row.last_start + SPACING_MS):
                return {'state': 'busy'}
            failures = 0
            if request_key is not None:
                found = c.exec_driver_sql('SELECT failures FROM scan_request_failures WHERE request_key=?', (request_key,)).first()
                failures = found.failures if found else 0
                if failures >= MAX_FAILURES:
                    return {'state': 'exhausted'}
            token = secrets.token_urlsafe(32)
            c.exec_driver_sql('UPDATE scan_request_gate SET owner=?,last_start=?,owner_instance=?,owner_request_key=? WHERE id=1',
                              (token, now_ms, instance, request_key))
            return {'state': 'reserved', 'token': token, **({'failures': failures} if request_key is not None else {})}
        return self._tx(action)

    def acquire(self, now_ms):
        """Compatibility form: a token or None."""
        result = self.reserve(now_ms)
        return result.get('token')

    def release_after_termination(self, token, not_before_ms=0, request_key=None, retry_failure=None):
        """Caller must prove request termination before calling; no timeout unlocks."""
        self._time(not_before_ms); self._key(request_key)
        if retry_failure is not None and (not isinstance(retry_failure, bool) or request_key is None):
            raise ValueError('Invalid retry state.')
        def action(c):
            row = c.exec_driver_sql('SELECT owner,not_before,owner_request_key FROM scan_request_gate WHERE id=1').one()
            if (not isinstance(token, str) or row.owner is None or not secrets.compare_digest(row.owner, token)
                    or row.owner_request_key != request_key):
                return False
            c.exec_driver_sql('UPDATE scan_request_gate SET owner=NULL,owner_instance=NULL,owner_request_key=NULL,not_before=? WHERE id=1',
                              (max(row.not_before, not_before_ms),))
            if request_key is not None and retry_failure is not None:
                if retry_failure:
                    c.exec_driver_sql('INSERT INTO scan_request_failures(request_key,failures) VALUES(?,1) '
                                      'ON CONFLICT(request_key) DO UPDATE SET failures=MIN(failures+1,3)', (request_key,))
                else:
                    c.exec_driver_sql('DELETE FROM scan_request_failures WHERE request_key=?', (request_key,))
            return True
        return self._tx(action)


def forget_job_failures(c, job_id):
    """Inside the caller's transaction: drop failure counts keyed [jobId, url]."""
    import json
    prefix = json.dumps([job_id], ensure_ascii=True, separators=(',', ':'))[:-1] + ','
    c.exec_driver_sql("DELETE FROM scan_request_failures WHERE substr(request_key,1,?)=?", (len(prefix), prefix))
