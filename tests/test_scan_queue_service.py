from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import URL

from backend.collection import CollectionService, SyntheticCollectionContext
from backend.queue import QueueConflict, QueueInvalid, QueueService
from backend.sample_data import build_sample_snapshot
from backend.scan_queue import ScanQueueService
from backend.sqlite_store import SQLiteStore
from backend.main import create_app
from fastapi.testclient import TestClient
from test_page_refresh import ORIGIN, PAGE, TIME, assignment, result


@pytest.fixture
def service(tmp_path):
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'scan.db')))
    snapshot = build_sample_snapshot()
    snapshot['courses'][0]['discovery'] = dict(sourceCourseId='101', sourceUrl=ORIGIN+'/course/view.php?id=101',
        title={'kind':'known','value':'Synthetic course'}, termIndicators={'kind':'unknown'}, currentTermStatus='unknown')
    snapshot['settings']['trackedCourseIds'] = [snapshot['courses'][0]['id']]
    store.replace(snapshot)
    collection = CollectionService(store, 'binding', SyntheticCollectionContext(store.namespace))
    yield ScanQueueService(store, collection, clock=lambda:1000), store
    store.close()


def test_scan_atomic_merge_and_claim_fencing(service):
    queue, store = service
    before = deepcopy(store.read())
    run = queue.start('scan')
    claim = queue.claim()['claim']
    body = dict(jobId=claim['job']['id'], generation=claim['generation'], token=claim['token'],
        selectionRevision=claim['selectionRevision'], outcome='completed', incompleteReasons=['undiscovered'],
        pages=[dict(pageType='assignment', scope='visited_activity_only', outcome='ok', coverage='complete',
                    reasons=[], observedAt=TIME, pageUrl=PAGE, collector='assignment', result=result()),
               dict(pageType='quiz', scope='unknown', outcome='undiscovered', coverage='none', reasons=['undiscovered'])])
    finished = queue.finish(body)
    assert finished['state'] == 'completed'
    assert store.read()['collection']['records'][0]['observations'] == [assignment()]
    assert store.read()['assessments'] == before['assessments']
    assert queue.pages(finished['id'])['incompleteReasons'] == ['undiscovered']
    assert len(queue.pages(finished['id'])['pages']) == 2
    with pytest.raises(QueueConflict): queue.finish(body)
    assert queue.read(run['id'])['status'] == 'completed'


def test_cancellation_fences_late_scan_and_preserves_snapshot(service):
    queue, store = service
    run = queue.start('cancel')
    claim = queue.claim()['claim']
    queue.cancel(run['id'])
    snapshot = store.read()
    body = dict(jobId=claim['job']['id'], generation=claim['generation'], token=claim['token'],
        selectionRevision=claim['selectionRevision'], outcome='completed', pages=[], incompleteReasons=['undiscovered'])
    with pytest.raises(QueueConflict): queue.finish(body)
    assert store.read() == snapshot


def test_scan_http_requires_binding_and_synthetic_context(service):
    queue, store = service
    app = create_app(store, collection_provider=SyntheticCollectionContext(store.namespace), queue_clock=lambda:1000)
    with TestClient(app) as client:
        h = {'X-Moodle-Helper-Bridge-Binding':client.get('/api/bridge-context').json()['binding']}
        assert client.post('/api/scan/runs', json={'idempotencyKey':'http'}).status_code == 409
        run = client.post('/api/scan/runs', headers=h, json={'idempotencyKey':'http'}).json()
        claim = client.post('/api/scan/claim', headers=h, json={}).json()['claim']
        body = dict(jobId=claim['job']['id'], generation=claim['generation'], token=claim['token'],
                    selectionRevision=claim['selectionRevision'], outcome='completed', incompleteReasons=['undiscovered'],
                    pages=[dict(pageType='quiz', scope='unknown', outcome='undiscovered', coverage='none', reasons=['undiscovered'])])
        assert client.post('/api/scan/finish', headers=h, json=body).status_code == 200
        assert client.get('/api/scan/jobs/'+claim['job']['id']+'/pages').json()['incompleteReasons'] == ['undiscovered']
        assert client.get('/api/scan/runs/'+run['id']).json()['status'] == 'completed'
    with TestClient(create_app(store)) as client:
        h = {'X-Moodle-Helper-Bridge-Binding':client.get('/api/bridge-context').json()['binding']}
        assert client.post('/api/scan/runs', headers=h, json={'idempotencyKey':'disabled'}).status_code == 409


