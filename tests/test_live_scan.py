"""#20 live scan path in the trusted real (non-demo) namespace: Sync all, the
verified scan context, Snapshot sync entries, sign-out fencing, the claim cap,
preservation of earlier records and the durable request gate.

Pages are wire evidence shaped like the extension's live scan output; no
Moodle request is made here.
"""
from copy import deepcopy

import pytest
import yaml
from fastapi.testclient import TestClient
from pathlib import Path
from sqlalchemy import URL

from backend.identity import namespace_key
from backend.main import create_app
from backend.queue import QueueService
from backend.sample_data import build_sample_snapshot
from backend.scan_queue import CLAIM_CAP, SYNC_ERRORS
from backend.sqlite_store import SQLiteStore

ORIGIN = 'https://moodle.sdu.edu.kz'
REAL = namespace_key('moodle', origin=ORIGIN, profile_label='test', stable_user_id='synthetic-student')
TIME = '2028-03-05T10:00:00.000Z'
NO_COURSES = 'Select at least one course to sync.'
UNLINKED = 'A selected course is not linked to a Moodle course.'
RUNNING = 'A sync is already running for one of the selected courses. Try again when it finishes.'
SIGN_IN = 'Sign in to SDU Moodle to continue.'


def discovery(source):
    return dict(sourceCourseId=source, sourceUrl=f'{ORIGIN}/course/view.php?id={source}',
                title={'kind': 'known', 'value': f'Fictional course {source}'}, termIndicators={'kind': 'unknown'},
                currentTermStatus='unknown')


def seeded(tmp_path, selected=('c-csc', 'c-math'), mapped=('c-csc', 'c-math', 'c-phy')):
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'live.sqlite3')), REAL)
    snapshot = build_sample_snapshot()
    for course, source in zip(('c-csc', 'c-math', 'c-phy'), ('9001', '9002', '9003')):
        if course in mapped:
            next(c for c in snapshot['courses'] if c['id'] == course)['discovery'] = discovery(source)
    snapshot['settings']['trackedCourseIds'] = list(selected)
    store.replace(snapshot)
    return store


class Live:
    def __init__(self, store, clock):
        self.clock = clock
        self.client = TestClient(create_app(store, queue_clock=lambda: clock[0]))
        self.client.__enter__()
        self.store = store

    def h(self):
        return {'X-Moodle-Helper-Bridge-Binding': self.client.get('/api/bridge-context').json()['binding']}

    def post(self, path, body=None):
        return self.client.post(path, headers=self.h(), **({'json': body} if body is not None else {}))

    def runs(self):
        with self.store.engine.connect() as c:
            return c.exec_driver_sql('SELECT count(*) FROM queue_runs').scalar_one(), c.exec_driver_sql('SELECT count(*) FROM queue_jobs').scalar_one()

    def sync_entry(self, course):
        return next(s for s in self.client.get('/api/snapshot').json()['sync'] if s['courseId'] == course)

    def close(self):
        self.client.__exit__(None, None, None)
        self.store.close()


@pytest.fixture
def live(tmp_path):
    clock = [1000]
    harness = Live(seeded(tmp_path), clock)
    yield harness
    harness.close()


def quiz(cm, source='9001', closing='2028-03-04T09:00+05:00', time=TIME):
    return dict(sourceCourseId=source, sourceActivityId=cm, sourceCourseModuleId=cm,
                sourceUrl=f'{ORIGIN}/mod/quiz/view.php?id={cm}', title=f'Fictional quiz {cm}', observedAt=time,
                closing=dict(value=dict(kind='exact', iso=closing, tz='Asia/Almaty'),
                             rawText='Closed: Saturday, 4 March 2028, 9:00 AM', location='quiz.closing'),
                attemptInformation={'kind': 'unknown'})


def quiz_page(cm, source='9001', **kwargs):
    result = dict(kind='quiz', observations=[quiz(cm, source, **kwargs)], reviews=[], diagnostics=[], pages=[],
                  coverage='complete', scope='visited_activity_only')
    return dict(pageType='quiz', scope='visited_activity_only', outcome='ok', coverage='complete', reasons=[],
                observedAt=TIME, pageUrl=f'{ORIGIN}/mod/quiz/view.php?id={cm}', collector='quiz', result=result)


def course_page(source='9001'):
    return dict(pageType='course', scope='unknown', outcome='unavailable', coverage='none',
                reasons=['collector_unavailable'], observedAt=TIME, pageUrl=f'{ORIGIN}/course/view.php?id={source}')


