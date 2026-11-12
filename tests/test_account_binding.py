"""#93: live collection saves only for the Moodle account the real dataset belongs to.

Verified-mode scan finishes and course discovery compare the received
moodleUserId with the dataset's stable user id. Ids here are invented.
"""
import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL

from backend.collection import CollectionRejected, CollectionService
from backend.identity import account_error, namespace_key
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from tests.test_live_scan import ACCOUNT, ORIGIN, SIGN_IN, Live, completed, failed, full_scan, live, seeded  # noqa: F401 (live is a fixture)

MISMATCH = 'The signed-in Moodle account is not the account of this dataset. Earlier data was kept.'
UNCONFIRMED = 'The Moodle account could not be confirmed. Earlier data was kept.'
DISCOVERY_MISMATCH = 'The signed-in Moodle account is not the account of this dataset. Nothing was saved.'
DISCOVERY_UNCONFIRMED = 'The Moodle account could not be confirmed. Nothing was saved.'
# A distinctive invented id: it must never appear in storage, responses or logs.
MARKER = '8765432109876543'


@pytest.fixture
def three(tmp_path):
    clock = [1000]
    harness = Live(seeded(tmp_path, selected=('c-csc', 'c-math', 'c-phy')), clock)
    yield harness
    harness.close()


def without_id(body):
    body.pop('moodleUserId')
    return body


def with_id(body, value):
    return {**body, 'moodleUserId': value}


def dump(store):
    with store.engine.connect() as c:
        return '\n'.join(c.connection.dbapi_connection.iterdump())


def jobs(store):
    with store.engine.connect() as c:
        return {r.course_id: (r.state, r.error_code, r.attempts) for r in
                c.exec_driver_sql('SELECT course_id,state,error_code,attempts FROM queue_jobs').all()}


def scan_pages(store):
    with store.engine.connect() as c:
        return c.exec_driver_sql('SELECT count(*) FROM scan_pages').scalar_one()


def records(live):
    snapshot = live.client.get('/api/snapshot').json()
    return snapshot.get('collection', {}).get('records', []), snapshot['assessments']


def test_matching_id_saves(live):
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    response = live.post('/api/scan/finish', completed(claim, full_scan(claim['sourceCourseId'], ['990103'])))
    assert response.status_code == 200 and response.json()['state'] == 'completed'
    assert [r['kind'] for r in records(live)[0]] == ['quiz']
    assert live.sync_entry(claim['job']['courseId'])['status'] == 'partial'
    assert scan_pages(live.store) > 0


@pytest.mark.parametrize('change,code,message', [
    (lambda body: with_id(body, MARKER), 'account_mismatch', MISMATCH),
    (without_id, 'account_unconfirmed', UNCONFIRMED),
], ids=['different', 'missing'])
def test_other_or_missing_account_saves_nothing_and_fails_the_run(three, change, code, message, caplog):
    caplog.set_level(logging.DEBUG)
    three.post('/api/sync')
    before = records(three)
    claim = three.post('/api/scan/claim', {}).json()['claim']
    body = change(completed(claim, full_scan(claim['sourceCourseId'], ['990103'])))
    response = three.post('/api/scan/finish', body)
    assert response.status_code == 200
    assert response.json()['state'] == 'failed' and response.json()['errorCode'] == code
    # Nothing from the batch: no records, reviews, receipts, deadline changes or scan_pages rows.
    assert records(three) == before
    snapshot = three.client.get('/api/snapshot').json()
    assert not snapshot.get('collection', {}).get('refreshes')
    assert scan_pages(three.store) == 0
    # The finished job and the run's other pending jobs fail with the same code, without a claim.
    states = jobs(three.store)
    assert {course: state[:2] for course, state in states.items()} == {c: ('failed', code) for c in ('c-csc', 'c-math', 'c-phy')}
    assert sorted(state[2] for state in states.values()) == [0, 0, 1]
    for course in ('c-csc', 'c-math', 'c-phy'):
        entry = three.sync_entry(course)
        assert entry['status'] == 'failed' and entry['error'] == message
    assert three.post('/api/scan/claim', {}).json() == {'unfinished': False}
    readback = three.client.get(f"/api/scan/jobs/{claim['job']['id']}/pages").json()
    assert readback['pages'] == [] and 'signInGuidance' not in readback
    # Privacy: the received id is only compared.
    assert MARKER not in response.text and MARKER not in dump(three.store) and MARKER not in caplog.text
    assert MARKER not in str(readback) and MARKER not in three.client.get('/api/snapshot').text


