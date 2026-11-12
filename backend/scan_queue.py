"""Selected-course scan jobs (#20).

The synthetic harness injects its context; the trusted startup real namespace runs
in verified mode, where the Chrome extension's live scan worker claims jobs and
this service also writes each course's Snapshot ``sync`` entry inside the same
transactions. This module never performs a Moodle request itself.
"""
import json
from datetime import datetime, timezone
from uuid import uuid4
from pydantic import ValidationError

from backend import schemas
from backend.collection import CollectionRejected, canonical, route
from backend.sync_queue import QueueConflict, QueueInvalid, QueueMissing, QueueService
from backend.scan_gate import ScanGate, forget_job_failures
from backend.submission_retention import _instant

# A job claimed this many times without finishing fails instead of running again,
# so repeated worker crashes or restarts cannot make one job repeat forever.
CLAIM_CAP = 3
SIGN_IN = 'Sign in to SDU Moodle to continue.'
SYNC_ERRORS = {
    'signed_out': SIGN_IN,
    'request_failed': 'Moodle could not be read for this course. Earlier data was kept.',
    'invalid_context': 'The course selection or its Moodle link changed during the sync. Earlier data was kept.',
    'claim_limit': 'The sync was interrupted too often and stopped. Earlier data was kept.',
    'cancelled': 'The sync was cancelled. Earlier data was kept.',
    'account_mismatch': 'The signed-in Moodle account is not the account of this dataset. Earlier data was kept.',
    'account_unconfirmed': 'The Moodle account could not be confirmed. Earlier data was kept.',
}


class SyncConflict(Exception):
    """A fixed /api/sync 409 message; nothing was written."""
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def set_sync(snapshot, course_id, **fields):
    entry = next((s for s in snapshot['sync'] if s['courseId'] == course_id), None)
    if entry is None:
        entry = {'courseId': course_id, 'status': 'never', 'coverage': 'none', 'progress': 0}
        snapshot['sync'].append(entry)
    for key, value in fields.items():
        if value is None:
            entry.pop(key, None)
        else:
            entry[key] = value
    return entry


