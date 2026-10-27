"""Isolated synthetic request authority; no live request transport is enabled.

The harness provisions a distinct authority and retains its random marker. Opening
never creates or repairs a file: missing, replaced, or invalid state fails closed.
"""
import secrets
from contextlib import closing
import sqlite3
from pathlib import Path


class AuthorityUnavailable(RuntimeError):
    pass


class SyntheticAuthority:
    def __init__(self, path, marker):
        self.path = Path(path).resolve()
        self.marker = marker
        if not isinstance(marker, str) or len(marker) != 64:
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
                c.execute('CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL, owner TEXT, last_start INTEGER NOT NULL, not_before INTEGER NOT NULL)')
                c.execute('INSERT INTO authority VALUES (1, ?, NULL, -1000, 0)', (marker,))
            return cls(path, marker)
        except (OSError, sqlite3.Error) as exc:
            raise AuthorityUnavailable('Scan authority unavailable.') from exc

    def _transaction(self, action):
        try:
            with closing(sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=1)) as c, c:
                c.execute('BEGIN IMMEDIATE')
                rows = c.execute('SELECT marker,owner,last_start,not_before FROM authority WHERE id=1').fetchall()
                if len(rows) != 1 or not secrets.compare_digest(rows[0][0], self.marker):
                    raise AuthorityUnavailable('Scan authority unavailable.')
                marker, owner, last_start, not_before = rows[0]
                if (not isinstance(last_start, int) or not isinstance(not_before, int)
                        or last_start < -1000 or not_before < 0
                        or owner is not None and not isinstance(owner, str)):
                    raise AuthorityUnavailable('Scan authority unavailable.')
                return action(c, owner, last_start, not_before)
        except (OSError, sqlite3.Error, TypeError) as exc:
            raise AuthorityUnavailable('Scan authority unavailable.') from exc

    def acquire(self, now_ms):
        if not isinstance(now_ms, int) or isinstance(now_ms, bool) or not 0 <= now_ms <= 2**63-1001:
            raise ValueError('Invalid time.')
        def reserve(c, owner, last_start, not_before):
            if owner is not None or now_ms < max(not_before, last_start + 1000):
                return None
            token = secrets.token_urlsafe(32)
            c.execute('UPDATE authority SET owner=?,last_start=? WHERE id=1', (token, now_ms))
            return token
        return self._transaction(reserve)

    def release_after_termination(self, token, not_before_ms=0):
        """Called only after the synthetic request's actual termination is confirmed."""
        if not isinstance(not_before_ms, int) or isinstance(not_before_ms, bool) or not 0 <= not_before_ms <= 2**63-1:
            raise ValueError('Invalid time.')
        def release(c, owner, _last_start, not_before):
            if not isinstance(token, str) or owner is None or not secrets.compare_digest(owner, token):
                return False
            c.execute('UPDATE authority SET owner=NULL,not_before=? WHERE id=1', (max(not_before, not_before_ms),))
            return True
        return self._transaction(release)
