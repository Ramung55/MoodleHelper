"""Selected-course synthetic scan jobs; this module never enables a transport."""
import json
from uuid import uuid4
from pydantic import ValidationError

from backend import schemas
from backend.collection import CollectionRejected, canonical, route
from backend.queue import QueueConflict, QueueInvalid, QueueMissing, QueueService


class ScanQueueService(QueueService):
    kind = 'scan'

    def __init__(self, store, collection, **kwargs):
        super().__init__(store, **kwargs)
        self.collection = collection

    def _snapshot_context(self, c):
        snapshot = self.store._decode(self.execute(c, 'SELECT snapshot FROM snapshots WHERE namespace=?', self.ns).scalar_one())
        context = self.collection._context(snapshot)
        selected = snapshot['settings']['trackedCourseIds']
        if (not self.collection._enabled() or not selected or
                len(selected) != len(context['courses']) or len(selected) > 100 or
                any(len(item['sourceCourseId']) > 128 for item in context['courses'])):
            raise QueueConflict()
        return snapshot, context

    def _job(self, c, row):
        result = {'id': row.id, 'courseId': row.course_id, 'state': row.state,
                  'attempts': row.attempts, 'generation': row.generation}
        if row.error_code:
            result['errorCode'] = row.error_code
        return result

    def start(self, key):
        def action(c):
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
        with self.collection.lock:
            return self.tx(action)

    def claim(self):
        with self.collection.lock:
            return super().claim()

    def _enrich_claim(self, c, row, claim):
        _, context = self._snapshot_context(c)
        mapping = [item for item in context['courses'] if item['courseId'] == row.course_id]
        if len(mapping) != 1: raise QueueConflict()
        claim.update(sourceCourseId=mapping[0]['sourceCourseId'], selectionRevision=context['selectionRevision'])
        self.execute(c, 'UPDATE queue_jobs SET scan_revision=?,scan_source_id=? WHERE namespace=? AND id=?',
                     context['selectionRevision'], mapping[0]['sourceCourseId'], self.ns, row.id)

    def _current_mapping(self, c, row):
        snapshot, context = self._snapshot_context(c)
        mapping = [item for item in context['courses'] if item['courseId'] == row.course_id]
        if (len(mapping) != 1 or row.scan_revision != context['selectionRevision'] or
                row.scan_source_id != mapping[0]['sourceCourseId']): raise QueueConflict()
        return snapshot, context, mapping[0]['sourceCourseId']

    def renew(self, job_id, generation, token):
        def action(c):
            row = self._valid(c, job_id, generation, token)
            self._current_mapping(c, row)
            expires = int(self.clock()) + 60
            self.execute(c, 'UPDATE queue_jobs SET expires=? WHERE namespace=? AND id=?', expires, self.ns, job_id)
            return {'expiresAt':expires}
        with self.collection.lock:
            return self.tx(action)

    def finish(self, body):
        try:
            body = schemas.ScanFinish.model_validate(body).model_dump(exclude_none=True)
        except ValidationError:
            raise QueueInvalid() from None
        def action(c):
            row = self._valid(c, body['jobId'], body['generation'], body['token'])
            snapshot, context, source = self._current_mapping(c, row)
            if row.scan_revision != body['selectionRevision']: raise QueueConflict()
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
                    self.collection._merge_refresh(snapshot, entry, {'collector':collector, 'result':page['result'],
                                                                     'observedAt':page['observedAt']})
                evidence = {k:v for k,v in page.items() if k != 'result'}
                evidence['ordinal'] = ordinal
                self.execute(c, 'INSERT INTO scan_pages(namespace,job_id,ordinal,page) VALUES(?,?,?,?)',
                             self.ns, row.id, ordinal, canonical(evidence))
            validated = self.store._validated(snapshot)
            self.execute(c, 'UPDATE snapshots SET snapshot=?,revision=revision+1 WHERE namespace=?',
                         json.dumps(validated, ensure_ascii=False, allow_nan=False), self.ns)
            self.execute(c, 'INSERT INTO scan_coverage(namespace,job_id,reasons) VALUES(?,?,?)',
                         self.ns, row.id, canonical(body['incompleteReasons']))
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
                result.update(signInGuidance='Sign in to SDU Moodle to continue.', signInUrl='https://moodle.sdu.edu.kz/login/index.php')
            return result
        return self.tx(action)
