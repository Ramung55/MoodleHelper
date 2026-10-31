"""#55 validated atomic backup restore."""
import json
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL, text

from backend.backup_restore import MAX_BACKUP_BYTES, unsafe_url_reason
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from backend.storage import InMemoryStore


@pytest.fixture(params=['memory', 'sqlite'])
def env(request, tmp_path):
    store = InMemoryStore() if request.param == 'memory' else SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'b.sqlite3')))
    with TestClient(create_app(store)) as client:
        yield client, store
    if isinstance(store, SQLiteStore):
        store.close()


def headers(client):
    return {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}


def backup_of(client, data=None, **extra):
    data = client.get('/api/snapshot').json() if data is None else data
    dataset = client.get('/api/local-context').json()['datasetId']
    return {'app': 'moodle-helper', 'version': 1, 'exportedAt': '2026-10-01T10:00:00.000Z', 'note': 'n', 'datasetId': dataset,
            'summary': {'counts': [], 'exclusions': [], 'redactions': 0}, 'data': data, **extra}


def request_body(client, backup, key='restore-key-1', **override):
    context = client.get('/api/backups/restore-context').json()
    return {'idempotencyKey': key, 'expectedDatasetId': context['datasetId'], 'expectedEpoch': context['epoch'],
            'expectedRevision': context['revision'], 'backup': backup, **override}


def incoming(client):
    data = client.get('/api/snapshot').json()
    data['settings']['semesterWeeks'] = 9
    data['overlays'] = [{'assessmentId': data['assessments'][0]['id'], 'completed': True, 'hidden': False}]
    return data


def test_restore_replaces_snapshot_settings_overlays_and_rebuilds_reminders_once(env):
    client, _ = env
    data = incoming(client)
    before = client.get('/api/backups/restore-context').json()
    response = client.post('/api/backups/restore', json=request_body(client, backup_of(client, data)), headers=headers(client))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['remindersRebuilt'] is True and body['replayed'] is False
    assert body['epoch'] == before['epoch'] + 1 and body['revision'] == before['revision'] + 1
    saved = client.get('/api/snapshot').json()
    assert saved['settings']['semesterWeeks'] == 9
    assert saved['overlays'][0]['completed'] is True
    assert client.get('/api/reminders/plan').json()['generation'] == body['reminderGeneration']


def test_response_loss_retry_reads_same_receipt_without_second_replace(env):
    client, _ = env
    body = request_body(client, backup_of(client, incoming(client)))
    first = client.post('/api/backups/restore', json=body, headers=headers(client)).json()
    second = client.post('/api/backups/restore', json=body, headers=headers(client)).json()
    assert second['replayed'] is True and second['restoreId'] == first['restoreId'] and second['epoch'] == first['epoch']
    assert client.get('/api/backups/restore-context').json()['revision'] == first['revision']
    changed = dict(body, backup=dict(body['backup'], note='other'))
    assert client.post('/api/backups/restore', json=changed, headers=headers(client)).status_code == 409


@pytest.mark.parametrize('mutate,message', [
    (lambda b: b.pop('datasetId'), 'Identity unavailable'),
    (lambda b: b.update(datasetId='00000000-0000-4000-8000-000000000000'), 'Wrong identity'),
    (lambda b: b.update(version=2), 'newer than this app'),
    (lambda b: b.update(version=0), 'Unsupported backup format version'),
    (lambda b: b.update(app='other'), 'not a Moodle Helper backup'),
    (lambda b: b.update(exportedAt='yesterday'), 'timestamp is invalid'),
    (lambda b: b.update(summary={'counts': 1}), 'summary metadata is invalid'),
    (lambda b: b['data'].pop('assessments'), 'Snapshot shape'),
    (lambda b: b['data']['materials'][0].update(url='https://moodle.example/pluginfile.php/1?token=abc'), 'credential-bearing, expiring'),
    (lambda b: b['data']['materials'][0].update(url='https://s3.example/x?X-Amz-Expires=300'), 'credential-bearing, expiring'),
])
def test_invalid_backups_rejected_with_specific_message_and_zero_mutation(env, mutate, message):
    client, _ = env
    original, context = client.get('/api/snapshot').json(), client.get('/api/backups/restore-context').json()
    backup = backup_of(client, incoming(client))
    if not backup['data']['materials']:
        backup['data']['materials'] = deepcopy(original['materials'][:1]) or pytest.skip('no material fixture')
    mutate(backup)
    response = client.post('/api/backups/restore', json=request_body(client, backup), headers=headers(client))
    assert response.status_code == 422 and message in response.json()['message']
    assert client.get('/api/snapshot').json() == original
    assert client.get('/api/backups/restore-context').json() == context