class ScanQueueService(QueueService):
    kind = 'scan'

    def __init__(self, store, collection, **kwargs):
        super().__init__(store, **kwargs)
        self.collection = collection

    @property
    def verified(self):
        return self.collection._mode() == 'verified'

    def _snapshot(self, c):
        return self.store._decode(self.execute(c, 'SELECT snapshot FROM snapshots WHERE namespace=?', self.ns).scalar_one())

    def _save(self, c, snapshot):
        # A failed or partial course scan changes freshness without producing a
        # submission observation. Rebuild the derived view in this transaction;
        # never invent an unknown observation or mutate the original assessment.
        if (any(r['kind'] == 'submission' for r in snapshot.get('collection', {}).get('records', [])) or
                any(a.get('submission') for a in snapshot.get('assessments', []))):
            from backend.reconciliation import project_sources
            project_sources(snapshot, self.ns)
        validated = self.store._validated(snapshot)
        self.execute(c, 'UPDATE snapshots SET snapshot=?,revision=revision+1 WHERE namespace=?',
                     json.dumps(validated, ensure_ascii=False, allow_nan=False), self.ns)

    def _snapshot_context(self, c):
        snapshot = self._snapshot(c)
        context = self.collection._context(snapshot)
        selected = snapshot['settings']['trackedCourseIds']
        if (self.collection._mode() == 'disabled' or not selected or
                len(selected) != len(context['courses']) or len(selected) > 100 or
                any(len(item['sourceCourseId']) > 128 for item in context['courses'])):
            raise QueueConflict()
        return snapshot, context

    def _lenient_mapping(self, snapshot):
        """Current unique mappings of selected courses; empty when the context is invalid."""
        if self.collection._mode() == 'disabled':
            return None, {}
        try:
            context = self.collection._context(snapshot)
        except CollectionRejected:
            return None, {}
        return context, {item['courseId']: item['sourceCourseId'] for item in context['courses']}

    def _job(self, c, row):
        result = {'id': row.id, 'courseId': row.course_id, 'state': row.state,
                  'attempts': row.attempts, 'generation': row.generation}
        if row.error_code:
            result['errorCode'] = row.error_code
        return result

    def _start(self, c, key):
        if self.execute(c, 'SELECT 1 FROM queue_key_aliases WHERE namespace=? AND idem=?', self.ns, key).first(): raise QueueConflict()
        old = self.execute(c, 'SELECT id,kind FROM queue_runs WHERE namespace=? AND idem=?', self.ns, key).first()
        if old:
            if old.kind != self.kind: raise QueueConflict()
            return self._run(c, old.id, None, 100)
        _, context = self._snapshot_context(c)
        ids = sorted(course['courseId'] for course in context['courses'])
        now = int(self.clock()); run_id = uuid4().hex
        self.execute(c, "INSERT INTO queue_runs(namespace,id,idem,course_ids,created,kind) VALUES(?,?,?,?,?,'scan')",
                     self.ns, run_id, key, json.dumps(ids, ensure_ascii=True), now)
        for course_id in ids:
            job = self.execute(c, "SELECT id,kind FROM queue_jobs WHERE namespace=? AND course_id=? AND state IN ('pending','running')", self.ns, course_id).first()
            if job and job.kind != self.kind: raise QueueConflict()
            job_id = job.id if job else uuid4().hex
            if not job:
                self.execute(c, "INSERT INTO queue_jobs(namespace,id,course_id,created,state,kind) VALUES(?,?,?,?,'pending','scan')", self.ns, job_id, course_id, now)
            self.execute(c, 'INSERT INTO queue_links(namespace,run_id,job_id) VALUES(?,?,?)', self.ns, run_id, job_id)
        return self._run(c, run_id, None, 100)

    def start(self, key):
        with self.collection.lock:
            return self.tx(lambda c: self._start(c, key))

    def sync(self):
        """Real-namespace Sync all: one transaction or nothing (fixed 409 messages)."""
        def action(c):
            snapshot = self._snapshot(c)
            selected = snapshot['settings']['trackedCourseIds']
            if not selected:
                raise SyncConflict(schemas.SYNC_NO_COURSES)
            try:
                context = self.collection._context(snapshot)
            except CollectionRejected:
                raise SyncConflict(schemas.SYNC_UNLINKED_COURSE) from None
            if (len(selected) != len(context['courses']) or len(selected) > 100 or
                    any(len(item['sourceCourseId']) > 128 for item in context['courses'])):
                raise SyncConflict(schemas.SYNC_UNLINKED_COURSE)
            for course_id in selected:
                job = self.execute(c, "SELECT kind FROM queue_jobs WHERE namespace=? AND course_id=? AND state IN ('pending','running')",
                                   self.ns, course_id).first()
                if job and job.kind != self.kind:
                    raise SyncConflict(schemas.SYNC_ALREADY_RUNNING)
            # Server-generated key: a client can never replay or choose the run.
            run = self._start(c, 'sync-' + uuid4().hex)
            for course_id in run['courseIds']:
                set_sync(snapshot, course_id, status='syncing', progress=0, error=None)
            self._save(c, snapshot)
            return self.store._validated(snapshot)
        with self.collection.lock:
            return self.tx(action)

    def _fail_jobs(self, c, rows, code, snapshot):
        for row in rows:
            self.execute(c, "UPDATE queue_jobs SET state='failed',error_code=?,generation=generation+1,token=NULL,expires=NULL WHERE namespace=? AND id=?",
                         code, self.ns, row.id)
            if not self.execute(c, 'SELECT 1 FROM scan_coverage WHERE namespace=? AND job_id=?', self.ns, row.id).first():
                # Server-only codes (claim_limit, #93 account codes) are not page reasons.
                reason = code if code in ('signed_out', 'invalid_context') else 'request_failed'
                self.execute(c, 'INSERT INTO scan_coverage(namespace,job_id,reasons) VALUES(?,?,?)', self.ns, row.id, canonical([reason]))
            forget_job_failures(c, row.id)
            if snapshot is not None:
                set_sync(snapshot, row.course_id, status='failed', progress=100, error=SYNC_ERRORS[code],
                         lastAttemptAt=now_iso())

    def _before_claim(self, c, now):
        snapshot = self._snapshot(c)
        _, mapping = self._lenient_mapping(snapshot)
        pending = self.execute(c, "SELECT * FROM queue_jobs WHERE namespace=? AND kind='scan' AND state='pending'", self.ns).all()
        capped = [row for row in pending if row.attempts >= CLAIM_CAP]
        # A deselected or unlinked course is fenced, never claimed with a stale mapping.
        fenced = [row for row in pending if row.attempts < CLAIM_CAP and row.course_id not in mapping]
        if not capped and not fenced:
            return
        verified = snapshot if self.verified else None
        self._fail_jobs(c, capped, 'claim_limit', verified)
        self._fail_jobs(c, fenced, 'invalid_context', verified)
        if verified is not None:
            self._save(c, snapshot)

    def claim(self):
        with self.collection.lock:
            return super().claim()

    def _enrich_claim(self, c, row, claim):
        snapshot = self._snapshot(c)
        context, mapping = self._lenient_mapping(snapshot)
        if row.course_id not in mapping or len(mapping[row.course_id]) > 128: raise QueueConflict()
        claim.update(sourceCourseId=mapping[row.course_id], selectionRevision=context['selectionRevision'])
        self.execute(c, 'UPDATE queue_jobs SET scan_revision=?,scan_source_id=? WHERE namespace=? AND id=?',
                     context['selectionRevision'], mapping[row.course_id], self.ns, row.id)

    def _current_mapping(self, c, row):
        snapshot = self._snapshot(c)
        context, mapping = self._lenient_mapping(snapshot)
        if (row.course_id not in mapping or context is None or row.scan_revision != context['selectionRevision'] or
                row.scan_source_id != mapping[row.course_id]): raise QueueConflict()
        return snapshot, context, mapping[row.course_id]

    def renew(self, job_id, generation, token):
        def action(c):
            row = self._valid(c, job_id, generation, token)
            self._current_mapping(c, row)
            expires = int(self.clock()) + 60
            self.execute(c, 'UPDATE queue_jobs SET expires=? WHERE namespace=? AND id=?', expires, self.ns, job_id)
            return {'expiresAt':expires}
        with self.collection.lock:
            return self.tx(action)

    def cancel(self, run_id):
        def action(c):
            before = {row.id for row in self.execute(c, """SELECT j.id FROM queue_jobs j JOIN queue_links l ON l.namespace=j.namespace
                AND l.job_id=j.id WHERE l.namespace=? AND l.run_id=? AND j.state IN ('pending','running')""", self.ns, run_id)}
            run = self._cancel(c, run_id)
            cancelled = [row for row in self.execute(c, "SELECT * FROM queue_jobs WHERE namespace=? AND state='cancelled'", self.ns).all()
                         if row.id in before]
            for row in cancelled:
                forget_job_failures(c, row.id)
            if cancelled and self.verified:
                snapshot = self._snapshot(c)
                for row in cancelled:
                    set_sync(snapshot, row.course_id, status='failed', progress=100, error=SYNC_ERRORS['cancelled'],
                             lastAttemptAt=now_iso())
                self._save(c, snapshot)
            return run
        with self.collection.lock:
            return self.tx(action)

    def finish(self, body):
        try:
            body = schemas.ScanFinish.model_validate(body).model_dump(exclude_none=True)
        except ValidationError:
            raise QueueInvalid() from None
        signed_out = body['outcome'] == 'failed' and body.get('errorCode') == 'signed_out'
        def pending_of_run(c, row):
            # The run's unstarted jobs: they fail without a claim, so without a Moodle request.
            return self.execute(c, """SELECT DISTINCT j.* FROM queue_jobs j JOIN queue_links l ON l.namespace=j.namespace AND l.job_id=j.id
                WHERE j.namespace=? AND j.kind='scan' AND j.state='pending' AND j.id<>? AND l.run_id IN
                (SELECT run_id FROM queue_links WHERE namespace=? AND job_id=?)""", self.ns, row.id, self.ns, row.id).all()
        def action(c):
            row = self._valid(c, body['jobId'], body['generation'], body['token'])
            snapshot, context, source = self._current_mapping(c, row)
            if row.scan_revision != body['selectionRevision']: raise QueueConflict()
            # #93: the received id is only compared here; it is not stored, logged or returned.
            account = self.collection.account_error(body.get('moodleUserId'))
            # Without an id, a failed finish, or one with no collector result (every page
            # failed, as on a 503 or a truncated page), keeps its own code, message and
            # cascade but merges no evidence. Only a completed finish with results needs it.
            unconfirmed_failure = account == 'account_unconfirmed' and (
                body['outcome'] == 'failed' or not any('result' in page for page in body['pages']))
            if account and not unconfirmed_failure:
                # Nothing from this batch is written; the run's pending jobs fail with the same code.
                self._fail_jobs(c, [row] + pending_of_run(c, row), account, snapshot)
                self._save(c, snapshot)
                return self._job(c, self.execute(c, 'SELECT * FROM queue_jobs WHERE namespace=? AND id=?', self.ns, row.id).one())
            for ordinal, page in enumerate(body['pages']):
                page_kind = page_id = None
                if 'pageUrl' in page:
                    if '#' in page['pageUrl']: raise QueueInvalid()
                    page_kind, page_id = route(page['pageUrl'])
                    allowed_types = {'assign':['assignment','submission'], 'quiz':['quiz'], 'calendar':['calendar'],
                                     'course':['course','material'], 'resource':['material'], 'url':['material'], 'folder':['material']}
                    if page['pageType'] not in allowed_types[page_kind]: raise QueueInvalid()
                    if page_kind == 'course' and page_id != source: raise QueueInvalid()
                if 'result' in page:
                    collector = page['collector']
                    if collector not in {'assign':['assignment','submission'], 'quiz':['quiz'], 'calendar':['calendar'],
                                         'course':['material'], 'resource':['material'], 'url':['material'], 'folder':['material']}[page_kind]:
                        raise QueueInvalid()
                    if page['pageType'] != collector and not (page_kind == 'course' and page['pageType'] == 'course' and collector == 'material'): raise QueueInvalid()
                    for raw in page['result'].get('observations', []):
                        if raw.get('sourceCourseId') != source: raise QueueInvalid()
                    for review in page['result'].get('reviews', []):
                        candidate = review.get('candidate', {})
                        if candidate.get('sourceCourseId') not in (None, source): raise QueueInvalid()
                    entry = {'revision': context['selectionRevision'], 'body': {'pageUrl':page['pageUrl'],
                             'visitId':f"scan:{row.id}:{ordinal}"}}
                    if not unconfirmed_failure:
                        self.collection._merge_refresh(snapshot, entry, {'collector':collector, 'result':page['result'],
                                                                         'observedAt':page['observedAt']}, body.get('moodleUserId'))
                evidence = {k:v for k,v in page.items() if k != 'result'}
                evidence['ordinal'] = ordinal
                self.execute(c, 'INSERT INTO scan_pages(namespace,job_id,ordinal,page) VALUES(?,?,?,?)',
                             self.ns, row.id, ordinal, canonical(evidence))
            # The session is gone: the run's unstarted jobs fail without a request.
            cascade = pending_of_run(c, row) if signed_out else []
            if self.verified:
                if body['outcome'] == 'completed':
                    incomplete = bool(body['incompleteReasons']) or any(p['coverage'] != 'complete' for p in body['pages'])
                    # #21: the earliest request of this scan; sources observed since were read again by it.
                    times = [p['observedAt'] for p in body['pages'] if p.get('observedAt')]
                    started = min(times, key=_instant) if times else None
                    set_sync(snapshot, row.course_id, status='partial' if incomplete else 'ok',
                             coverage='partial' if incomplete else 'full', progress=100, lastSuccessAt=now_iso(), error=None,
                             lastScanStartedAt=started)
                else:
                    set_sync(snapshot, row.course_id, status='failed', progress=100, error=SYNC_ERRORS[body['errorCode']],
                             lastAttemptAt=now_iso())
            self._fail_jobs(c, cascade, 'signed_out', snapshot if self.verified else None)
            self._save(c, snapshot)
            self.execute(c, 'INSERT INTO scan_coverage(namespace,job_id,reasons) VALUES(?,?,?)',
                         self.ns, row.id, canonical(body['incompleteReasons']))
            forget_job_failures(c, row.id)
            self.execute(c, 'UPDATE queue_jobs SET state=?,error_code=?,token=NULL,expires=NULL WHERE namespace=? AND id=?',
                         body['outcome'], body.get('errorCode'), self.ns, row.id)
            return self._job(c, self.execute(c, 'SELECT * FROM queue_jobs WHERE namespace=? AND id=?', self.ns, row.id).one())
        try:
            with self.collection.lock:
                return self.tx(action)
        except CollectionRejected as exc:
            raise QueueInvalid() from exc

    def pages(self, job_id, cursor=None, limit=100):
        def action(c):
            row = self.execute(c, 'SELECT state FROM queue_jobs WHERE namespace=? AND id=? AND kind=?', self.ns, job_id, self.kind).first()
            if not row: raise QueueMissing()
            try:
                offset = int(cursor) if cursor is not None else -1
                if offset < -1 or offset > 99 or cursor is not None and str(offset) != cursor: raise ValueError()
            except ValueError:
                raise QueueInvalid() from None
            rows = self.execute(c, 'SELECT ordinal,page FROM scan_pages WHERE namespace=? AND job_id=? AND ordinal>? ORDER BY ordinal LIMIT ?',
                                self.ns, job_id, offset, limit+1).all()
            coverage = self.execute(c, 'SELECT reasons FROM scan_coverage WHERE namespace=? AND job_id=?', self.ns, job_id).first()
            reasons = json.loads(coverage.reasons) if coverage else []
            result = {'pages':[json.loads(item.page) for item in rows[:limit]], 'incompleteReasons':reasons}
            if len(rows)>limit: result['nextCursor'] = str(rows[limit-1].ordinal)
            if 'signed_out' in reasons:
                result.update(signInGuidance=SIGN_IN, signInUrl='https://moodle.sdu.edu.kz/login/index.php')
            return result
        return self.tx(action)

    # Durable pacing for the extension's live request authority.
    def _gate(self):
        from backend.sqlite_store import SQLiteStore, StorageError
        if not isinstance(self.store, SQLiteStore):
            raise StorageError('Queue requires file-backed SQLite storage.')
        return ScanGate(self.store)

    def gate_acquire(self, now_ms, instance, request_key=None):
        return self._gate().reserve(now_ms, instance, request_key)

    def gate_release(self, token, not_before_ms, request_key=None, retry_failure=None):
        return {'released': self._gate().release_after_termination(token, not_before_ms, request_key, retry_failure)}
