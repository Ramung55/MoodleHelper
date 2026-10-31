"""#62: reset and sync (and every write) require the current process binding."""
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL

from backend.identity import namespace_key
from backend.main import create_app
from backend.sample_data import build_sample_snapshot
from backend.services import SYNC_UNAVAILABLE
from backend.sqlite_store import SQLiteStore
from backend.storage import InMemoryStore

H = 'X-Moodle-Helper-Bridge-Binding'
EVIL = {'origin': 'https://evil.example', 'content-type': 'text/plain'}
STALE = {H: 'stale-binding-from-a-previous-process'}


@pytest.fixture
def client():
    store = InMemoryStore()
    snapshot = build_sample_snapshot()
    snapshot['settings']['trackedCourseIds'] = []
    store.replace(snapshot)
    with TestClient(create_app(store), bind_writes=False) as client:
        yield client


def binding(client):
    return {H: client.get('/api/bridge-context').json()['binding']}


@pytest.mark.parametrize('path', ['/api/demo/reset', '/api/sync'])
@pytest.mark.parametrize('headers', [{}, STALE, EVIL, {**EVIL, **STALE}], ids=['absent', 'stale', 'cross-site', 'cross-site-stale'])
@pytest.mark.parametrize('body', [None, b'', b'{}', b'not json'], ids=['none', 'empty', 'json', 'text'])
def test_unbound_or_stale_write_is_409_and_changes_nothing(client, path, headers, body):
    before = deepcopy(client.get('/api/snapshot').json())
    response = client.post(path, headers=headers, **({} if body is None else {'content': body}))
    assert response.status_code == 409
    assert response.json() == {'message': 'Backend context changed. Reconnect.'}
    assert client.get('/api/snapshot').json() == before


def test_rejection_happens_before_the_service_runs(client, monkeypatch):
    calls = []
    service = client.app.state.service
    monkeypatch.setattr(service, 'reset_demo', lambda: calls.append('reset'))
    monkeypatch.setattr(service, 'sync_all', lambda: calls.append('sync'))
    for path in ['/api/demo/reset', '/api/sync']:
        assert client.post(path, headers=EVIL).status_code == 409
    assert calls == []


def test_current_binding_reset_returns_sample_snapshot(client):
    response = client.post('/api/demo/reset', headers=binding(client))
    assert response.status_code == 200
    assert response.json() == client.get('/api/snapshot').json()
    assert response.json()['courses'] == build_sample_snapshot()['courses']


def test_current_binding_sync_behaves_as_before(client):
    response = client.post('/api/sync', headers=binding(client))
    assert response.status_code == 200


def test_current_binding_sync_keeps_unavailable_path(tmp_path):
    namespace = namespace_key('moodle', origin='https://moodle.sdu.edu.kz', profile_label='test', stable_user_id='synthetic')
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'sync.sqlite3')), namespace)
    try:
        snapshot = build_sample_snapshot()
        snapshot['settings']['trackedCourseIds'] = ['c-csc']
        store.replace(snapshot)
        with TestClient(create_app(store), bind_writes=False) as client:
            assert client.post('/api/sync').status_code == 409
            response = client.post('/api/sync', headers=binding(client))
            assert response.status_code == 503 and response.json() == {'message': SYNC_UNAVAILABLE}
    finally:
        store.close()


def test_docs_still_load_and_swagger_reset_without_header_is_409(client):
    assert client.get('/docs').status_code == 200
    assert client.post('/api/demo/reset', headers={'accept': 'application/json'}).status_code == 409
