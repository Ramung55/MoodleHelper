"""Durable mock queue. SQLite is the sole authority; execution is at least once."""
import json
import secrets
import sqlite3
import time
from uuid import uuid4
from sqlalchemy.exc import SQLAlchemyError
from backend.sqlite_store import SQLiteStore, StorageError, storage_failure

LEASE_SECONDS = 60
STATES = ('pending', 'running', 'completed', 'failed', 'cancelled')

class QueueConflict(Exception): pass
class QueueMissing(Exception): pass
class QueueInvalid(Exception): pass

class QueueService:
    def __init__(self, store, concurrency=1, clock=time.time):
        self.store, self.concurrency, self.clock = store, concurrency, clock

    def tx(self, operation):
        if not isinstance(self.store, SQLiteStore):
            raise StorageError('Queue requires file-backed SQLite storage.')
        try:
            with self.store._transaction() as c:
                return operation(c)
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc

    @property
    def ns(self): return self.store.namespace

    def execute(self, c, sql, *args):
        return c.exec_driver_sql(sql, args)

    def start(self, key, ids):
        ids = sorted(ids)
        def action(c):
            existing = self.execute(c, 'SELECT id, course_ids, kind FROM queue_runs WHERE namespace=? AND idem=?', self.ns, key).first()
            if existing:
                if existing.kind != 'mock' or json.loads(existing.course_ids) != ids: raise QueueConflict()
                return self._run(c, existing.id, None, 100)
            snapshot = self.store._decode(self.execute(c, 'SELECT snapshot FROM snapshots WHERE namespace=?', self.ns).scalar_one())
            if not set(ids) <= {x['id'] for x in snapshot['courses']}: raise QueueInvalid()
            now = int(self.clock()); run_id = uuid4().hex
            self.execute(c, 'INSERT INTO queue_runs(namespace,id,idem,course_ids,created) VALUES(?,?,?,?,?)', self.ns, run_id, key, json.dumps(ids, ensure_ascii=True), now)
            for course_id in ids:
                job = self.execute(c, "SELECT id,kind FROM queue_jobs WHERE namespace=? AND course_id=? AND state IN ('pending','running')", self.ns, course_id).first()
                if job and job.kind != 'mock': raise QueueConflict()
                job_id = job.id if job else uuid4().hex
                if not job:
                    self.execute(c, "INSERT INTO queue_jobs(namespace,id,course_id,created,state) VALUES(?,?,?,?,'pending')", self.ns, job_id, course_id, now)
                self.execute(c, 'INSERT INTO queue_links(namespace,run_id,job_id) VALUES(?,?,?)', self.ns, run_id, job_id)
            return self._run(c, run_id, None, 100)
        return self.tx(action)

    def _job(self, c, row):
        result = {'id':row.id, 'courseId':row.course_id, 'state':row.state, 'attempts':row.attempts, 'generation':row.generation}
        if row.error_code: result['errorCode'] = row.error_code
        saved = self.execute(c, 'SELECT id,summary FROM queue_results WHERE namespace=? AND job_id=?', self.ns, row.id).first()
        if saved: result['result'] = {'id':saved.id, 'summary':saved.summary}
        return result

    def _run(self, c, run_id, cursor, limit, kind='mock'):
        run = self.execute(c, 'SELECT * FROM queue_runs WHERE namespace=? AND id=? AND kind=?', self.ns, run_id, kind).first()
        if not run: raise QueueMissing()
        counts = {s:0 for s in STATES}
        for state, count in self.execute(c, 'SELECT j.state, count(*) FROM queue_jobs j JOIN queue_links l ON l.namespace=j.namespace AND l.job_id=j.id WHERE l.namespace=? AND l.run_id=? GROUP BY j.state', self.ns, run_id): counts[state] = count
        counts['total'] = sum(counts.values())
        status = ('cancelled' if run.cancelled else 'running' if counts['running'] else 'pending' if counts['pending'] else 'failed' if counts['failed'] else 'completed')
        rows = self.execute(c, 'SELECT j.* FROM queue_jobs j JOIN queue_links l ON l.namespace=j.namespace AND l.job_id=j.id WHERE l.namespace=? AND l.run_id=? AND j.id>? ORDER BY j.id LIMIT ?', self.ns, run_id, cursor or '', limit+1).all()
        out = {'id':run.id,'idempotencyKey':run.idem,'courseIds':json.loads(run.course_ids),'createdAt':run.created,'status':status,'cancelled':bool(run.cancelled),'progress':counts,'jobs':[self._job(c, row) for row in rows[:limit]]}
        if len(rows)>limit: out['nextCursor'] = rows[limit-1].id
        return out

    def read(self, run_id, cursor=None, limit=100): return self.tx(lambda c:self._run(c, run_id, cursor, limit))

    def cancel(self, run_id):
        def action(c):
            run = self._run(c, run_id, None, 100)
            if run['status'] == 'completed' or run['cancelled']: return run
            self.execute(c, 'UPDATE queue_runs SET cancelled=1 WHERE namespace=? AND id=?', self.ns, run_id)
            self.execute(c, """UPDATE queue_jobs SET state='cancelled', generation=generation+1, token=NULL, expires=NULL
                WHERE namespace=? AND state IN ('pending','running') AND id IN
                (SELECT job_id FROM queue_links WHERE namespace=? AND run_id=?) AND NOT EXISTS
                (SELECT 1 FROM queue_links l JOIN queue_runs r ON r.namespace=l.namespace AND r.id=l.run_id
                 WHERE l.namespace=queue_jobs.namespace AND l.job_id=queue_jobs.id AND r.cancelled=0)""", self.ns, self.ns, run_id)
            return self._run(c, run_id, None, 100)
        return self.tx(action)

    def claim(self):
        def action(c):
            now=int(self.clock())
            # Expiration is a reclaim, never a successful completion.
            self.execute(c, "UPDATE queue_jobs SET state='pending',token=NULL,expires=NULL WHERE namespace=? AND kind='mock' AND state='running' AND expires<=?", self.ns, now)
            active=self.execute(c, "SELECT count(*) FROM queue_jobs WHERE namespace=? AND kind='mock' AND state='running' AND expires>?", self.ns, now).scalar_one()
            unfinished=bool(self.execute(c, "SELECT 1 FROM queue_jobs WHERE namespace=? AND kind='mock' AND state IN ('pending','running') LIMIT 1", self.ns).first())
            if active>=self.concurrency: return {'unfinished':unfinished}
            row=self.execute(c, """SELECT j.* FROM queue_jobs j WHERE j.namespace=? AND j.kind='mock' AND j.state='pending' AND EXISTS
                (SELECT 1 FROM queue_links l JOIN queue_runs r ON r.namespace=l.namespace AND r.id=l.run_id
                 WHERE l.namespace=j.namespace AND l.job_id=j.id AND r.cancelled=0)
                 ORDER BY j.created,j.id LIMIT 1""", self.ns).first()
            if not row: return {'unfinished':unfinished}
            token=secrets.token_urlsafe(32); generation=row.generation+1; expires=now+LEASE_SECONDS
            self.execute(c, "UPDATE queue_jobs SET state='running',attempts=attempts+1,generation=?,token=?,expires=? WHERE namespace=? AND id=?", generation, token, expires, self.ns, row.id)
            row=self.execute(c, 'SELECT * FROM queue_jobs WHERE namespace=? AND id=?', self.ns, row.id).one()
            return {'unfinished':True,'claim':{'job':self._job(c,row),'token':token,'generation':generation,'expiresAt':expires}}
        return self.tx(action)

    def _valid(self,c,job_id,generation,token):
        row=self.execute(c, """SELECT j.* FROM queue_jobs j WHERE j.namespace=? AND j.id=? AND j.kind='mock' AND j.state='running'
            AND j.generation=? AND j.token=? AND j.expires>? AND EXISTS
            (SELECT 1 FROM queue_links l JOIN queue_runs r ON r.namespace=l.namespace AND r.id=l.run_id
             WHERE l.namespace=j.namespace AND l.job_id=j.id AND r.cancelled=0)""", self.ns,job_id,generation,token,int(self.clock())).first()
        if not row: raise QueueConflict()
        return row

    def renew(self,job_id,generation,token):
        def action(c):
            self._valid(c,job_id,generation,token); expires=int(self.clock())+LEASE_SECONDS
            self.execute(c, 'UPDATE queue_jobs SET expires=? WHERE namespace=? AND id=?',expires,self.ns,job_id)
            return {'expiresAt':expires}
        return self.tx(action)

    def finish(self,job_id,generation,token,outcome,error):
        if (outcome=='failed') != (error=='mock_failure'): raise QueueInvalid()
        def action(c):
            row=self._valid(c,job_id,generation,token)
            if outcome=='completed':
                self.execute(c, 'INSERT INTO queue_results(namespace,job_id,id,summary) VALUES(?,?,?,?)',self.ns,job_id,job_id,'Synthetic mock scan completed')
            self.execute(c, 'UPDATE queue_jobs SET state=?,error_code=?,token=NULL,expires=NULL WHERE namespace=? AND id=?',outcome,error,self.ns,job_id)
            return self._job(c,self.execute(c,'SELECT * FROM queue_jobs WHERE namespace=? AND id=?',self.ns,job_id).one())
        return self.tx(action)