def unavailable(kind, url):
    return dict(pageType=kind, scope='unknown', outcome='unavailable', coverage='none',
                reasons=['collector_unavailable'], observedAt=TIME, pageUrl=url)


def undiscovered(kind):
    return dict(pageType=kind, scope='unknown', outcome='undiscovered', coverage='none', reasons=['undiscovered', 'collector_unavailable'])


def completed(claim, pages):
    reasons = sorted({r for p in pages for r in p['reasons']})
    return dict(jobId=claim['job']['id'], generation=claim['generation'], token=claim['token'],
                selectionRevision=claim['selectionRevision'], outcome='completed', pages=pages,
                incompleteReasons=reasons)


def failed(claim, code, pages):
    reasons = sorted({r for p in pages for r in p['reasons']} | {code, 'undiscovered'})
    return dict(jobId=claim['job']['id'], generation=claim['generation'], token=claim['token'],
                selectionRevision=claim['selectionRevision'], outcome='failed', errorCode=code, pages=pages,
                incompleteReasons=reasons)


def full_scan(source, quizzes):
    return [course_page(source), *[quiz_page(cm, source) for cm in quizzes],
            unavailable('assignment', f'{ORIGIN}/mod/assign/view.php?id=990101'),
            undiscovered('calendar'), undiscovered('material'), undiscovered('submission')]


# AC1 -----------------------------------------------------------------------

def test_sync_all_queues_exactly_the_selected_mapped_courses(live):
    before = live.client.get('/api/snapshot').json()
    response = live.post('/api/sync')
    assert response.status_code == 200
    snapshot = response.json()
    assert {s['courseId']: (s['status'], s['progress']) for s in snapshot['sync'] if s['courseId'] in ('c-csc', 'c-math')} == \
        {'c-csc': ('syncing', 0), 'c-math': ('syncing', 0)}
    assert live.sync_entry('c-phy') == next(s for s in before['sync'] if s['courseId'] == 'c-phy')
    with live.store.engine.connect() as c:
        run_id = c.exec_driver_sql('SELECT id FROM queue_runs').scalar_one()
    run = live.client.get(f'/api/scan/runs/{run_id}').json()
    assert run['courseIds'] == ['c-csc', 'c-math'] and len(run['jobs']) == 2
    assert sorted(job['courseId'] for job in run['jobs']) == ['c-csc', 'c-math']
    # Claims carry exactly the selected Moodle mapping; the unselected 9003 never appears.
    sources = []
    for _ in range(2):
        claim = live.post('/api/scan/claim', {}).json()['claim']
        sources.append(claim['sourceCourseId'])
        assert live.post('/api/scan/finish', completed(claim, full_scan(claim['sourceCourseId'], []))).status_code == 200
    assert sorted(sources) == ['9001', '9002']
    assert live.post('/api/scan/claim', {}).json() == {'unfinished': False}


def test_second_sync_while_active_shares_jobs(live):
    assert live.post('/api/sync').status_code == 200
    assert live.post('/api/sync').status_code == 200
    runs, jobs = live.runs()
    assert (runs, jobs) == (2, 2)


@pytest.mark.parametrize('selected,mapped,message', [
    ((), ('c-csc',), NO_COURSES),
    (('c-csc', 'c-math'), ('c-csc',), UNLINKED),
    (('c-csc', 'c-missing'), ('c-csc',), UNLINKED),
])
def test_sync_conflicts_write_nothing(tmp_path, selected, mapped, message):
    harness = Live(seeded(tmp_path, selected, mapped), [1000])
    try:
        before = harness.client.get('/api/snapshot').json()
        response = harness.post('/api/sync')
        assert response.status_code == 409 and response.json() == {'message': message}
        assert harness.client.get('/api/snapshot').json() == before
        assert harness.runs() == (0, 0)
    finally:
        harness.close()


def test_active_mock_job_for_a_selected_course_conflicts_atomically(live):
    QueueService(live.store, clock=lambda: 1000).start('mock-active', ['c-math'])
    before = live.client.get('/api/snapshot').json()
    response = live.post('/api/sync')
    assert response.status_code == 409 and response.json() == {'message': RUNNING}
    assert live.client.get('/api/snapshot').json() == before
    assert live.runs() == (1, 1)


