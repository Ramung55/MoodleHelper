"""Validated, atomic restore of a #45 v1 backup (#55).

Identity, version, size and shape are checked before any transaction opens. The
replacement Snapshot, lifecycle epoch, queue fencing, reminder plan rebuild and
idempotency receipt commit or roll back together. Links are never fetched.
"""
from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit
from uuid import uuid4

from pydantic import ValidationError

MAX_BACKUP_BYTES = 20 * 1024 * 1024
MAX_DEPTH = 64
MAX_NODES = 1_000_000
MAX_STRING = 2 * 1024 * 1024
BACKUP_VERSION = 1
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)

SECRET_QUERY = re.compile(r'^(token|wstoken|sesskey|session|sessionid|sid|moodlesession|sig|signature|auth|authorization|access_token|id_token|refresh_token|api_key|apikey|key|password|passwd|secret|credential|se|sp|sv|expires|expiry|exp)$', re.I)
SECRET_QUERY_PREFIX = re.compile(r'^(x-amz-|x-goog-)', re.I)
AUTH_ROUTE = re.compile(r'/(login|logout|auth|oauth2?|sso|saml)(/|$)|/token\.php$', re.I)
URL_LIKE = re.compile(r'^[a-z][a-z0-9+.-]*:', re.I)
LINK_SCHEMES = {'javascript', 'data', 'file', 'blob', 'vbscript', 'ftp', 'ws', 'wss', 'chrome-extension', 'moz-extension'}
SECRET_TEXT = [re.compile(p, f) for p, f in [
    (r'\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}', 0), (r'\bAKIA[0-9A-Z]{16}\b', 0), (r'\bgh[pousr]_[A-Za-z0-9]{20,}', 0),
    (r'\bBearer\s+[A-Za-z0-9._~+/-]{16,}', re.I), (r'MoodleSession[A-Za-z]*=', re.I), (r'-----BEGIN [A-Z ]*PRIVATE KEY-----', 0),
    (r'[?&](?:wstoken|sesskey|token|X-Amz-Signature|X-Amz-Expires|Expires)=', re.I)]]


class RestoreRejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def unsafe_url_reason(value: str) -> str | None:
    v = value.strip()
    if not URL_LIKE.match(v) or re.match(r'^[a-z]:[\\/]', v, re.I):
        return None
    try:
        u = urlsplit(v)
    except ValueError:
        return 'unparseable link' if '://' in v else None
    scheme = u.scheme.lower()
    if scheme not in ('http', 'https'):
        return 'unexpected link scheme' if scheme in LINK_SCHEMES or '://' in v else None
    if u.username or u.password:
        return 'link contains embedded credentials'
    for key, _ in parse_qsl(u.query, keep_blank_values=True):
        if SECRET_QUERY.match(key) or SECRET_QUERY_PREFIX.match(key):
            return 'link contains a session, token, signature or expiring-access parameter'
    if re.search(r'(^|[&#])(access_token|id_token|token)=', u.fragment, re.I):
        return 'link contains a token fragment'
    if AUTH_ROUTE.search(u.path):
        return 'link points to a login or session route'
    return None


def _scan(value, path: str, out: list[str], depth: int, counter: list[int]):
    counter[0] += 1
    if depth > MAX_DEPTH or counter[0] > MAX_NODES:
        raise RestoreRejected(422, 'Backup is too deeply nested or has too many entries to restore safely.')
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            raise RestoreRejected(422, f'Backup field {path} is too long to restore safely.')
        if unsafe_url_reason(value) or any(p.search(value) for p in SECRET_TEXT):
            out.append(path)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            _scan(item, f'{path}[{i}]', out, depth + 1, counter)
    elif isinstance(value, dict):
        for key, item in value.items():
            if any(p.search(key) for p in SECRET_TEXT):
                out.append(f'{path}.<key>')
            _scan(item, f'{path}.{key}', out, depth + 1, counter)


def check_bounds(value) -> None:
    _scan(value, 'backup', [], 0, [0])


