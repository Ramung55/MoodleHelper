"""Exercise the explicitly ephemeral entry point and its durable capability boundary."""

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app as create_backend_app
from backend.memory import create_app
from backend.storage import InMemoryStore
from test_contract import OPERATIONS


def test_memory_startup_never_opens_database_and_restarts_fresh(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        pytest.fail('The memory entry point attempted to open SQLite.')

    monkeypatch.setattr('backend.main.SQLiteStore', forbidden)
    monkeypatch.setenv('MOODLE_HELPER_DATABASE_URL', 'sqlite:///' + str(tmp_path / 'forbidden.db'))
    application = create_app()
    with TestClient(application) as client:
        assert isinstance(application.state.service.store, InMemoryStore)
        initial = client.get('/api/snapshot').json()
        identity = client.get('/api/local-context').json()
        assert initial['courses']
        assert client.get('/docs').status_code == 200
        assert client.get('/openapi.json').status_code == 200
        assert client.delete('/api/local-data').json()['courses'] == []
        assert client.get('/api/local-context').json() == identity
    with TestClient(application) as client:
        assert client.get('/api/snapshot').json()['courses'] == initial['courses']
        assert client.get('/api/local-context').json() != identity
    assert not (tmp_path / 'forbidden.db').exists()


def test_memory_app_instances_are_independent():
    with TestClient(create_app()) as first, TestClient(create_app()) as second:
        original = second.get('/api/snapshot').json()
        assert first.patch('/api/settings', json={'semesterWeeks': 20}).status_code == 200
        assert first.delete('/api/local-data').status_code == 200
        assert second.get('/api/snapshot').json() == original
        assert first.get('/api/bridge-context').json() != second.get('/api/bridge-context').json()


def test_store_factory_conflict_rejected_and_owned_store_closed():
    with pytest.raises(ValueError, match='either store or store_factory'):
        create_backend_app(InMemoryStore(), store_factory=InMemoryStore)

    class OwnedStore(InMemoryStore):
        closed = False

        def close(self):
            self.closed = True

    owned = OwnedStore()
    with TestClient(create_backend_app(store_factory=lambda: owned)):
        assert not owned.closed
    assert owned.closed


@pytest.mark.parametrize('method,path,body', OPERATIONS)
def test_memory_entrypoint_existing_operations_match_source_contract(contract, contract_validator, method, path, body):
    with TestClient(create_app()) as client:
        operation = contract['paths'][path][method]
        url = path.replace('{assessmentId}', 'a1').replace('{candidateId}', 'k1').replace('{id}', 'missing')
        if body == 'snapshot':
            body = client.get('/api/snapshot').json()
        if body is not None:
            contract_validator(operation['requestBody']['content']['application/json']['schema'], body)
        response = client.request(method, url, **({'json': body} if body is not None else {}))
        assert response.status_code == 200, response.text
        contract_validator(operation['responses']['200']['content']['application/json']['schema'], response.json())


TOKEN = {'jobId': 'example', 'generation': 1, 'token': 'example'}
DURABLE_OPERATIONS = [
    ('get', '/api/queue/current', None),
    ('post', '/api/queue/current', {'idempotencyKey': 'example'}),
    ('post', '/api/queue/runs', {'idempotencyKey': 'example', 'courseIds': ['c-csc']}),
    ('get', '/api/queue/runs/example', None),
    ('post', '/api/queue/runs/example/cancel', None),
    ('post', '/api/queue/claim', {}),
    ('post', '/api/queue/renew', TOKEN),
    ('post', '/api/queue/finish', {**TOKEN, 'outcome': 'completed'}),
    ('post', '/api/scan/runs', {'idempotencyKey': 'example'}),
    ('get', '/api/scan/runs/example', None),
    ('post', '/api/scan/runs/example/cancel', None),
    ('post', '/api/scan/claim', {}),
    ('post', '/api/scan/renew', TOKEN),
    ('post', '/api/scan/finish', {**TOKEN, 'selectionRevision': '0' * 64,
                               'outcome': 'completed', 'pages': [], 'incompleteReasons': ['undiscovered']}),
    ('get', '/api/scan/jobs/example/pages', None),
]


@pytest.mark.parametrize('method,path,body', DURABLE_OPERATIONS)
def test_durable_operations_report_unavailable_without_mutation(method, path, body, contract, contract_validator):
    with TestClient(create_app()) as client:
        before = client.get('/api/snapshot').json()
        headers = {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}
        response = client.request(method, path, headers=headers, **({'json': body} if body is not None else {}))
        assert response.status_code == 503, response.text
        assert response.json() == {'message': 'Queue requires file-backed SQLite storage.'}
        contract_validator(contract['components']['schemas']['ProposedHttpError'], response.json())
        assert client.get('/api/snapshot').json() == before


def test_memory_validation_and_context_preconditions_remain_atomic():
    with TestClient(create_app()) as client:
        before = client.get('/api/snapshot').json()
        assert client.put('/api/snapshot', json={'courses': []}).status_code == 422
        assert client.post('/api/personal-events', content='{', headers={'Content-Type': 'application/json'}).status_code == 422
        assert client.post('/api/queue/runs', json={}).status_code == 409
        assert client.patch('/api/settings', json={'semesterWeeks': 20},
                            headers={'X-Moodle-Helper-Bridge-Binding': 'stale'}).status_code == 409
        assert client.get('/api/collection-context').json()['mode'] == 'disabled'
        assert client.get('/api/snapshot').json() == before