def test_demo_keeps_labelled_simulation_and_source_409_contract(tmp_path):
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'demo.sqlite3')))
    try:
        with TestClient(create_app(store)) as client:
            h = {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}
            response = client.post('/api/sync', headers=h)
            assert response.status_code == 200
            assert next(s for s in response.json()['sync'] if s['courseId'] == 'c-csc')['coverage'] == 'full'
            with store.engine.connect() as c:
                assert c.exec_driver_sql('SELECT count(*) FROM queue_runs').scalar_one() == 0
            generated = client.get('/openapi.json').json()
    finally:
        store.close()
    source = yaml.safe_load(Path('openapi.yaml').read_text(encoding='utf-8'))
    ref = source['paths']['/api/sync']['post']['responses']['409']['content']['application/json']['schema']['$ref']
    expected = source['components']['schemas'][ref.rsplit('/', 1)[-1]]['properties']['message']['enum']
    ref = generated['paths']['/api/sync']['post']['responses']['409']['content']['application/json']['schema']['$ref']
    actual = generated['components']['schemas'][ref.rsplit('/', 1)[-1]]['properties']['message']['enum']
    assert actual == expected == [NO_COURSES, UNLINKED, RUNNING, 'Backend context changed. Reconnect.']


def test_real_namespace_is_verified_and_refuses_visited_page_receipts(live):
    context = live.client.get('/api/collection-context').json()
    assert context['mode'] == 'verified' and 'reason' not in context
    response = live.client.post('/api/collection/visits', headers={'X-Moodle-Helper-Bridge-Binding': context['binding']},
                                json={'documentKey': 'document', 'visitId': 'visit', 'selectionRevision': context['selectionRevision'],
                                      'pageUrl': f'{ORIGIN}/course/view.php?id=9001'})
    assert response.status_code == 409
    assert 'collection' not in live.client.get('/api/snapshot').json()
    assert 'unavailable' not in live.client.get('/api/connection').json()['message']


# AC2 -----------------------------------------------------------------------

def test_completed_scan_with_incomplete_page_types_is_partial_never_full(live):
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    course = claim['job']['courseId']
    assert live.post('/api/scan/finish', completed(claim, full_scan(claim['sourceCourseId'], ['990103']))).status_code == 200
    entry = live.sync_entry(course)
    assert (entry['status'], entry['coverage'], entry['progress']) == ('partial', 'partial', 100)
    assert entry['lastSuccessAt'] and 'error' not in entry
    pages = live.client.get(f"/api/scan/jobs/{claim['job']['id']}/pages").json()
    assert [p['pageType'] for p in pages['pages']] == ['course', 'quiz', 'assignment', 'calendar', 'material', 'submission']
    assert pages['pages'][1]['outcome'] == 'ok' and pages['pages'][1]['coverage'] == 'complete'
    assert all(p['coverage'] in ('none', 'partial') and p['reasons'] for i, p in enumerate(pages['pages']) if i != 1)
    receipts = live.client.get('/api/snapshot').json()['collection']['refreshes']
    assert [r['evidenceMode'] for r in receipts] == ['verified']


def test_failed_job_keeps_last_success_and_sets_fixed_error(live):
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    before = live.sync_entry(claim['job']['courseId'])
    pages = [dict(pageType='course', scope='unknown', outcome='failed', coverage='none', reasons=['request_failed'],
                  observedAt=TIME, pageUrl=f"{ORIGIN}/course/view.php?id={claim['sourceCourseId']}")]
    assert live.post('/api/scan/finish', failed(claim, 'request_failed', pages)).status_code == 200
    entry = live.sync_entry(claim['job']['courseId'])
    assert entry['status'] == 'failed' and entry['error'] == SYNC_ERRORS['request_failed']
    assert entry.get('lastSuccessAt') == before.get('lastSuccessAt') and entry['coverage'] == before['coverage']


# AC4 -----------------------------------------------------------------------