def test_oversize_rejected_before_parse_and_binding_required(env):
    client, _ = env
    original = client.get('/api/snapshot').json()
    big = b'{"x":"' + b'a' * (MAX_BACKUP_BYTES + 8192) + b'"}'
    response = client.post('/api/backups/restore', content=big, headers={**headers(client), 'Content-Type': 'application/json'})
    assert response.status_code == 413 and '20 MiB' in response.json()['message']
    body = request_body(client, backup_of(client))
    assert client.post('/api/backups/restore', json=body).status_code in (409, 422)
    assert client.post('/api/backups/restore', json=body, headers={'X-Moodle-Helper-Bridge-Binding': 'stale'}).status_code == 409
    bad = client.post('/api/backups/restore', content=b'{"a":', headers={**headers(client), 'Content-Type': 'application/json'})
    assert bad.status_code == 422 and 'not valid JSON' in bad.json()['message']
    utf = client.post('/api/backups/restore', content=b'{"a":"\xff"}', headers={**headers(client), 'Content-Type': 'application/json'})
    assert utf.status_code == 422 and 'UTF-8' in utf.json()['message']
    nested = backup_of(client)
    nested['data'] = json.loads('[' * 100 + ']' * 100)
    deep = client.post('/api/backups/restore', json=request_body(client, nested), headers=headers(client))
    assert deep.status_code == 422
    assert client.get('/api/snapshot').json() == original


def test_stale_revision_after_concurrent_write_is_rejected(env):
    client, _ = env
    body = request_body(client, backup_of(client, incoming(client)))
    client.patch('/api/settings', json={'semesterWeeks': 15})
    after = client.get('/api/snapshot').json()
    response = client.post('/api/backups/restore', json=body, headers=headers(client))
    assert response.status_code == 409 and 'Refresh the preview' in response.json()['message']
    assert client.get('/api/snapshot').json() == after


def test_failure_before_commit_rolls_back_snapshot_epoch_and_receipt(env):
    client, _ = env
    original, context = client.get('/api/snapshot').json(), client.get('/api/backups/restore-context').json()
    def boom():
        from backend.sqlite_store import StorageError
        raise StorageError('injected')
    client.app.state.restore.before_commit = boom
    body = request_body(client, backup_of(client, incoming(client)))
    assert client.post('/api/backups/restore', json=body, headers=headers(client)).status_code == 503
    assert client.get('/api/snapshot').json() == original
    assert client.get('/api/backups/restore-context').json() == context
    client.app.state.restore.before_commit = None
    assert client.post('/api/backups/restore', json=body, headers=headers(client)).json()['replayed'] is False


def test_restored_pending_notifications_are_not_replayed(env):
    client, _ = env
    data = incoming(client)
    data['alerts'] = [{'id': 'al-1', 'kind': 'deadline', 'message': 'Due', 'deliveryKey': 'dk-1', 'createdAt': '2026-10-01T10:00:00Z', 'read': False,
                       'delivery': {'channel': 'os', 'state': 'pending', 'updatedAt': '2026-10-01T10:00:00Z'}}]
    response = client.post('/api/backups/restore', json=request_body(client, backup_of(client, data)), headers=headers(client))
    assert response.status_code == 200, response.text
    alert = client.get('/api/snapshot').json()['alerts'][0]
    assert alert['delivery']['state'] == 'dashboard_only'
    assert client.get('/api/reminders/plan').json().get('pendingDeliveries', []) == []


def test_sqlite_restore_fences_old_queue_claims(tmp_path):
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'q.sqlite3')))
    try:
        with TestClient(create_app(store)) as client:
            h = headers(client)
            course = client.get('/api/snapshot').json()['courses'][0]['id']
            assert client.post('/api/queue/runs', json={'idempotencyKey': 'run-key-1', 'courseIds': [course]}, headers=h).status_code == 200
            claim = client.post('/api/queue/claim', headers=h).json()
            client.post('/api/backups/restore', json=request_body(client, backup_of(client, incoming(client))), headers=h)
            with store.engine.connect() as c:
                assert c.execute(text("SELECT count(*) FROM queue_jobs WHERE state IN ('pending','running')")).scalar_one() == 0
            if claim and claim.get('jobs'):
                job = claim['jobs'][0]
                renew = client.post('/api/queue/renew', json={'jobId': job['id'], 'generation': job['generation'], 'token': job['token']}, headers=h)
                assert renew.status_code != 200
    finally:
        store.close()


def test_url_reason_keeps_stable_links_and_rejects_unsafe():
    assert unsafe_url_reason('https://moodle.example/mod/resource/view.php?id=4') is None
    assert unsafe_url_reason('not a link') is None
    assert unsafe_url_reason('https://u:p@x.example/') is not None
    assert unsafe_url_reason('javascript:alert(1)') is not None
    assert unsafe_url_reason('https://x.example/f?Expires=1') is not None
