"""Confirmed erasure of local student data with durable epoch tombstone (#56).

One transaction replaces the Snapshot with an empty first-run namespace and safe
default settings, deletes queue/scan/collection/reminder/transfer job state, bumps
the shared #55 lifecycle epoch (fencing every older epoch-bound write) and stores a
minimal nonstudent receipt with per-component cleanup markers. The opaque datasetId
is unchanged. Nothing is reseeded. Moodle, provider data and disk files are never
touched. The #43 AI admission ledger holds only IDs/digests/cost (no student
content) and is retained so the spend cap cannot be reset by erasing.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

COMPONENTS = ('dashboard', 'extension')
CLEANUP_STATES = ('pending', 'complete', 'failed')
# Child tables first; all namespace-scoped job/claim/outbox state (#19/#20/#38/#41).
SQL_JOB_TABLES = ('queue_results', 'scan_pages', 'scan_coverage', 'queue_links', 'queue_key_aliases', 'queue_jobs', 'queue_runs',
                  'reminder_requests', 'reminder_receipts', 'material_transfers')


class EraseRejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def default_settings(today: date) -> dict:
    """Nonstudent first-run defaults: no courses, reminders and AI off."""
    monday = today - timedelta(days=today.weekday())
    return {'trackedCourseIds': [], 'semesterStart': monday.isoformat(), 'semesterWeeks': 15, 'timezone': 'Asia/Almaty',
            'weights': {'exam': 3, 'assignment': 2, 'quiz': 1, 'other': 0}, 'thresholds': {'maxOutstanding': 5, 'maxWeighted': 10},
            'reminders': {'enabled': False, 'hoursBefore': 24, 'busyWeek': True}, 'ai': {'enabled': False, 'consentGiven': False}}


def empty_snapshot(today: date) -> dict:
    from backend.storage import InMemoryStore
    return InMemoryStore._validated({key: [] for key in ('courses', 'assessments', 'overlays', 'materials', 'documents', 'candidates',
                                                          'sync', 'changes', 'alerts')} | {'settings': default_settings(today)})


def fingerprint(body: dict) -> str:
    material = {k: body[k] for k in ('expectedDatasetId', 'expectedEpoch', 'expectedRevision')}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()


def _cleanup(meta: dict) -> dict:
    return {'backend': 'complete', 'dashboard': meta['dashboard'], 'extension': meta['extension']}


class EraseService:
    def __init__(self, store, clock=None, material_rows=None, reminder_ledger=None, on_commit=None):
        self.store, self.material_rows, self.reminder_ledger = store, material_rows, reminder_ledger
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.on_commit = on_commit  # in-process token/claim invalidation after commit
        self.before_commit = None  # test seam

    @property
    def sql(self):
        return hasattr(self.store, 'engine')

    def _guard(self, operation):
        if not self.sql:
            return operation()
        from sqlalchemy.exc import SQLAlchemyError
        import sqlite3
        from backend.sqlite_store import storage_failure
        try:
            return operation()
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc

    # ---- read-only context -------------------------------------------------
    def context(self) -> dict:
        def read():
            if self.sql:
                from sqlalchemy import text
                with self.store.engine.connect() as c:
                    row = c.execute(text('SELECT s.revision, d.dataset_id, COALESCE(l.epoch,0) FROM snapshots s JOIN local_datasets d ON d.namespace=s.namespace '
                                         'LEFT JOIN data_lifecycle l ON l.namespace=s.namespace WHERE s.namespace=:n'), {'n': self.store.namespace}).one()
                    latest = c.execute(text('SELECT erase_id, epoch, revision, dashboard, extension, created FROM erase_receipts WHERE namespace=:n '
                                            'ORDER BY epoch DESC LIMIT 1'), {'n': self.store.namespace}).first()
                context = {'datasetId': row[1], 'epoch': row[2], 'revision': row[0]}
                erase = dict(zip(('eraseId', 'epoch', 'revision', 'dashboard', 'extension', 'created'), latest)) if latest else None
            else:
                with self.store._lock:
                    context = {'datasetId': self.store.dataset_id, 'epoch': self.store.epoch, 'revision': self.store.revision}
                    metas = sorted(self.store.erase_receipts.values(), key=lambda m: m['epoch'])
                    erase = dict(metas[-1]) if metas else None
            if erase is None or erase['epoch'] != context['epoch']:
                return {**context, 'lifecycle': 'active'}
            pending = 'complete' if all(erase[c] == 'complete' for c in COMPONENTS) else 'cleanup_pending'
            return {**context, 'lifecycle': pending, 'erasure': {'eraseId': erase['eraseId'], 'cleanup': _cleanup(erase)}}
        return self._guard(read)

    # ---- erase -------------------------------------------------------------
    def erase(self, body: dict) -> dict:
        print_ = fingerprint(body)
        snapshot = empty_snapshot(self.clock().date())
        result = self._erase_sql(body, print_, snapshot) if self.sql else self._erase_memory(body, print_, snapshot)
        if self.on_commit and not result.pop('_replayed', False):
            self.on_commit()
        result.pop('_replayed', None)
        return result

    def _check(self, body, current):
        if current['datasetId'] != body['expectedDatasetId']:
            raise EraseRejected(409, 'Local dataset changed. Reload and confirm deletion again; nothing was deleted.')
        if (current['epoch'], current['revision']) != (body['expectedEpoch'], body['expectedRevision']):
            raise EraseRejected(409, 'Local data changed since you opened the confirmation. Reload and confirm again; nothing was deleted.')

    def _response(self, meta, snapshot, replayed):
        return {'eraseId': meta['eraseId'], 'datasetId': meta['datasetId'], 'epoch': meta['epoch'], 'revision': meta['revision'],
                'snapshot': snapshot, 'cleanup': _cleanup(meta), '_replayed': replayed}

    def _meta(self, current, print_):
        return {'eraseId': uuid4().hex, 'datasetId': current['datasetId'], 'epoch': current['epoch'] + 1, 'revision': current['revision'] + 1,
                'fingerprint': print_, 'dashboard': 'pending', 'extension': 'pending', 'created': self.clock().isoformat()}

    def _erase_memory(self, body, print_, snapshot):
        store = self.store
        with store._lock:
            saved = store.erase_receipts.get(body['idempotencyKey'])
            if saved is not None:
                if saved['fingerprint'] != print_:
                    raise EraseRejected(409, 'This deletion request key was already used for a different context.')
                return self._response(saved, store.read(), True)
            current = {'datasetId': store.dataset_id, 'epoch': store.epoch, 'revision': store.revision}
            self._check(body, current)
            previous = (store._snapshot, store.revision, store.epoch)
            rows_before = dict(self.material_rows.rows) if self.material_rows is not None else None
            ledger = self.reminder_ledger
            ledger_before = (dict(ledger.requested), dict(ledger.receipts)) if ledger is not None else None
            try:
                if self.material_rows is not None:
                    self.material_rows.rows = {k: v for k, v in self.material_rows.rows.items() if v.get('namespace') != store.namespace}
                if ledger is not None:
                    ledger.requested, ledger.receipts = {}, {}
                store._snapshot = snapshot
                store.revision += 1
                store.epoch += 1
                if self.before_commit:
                    self.before_commit()
                meta = self._meta(current, print_)
                store.erase_receipts[body['idempotencyKey']] = meta
            except BaseException:
                store._snapshot, store.revision, store.epoch = previous
                if rows_before is not None:
                    self.material_rows.rows = rows_before
                if ledger_before is not None:
                    ledger.requested, ledger.receipts = ledger_before
                raise
            return self._response(meta, store.read(), False)

    def _erase_sql(self, body, print_, snapshot):
        from sqlalchemy import text
        store, ns = self.store, {'n': self.store.namespace}

        def run():
            with store._transaction() as c:
                saved = c.execute(text('SELECT erase_id, fingerprint, epoch, revision, dashboard, extension FROM erase_receipts WHERE namespace=:n AND idem=:i'),
                                  {**ns, 'i': body['idempotencyKey']}).first()
                if saved is not None:
                    if saved[1] != print_:
                        raise EraseRejected(409, 'This deletion request key was already used for a different context.')
                    return {'eraseId': saved[0], 'datasetId': body['expectedDatasetId'], 'epoch': saved[2], 'revision': saved[3],
                            'dashboard': saved[4], 'extension': saved[5]}, None
                row = c.execute(text('SELECT s.revision, d.dataset_id, COALESCE(l.epoch,0) FROM snapshots s JOIN local_datasets d ON d.namespace=s.namespace '
                                     'LEFT JOIN data_lifecycle l ON l.namespace=s.namespace WHERE s.namespace=:n'), ns).one()
                current = {'datasetId': row[1], 'epoch': row[2], 'revision': row[0]}
                self._check(body, current)
                c.execute(text('UPDATE snapshots SET snapshot=:s, revision=revision+1 WHERE namespace=:n'),
                          {**ns, 's': json.dumps(snapshot, ensure_ascii=False, allow_nan=False)})
                for table in SQL_JOB_TABLES:
                    c.execute(text(f'DELETE FROM {table} WHERE namespace=:n'), ns)
                c.execute(text('INSERT OR IGNORE INTO data_lifecycle(namespace,epoch) VALUES(:n,0)'), ns)
                c.execute(text('UPDATE data_lifecycle SET epoch=epoch+1 WHERE namespace=:n'), ns)
                if self.before_commit:
                    self.before_commit()
                meta = self._meta(current, print_)
                c.execute(text('INSERT INTO erase_receipts(namespace,idem,erase_id,fingerprint,epoch,revision,dashboard,extension,created) '
                               'VALUES(:n,:i,:e,:f,:ep,:r,:d,:x,:c)'),
                          {**ns, 'i': body['idempotencyKey'], 'e': meta['eraseId'], 'f': print_, 'ep': meta['epoch'], 'r': meta['revision'],
                           'd': 'pending', 'x': 'pending', 'c': meta['created']})
                return meta, snapshot
        meta, fresh = self._guard(run)
        return self._response(meta, fresh if fresh is not None else store.read(), fresh is None)

    # ---- receipts and closed component acknowledgements --------------------
    def _find(self, erase_id: str):
        if self.sql:
            from sqlalchemy import text
            with self.store.engine.connect() as c:
                row = c.execute(text('SELECT erase_id, epoch, revision, dashboard, extension FROM erase_receipts WHERE namespace=:n AND erase_id=:e'),
                                {'n': self.store.namespace, 'e': erase_id}).first()
            return dict(zip(('eraseId', 'epoch', 'revision', 'dashboard', 'extension'), row)) if row else None
        with self.store._lock:
            return next((dict(m) for m in self.store.erase_receipts.values() if m['eraseId'] == erase_id), None)

    def status(self, erase_id: str) -> dict:
        meta = self._guard(lambda: self._find(erase_id))
        if meta is None:
            raise EraseRejected(404, 'Deletion receipt not found.')
        current = self.context()
        return {'eraseId': meta['eraseId'], 'datasetId': current['datasetId'], 'epoch': meta['epoch'],
                'current': meta['epoch'] == current['epoch'], 'cleanup': _cleanup(meta)}

    def acknowledge(self, erase_id: str, component: str, state: str) -> dict:
        if component not in COMPONENTS or state not in ('complete', 'failed'):
            raise EraseRejected(422, 'Unsupported cleanup acknowledgement.')

        def run():
            meta = self._find(erase_id)
            if meta is None:
                raise EraseRejected(404, 'Deletion receipt not found.')
            if meta[component] == 'complete':
                return  # idempotent; a completed component never regresses
            if self.sql:
                from sqlalchemy import text
                with self.store._transaction() as c:
                    c.execute(text(f"UPDATE erase_receipts SET {component}=:s WHERE namespace=:n AND erase_id=:e AND {component}!='complete'"),
                              {'s': state, 'n': self.store.namespace, 'e': erase_id})
            else:
                with self.store._lock:
                    for m in self.store.erase_receipts.values():
                        if m['eraseId'] == erase_id:
                            m[component] = state
        self._guard(run)
        return self.status(erase_id)

