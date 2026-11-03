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


def test_other_types_and_links_are_truthfully_unsupported(make):
    # #85: DOCX and PPTX are now allowed; any other type stays unsupported, links not a file.
    client, store = make(snapshot(file_type='other'))
    r = start(client, store).json()
    assert r['reason'] == 'unsupported_type'
    assert r['message'] == 'Only PDF, Word (DOCX) and PowerPoint (PPTX) files can be downloaded. Open this resource in Moodle instead.'
    for file_type in ('link', 'video'):
        client, store = make(snapshot(file_type=file_type))
        assert start(client, store).json()['reason'] == 'not_a_file'


@pytest.mark.parametrize('file_type', ['docx', 'pptx'])
def test_legacy_docx_and_pptx_register_with_their_format(make, file_type):
    client, store = make(snapshot(url=PDF_URL.replace('.pdf', '.' + file_type), file_type=file_type))
    t = start(client, store).json()['transfer']
    d = client.post(f"/api/material-downloads/{t['transferId']}/descriptor").json()
    assert d['format'] == file_type and d['url'].endswith('.' + file_type)


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


def _restore(client, store):
    ctx = client.get('/api/backups/restore-context').json()
    backup = {'app': 'moodle-helper', 'version': 1, 'exportedAt': '2026-10-01T10:00:00Z', 'note': '', 'datasetId': ctx['datasetId'], 'data': client.get('/api/snapshot').json()}
    return client.post('/api/backups/restore', json={'idempotencyKey': 'restore-mat-1', 'expectedDatasetId': ctx['datasetId'], 'expectedEpoch': ctx['epoch'], 'expectedRevision': ctx['revision'], 'backup': backup})


def test_restore_cancels_queued_and_fences_in_flight_transfers_atomically(make):
    """#55: restore neutralizes active transfers in the same transaction."""
    client, store = make()
    queued = start(client, store).json()['transfer']
    assert _restore(client, store).status_code == 200
    after = client.get(f"/api/material-downloads/{queued['transferId']}").json()
    assert after['state'] == 'cancelled' and after['cancelRequested']
    assert client.post(f"/api/material-downloads/{queued['transferId']}/descriptor").status_code == 409


def test_restore_fences_saving_transfer_and_rollback_keeps_it(make):
    client, store = make()
    t = start(client, store).json()['transfer']
    d, saving = run_to_saving(client, t['transferId'])
    from backend.sqlite_store import StorageError
    def boom():
        raise StorageError('injected')
    client.app.state.restore.before_commit = boom
    assert _restore(client, store).status_code == 503
    kept = client.get(f"/api/material-downloads/{t['transferId']}").json()
    assert kept['state'] == 'saving' and not kept['cancelRequested'] and kept['generation'] == saving['generation']
    client.app.state.restore.before_commit = None
    assert _restore(client, store).status_code == 200
    fenced = client.get(f"/api/material-downloads/{t['transferId']}").json()
    assert fenced['cancelRequested'] and fenced['generation'] == saving['generation'] + 1
    assert client.post(f"/api/material-downloads/{t['transferId']}/descriptor").status_code == 409


# ---- #41 pilot capability (owner decision 2026-11-02) ----
from backend.identity import namespace_key  # noqa: E402

REAL = namespace_key('moodle', origin='https://moodle.sdu.edu.kz', profile_label='test', stable_user_id='synthetic-student')
CMID = '990104'
VIEW_URL = f'https://moodle.sdu.edu.kz/mod/resource/view.php?id={CMID}'


def resource_record(rid='r-pdf', *, cm=CMID, url=None, module='resource', kind='file', file_type='pdf', mime=None):
    at = '2026-11-01T10:00:00Z'
    source = f'https://moodle.sdu.edu.kz/mod/{module}/view.php?id={cm}'
    o = {'sourcePageUrl': 'https://moodle.sdu.edu.kz/course/view.php?id=7001', 'sourceUrl': source, 'observedAt': at,
         'location': 'course.material', 'sourceCourseId': '7001', 'sourceCourseModuleId': cm, 'sourceModuleType': module,
         'resourceKey': f'["https://moodle.sdu.edu.kz","7001","{module}","module","{cm}"]', 'kind': kind,
         'title': {'kind': 'known', 'value': 'Лекция 1'}, 'section': {'kind': 'unknown'},
         'fileType': {'kind': 'known', 'value': file_type} if file_type else {'kind': 'unknown'},
         'mimeType': {'kind': 'known', 'value': mime} if mime else {'kind': 'unknown'},
         'destinationUrl': url if url is not None else f'https://moodle.sdu.edu.kz/mod/resource/view.php?id={cm}',
         'references': []}
    return {'kind': 'material', 'id': rid, 'courseId': '', 'firstObservedAt': at, 'lastObservedAt': at, 'observations': [o]}


