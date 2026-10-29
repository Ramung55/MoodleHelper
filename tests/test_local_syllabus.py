from copy import deepcopy
import pytest

FLAGS = dict(complete=True, evidenceRetained=True, traceable=True, sourceAvailable=True, contextVerified=True, singleAssociation=True, explicitDate=True, inferredYear=False, localeAmbiguous=False, contradictory=False, policyOrHeading=False, conflictingMatch=False, mappingResolved=True, timezoneResolved=True, ocr='none')

def request(client, **proposal):
    headers = {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}
    body = dict(datasetId=client.get('/api/local-context').json()['datasetId'], courseId='c-csc', digest='a'*64, format='pdf', pipelineVersion='local-syllabus-1', proposals=[dict(mentionId='mention-stable', locationId='location-opaque', title='Exam 1', type='exam', date=dict(kind='date', date='2027-03-12'), language='en', facts=deepcopy(FLAGS), **proposal)])
    return body, headers

def submit(client, body, headers):
    return client.post('/api/local-syllabus/route', json=body, headers=headers)

def test_clear_auto_has_registered_reference_and_replay_retains_one_event(client):
    body, headers = request(client)
    before = client.get('/api/snapshot').json()
    response = submit(client, body, headers)
    assert response.status_code == 200, response.text
    first = response.json(); route = first['routes'][0]
    assert route['disposition'] == 'auto' and route['reasons'] == ['clear_explicit']
    assert len(first['snapshot']['assessments']) == len(before['assessments']) + 1
    document = next(item for item in first['snapshot']['documents'] if item['id'] == route['documentId'])
    assert document['mocked'] is False and document['localDigest'] == body['digest']
    candidate = next(item for item in first['snapshot']['candidates'] if item['id'] == route['candidateId'])
    assert candidate['localEvidence']['mentionId'] == 'mention-stable'
    assert candidate['excerpt'] == candidate['rawDateText'] == ''
    event = next(item for item in first['snapshot']['assessments'] if item['id'] == route['assessmentId'])
    assert event['sources'][0]['localEvidence'] == candidate['localEvidence']
    assert event['sources'][0]['date'] == {'kind': 'date', 'date': '2027-03-12'}
    replay = submit(client, body, headers).json()
    assert replay['routes'][0] == {**route, 'disposition': 'retained'}
    assert replay['snapshot'] == first['snapshot']

@pytest.mark.parametrize('changes,reason', [
    ({'complete':False}, 'incomplete_extraction'), ({'evidenceRetained':False},'evidence_missing'), ({'traceable':False},'location_missing'), ({'sourceAvailable':False},'source_unavailable'), ({'contextVerified':False},'context_unverified'), ({'singleAssociation':False},'association_ambiguous'), ({'explicitDate':False},'date_not_explicit'), ({'inferredYear':True},'year_inferred'), ({'localeAmbiguous':True},'locale_ambiguous'), ({'contradictory':True},'contradictory'), ({'policyOrHeading':True},'policy_or_heading'), ({'conflictingMatch':True},'conflicting_match'), ({'mappingResolved':False},'mapping_unresolved'), ({'ocr':'low_quality'},'ocr_low_quality'), ({'ocr':'synthetic'},'ocr_synthetic'), ({'ocr':'missing_provenance'},'ocr_provenance_missing'),
])
def test_uncertain_policy_facts_require_review_without_event(client, changes, reason):
    body, headers = request(client); body['proposals'][0]['facts'].update(changes)
    before = client.get('/api/snapshot').json()
    result = submit(client, body, headers).json()
    assert result['routes'][0]['disposition'] == 'review' and reason in result['routes'][0]['reasons']
    assert result['snapshot']['assessments'] == before['assessments']

def test_review_decisions_survive_rerouting_and_week_precision_is_not_promoted(client):
    body, headers = request(client); body['proposals'][0]['date'] = {'kind':'week','week':2}
    client.patch('/api/settings', json={'teachingCalendar': dict(startDate='2027-01-04',endDate='2027-02-28',timezone='UTC',excludedWeekStarts=[])})
    first = submit(client, body, headers).json(); route = first['routes'][0]
    assert route['disposition'] == 'review' and route['reasons'] == ['week_only']
    candidate_id = route['candidateId']
    reviewed = client.post(f'/api/candidates/{candidate_id}/review', json={'kind':'correct','title':'Reviewed title','type':'assignment','date':{'kind':'week','week':3}})
    assert reviewed.status_code == 200
    replay = submit(client, body, headers).json()
    assert replay['routes'][0]['disposition'] == 'retained'
    assert replay['snapshot'] == reviewed.json()
    candidate = next(item for item in replay['snapshot']['candidates'] if item['id'] == candidate_id)
    assert candidate['status'] == 'corrected' and candidate['date'] == {'kind':'week','week':3}