@pytest.mark.parametrize('value', ['0', '0123', '-5', '12a', ' 42', '42 ', '1' * 20, 4242])
def test_non_canonical_id_is_rejected_by_validation(live, value):
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    response = live.post('/api/scan/finish', with_id(completed(claim, full_scan(claim['sourceCourseId'], [])), value))
    assert response.status_code == 422 and response.json() == {'message': 'Invalid request.'}
    assert jobs(live.store)[claim['job']['courseId']][0] == 'running'


def test_run_keeps_matching_job_rejects_other_account_and_fails_the_rest_unclaimed(three):
    three.post('/api/sync')
    first = three.post('/api/scan/claim', {}).json()['claim']
    assert three.post('/api/scan/finish', completed(first, full_scan(first['sourceCourseId'], ['990103']))).status_code == 200
    saved = records(three)
    assert [r['kind'] for r in saved[0]] == ['quiz']
    second = three.post('/api/scan/claim', {}).json()['claim']
    other_quiz = f"99{second['sourceCourseId'][-1]}203"
    body = with_id(completed(second, full_scan(second['sourceCourseId'], [other_quiz])), MARKER)
    assert three.post('/api/scan/finish', body).json()['errorCode'] == 'account_mismatch'
    # Job 1's data is kept; job 2 saved nothing; job 3 failed without being claimed.
    assert records(three) == saved
    states = jobs(three.store)
    assert states[first['job']['courseId']] == ('completed', None, 1)
    assert states[second['job']['courseId']] == ('failed', 'account_mismatch', 1)
    rest = next(course for course in states if course not in (first['job']['courseId'], second['job']['courseId']))
    assert states[rest] == ('failed', 'account_mismatch', 0)
    assert three.sync_entry(first['job']['courseId'])['status'] == 'partial'
    assert three.sync_entry(rest)['error'] == MISMATCH
    assert three.post('/api/scan/claim', {}).json() == {'unfinished': False}


def test_signed_out_without_id_is_handled_as_before(live):
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    pages = [dict(pageType='course', scope='unknown', outcome='signed_out', coverage='none', reasons=['signed_out'],
                  observedAt='2028-03-05T10:00:00.000Z', pageUrl=f"{ORIGIN}/course/view.php?id={claim['sourceCourseId']}")]
    assert live.post('/api/scan/finish', without_id(failed(claim, 'signed_out', pages))).json()['errorCode'] == 'signed_out'
    for course in ('c-csc', 'c-math'):
        entry = live.sync_entry(course)
        assert entry['status'] == 'failed' and entry['error'] == SIGN_IN
    assert {state[:2] for state in jobs(live.store).values()} == {('failed', 'signed_out')}
    assert scan_pages(live.store) == 1


def test_every_verified_merge_requires_the_dataset_account(tmp_path):
    store = seeded(tmp_path)
    try:
        service = CollectionService(store, 'binding')
        assert service._mode() == 'verified'
        assert service.account_error(ACCOUNT) is None
        assert service.account_error(None) == 'account_unconfirmed'
        assert service.account_error(MARKER) == 'account_mismatch'
        snapshot = store.read()
        for value in (None, MARKER):
            with pytest.raises(CollectionRejected):
                service._merge_refresh(snapshot, {}, {}, value)
    finally:
        store.close()


def test_account_check_is_exact_and_demo_needs_no_id():
    real = namespace_key('moodle', origin=ORIGIN, profile_label='p', stable_user_id='4242')
    assert account_error(real, '4242') is None
    assert account_error(real, '42420') == 'account_mismatch'
    assert account_error(real, None) == account_error(real, '04242') == account_error(real, '4242\n') == 'account_unconfirmed'
    # A non-decimal stable id never matches a canonical received id.
    other = namespace_key('moodle', origin=ORIGIN, profile_label='p', stable_user_id='synthetic')
    assert account_error(other, ACCOUNT) == 'account_mismatch'
    assert account_error(namespace_key(), None) is None and account_error(namespace_key(), MARKER) is None