def collected(*records):
    s = build_sample_snapshot()
    for r in records:
        r['courseId'] = s['courses'][0]['id']
    s['collection'] = {'records': list(records), 'reviews': [], 'refreshes': []}
    return s


@pytest.fixture
def real(tmp_path):
    opened = []
    def factory(snap, namespace=REAL, name='real'):
        store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / f'{name}{len(opened)}.sqlite3')), namespace)
        store.replace(snap)
        client = TestClient(create_app(store))  # No injected capability: trusted construction only.
        client.__enter__()
        opened.append((client, store))
        client.headers['X-Moodle-Helper-Bridge-Binding'] = client.get('/api/bridge-context').json()['binding']
        return client, store
    yield factory
    for client, store in opened:
        client.__exit__(None, None, None)
        store.close()


def test_verified_real_namespace_queues_resource_view_pdf(real):
    client, store = real(collected(resource_record()))
    assert client.get('/api/collection-context').json()['mode'] == 'verified'
    r = start(client, store, 'r-pdf').json()
    assert r['supported'] is True and r['transfer']['state'] == 'queued' and r.get('reason') != 'source_unavailable'
    d = client.post(f"/api/material-downloads/{r['transfer']['transferId']}/descriptor").json()
    assert d['url'] == VIEW_URL and d['format'] == 'pdf' and d['timeoutMs'] == 60000 and d['maxBytes'] == 20 * 1024 * 1024
    assert d['suggestedName'] == 'Лекция 1'


def test_demo_namespace_and_memory_store_stay_source_unavailable(real):
    client, store = real(collected(resource_record()), namespace=namespace_key(), name='demo')
    assert client.get('/api/collection-context').json()['mode'] != 'verified'
    r = start(client, store, 'r-pdf').json()
    assert r['reason'] == 'source_unavailable' and 'Open the file in Moodle' in r['message']
    memory_store = InMemoryStore(collected(resource_record()))
    with TestClient(create_app(memory_store)) as memory:
        memory.headers['X-Moodle-Helper-Bridge-Binding'] = memory.get('/api/bridge-context').json()['binding']
        assert start(memory, memory_store, 'r-pdf').json()['reason'] == 'source_unavailable'


def test_synthetic_provider_namespace_stays_source_unavailable(tmp_path):
    from backend.collection import SyntheticCollectionContext
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 's.sqlite3')), REAL)
    store.replace(collected(resource_record()))
    try:
        with TestClient(create_app(store, collection_provider=SyntheticCollectionContext(namespace=REAL))) as client:
            assert client.get('/api/collection-context').json()['mode'] == 'synthetic'
            client.headers['X-Moodle-Helper-Bridge-Binding'] = client.get('/api/bridge-context').json()['binding']
            assert start(client, store, 'r-pdf').json()['reason'] == 'source_unavailable'
    finally:
        store.close()


