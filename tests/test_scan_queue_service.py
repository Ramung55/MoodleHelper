from copy import deepcopy

import pytest
from sqlalchemy import URL

from backend.collection import CollectionService, SyntheticCollectionContext
from backend.queue import QueueConflict
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
