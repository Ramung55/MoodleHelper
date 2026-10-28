from concurrent.futures import ThreadPoolExecutor
from uuid import UUID
from fastapi.testclient import TestClient
from sqlalchemy import URL
from backend.identity import namespace_key
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from backend.storage import InMemoryStore


def test_memory_context_is_per_instance_and_rejects_selectors():
    first, second = InMemoryStore(), InMemoryStore()
    with TestClient(create_app(first)) as client:
        body = client.get('/api/local-context').json()
        assert set(body) == {'datasetId'}
        UUID(body['datasetId'])
        assert body['datasetId'] == client.get('/api/local-context').json()['datasetId']
        assert client.get('/api/local-context?namespace=other').status_code == 422
    assert first.dataset_id != second.dataset_id


def test_sqlite_identity_survives_restart_reset_and_isolates_namespaces(tmp_path):
    url = URL.create('sqlite', database=str(tmp_path / 'identity.sqlite3'))
    namespace = namespace_key('moodle', origin='https://moodle.sdu.edu.kz', profile_label='test', stable_user_id='student')
    first = SQLiteStore(url)
    other = SQLiteStore(url, namespace)
    original = first.dataset_id
    assert original != other.dataset_id
    with TestClient(create_app(first)) as client:
        assert client.get('/api/local-context').json() == {'datasetId': original}
        client.delete('/api/local-data')
    first.close()
    again = SQLiteStore(url)
    assert again.dataset_id == original
    again.close()
    other.close()


def test_concurrent_initialization_commits_one_identity(tmp_path):
    url = URL.create('sqlite', database=str(tmp_path / 'race.sqlite3'))
    def create(_):
        store = SQLiteStore(url, timeout=10)
        identity = store.dataset_id
        store.close()
        return identity
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert len(set(pool.map(create, range(4)))) == 1