@pytest.mark.parametrize('record,reason', [
    (resource_record(cm='990105', url=VIEW_URL), 'unsafe_destination'),  # cmid does not match the record
    (resource_record(url=VIEW_URL + '&redirect=1'), 'unsafe_destination'),
    (resource_record(url='https://moodle.sdu.edu.kz/mod/url/view.php?id=' + CMID), 'unsafe_destination'),
    (resource_record(url='https://evil.example/mod/resource/view.php?id=' + CMID), 'unsafe_destination'),
    (resource_record(url='http://moodle.sdu.edu.kz/mod/resource/view.php?id=' + CMID), 'unsafe_destination'),
    (resource_record(module='folder', kind='folder'), 'not_a_file'),
    (resource_record(module='url', kind='link', file_type='link'), 'not_a_file'),
    (resource_record(module='resource', kind='link', file_type=None), 'not_a_file'),
    (resource_record(file_type='other', mime='application/epub+zip'), 'unsupported_type'),
    (resource_record(file_type='other'), 'unsupported_type'),
    (resource_record(file_type=None), 'unsupported_type'),
    (resource_record(file_type='docx', mime='application/pdf'), 'unsupported_type'),
    (resource_record(file_type='pptx', mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'unsupported_type'),
    (resource_record(file_type='pdf', mime='application/octet-stream'), 'unsupported_type'),
])
def test_real_namespace_destination_and_type_rules(real, record, reason):
    client, store = real(collected(record))
    assert start(client, store, 'r-pdf').json()['reason'] == reason


def test_real_namespace_keeps_exact_pluginfile_destination(real):
    client, store = real(collected(resource_record(url=PDF_URL.replace('/42/', '/55001/'))))
    assert start(client, store, 'r-pdf').json()['supported'] is True


@pytest.mark.parametrize('reason', ['not_a_file', 'network', 'sign_in_required', 'forbidden', 'not_found', 'timeout', 'download_interrupted'])
def test_new_failure_reasons_never_record_success(real, reason):
    client, store = real(collected(resource_record()))
    t = start(client, store, 'r-pdf').json()['transfer']
    d = client.post(f"/api/material-downloads/{t['transferId']}/descriptor").json()
    v = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': d['generation'], 'attemptId': d['attemptId'], 'state': 'validating'}).json()
    state = 'interrupted' if reason == 'download_interrupted' else 'failed'
    r = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': v['generation'], 'attemptId': d['attemptId'], 'state': state, 'reason': reason}).json()
    assert r['state'] == state and r['reason'] == reason and 'completedAt' not in r
    assert all('downloadedAt' not in m for m in store.read()['materials'])
    assert client.get('/api/material-downloads').json()['transfers'][0]['state'] == state


def _to_validating(client, store):
    t = start(client, store, 'r-pdf').json()['transfer']
    d = client.post(f"/api/material-downloads/{t['transferId']}/descriptor").json()
    v = client.post(f"/api/material-downloads/{t['transferId']}/status", json={'generation': d['generation'], 'attemptId': d['attemptId'], 'state': 'validating'}).json()
    return t['transferId'], d['attemptId'], v['generation']


def test_busy_network_detail_round_trips_to_the_dashboard_list(real):
    """#41 QA fix 2: a 429/503 stays failed/network and carries networkDetail=busy, never a success record."""
    client, store = real(collected(resource_record()))
    tid, attempt, gen = _to_validating(client, store)
    body = {'generation': gen, 'attemptId': attempt, 'state': 'failed', 'reason': 'network', 'networkDetail': 'busy'}
    r = client.post(f'/api/material-downloads/{tid}/status', json=body)
    assert r.status_code == 200
    assert (r.json()['state'], r.json()['reason'], r.json()['networkDetail']) == ('failed', 'network', 'busy')
    assert 'completedAt' not in r.json()
    assert client.post(f'/api/material-downloads/{tid}/status', json=body).json()['networkDetail'] == 'busy'  # idempotent replay
    assert client.get(f'/api/material-downloads/{tid}').json()['networkDetail'] == 'busy'
    listed = client.get('/api/material-downloads').json()['transfers'][0]
    assert (listed['state'], listed['reason'], listed['networkDetail']) == ('failed', 'network', 'busy')
    assert all('downloadedAt' not in m for m in store.read()['materials'])


def test_plain_network_failure_has_no_network_detail(real):
    client, store = real(collected(resource_record()))
    tid, attempt, gen = _to_validating(client, store)
    r = client.post(f'/api/material-downloads/{tid}/status', json={'generation': gen, 'attemptId': attempt, 'state': 'failed', 'reason': 'network'}).json()
    assert (r['state'], r['reason']) == ('failed', 'network') and 'networkDetail' not in r
    assert 'networkDetail' not in client.get('/api/material-downloads').json()['transfers'][0]


@pytest.mark.parametrize('extra', [
    {'state': 'failed', 'reason': 'timeout', 'networkDetail': 'busy'},
    {'state': 'interrupted', 'reason': 'network', 'networkDetail': 'busy'},
    {'state': 'saving', 'downloadId': 7, 'networkDetail': 'busy'},
])
def test_network_detail_only_on_a_failed_network_outcome(real, extra):
    client, store = real(collected(resource_record()))
    tid, attempt, gen = _to_validating(client, store)
    r = client.post(f'/api/material-downloads/{tid}/status', json={'generation': gen, 'attemptId': attempt, **extra})
    assert r.status_code == 409
    assert client.get(f'/api/material-downloads/{tid}').json()['state'] == 'validating'
    assert all('downloadedAt' not in m for m in store.read()['materials'])


@pytest.mark.parametrize('detail', ['Busy', 'rate_limited', '', None])
def test_network_detail_is_a_closed_enum(real, detail):
    client, store = real(collected(resource_record()))
    tid, attempt, gen = _to_validating(client, store)
    r = client.post(f'/api/material-downloads/{tid}/status', json={'generation': gen, 'attemptId': attempt, 'state': 'failed', 'reason': 'network', 'networkDetail': detail})
    assert r.status_code == 422
    assert client.get(f'/api/material-downloads/{tid}').json()['state'] == 'validating'


# ---- #85 DOCX and PPTX (owner decision 2026-11-03) ----
DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'


@pytest.mark.parametrize('file_type,mime', [('pdf', None), ('pdf', 'application/pdf'), ('docx', None), ('docx', DOCX_MIME),
                                            ('pptx', None), ('pptx', PPTX_MIME)])
def test_resolve_allows_pdf_docx_pptx_with_matching_or_unknown_mime(file_type, mime):
    from backend.material_downloads import resolve
    s = {'materials': [], 'collection': {'records': [resource_record(file_type=file_type, mime=mime)]}}
    assert resolve(s, 'r-pdf') == ({'url': VIEW_URL, 'format': file_type, 'suggestedName': 'Лекция 1'}, None)


@pytest.mark.parametrize('record,reason', [
    (resource_record(file_type='other', mime='application/epub+zip'), 'unsupported_type'),  # EPUB: declined
    (resource_record(file_type=None), 'unsupported_type'),
    (resource_record(file_type='docx', mime=PPTX_MIME), 'unsupported_type'),
    (resource_record(file_type='pptx', mime='application/zip'), 'unsupported_type'),
    (resource_record(module='folder', kind='folder', file_type=None), 'not_a_file'),
    (resource_record(module='folder', kind='file', file_type='docx'), 'not_a_file'),  # folder entry: declined
    (resource_record(module='page', kind='link', file_type=None, url=''), 'not_a_file'),
    (resource_record(module='url', kind='link', file_type='link'), 'not_a_file'),
    (resource_record(kind='link', file_type='video'), 'not_a_file'),
])
def test_resolve_declines_epub_unknown_mismatch_and_folders(record, reason):
    from backend.material_downloads import resolve
    assert resolve({'materials': [], 'collection': {'records': [record]}}, 'r-pdf') == (None, reason)


@pytest.mark.parametrize('file_type', ['docx', 'pptx'])
def test_verified_real_namespace_queues_docx_and_pptx(real, file_type):
    client, store = real(collected(resource_record(file_type=file_type)))
    r = start(client, store, 'r-pdf').json()
    assert r['supported'] is True and r['transfer']['state'] == 'queued'
    again = start(client, store, 'r-pdf', key='k2').json()  # repeated click: the same transfer
    assert again['transfer']['transferId'] == r['transfer']['transferId']
    d = client.post(f"/api/material-downloads/{r['transfer']['transferId']}/descriptor").json()
    assert d['url'] == VIEW_URL and d['format'] == file_type and d['maxBytes'] == 20 * 1024 * 1024


@pytest.mark.parametrize('before,after', [('pptx', 'docx'), ('docx', 'pptx'), ('pdf', 'pptx'), ('docx', 'other')])
def test_descriptor_fails_when_the_format_changed(real, before, after):
    client, store = real(collected(resource_record(file_type=before)))
    t = start(client, store, 'r-pdf').json()['transfer']
    def change(s):
        s['collection']['records'][0]['observations'][-1]['fileType'] = {'kind': 'known', 'value': after}
    store.mutate(change)
    assert client.post(f"/api/material-downloads/{t['transferId']}/descriptor").status_code == 409
    failed = client.get(f"/api/material-downloads/{t['transferId']}").json()
    assert failed['state'] == 'failed' and failed['reason'] in ('outcome_unknown', 'unsupported_type')
    assert all('downloadedAt' not in m for m in store.read()['materials'])


def test_descriptor_format_enum_is_additive():
    from backend.material_downloads import MaterialTransferDescriptor
    schema = MaterialTransferDescriptor.model_json_schema()['properties']['format']
    assert schema['enum'] == ['pdf', 'docx', 'pptx']