def observation(source):
    return {'sourceCourseId': source, 'sourceUrl': f'{ORIGIN}/course/view.php?id={source}',
            'title': {'kind': 'known', 'value': f'Fictional course {source}'}, 'termIndicators': {'kind': 'unknown'}}


@pytest.mark.parametrize('extra,status,message', [
    ({'moodleUserId': ACCOUNT}, 200, None),
    ({'moodleUserId': MARKER}, 409, DISCOVERY_MISMATCH),
    ({}, 409, DISCOVERY_UNCONFIRMED),
], ids=['match', 'mismatch', 'missing'])
def test_discovery_in_the_real_dataset(live, extra, status, message, caplog):
    caplog.set_level(logging.DEBUG)
    before = live.client.get('/api/snapshot').json()
    response = live.post('/api/courses/discovery', {'observations': [observation('9777')], **extra})
    assert response.status_code == status
    after = live.client.get('/api/snapshot').json()
    if message is None:
        assert any(c.get('discovery', {}).get('sourceCourseId') == '9777' for c in after['courses'])
    else:
        assert response.json() == {'message': message}
        assert after == before
    assert MARKER not in response.text and MARKER not in dump(live.store) and MARKER not in caplog.text


def test_demo_discovery_needs_no_id(tmp_path):
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'demo.sqlite3')))
    with TestClient(create_app(store)) as client:
        binding = {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}
        response = client.post('/api/courses/discovery', headers=binding, json={'observations': [observation('9777')]})
        assert response.status_code == 200
    store.close()


def test_failed_finish_without_id_keeps_its_code_merges_nothing_and_the_run_continues(three):
    # Clarification: a 503 (request_failed) finish without an id is not account_unconfirmed.
    three.post('/api/sync')
    before = records(three)
    claim = three.post('/api/scan/claim', {}).json()['claim']
    pages = full_scan(claim['sourceCourseId'], ['990103'])
    pages[0] = dict(pages[0], outcome='failed', reasons=['request_failed'])
    body = without_id(failed(claim, 'request_failed', pages))
    response = three.post('/api/scan/finish', body)
    assert response.json()['state'] == 'failed' and response.json()['errorCode'] == 'request_failed'
    # The quiz result in the batch is not merged.
    assert records(three) == before
    entry = three.sync_entry(claim['job']['courseId'])
    assert entry['status'] == 'failed' and entry['error'] == 'Moodle could not be read for this course. Earlier data was kept.'
    # No cascade: the other jobs are still claimed and saved normally.
    states = jobs(three.store)
    assert sorted(state[0] for state in states.values()) == ['failed', 'pending', 'pending']
    other = three.post('/api/scan/claim', {}).json()['claim']
    assert three.post('/api/scan/finish', completed(other, full_scan(other['sourceCourseId'], []))).json()['state'] == 'completed'


def test_completed_finish_without_id_and_without_results_is_handled_as_before(live):
    # Every page failed (for example a truncated course page): nothing to merge, so no account is needed.
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    page = dict(pageType='course', scope='unknown', outcome='failed', coverage='none', reasons=['access_error'],
                observedAt='2028-03-05T10:00:00.000Z', pageUrl=f"{ORIGIN}/course/view.php?id={claim['sourceCourseId']}")
    pages = [page] + [dict(pageType=k, scope='unknown', outcome='undiscovered', coverage='none', reasons=['undiscovered'])
                      for k in ('assignment', 'calendar', 'material', 'quiz', 'submission')]
    response = live.post('/api/scan/finish', without_id(completed(claim, pages)))
    assert response.json()['state'] == 'completed'
    assert live.sync_entry(claim['job']['courseId'])['status'] == 'partial'
    assert scan_pages(live.store) == len(pages)
    assert live.post('/api/scan/claim', {}).json()['claim']
