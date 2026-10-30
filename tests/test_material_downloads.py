"""#41 explicit material transfer metadata: fail-closed capability, idempotency, honest terminal truth."""
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL

from backend.main import create_app
from backend.sample_data import build_sample_snapshot
from backend.sqlite_store import SQLiteStore
from backend.storage import InMemoryStore

PDF_URL = 'https://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/lecture-1.pdf'


def snapshot(url=PDF_URL, file_type='pdf'):
    s = build_sample_snapshot()
    s['materials'].append({'id': 'm-pdf', 'courseId': 'c-csc', 'section': 'Week 1', 'title': 'Lecture 1', 'fileType': file_type,
                           'url': url, 'accessible': True, 'stale': False, 'lastCheckedAt': s['materials'][0]['lastCheckedAt'], 'syllabusSuggestion': False})
    return s


@pytest.fixture(params=['memory', 'sqlite'])
def make(request, tmp_path):
    opened = []
    def factory(snap=None, capability=True):
        if request.param == 'memory':
            store = InMemoryStore(snap or snapshot())
        else:
            store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / f'd{len(opened)}.sqlite3')))
            store.replace(snap or snapshot())
        client = TestClient(create_app(store, material_download_capability=capability))
        client.__enter__()
        opened.append((client, store))
        binding = client.get('/api/bridge-context').json()['binding']
        client.headers['X-Moodle-Helper-Bridge-Binding'] = binding
        return client, store
    yield factory
    for client, store in opened:
        client.__exit__(None, None, None)
        if isinstance(store, SQLiteStore):
            store.close()


def start(client, store, material='m-pdf', key='k1'):
    return client.post('/api/material-downloads', json={'datasetId': store.dataset_id, 'materialId': material, 'idempotencyKey': key})


def test_ordinary_runtime_fails_closed_without_verified_source(make):
    client, store = make(capability=None)
    r = start(client, store).json()
    assert r == {'supported': False, 'reason': 'source_unavailable', 'message': r['message']}
    assert 'Open the file in Moodle' in r['message']
    assert client.get('/api/material-downloads').json() == {'transfers': []}


@pytest.mark.parametrize('material,reason', [('missing', 'material_not_found'), ('m1', 'unsafe_destination')])
def test_unsupported_materials_never_register(make, material, reason):
    client, store = make()
    assert start(client, store, material).json()['reason'] == reason


def test_docx_and_links_are_truthfully_unsupported(make):
    client, store = make(snapshot(file_type='docx'))
    assert start(client, store).json()['reason'] == 'unsupported_type'
    client, store = make(snapshot(file_type='link'))
    assert start(client, store).json()['reason'] == 'not_a_file'


@pytest.mark.parametrize('url', ['https://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/a.pdf?token=x',
                                 'https://evil.example/pluginfile.php/42/mod_resource/content/3/a.pdf',
                                 'http://moodle.sdu.edu.kz/pluginfile.php/42/mod_resource/content/3/a.pdf',
                                 'https://moodle.sdu.edu.kz/pluginfile.php/42/mod_folder/content/3/a.pdf'])
def test_credential_bearing_or_foreign_destinations_rejected(make, url):
    client, store = make(snapshot(url=url))
    assert start(client, store).json()['reason'] == 'unsafe_destination'


def test_binding_and_dataset_preconditions(make):
    client, store = make()
    assert client.post('/api/material-downloads', headers={'X-Moodle-Helper-Bridge-Binding': 'stale'},
                       json={'datasetId': store.dataset_id, 'materialId': 'm-pdf', 'idempotencyKey': 'k'}).status_code == 409
    assert client.post('/api/material-downloads', json={'datasetId': 'other', 'materialId': 'm-pdf', 'idempotencyKey': 'k'}).status_code == 409


def test_repeated_clicks_return_the_same_active_transfer(make):
    client, store = make()
    first = start(client, store).json()['transfer']
    again = start(client, store, key='k2').json()
    assert again['transfer']['transferId'] == first['transferId'] and 'already' in again['message']
    assert start(client, store, key='k1').json()['transfer']['transferId'] == first['transferId']
    assert first['state'] == 'queued' and 'url' not in first


def run_to_saving(client, transfer_id):
    d = client.post(f'/api/material-downloads/{transfer_id}/descriptor').json()
    assert d['url'] == PDF_URL and d['format'] == 'pdf' and d['maxBytes'] == 20 * 1024 * 1024 and d['timeoutMs'] == 60000
    g = d['generation']
    r = client.post(f'/api/material-downloads/{transfer_id}/status', json={'generation': g, 'attemptId': d['attemptId'], 'state': 'validating', 'bytesReceived': 10}).json()
    r = client.post(f'/api/material-downloads/{transfer_id}/status', json={'generation': r['generation'], 'attemptId': d['attemptId'], 'state': 'saving', 'downloadId': 77}).json()
    return d, r


