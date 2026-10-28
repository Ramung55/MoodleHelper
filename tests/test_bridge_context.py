"""Process binding is a precondition, never an identity selector."""
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.storage import InMemoryStore
from tests.test_contract import OPERATIONS
import json
import re
from pathlib import Path
import yaml


def test_shared_closed_inventory_tracks_source_contract():
    root = Path(__file__).parents[1]
    source = yaml.safe_load((root / 'openapi.yaml').read_text(encoding='utf-8'))
    bridge = (root / 'shared/src/bridge.ts').read_text(encoding='utf-8')
    inventory = json.loads(re.search(r'const schemas: Record<string, any> = (.*?);\s*export const catalog', bridge, re.S)[1])
    catalog = json.loads(re.search(r'export const catalog = (.*?) as const;', bridge, re.S)[1])
    assert inventory == source['components']['schemas']
    expected = {}
    for path, operations in source['paths'].items():
        for method, operation in operations.items():
            if path.startswith(('/api/queue/','/api/scan/')) or operation['operationId'] in {'bridgeContext','collectionContext','beginPageVisit','ingestPageRefresh'}:
                continue
            expected[operation['operationId']] = {
                'method': method.upper(), 'path': path,
                'body': operation.get('requestBody', {}).get('content', {}).get('application/json', {}).get('schema'),
                'result': operation['responses']['200']['content']['application/json']['schema'],
            }
    for name, method, path in [('currentMockRun','get','/api/queue/current'), ('startMockRun','post','/api/queue/current'), ('cancelMockRun','post','/api/queue/runs/{runId}/cancel')]:
        operation = source['paths'][path][method]
        expected[name] = {'method':method.upper(), 'path':path,
                          'body':operation.get('requestBody', {}).get('content', {}).get('application/json', {}).get('schema'),
                          'result':operation['responses']['200']['content']['application/json']['schema']}
    assert catalog == expected
    assert len(catalog)==24
    assert not {'collectionContext','beginPageVisit','ingestPageRefresh'} & catalog.keys()


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