def test_signed_out_fails_unstarted_jobs_without_requests_and_shows_guidance(live):
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    pages = [dict(pageType='course', scope='unknown', outcome='signed_out', coverage='none', reasons=['signed_out'],
                  observedAt=TIME, pageUrl=f"{ORIGIN}/course/view.php?id={claim['sourceCourseId']}")]
    assert live.post('/api/scan/finish', failed(claim, 'signed_out', pages)).status_code == 200
    for course in ('c-csc', 'c-math'):
        entry = live.sync_entry(course)
        assert entry['status'] == 'failed' and entry['error'] == SIGN_IN
    # Nothing left to claim, so the one-minute alarm cannot keep fetching the login page.
    assert live.post('/api/scan/claim', {}).json() == {'unfinished': False}
    with live.store.engine.connect() as c:
        rows = c.exec_driver_sql('SELECT id,state,error_code FROM queue_jobs').all()
    assert {(r.state, r.error_code) for r in rows} == {('failed', 'signed_out')}
    other = next(r.id for r in rows if r.id != claim['job']['id'])
    readback = live.client.get(f'/api/scan/jobs/{other}/pages').json()
    assert readback['pages'] == [] and readback['incompleteReasons'] == ['signed_out']
    assert readback['signInGuidance'] == SIGN_IN
    # A new Sync all starts fresh work.
    assert live.post('/api/sync').status_code == 200
    assert live.post('/api/scan/claim', {}).json()['claim']


# AC3(e) claim cap ----------------------------------------------------------

def test_claim_cap_bounds_repeated_worker_crashes(live):
    live.client.put('/api/tracked-courses', headers=live.h(), json=['c-csc'])
    live.post('/api/sync')
    claims = 0
    for _ in range(10):
        reply = live.post('/api/scan/claim', {}).json()
        if not reply.get('claim'):
            break
        claims += 1
        live.clock[0] += 61  # the worker crashed; its lease expires
    assert claims == CLAIM_CAP
    with live.store.engine.connect() as c:
        assert c.exec_driver_sql('SELECT state,error_code,attempts FROM queue_jobs').one() == ('failed', 'claim_limit', CLAIM_CAP)
    entry = live.sync_entry('c-csc')
    assert entry['status'] == 'failed' and entry['error'] == SYNC_ERRORS['claim_limit']


# AC5 -----------------------------------------------------------------------

def preserved(snapshot):
    return {k: v for k, v in snapshot.items() if k != 'sync'}


def seed_quizzes(live):
    """A first completed scan observes two quizzes, creating records and assessments."""
    live.client.put('/api/tracked-courses', headers=live.h(), json=['c-csc'])
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    assert live.post('/api/scan/finish', completed(claim, full_scan('9001', ['990103', '990109']))).status_code == 200
    snapshot = live.client.get('/api/snapshot').json()
    assert sum(a['type'] == 'quiz' for a in snapshot['assessments']) == 2
    assert snapshot['overlays'] and snapshot['materials'] and snapshot['candidates']
    return snapshot


@pytest.mark.parametrize('ending', ['signed_out', 'exhausted', 'cancelled', 'crash', 'missing_quiz'])
def test_partial_or_failed_scans_preserve_records_and_record_no_removal(live, ending):
    before = seed_quizzes(live)
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    url = f'{ORIGIN}/course/view.php?id=9001'
    if ending == 'signed_out':
        pages = [course_page(), dict(pageType='quiz', scope='unknown', outcome='signed_out', coverage='none',
                 reasons=['signed_out'], observedAt=TIME, pageUrl=f'{ORIGIN}/mod/quiz/view.php?id=990103')]
        assert live.post('/api/scan/finish', failed(claim, 'signed_out', pages)).status_code == 200
    elif ending == 'exhausted':
        pages = [dict(pageType='course', scope='unknown', outcome='failed', coverage='none', reasons=['request_failed'],
                      observedAt=TIME, pageUrl=url)]
        assert live.post('/api/scan/finish', failed(claim, 'request_failed', pages)).status_code == 200
    elif ending == 'cancelled':
        with live.store.engine.connect() as c:
            run_id = c.exec_driver_sql('SELECT run_id FROM queue_links WHERE job_id=? ORDER BY rowid DESC', (claim['job']['id'],)).first()[0]
        assert live.post(f'/api/scan/runs/{run_id}/cancel', {}).status_code == 200
        assert live.post('/api/scan/finish', completed(claim, full_scan('9001', []))).status_code == 409
        assert live.sync_entry('c-csc')['error'] == SYNC_ERRORS['cancelled']
    elif ending == 'crash':
        live.clock[0] += 61
    else:
        assert live.post('/api/scan/finish', completed(claim, full_scan('9001', ['990103']))).status_code == 200
    after = live.client.get('/api/snapshot').json()
    if ending == 'missing_quiz':
        # The quiz the scan no longer found keeps its record and assessment.
        assert after['assessments'] == before['assessments']
        assert after['overlays'] == before['overlays'] and after['materials'] == before['materials']
        assert after['candidates'] == before['candidates'] and after['reconciliation'] == before['reconciliation']
        assert after['collection']['records'] == before['collection']['records']
        assert len(after['collection']['refreshes']) == len(before['collection']['refreshes']) + 1
    else:
        assert preserved(after) == preserved(before)
    assert after['changes'] == before['changes']
    assert not any(state.get('accepted', {}).get('kind') == 'removed' for state in after.get('deadlineStreams', []))


