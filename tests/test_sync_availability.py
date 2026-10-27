"""Live user actions must not silently fall back to demo simulation."""
from copy import deepcopy

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy import URL

from backend.collection import SyntheticCollectionContext
from backend.identity import namespace_key
from backend.main import create_app
from backend.sample_data import build_sample_snapshot
from backend.services import SYNC_UNAVAILABLE
from backend.sqlite_store import SQLiteStore
from pathlib import Path


@pytest.mark.parametrize('injected', [False, True])
def test_non_demo_sync_unavailable_without_mutating_snapshot_or_queue(tmp_path, injected):
    namespace = namespace_key('moodle', origin='https://moodle.sdu.edu.kz', profile_label='test', stable_user_id='synthetic')
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'sync.sqlite3')), namespace)
    try:
        snapshot = build_sample_snapshot()
        snapshot['settings']['trackedCourseIds'] = ['c-csc']
        snapshot['courses'][0]['discovery'] = dict(sourceCourseId='101', sourceUrl='https://moodle.sdu.edu.kz/course/view.php?id=101',
            title={'kind':'known','value':'Synthetic course'}, termIndicators={'kind':'unknown'}, currentTermStatus='unknown')
        store.replace(snapshot)
        provider = SyntheticCollectionContext(namespace) if injected else None
        with TestClient(create_app(store, collection_provider=provider)) as client:
            before = deepcopy(client.get('/api/snapshot').json())
            if injected:
                context = client.get('/api/collection-context').json()
                h = {'X-Moodle-Helper-Bridge-Binding':context['binding']}
                visit = client.post('/api/collection/visits', headers=h, json={'documentKey':'document', 'visitId':'visit',
                    'pageUrl':'https://moodle.sdu.edu.kz/course/view.php?id=101', 'selectionRevision':context['selectionRevision']})
                assert visit.status_code == 200
            for body in (None, {'mode':'demo'}, {'mode':'verified'}):
                response = client.post('/api/sync', **({'json':body} if body is not None else {}))
                assert response.status_code == 503
                assert response.json() == {'message':SYNC_UNAVAILABLE}
                assert client.get('/api/snapshot').json() == before
            assert client.get('/api/connection').json()['state'] == 'disconnected'
            with store.engine.connect() as db:
                assert db.exec_driver_sql('SELECT count(*) FROM queue_runs').scalar_one() == 0
                assert db.exec_driver_sql('SELECT count(*) FROM queue_jobs').scalar_one() == 0
            if injected:
                assert client.get('/api/collection-context').json()['selectionRevision'] == context['selectionRevision']
                assert visit.json()['visitToken'] in client.app.state.collection.tokens
    finally:
        store.close()


def test_demo_namespace_retains_explicit_simulation(tmp_path):
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'demo.sqlite3')))
    try:
        with TestClient(create_app(store)) as client:
            assert client.get('/api/connection').json()['state'] == 'demo'
            response = client.post('/api/sync')
            assert response.status_code == 200
            assert next(row for row in response.json()['sync'] if row['courseId']=='c-csc')['coverage'] == 'full'
    finally:
        store.close()


def test_source_and_generated_sync_error_contract_are_identical(tmp_path):
    source = yaml.safe_load(Path('openapi.yaml').read_text(encoding='utf-8'))
    source_ref = source['paths']['/api/sync']['post']['responses']['503']['content']['application/json']['schema']['$ref']
    source_schema = source['components']['schemas'][source_ref.rsplit('/',1)[-1]]
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'contract.sqlite3')))
    try:
        with TestClient(create_app(store)) as client:
            generated = client.get('/openapi.json').json()
            ref = generated['paths']['/api/sync']['post']['responses']['503']['content']['application/json']['schema']['$ref']
            actual = generated['components']['schemas'][ref.rsplit('/',1)[-1]]
            assert actual['additionalProperties'] is False
            assert actual['required'] == source_schema['required'] == ['message']
            assert actual['properties']['message']['const'] == source_schema['properties']['message']['const'] == SYNC_UNAVAILABLE
    finally:
        store.close()
