"""Process binding is a precondition, never an identity selector."""
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.storage import InMemoryStore
from tests.test_contract import OPERATIONS


def test_binding_initialization_and_restart():
    app = create_app(InMemoryStore())
    initial = app.state.bridge_binding
    client = TestClient(app)
    assert client.get('/api/bridge-context').json() == {'version': '1', 'binding': initial}
    assert client.get('/api/bridge-context').json()['binding'] == initial
    with TestClient(app) as started:
        current = started.get('/api/bridge-context').json()['binding']
        assert current != initial
    with TestClient(app) as restarted:
        assert restarted.get('/api/bridge-context').json()['binding'] != current


def test_binding_precedes_parsing_and_every_service_operation(client):
    before = client.get('/api/snapshot').json()
    for method, path, _ in OPERATIONS:
        if path == '/api/bridge-context':
            continue
        url = path.replace('{assessmentId}', 'a1').replace('{candidateId}', 'k1').replace('{id}', 'missing')
        response = client.request(method, url, headers={'X-Moodle-Helper-Bridge-Binding': 'stale'}, content='{malformed')
        assert response.status_code == 409
        assert response.json() == {'message': 'Backend context changed. Reconnect.'}
        assert client.get('/api/snapshot').json() == before
    binding = client.get('/api/bridge-context').json()['binding']
    assert client.patch('/api/settings', json={'semesterWeeks': 18}, headers={'X-Moodle-Helper-Bridge-Binding': binding}).json()['settings']['semesterWeeks'] == 18
    assert client.patch('/api/settings', json={'semesterWeeks': 19}).json()['settings']['semesterWeeks'] == 19