def validate_backup(backup, dataset_id: str) -> dict:
    """Return the validated Snapshot or raise a specific RestoreRejected; never mutates."""
    from backend.storage import InMemoryStore
    if not isinstance(backup, dict):
        raise RestoreRejected(422, 'This file is not a valid Moodle Helper backup.')
    check_bounds(backup)
    if backup.get('app') != 'moodle-helper':
        raise RestoreRejected(422, 'This file is not a Moodle Helper backup.')
    version = backup.get('version')
    if not isinstance(version, int) or isinstance(version, bool):
        raise RestoreRejected(422, 'Backup format version is missing or invalid.')
    if version > BACKUP_VERSION:
        raise RestoreRejected(422, f'Backup format version {version} is newer than this app supports. Update Moodle Helper and retry.')
    if version != BACKUP_VERSION:
        raise RestoreRejected(422, f'Unsupported backup format version: {version}.')
    exported = backup.get('exportedAt')
    try:
        if not isinstance(exported, str) or not re.match(r'^\d{4}-\d{2}-\d{2}T', exported):
            raise ValueError
        datetime.fromisoformat(exported.replace('Z', '+00:00'))
    except ValueError:
        raise RestoreRejected(422, 'Backup export timestamp is invalid.') from None
    if not isinstance(backup.get('note'), str):
        raise RestoreRejected(422, 'This file is not a valid Moodle Helper backup.')
    identity = backup.get('datasetId')
    if identity is None:
        raise RestoreRejected(422, 'Identity unavailable: this backup has no dataset identity and cannot be restored here.')
    if not isinstance(identity, str) or not UUID.match(identity):
        raise RestoreRejected(422, 'Backup dataset identity is invalid.')
    if identity != dataset_id:
        raise RestoreRejected(422, 'Wrong identity: this backup belongs to a different local dataset and cannot be restored here.')
    summary = backup.get('summary')
    if summary is not None and not _valid_summary(summary):
        raise RestoreRejected(422, 'Backup summary metadata is invalid.')
    if set(backup) - {'app', 'version', 'exportedAt', 'note', 'datasetId', 'summary', 'data'}:
        raise RestoreRejected(422, 'Backup contains unsupported top-level fields.')
    try:
        data = InMemoryStore._validated(deepcopy(backup.get('data')))
    except (ValidationError, ValueError, TypeError):
        raise RestoreRejected(422, 'Backup data does not match the supported Snapshot shape.') from None
    unsafe: list[str] = []
    _scan(data, 'data', unsafe, 0, [0])
    if unsafe:
        shown = ', '.join(unsafe[:3]) + (', …' if len(unsafe) > 3 else '')
        raise RestoreRejected(422, f'Backup rejected: {len(unsafe)} field(s) contain credential-bearing, expiring or unsafe links ({shown}).')
    return data


def _valid_summary(summary) -> bool:
    if not isinstance(summary, dict) or set(summary) != {'counts', 'exclusions', 'redactions'}:
        return False
    counts, exclusions, redactions = summary['counts'], summary['exclusions'], summary['redactions']
    return (isinstance(counts, list) and all(isinstance(c, dict) and set(c) == {'label', 'count'} and isinstance(c['label'], str)
                                              and isinstance(c['count'], int) and not isinstance(c['count'], bool) and c['count'] >= 0 for c in counts)
            and isinstance(exclusions, list) and all(isinstance(e, str) for e in exclusions)
            and isinstance(redactions, int) and not isinstance(redactions, bool) and redactions >= 0)