def test_finish_rollback_leaves_sync_entry_evidence_and_queue_unchanged(live, monkeypatch):
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    before = live.client.get('/api/snapshot').json()
    scan = live.client.app.state.scan
    execute = scan.execute
    def crash(c, sql, *args):
        if sql.startswith('UPDATE queue_jobs SET state=?'):
            raise RuntimeError('injected crash')
        return execute(c, sql, *args)
    monkeypatch.setattr(scan, 'execute', crash)
    with pytest.raises(RuntimeError):
        scan.finish(completed(claim, full_scan(claim['sourceCourseId'], ['990103'])))
    monkeypatch.setattr(scan, 'execute', execute)
    assert live.client.get('/api/snapshot').json() == before
    assert live.client.get(f"/api/scan/jobs/{claim['job']['id']}/pages").json()['pages'] == []
    assert live.post('/api/scan/finish', completed(claim, full_scan(claim['sourceCourseId'], ['990103']))).status_code == 200


# Durable gate ---------------------------------------------------------------

def test_gate_spacing_retry_counts_and_stale_reclaim_over_http(live):
    assert live.client.post('/api/scan/gate/acquire', json={'nowMs': 10_000, 'instance': 'a'}).status_code == 409
    first = live.post('/api/scan/gate/acquire', {'nowMs': 10_000, 'instance': 'a', 'requestKey': '["job","u"]'}).json()
    assert first['state'] == 'reserved' and first['failures'] == 0
    # Same instance never reclaims its own reservation; another waits for 30 s.
    assert live.post('/api/scan/gate/acquire', {'nowMs': 60_000, 'instance': 'a'}).json() == {'state': 'busy'}
    assert live.post('/api/scan/gate/acquire', {'nowMs': 39_999, 'instance': 'b'}).json() == {'state': 'busy'}
    reclaimed = live.post('/api/scan/gate/acquire', {'nowMs': 40_000, 'instance': 'b'}).json()
    assert reclaimed['state'] == 'reserved'
    assert live.post('/api/scan/gate/release', {'token': first['token'], 'notBeforeMs': 0, 'requestKey': '["job","u"]'}).json() == {'released': False}
    assert live.post('/api/scan/gate/release', {'token': reclaimed['token'], 'notBeforeMs': 50_000}).json() == {'released': True}
    assert live.post('/api/scan/gate/acquire', {'nowMs': 49_999, 'instance': 'b'}).json() == {'state': 'busy'}
    now = 50_000
    for failures in range(3):
        reserved = live.post('/api/scan/gate/acquire', {'nowMs': now, 'instance': 'b', 'requestKey': 'key'}).json()
        assert reserved['state'] == 'reserved' and reserved['failures'] == failures
        # A shorter not-before never lowers the stored deadline.
        assert live.post('/api/scan/gate/release', {'token': reserved['token'], 'notBeforeMs': 0, 'requestKey': 'key', 'retryFailure': True}).json()['released']
        now += 1000
    assert live.post('/api/scan/gate/acquire', {'nowMs': now, 'instance': 'b', 'requestKey': 'key'}).json() == {'state': 'exhausted'}
    assert live.post('/api/scan/gate/acquire', {'nowMs': now, 'instance': 'b', 'requestKey': 'other'}).json()['state'] == 'reserved'
    for invalid in ({'nowMs': -1, 'instance': 'b'}, {'nowMs': 1, 'instance': 'bad id'}, {'nowMs': 1, 'instance': 'b', 'extra': 1}):
        assert live.post('/api/scan/gate/acquire', invalid).status_code == 422


def test_non_sqlite_real_namespace_stays_unavailable():
    from backend.storage import InMemoryStore
    from backend.services import SYNC_UNAVAILABLE
    class RealMemory(InMemoryStore):
        namespace = REAL
    with TestClient(create_app(RealMemory())) as client:
        h = {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}
        response = client.post('/api/sync', headers=h)
        assert response.status_code == 503 and response.json() == {'message': SYNC_UNAVAILABLE}
