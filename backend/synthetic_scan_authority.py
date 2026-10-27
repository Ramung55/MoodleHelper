"""Isolated synthetic request authority; no live request transport is enabled.

The harness provisions a distinct authority and retains its random marker. Opening
never creates or repairs a file: missing, replaced, or invalid state fails closed.
"""
import secrets
import re
from contextlib import closing
import sqlite3
from pathlib import Path


class AuthorityUnavailable(RuntimeError):
    pass


class SyntheticAuthority:
    def __init__(self, path, marker):
        self.path = Path(path).resolve()
        self.marker = marker
        if not isinstance(marker, str) or not re.fullmatch(r'[0-9a-f]{64}', marker):
            raise AuthorityUnavailable('Scan authority unavailable.')

    @classmethod
    def provision(cls, path):
        """One-time isolated harness setup, never ordinary runtime configuration."""
        path = Path(path).resolve()
        try:
            # Exclusive creation prevents silently replacing an existing authority.
            with path.open('xb'):
                pass
            marker = secrets.token_hex(32)
            with closing(sqlite3.connect(str(path))) as c, c:
                c.execute('CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), marker TEXT NOT NULL, owner TEXT, last_start INTEGER NOT NULL, not_before INTEGER NOT NULL, owner_request_key TEXT)')
                c.execute('CREATE TABLE request_failures (request_key TEXT PRIMARY KEY, failures INTEGER NOT NULL CHECK(failures BETWEEN 1 AND 3))')
                c.execute('INSERT INTO authority VALUES (1, 1, ?, NULL, -1000, 0, NULL)', (marker,))
            return cls(path, marker)
        except (OSError, sqlite3.Error) as exc:
            raise AuthorityUnavailable('Scan authority unavailable.') from exc

    def _transaction(self, action):
        try:
            with closing(sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=1)) as c, c:
                c.execute('BEGIN IMMEDIATE')
                rows = c.execute('SELECT version,marker,owner,last_start,not_before,owner_request_key FROM authority WHERE id=1').fetchall()
                if len(rows) != 1 or rows[0][0] != 1 or not secrets.compare_digest(rows[0][1], self.marker):
                    raise AuthorityUnavailable('Scan authority unavailable.')
                _, marker, owner, last_start, not_before, owner_key = rows[0]
                if (not isinstance(last_start, int) or not isinstance(not_before, int)
                        or last_start < -1000 or not_before < 0
                        or owner is not None and not isinstance(owner, str)
                        or owner_key is not None and not isinstance(owner_key, str)
                        or owner is None and owner_key is not None):
                    raise AuthorityUnavailable('Scan authority unavailable.')
                return action(c, owner, last_start, not_before, owner_key)
        except (OSError, sqlite3.Error, TypeError) as exc:
            raise AuthorityUnavailable('Scan authority unavailable.') from exc

    def acquire(self, now_ms, request_key=None):
        if not isinstance(now_ms, int) or isinstance(now_ms, bool) or not 0 <= now_ms <= 2**63-1001:
            raise ValueError('Invalid time.')
        if request_key is not None and (not isinstance(request_key, str) or not 1 <= len(request_key) <= 8192):
            raise ValueError('Invalid request key.')
        def reserve(c, owner, last_start, not_before, _owner_key):
            if owner is not None or now_ms < max(not_before, last_start + 1000):
                return None
            failures = 0
            if request_key is not None:
                row = c.execute('SELECT failures FROM request_failures WHERE request_key=?', (request_key,)).fetchone()
                failures = row[0] if row else 0
                if not isinstance(failures, int) or not 0 <= failures <= 3:
                    raise AuthorityUnavailable('Scan authority unavailable.')
                if failures >= 3:
                    return 'exhausted'
            token = secrets.token_urlsafe(32)
            c.execute('UPDATE authority SET owner=?,last_start=?,owner_request_key=? WHERE id=1', (token, now_ms, request_key))
            return {'token':token, 'failures':failures} if request_key is not None else token
        return self._transaction(reserve)

    def release_after_termination(self, token, not_before_ms=0, request_key=None, retry_failure=None):
        """Called only after the synthetic request's actual termination is confirmed."""
        if not isinstance(not_before_ms, int) or isinstance(not_before_ms, bool) or not 0 <= not_before_ms <= 2**63-1:
            raise ValueError('Invalid time.')
        if request_key is not None and (not isinstance(request_key, str) or not 1 <= len(request_key) <= 8192):
            raise ValueError('Invalid request key.')
        if retry_failure is not None and (not isinstance(retry_failure, bool) or request_key is None):
            raise ValueError('Invalid retry state.')
        def release(c, owner, _last_start, not_before, owner_key):
            if not isinstance(token, str) or owner is None or not secrets.compare_digest(owner, token) or owner_key != request_key:
                return False
            c.execute('UPDATE authority SET owner=NULL,not_before=?,owner_request_key=NULL WHERE id=1', (max(not_before, not_before_ms),))
            if request_key is not None and retry_failure is not None:
                if retry_failure:
                    c.execute('INSERT INTO request_failures(request_key,failures) VALUES(?,1) ON CONFLICT(request_key) DO UPDATE SET failures=failures+1', (request_key,))
                else:
                    c.execute('DELETE FROM request_failures WHERE request_key=?', (request_key,))
            return True
        return self._transaction(release)