def test_invalid_or_conflicting_batch_is_atomic_and_context_is_required(client):
    body, headers = request(client)
    before = client.get('/api/snapshot').json()
    assert submit(client, body, {}).status_code == 409
    changed = deepcopy(body); changed['datasetId'] = 'other'
    assert submit(client, changed, headers).status_code == 409
    changed = deepcopy(body); changed['proposals'][0]['excerpt'] = 'prohibited raw content'
    assert submit(client, changed, headers).status_code == 422
    changed = deepcopy(body); changed['proposals'][0]['date'] = dict(kind='date',date='2027-02-29')
    assert submit(client, changed, headers).status_code == 422
    changed = deepcopy(body); changed['proposals'].append({**changed['proposals'][0], 'title':'Conflicting title'})
    assert submit(client, changed, headers).status_code == 409
    assert client.get('/api/snapshot').json() == before
    first = submit(client, body, headers).json()['snapshot']
    changed = deepcopy(body); changed['proposals'][0]['title'] = 'Changed immutable metadata'
    assert submit(client, changed, headers).status_code == 409
    assert client.get('/api/snapshot').json() == first


def test_current_backend_map_overrides_stale_browser_week_assertion(client):
    body, headers = request(client); body['proposals'][0]['date'] = {'kind':'week','week':2}
    body['proposals'][0]['facts']['mappingResolved'] = True
    calendar = dict(startDate='2027-01-04',endDate='2027-02-28',timezone='UTC',excludedWeekStarts=[])
    client.patch('/api/settings', json={'teachingCalendar': calendar})
    # Current #52 uncertainty, despite the earlier browser preview being mapped.
    calendar['partialBreaks'] = [dict(startDate='2027-01-13',endDate='2027-01-13',numbering='unresolved')]
    client.patch('/api/settings', json={'teachingCalendar': calendar})
    result = submit(client, body, headers).json()
    assert result['routes'][0]['disposition'] == 'review'
    assert 'mapping_unresolved' in result['routes'][0]['reasons']
    missing = client.get('/api/snapshot').json(); del missing['settings']['teachingCalendar']
    client.put('/api/snapshot', json=missing)
    fresh = deepcopy(body); fresh['proposals'][0]['mentionId'] = 'another-mention'
    no_map = submit(client, fresh, headers).json()
    assert no_map['routes'][0]['disposition'] == 'review' and 'mapping_unresolved' in no_map['routes'][0]['reasons']


def test_two_tabs_route_once_and_conflicting_batch_rolls_back(client):
    from concurrent.futures import ThreadPoolExecutor
    body, headers = request(client)
    before = client.get('/api/snapshot').json()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(client, body, headers), range(2)))
    assert all(response.status_code == 200 for response in results)
    assert sorted(response.json()['routes'][0]['disposition'] for response in results) == ['auto', 'retained']
    after = client.get('/api/snapshot').json()
    assert len(after['assessments']) == len(before['assessments']) + 1
    assert len(after['localSyllabusReceipts']) == 1
    batch = deepcopy(body)
    batch['proposals'].insert(0, {**deepcopy(body['proposals'][0]), 'mentionId':'first-new-item'})
    batch['proposals'][1]['title'] = 'Changed prior immutable proposal'
    assert submit(client, batch, headers).status_code == 409
    assert client.get('/api/snapshot').json() == after


def test_failed_sqlite_commit_rolls_back_documents_candidates_events_and_receipts(tmp_path):
    from fastapi.testclient import TestClient
    from sqlalchemy import URL, event
    from sqlalchemy.exc import OperationalError
    from backend.main import create_app
    from backend.sqlite_store import SQLiteStore
    store = SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'local-route.sqlite3')))
    try:
        with TestClient(create_app(store)) as client:
            body, headers = request(client); before = client.get('/api/snapshot').json()
            def fail(_connection, _cursor, statement, _parameters, _context, _many):
                if statement.startswith('UPDATE snapshots'): raise OperationalError(statement, {}, Exception('disk full'))
            event.listen(store.engine, 'after_cursor_execute', fail)
            try:
                response = submit(client, body, headers)
                assert response.status_code == 503
            finally: event.remove(store.engine, 'after_cursor_execute', fail)
            assert client.get('/api/snapshot').json() == before
            assert submit(client, body, headers).status_code == 200
    finally: store.close()