def test_chrome_id_is_not_completion_and_complete_records_identity(make):
    client, store = make()
    t = start(client, store).json()['transfer']
    d, saving = run_to_saving(client, t['transferId'])
    assert saving['state'] == 'saving' and saving['downloadId'] == 77 and 'completedAt' not in saving
    assert 'downloadedAt' not in next(m for m in store.read()['materials'] if m['id'] == 'm-pdf')
    assert client.post(f"/api/material-downloads/{t['transferId']}/descriptor").status_code == 409  # one-use
    bad = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': saving['generation'], 'attemptId': d['attemptId'], 'state': 'complete', 'downloadId': 78})
    assert bad.status_code == 409
    done = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': saving['generation'], 'attemptId': d['attemptId'], 'state': 'complete', 'downloadId': 77}).json()
    assert done['state'] == 'complete' and done['materialId'] == 'm-pdf' and done['downloadId'] == 77 and done['completedAt']
    assert next(m for m in store.read()['materials'] if m['id'] == 'm-pdf')['downloadedAt'] == done['completedAt']
    replay = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': 0, 'attemptId': d['attemptId'], 'state': 'complete', 'downloadId': 77})
    assert replay.json() == done
    assert client.get('/api/material-downloads').json() == {'transfers': [done]}
    # A finished transfer allows an explicit new attempt, never a duplicate active one.
    assert start(client, store, key='k3').json()['transfer']['transferId'] != t['transferId']


@pytest.mark.parametrize('reason', ['sign_in_required', 'timeout', 'too_large', 'unsupported_type'])
def test_failure_never_records_download(make, reason):
    client, store = make()
    t = start(client, store).json()['transfer']
    d = client.post(f"/api/material-downloads/{t['transferId']}/descriptor").json()
    assert client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': d['generation'], 'attemptId': d['attemptId'], 'state': 'failed'}).status_code == 409
    r = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': d['generation'], 'attemptId': d['attemptId'], 'state': 'failed', 'reason': reason}).json()
    assert r['state'] == 'failed' and r['reason'] == reason
    assert 'downloadedAt' not in next(m for m in store.read()['materials'] if m['id'] == 'm-pdf')
    assert client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': r['generation'], 'attemptId': d['attemptId'], 'state': 'saving'}).status_code == 409


def test_cancel_before_start_and_during_transfer(make):
    client, store = make()
    t = start(client, store).json()['transfer']
    c = client.post(f"/api/material-downloads/{t['transferId']}/cancel").json()
    assert c['state'] == 'cancelled' and c['reason'] == 'cancelled_by_user'
    assert client.post(f"/api/material-downloads/{t['transferId']}/descriptor").status_code == 409
    t = start(client, store, key='k2').json()['transfer']
    d, saving = run_to_saving(client, t['transferId'])
    c = client.post(f"/api/material-downloads/{t['transferId']}/cancel").json()
    assert c['cancelRequested'] and c['state'] == 'saving'
    # The page reports with the generation it held; cancellation fences it but allows the honest terminal.
    r = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': saving['generation'], 'attemptId': d['attemptId'], 'state': 'cancelled', 'reason': 'cancelled_by_user', 'downloadId': 77}).json()
    assert r['state'] == 'cancelled' and 'downloadedAt' not in next(m for m in store.read()['materials'] if m['id'] == 'm-pdf')


def test_wrong_attempt_and_stale_generation_rejected(make):
    client, store = make()
    t = start(client, store).json()['transfer']
    d = client.post(f"/api/material-downloads/{t['transferId']}/descriptor").json()
    assert client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': d['generation'], 'attemptId': 'other', 'state': 'validating'}).status_code == 409
    assert client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': 9, 'attemptId': d['attemptId'], 'state': 'validating'}).status_code == 409
    assert client.get('/api/material-downloads/nope').status_code == 404


def test_context_change_fails_descriptor(make):
    client, store = make()
    t = start(client, store).json()['transfer']
    def move(s):
        next(m for m in s['materials'] if m['id'] == 'm-pdf')['url'] = PDF_URL.replace('lecture-1', 'lecture-2')
    store.mutate(move)
    assert client.post(f"/api/material-downloads/{t['transferId']}/descriptor").status_code == 409
    assert client.get(f"/api/material-downloads/{t['transferId']}").json()['state'] == 'failed'


def test_collected_record_resolution():
    from backend.material_downloads import resolve
    o = {'kind': 'file', 'sourceModuleType': 'resource', 'fileType': {'kind': 'known', 'value': 'pdf'},
         'mimeType': {'kind': 'known', 'value': 'application/pdf'}, 'destinationUrl': PDF_URL,
         'title': {'kind': 'known', 'value': 'Лекция 1'}}
    s = {'materials': [], 'collection': {'records': [{'kind': 'material', 'id': 'r1', 'observations': [o]}]}}
    assert resolve(s, 'r1') == ({'url': PDF_URL, 'format': 'pdf', 'suggestedName': 'Лекция 1'}, None)
    folder = deepcopy(s); folder['collection']['records'][0]['observations'][0].update(kind='folder', sourceModuleType='folder')
    assert resolve(folder, 'r1') == (None, 'not_a_file')
    html = deepcopy(s); html['collection']['records'][0]['observations'][0]['mimeType']['value'] = 'text/html'
    assert resolve(html, 'r1') == (None, 'unsupported_type')


def test_body_bound(make):
    client, store = make()
    big = client.post('/api/material-downloads', content=b'{"x":"' + b'a' * (1024 * 1024 + 10) + b'"}', headers={'content-type': 'application/json'})
    assert big.status_code == 422