def fingerprint(body: dict) -> str:
    material = {k: body[k] for k in ('expectedDatasetId', 'expectedEpoch', 'expectedRevision', 'backup')}
    return hashlib.sha256(json.dumps(material, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def prepare_snapshot(data: dict, namespace: str) -> dict:
    from backend.alert_delivery import neutralize_imported
    from backend.storage import InMemoryStore
    snapshot = neutralize_imported(deepcopy(data))
    if 'reconciliation' in snapshot:
        from backend.reconciliation import project_sources
        project_sources(snapshot, namespace)
    return InMemoryStore._validated(snapshot)


class RestoreService:
    def __init__(self, store, clock=None, resolver=None):
        self.store = store
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.resolver = resolver
        # Test seam: called after the Snapshot write and before commit.
        self.before_commit = None

    def _rebuild_plan(self, snapshot: dict) -> str:
        from backend import reminders
        kwargs = {'resolver': self.resolver} if self.resolver else {}
        return reminders.plan(snapshot, self.store.namespace, self.store.dataset_id, self.clock(), **kwargs)['generation']

    def context(self) -> dict:
        if hasattr(self.store, 'engine'):
            from sqlalchemy import text
            from backend.sqlite_store import storage_failure
            import sqlite3
            from sqlalchemy.exc import SQLAlchemyError
            try:
                with self.store.engine.connect() as c:
                    row = c.execute(text('SELECT s.revision, d.dataset_id, COALESCE(l.epoch,0) FROM snapshots s JOIN local_datasets d ON d.namespace=s.namespace '
                                         'LEFT JOIN data_lifecycle l ON l.namespace=s.namespace WHERE s.namespace=:namespace'), self.store._key).one()
            except (SQLAlchemyError, sqlite3.Error) as exc:
                raise storage_failure(exc) from exc
            return {'datasetId': row[1], 'epoch': row[2], 'revision': row[0]}
        with self.store._lock:
            return {'datasetId': self.store.dataset_id, 'epoch': self.store.epoch, 'revision': self.store.revision}

    def restore(self, body: dict) -> dict:
        print_ = fingerprint(body)
        dataset_id = self.store.dataset_id
        receipt = self._receipt(body['idempotencyKey'], print_)
        if receipt is not None:
            return receipt
        if body['expectedDatasetId'] != dataset_id:
            raise RestoreRejected(409, 'Local dataset changed. Refresh the restore preview and confirm again.')
        data = validate_backup(body['backup'], dataset_id)
        snapshot = prepare_snapshot(data, self.store.namespace)
        if hasattr(self.store, 'engine'):
            return self._restore_sql(body, print_, snapshot)
        return self._restore_memory(body, print_, snapshot)

    def _check_context(self, body, current):
        if (current['datasetId'], current['epoch'], current['revision']) != (body['expectedDatasetId'], body['expectedEpoch'], body['expectedRevision']):
            raise RestoreRejected(409, 'Local data changed since the restore preview. Refresh the preview and confirm again.')

    def _response(self, snapshot, context, generation, replayed=False):
        return {'snapshot': snapshot, 'datasetId': context['datasetId'], 'epoch': context['epoch'], 'revision': context['revision'],
                'restoreId': context['restoreId'], 'remindersRebuilt': True, 'reminderGeneration': generation, 'replayed': replayed}

    def _receipt(self, idem, print_):
        if hasattr(self.store, 'engine'):
            from sqlalchemy import text
            with self.store.engine.connect() as c:
                row = c.execute(text('SELECT fingerprint, response FROM restore_receipts WHERE namespace=:n AND idem=:i'),
                                {'n': self.store.namespace, 'i': idem}).first()
            saved = (row[0], json.loads(row[1])) if row else None
        else:
            with self.store._lock:
                saved = deepcopy(self.store.restore_receipts.get(idem))
        if saved is None:
            return None
        if saved[0] != print_:
            raise RestoreRejected(409, 'This restore request key was already used for a different backup or context.')
        meta = saved[1]
        return self._response(self.store.read(), meta, meta['reminderGeneration'], replayed=True)

    def _restore_memory(self, body, print_, snapshot):
        store = self.store
        with store._lock:
            if body['idempotencyKey'] in store.restore_receipts:
                return self._receipt(body['idempotencyKey'], print_)
            self._check_context(body, {'datasetId': store.dataset_id, 'epoch': store.epoch, 'revision': store.revision})
            previous = (store._snapshot, store.revision, store.epoch)
            try:
                store._snapshot = snapshot
                store.revision += 1
                store.epoch += 1
                generation = self._rebuild_plan(snapshot)
                if self.before_commit:
                    self.before_commit()
                meta = {'datasetId': store.dataset_id, 'epoch': store.epoch, 'revision': store.revision,
                        'restoreId': uuid4().hex, 'reminderGeneration': generation}
                store.restore_receipts[body['idempotencyKey']] = (print_, meta)
            except BaseException:
                store._snapshot, store.revision, store.epoch = previous
                raise
            return self._response(deepcopy(snapshot), meta, generation)

    def _restore_sql(self, body, print_, snapshot):
        from sqlalchemy import text
        from sqlalchemy.exc import SQLAlchemyError
        import sqlite3
        from backend.sqlite_store import storage_failure
        store, ns = self.store, {'n': self.store.namespace}
        try:
            with store._transaction() as c:
                row = c.execute(text('SELECT fingerprint FROM restore_receipts WHERE namespace=:n AND idem=:i'), {**ns, 'i': body['idempotencyKey']}).first()
                if row is not None:
                    replay = True
                else:
                    replay = False
                    current = c.execute(text('SELECT s.revision, d.dataset_id, COALESCE(l.epoch,0) FROM snapshots s JOIN local_datasets d ON d.namespace=s.namespace '
                                             'LEFT JOIN data_lifecycle l ON l.namespace=s.namespace WHERE s.namespace=:n'), ns).one()
                    self._check_context(body, {'datasetId': current[1], 'epoch': current[2], 'revision': current[0]})
                    c.execute(text('UPDATE snapshots SET snapshot=:s, revision=revision+1 WHERE namespace=:n'),
                              {**ns, 's': json.dumps(snapshot, ensure_ascii=False, allow_nan=False)})
                    # Fence old workers: pending/running claims can no longer renew or finish.
                    c.execute(text("UPDATE queue_jobs SET state='cancelled', generation=generation+1, token=NULL, expires=NULL, error_code='restored' "
                                   "WHERE namespace=:n AND state IN ('pending','running')"), ns)
                    c.execute(text('UPDATE queue_runs SET cancelled=1 WHERE namespace=:n AND cancelled=0'), ns)
                    c.execute(text('INSERT OR IGNORE INTO data_lifecycle(namespace,epoch) VALUES(:n,0)'), ns)
                    c.execute(text('UPDATE data_lifecycle SET epoch=epoch+1 WHERE namespace=:n'), ns)
                    generation = self._rebuild_plan(snapshot)
                    if self.before_commit:
                        self.before_commit()
                    meta = {'datasetId': current[1], 'epoch': current[2] + 1, 'revision': current[0] + 1,
                            'restoreId': uuid4().hex, 'reminderGeneration': generation}
                    c.execute(text('INSERT INTO restore_receipts(namespace,idem,fingerprint,response) VALUES(:n,:i,:f,:r)'),
                              {**ns, 'i': body['idempotencyKey'], 'f': print_, 'r': json.dumps(meta)})
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc
        if replay:
            return self._receipt(body['idempotencyKey'], print_)
        return self._response(snapshot, meta, generation)
