"""#56 confirmed local-data erasure, epoch tombstone and no-resurrection fencing."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL, text

from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from backend.storage import InMemoryStore, EpochConflict, expected_epoch


@pytest.fixture(params=['memory', 'sqlite'])
def env(request, tmp_path):
    store = InMemoryStore() if request.param == 'memory' else SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'e.sqlite3')))
    with TestClient(create_app(store)) as client:
        yield client, store
    if isinstance(store, SQLiteStore):
        store.close()


def binding(client):
    return {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}


def body(client, key='erase-key-0001', **override):
    ctx = client.get('/api/data-context').json()
    return {'idempotencyKey': key, 'expectedDatasetId': ctx['datasetId'], 'expectedEpoch': ctx['epoch'], 'expectedRevision': ctx['revision'], **override}


def erase(client, **kw):
    return client.post('/api/local-data/erase', json=body(client, **kw), headers=binding(client))


def personalize(client):
    client.patch('/api/settings', json={'semesterWeeks': 9, 'reminders': {'enabled': True, 'hoursBefore': 2, 'busyWeek': False}, 'ai': {'enabled': True, 'consentGiven': True}})


def test_cancel_without_request_leaves_everything(env):
    client, _ = env
    before = client.get('/api/snapshot').json()
    assert client.get('/api/data-context').json()['lifecycle'] == 'active'
    assert client.get('/api/snapshot').json() == before


def test_erase_replaces_records_settings_with_first_run_defaults_and_keeps_identity(env):
    client, store = env
    personalize(client)
    dataset = store.dataset_id
    response = erase(client)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['datasetId'] == dataset and result['epoch'] == 1
    assert result['cleanup'] == {'backend': 'complete', 'dashboard': 'pending', 'extension': 'pending'}
    snap = client.get('/api/snapshot').json()
    for key in ('courses', 'assessments', 'overlays', 'materials', 'documents', 'candidates', 'sync', 'changes', 'alerts'):
        assert snap[key] == []
    for key in ('collection', 'reconciliation', 'deadlineStreams', 'syllabusRevisions', 'localSyllabusReceipts', 'dismissedSyllabusSuggestions'):
        assert key not in snap
    settings = snap['settings']
    assert settings['trackedCourseIds'] == [] and settings['semesterWeeks'] == 15
    assert settings['reminders']['enabled'] is False and settings['ai'] == {'enabled': False, 'consentGiven': False}
    assert 'teachingCalendar' not in settings
    assert client.get('/api/reminders/plan').json()['items'] == []
    assert client.get('/api/local-context').json() == {'datasetId': dataset}


def test_stale_context_and_missing_binding_reject_without_change(env):
    client, _ = env
    before = client.get('/api/snapshot').json()
    stale = client.post('/api/local-data/erase', json=body(client, expectedRevision=999), headers=binding(client))
    assert stale.status_code == 409
    assert client.post('/api/local-data/erase', json=body(client)).status_code == 409
    assert client.post('/api/local-data/erase', json={**body(client), 'namespace': 'x'}, headers=binding(client)).status_code == 422
    assert client.post('/api/local-data/erase?store=blobs', json=body(client), headers=binding(client)).status_code == 422
    assert client.get('/api/snapshot').json() == before
    assert client.get('/api/data-context').json()['epoch'] == 0


def test_backend_failure_rolls_back_everything(env):
    client, store = env
    before = client.get('/api/snapshot').json()

    def boom():
        raise RuntimeError('disk')
    client.app.state.erase.before_commit = boom
    with pytest.raises(RuntimeError):
        client.post('/api/local-data/erase', json=body(client), headers=binding(client))
    client.app.state.erase.before_commit = None
    assert client.get('/api/snapshot').json() == before
    assert client.get('/api/data-context').json()['lifecycle'] == 'active'


def test_same_key_replays_receipt_and_never_recreates(env):
    client, _ = env
    first = erase(client).json()
    replay = client.post('/api/local-data/erase', json={'idempotencyKey': 'erase-key-0001', 'expectedDatasetId': first['datasetId'],
                                                         'expectedEpoch': 0, 'expectedRevision': first['revision'] - 1}, headers=binding(client))
    assert replay.status_code == 200 and replay.json()['eraseId'] == first['eraseId']
    assert client.get('/api/data-context').json()['epoch'] == 1
    other = client.post('/api/local-data/erase', json={'idempotencyKey': 'erase-key-0001', 'expectedDatasetId': first['datasetId'],
                                                        'expectedEpoch': 1, 'expectedRevision': first['revision']}, headers=binding(client))
    assert other.status_code == 409


def test_epoch_header_fences_stale_writes_inside_transaction(env):
    client, store = env
    epoch = client.get('/api/data-context').json()['epoch']
    assert client.patch('/api/settings', json={'semesterWeeks': 8}, headers={'X-Moodle-Helper-Data-Epoch': str(epoch)}).status_code == 200
    erase(client)
    for method, path, payload in [('patch', '/api/settings', {'semesterWeeks': 7}), ('put', '/api/alerts', []),
                                  ('put', '/api/snapshot', None), ('post', '/api/demo/reset', None)]:
        kwargs = {'json': payload if payload is not None or path != '/api/snapshot' else client.get('/api/snapshot').json()}
        response = client.request(method, path, headers={'X-Moodle-Helper-Data-Epoch': str(epoch)}, **kwargs)
        assert response.status_code == 409, path
    assert client.get('/api/snapshot').json()['settings']['semesterWeeks'] == 15
    assert client.patch('/api/settings', json={'semesterWeeks': 7}, headers={'X-Moodle-Helper-Data-Epoch': 'x'}).status_code == 422
    # A job accepted before erase that commits later is rejected in its own transaction.
    token = expected_epoch.set(epoch)
    try:
        with pytest.raises(EpochConflict):
            store.mutate(lambda s: s['courses'].append({'id': 'c-old'}))
    finally:
        expected_epoch.reset(token)
    assert client.get('/api/snapshot').json()['courses'] == []


def test_acknowledgements_are_closed_idempotent_and_drive_lifecycle(env):
    client, _ = env
    erase_id = erase(client).json()['eraseId']
    status = client.get(f'/api/local-data/erasures/{erase_id}').json()
    assert status['current'] is True and status['cleanup']['dashboard'] == 'pending'
    url = f'/api/local-data/erasures/{erase_id}/ack'
    assert client.post(url, json={'component': 'dashboard', 'state': 'complete'}).status_code == 409  # binding
    assert client.post(url, json={'component': 'blobs', 'state': 'complete'}, headers=binding(client)).status_code == 422
    assert client.post(url, json={'component': 'extension', 'state': 'failed'}, headers=binding(client)).json()['cleanup']['extension'] == 'failed'
    assert client.get('/api/data-context').json()['lifecycle'] == 'cleanup_pending'
    client.post(url, json={'component': 'dashboard', 'state': 'complete'}, headers=binding(client))
    client.post(url, json={'component': 'extension', 'state': 'complete'}, headers=binding(client))
    done = client.post(url, json={'component': 'dashboard', 'state': 'failed'}, headers=binding(client)).json()
    assert done['cleanup'] == {'backend': 'complete', 'dashboard': 'complete', 'extension': 'complete'}
    assert client.get('/api/data-context').json()['lifecycle'] == 'complete'
    assert client.get('/api/local-data/erasures/' + '0' * 32).status_code == 404


def test_legacy_delete_keeps_documented_partial_semantics(env):
    client, _ = env
    personalize(client)
    snap = client.delete('/api/local-data').json()
    assert snap['courses'] == [] and snap['settings']['semesterWeeks'] == 9


def test_sqlite_erase_deletes_jobs_and_tombstone_survives_restart_without_reseed(tmp_path):
    url = URL.create('sqlite', database=str(tmp_path / 'r.sqlite3'))
    store = SQLiteStore(url)
    ns = {'n': store.namespace}
    with store._transaction() as c:
        c.execute(text("INSERT INTO queue_runs(namespace,id,idem,course_ids,created) VALUES(:n,'r1','k1','[]',0)"), ns)
        c.execute(text("INSERT INTO queue_jobs(namespace,id,course_id,created,state) VALUES(:n,'j1','c-csc',0,'running')"), ns)
        c.execute(text("INSERT INTO reminder_requests(namespace,delivery_key,request_id) VALUES(:n,'d','r')"), ns)
        c.execute(text("INSERT INTO material_transfers(namespace,transfer_id,material_id,created,record) VALUES(:n,'t','m','x','{}')"), ns)
    with TestClient(create_app(store)) as client:
        dataset = store.dataset_id
        assert erase(client).status_code == 200
    with store.engine.connect() as c:
        for table in ('queue_runs', 'queue_jobs', 'reminder_requests', 'material_transfers'):
            assert c.execute(text(f'SELECT COUNT(*) FROM {table} WHERE namespace=:n'), ns).scalar_one() == 0
        receipt = c.execute(text('SELECT * FROM erase_receipts')).mappings().one()
        assert set(receipt) == {'namespace', 'idem', 'erase_id', 'fingerprint', 'epoch', 'revision', 'dashboard', 'extension', 'created'}
    store.close()
    reopened = SQLiteStore(url)
    try:
        with TestClient(create_app(reopened)) as client:
            ctx = client.get('/api/data-context').json()
            assert ctx['epoch'] == 1 and ctx['datasetId'] == dataset and ctx['lifecycle'] == 'cleanup_pending'
            assert client.get('/api/snapshot').json()['courses'] == []
    finally:
        reopened.close()