@pytest.mark.parametrize('page', [
    dict(pageType='assignment', scope='unknown', outcome='forbidden', coverage='none', reasons=['forbidden'], observedAt=TIME, pageUrl='https://user:password@evil.invalid/secret'),
    dict(pageType='unsupported', scope='unknown', outcome='unavailable', coverage='none', reasons=['collector_unavailable','unsupported_page'], observedAt=TIME, pageUrl='https://evil.invalid/'),
    dict(pageType='calendar', scope='visited_activity_only', outcome='ok', coverage='complete', reasons=[], observedAt=TIME, pageUrl=PAGE, collector='assignment', result=result()),
    dict(pageType='assignment', scope='unknown', outcome='forbidden', coverage='none', reasons=['forbidden'], observedAt=TIME, pageUrl=PAGE+'#fragment'),
])
def test_rejects_unsafe_or_mislabeled_page_without_side_effects(service, page):
    queue, store = service
    queue.start('unsafe')
    claim = queue.claim()['claim']
    before = store.read()
    body = dict(jobId=claim['job']['id'], generation=claim['generation'], token=claim['token'],
                selectionRevision=claim['selectionRevision'], outcome='completed', pages=[page],
                incompleteReasons=page['reasons'])
    with pytest.raises(QueueInvalid): queue.finish(body)
    assert store.read() == before
    assert queue.pages(claim['job']['id'])['pages'] == []


def test_mapping_change_fences_even_if_caller_submits_new_revision(service):
    queue, store = service
    queue.start('changed')
    claim = queue.claim()['claim']
    snapshot = store.read()
    snapshot['courses'][0]['discovery']['sourceCourseId'] = '102'
    snapshot['courses'][0]['discovery']['sourceUrl'] = ORIGIN+'/course/view.php?id=102'
    store.replace(snapshot)
    revised = queue.collection.context()['selectionRevision']
    assert revised != claim['selectionRevision']
    with pytest.raises(QueueConflict): queue.renew(claim['job']['id'],claim['generation'],claim['token'])
    body = dict(jobId=claim['job']['id'],generation=claim['generation'],token=claim['token'],
                selectionRevision=revised,outcome='completed',pages=[],incompleteReasons=['undiscovered'])
    with pytest.raises(QueueConflict): queue.finish(body)
    assert store.read() == snapshot


def test_crash_before_finalization_rolls_back_observations_and_coverage(service, monkeypatch):
    queue, store = service
    queue.start('crash'); claim = queue.claim()['claim']; before = store.read()
    body = dict(jobId=claim['job']['id'], generation=claim['generation'], token=claim['token'],
        selectionRevision=claim['selectionRevision'], outcome='completed', incompleteReasons=['undiscovered'],
        pages=[dict(pageType='assignment', scope='visited_activity_only', outcome='ok', coverage='complete',
                    reasons=[], observedAt=TIME, pageUrl=PAGE, collector='assignment', result=result())])
    execute = queue.execute
    def fail(c, sql, *args):
        if sql.startswith('UPDATE queue_jobs SET state='): raise RuntimeError('injected crash')
        return execute(c, sql, *args)
    monkeypatch.setattr(queue, 'execute', fail)
    with pytest.raises(RuntimeError): queue.finish(body)
    monkeypatch.setattr(queue, 'execute', execute)
    assert store.read() == before
    assert queue.pages(claim['job']['id'])['pages'] == []
    assert queue.finish(body)['state'] == 'completed'
    assert store.read()['collection']['records'][0]['observations'] == [assignment()]


@pytest.mark.parametrize('first_kind', ['mock', 'scan'])
def test_mixed_kind_conflicts_are_atomic_and_recover_after_terminal(service, first_kind):
    scan, store = service
    mock = QueueService(store, clock=lambda:1000)
    course = store.read()['settings']['trackedCourseIds'][0]
    first = mock.start('mock-first', [course]) if first_kind == 'mock' else scan.start('scan-first')
    with pytest.raises(QueueConflict):
        scan.start('other') if first_kind == 'mock' else mock.start('other', [course])
    with pytest.raises(QueueConflict):
        scan.start('mock-first') if first_kind == 'mock' else mock.start('scan-first', [course])
    with store.engine.connect() as c:
        assert c.exec_driver_sql("SELECT count(*) FROM queue_runs WHERE idem='other'").scalar_one() == 0
    (mock if first_kind == 'mock' else scan).cancel(first['id'])
    assert (scan.start('other') if first_kind == 'mock' else mock.start('other', [course]))['status'] == 'pending'


def test_concurrent_mixed_kind_start_has_one_atomic_winner(service):
    scan, store = service
    mock = QueueService(store, clock=lambda:1000)
    course = store.read()['settings']['trackedCourseIds'][0]
    def start(kind):
        try: return ('ok', mock.start('mock-race', [course]) if kind == 'mock' else scan.start('scan-race'))
        except QueueConflict: return ('conflict', None)
    with ThreadPoolExecutor(max_workers=2) as pool: outcomes = list(pool.map(start, ['mock','scan']))
    assert sorted(value[0] for value in outcomes) == ['conflict','ok']
    with store.engine.connect() as c:
        assert c.exec_driver_sql('SELECT count(*) FROM queue_runs').scalar_one() == 1
        assert c.exec_driver_sql('SELECT count(*) FROM queue_jobs').scalar_one() == 1
