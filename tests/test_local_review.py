"""#32 registered local candidate review through the existing review endpoint."""
from copy import deepcopy
import pytest

from tests.test_local_syllabus import request, submit


def routed(client, **date):
    body, headers = request(client)
    body['proposals'][0]['facts']['inferredYear'] = True
    if date:
        body['proposals'][0]['date'] = date
    first = submit(client, body, headers).json()
    route = first['routes'][0]
    assert route['disposition'] == 'review'
    receipt = next(item for item in first['snapshot']['localSyllabusReceipts'] if item['route']['candidateId'] == route['candidateId'])
    context = dict(datasetId=body['datasetId'], pipelineVersion='local-syllabus-1', proposalFingerprint=receipt['fingerprint'], decisionId='decision-1', evidenceMode='original-available', acknowledgedStoredOnly=False)
    return body, headers, route['candidateId'], context


def review(client, candidate_id, decision, headers):
    return client.post(f'/api/candidates/{candidate_id}/review', json=decision, headers=headers)


def candidate(snapshot, candidate_id):
    return next(item for item in snapshot['candidates'] if item['id'] == candidate_id)


def test_confirm_is_idempotent_by_decision_id_and_creates_one_typed_event(client):
    body, headers, candidate_id, context = routed(client)
    before = client.get('/api/snapshot').json()
    first = review(client, candidate_id, {'kind': 'confirm', 'localReview': context}, headers)
    assert first.status_code == 200, first.text
    snap = first.json()
    events = [item for item in snap['assessments'] if item['id'] == 'syl-' + candidate_id]
    assert len(events) == 1 and len(snap['assessments']) == len(before['assessments']) + 1
    source = events[0]['sources'][0]
    assert source['date'] == {'kind': 'date', 'date': '2027-03-12'}
    assert source['localEvidence'] == candidate(snap, candidate_id)['localEvidence']
    assert source['localDecisionId'] == 'decision-1' and source['localReviewMode'] == 'original-available'
    assert 'excerpt' not in source
    decision = candidate(snap, candidate_id)['localDecision']
    assert decision['kind'] == 'confirm' and decision['originalValues'] == {'title': 'Exam 1', 'type': 'exam', 'date': {'kind': 'date', 'date': '2027-03-12'}}
    assert decision['assessmentId'] == 'syl-' + candidate_id
    # Same decision replay (lost response, second tab with same id): no extra event.
    replay = review(client, candidate_id, {'kind': 'confirm', 'localReview': context}, headers)
    assert replay.status_code == 200 and replay.json() == snap
    # Another tab with a fresh decision id cannot duplicate or change the decision.
    other = review(client, candidate_id, {'kind': 'confirm', 'localReview': {**context, 'decisionId': 'decision-2'}}, headers)
    assert other.status_code == 409
    conflicting = review(client, candidate_id, {'kind': 'reject', 'localReview': context}, headers)
    assert conflicting.status_code == 409
    assert client.get('/api/snapshot').json() == snap
    # Unchanged re-extraction is retained and keeps the event.
    replayed = submit(client, body, headers).json()
    assert replayed['routes'][0]['disposition'] == 'retained' and replayed['snapshot'] == snap


def test_correct_records_original_and_corrected_values_and_survives_rerouting(client):
    body, headers, candidate_id, context = routed(client)
    correction = {'kind': 'correct', 'title': 'Midterm', 'type': 'quiz', 'date': {'kind': 'exact', 'iso': '2027-03-14T09:30:00+05:00', 'tz': 'Asia/Almaty'}, 'localReview': context}
    snap = review(client, candidate_id, correction, headers).json()
    item = candidate(snap, candidate_id)
    assert item['status'] == 'corrected' and item['title'] == 'Midterm' and item['date']['kind'] == 'exact'
    assert item['localDecision']['originalValues']['title'] == 'Exam 1'
    assert item['localDecision']['correctedValues']['title'] == 'Midterm'
    receipt = next(r for r in snap['localSyllabusReceipts'] if r['route']['candidateId'] == candidate_id)
    assert receipt['fingerprint'] == context['proposalFingerprint']
    replayed = submit(client, body, headers).json()
    assert replayed['snapshot'] == snap


def test_reject_with_unavailable_evidence_is_allowed_and_not_resurrected(client):
    body, headers, candidate_id, context = routed(client)
    for kind in ['confirm', 'correct']:
        decision = {'kind': kind, 'localReview': {**context, 'evidenceMode': 'unavailable'}}
        if kind == 'correct':
            decision.update(title='X', type='exam', date={'kind': 'date', 'date': '2027-03-12'})
        assert review(client, candidate_id, decision, headers).status_code == 422
    snap = review(client, candidate_id, {'kind': 'reject', 'localReview': {**context, 'evidenceMode': 'unavailable'}}, headers).json()
    item = candidate(snap, candidate_id)
    assert item['status'] == 'rejected' and item['localDecision']['evidenceMode'] == 'unavailable'
    assert not any(a['id'] == 'syl-' + candidate_id for a in snap['assessments'])
    replayed = submit(client, body, headers).json()
    assert replayed['routes'][0]['disposition'] == 'retained' and candidate(replayed['snapshot'], candidate_id)['status'] == 'rejected'


def test_stored_only_requires_acknowledgement(client):
    _, headers, candidate_id, context = routed(client)
    stored = {**context, 'evidenceMode': 'stored-evidence-only'}
    assert review(client, candidate_id, {'kind': 'confirm', 'localReview': stored}, headers).status_code == 422
    snap = review(client, candidate_id, {'kind': 'confirm', 'localReview': {**stored, 'acknowledgedStoredOnly': True}}, headers).json()
    event = next(a for a in snap['assessments'] if a['id'] == 'syl-' + candidate_id)
    assert event['sources'][0]['localReviewMode'] == 'stored-evidence-only'


@pytest.mark.parametrize('change', [
    {'datasetId': 'other-dataset'},
    {'proposalFingerprint': 'c' * 64},
])
def test_context_mismatch_conflicts_atomically(client, change):
    _, headers, candidate_id, context = routed(client)
    before = client.get('/api/snapshot').json()
    assert review(client, candidate_id, {'kind': 'confirm', 'localReview': {**context, **change}}, headers).status_code == 409
    assert client.get('/api/snapshot').json() == before


def test_binding_and_context_are_required_for_local_candidates_only(client):
    _, headers, candidate_id, context = routed(client)
    before = client.get('/api/snapshot').json()
    assert review(client, candidate_id, {'kind': 'confirm', 'localReview': context}, {}).status_code == 409
    assert review(client, candidate_id, {'kind': 'confirm', 'localReview': context}, {'X-Moodle-Helper-Bridge-Binding': 'stale'}).status_code == 409
    assert review(client, candidate_id, {'kind': 'confirm'}, headers).status_code == 409
    assert client.get('/api/snapshot').json() == before
    # Legacy/mock candidates keep the existing wire behavior without new fields.
    legacy = next(item for item in before['candidates'] if item['status'] == 'pending' and not item.get('localEvidence'))
    assert client.post(f"/api/candidates/{legacy['id']}/review", json={'kind': 'reject'}).status_code == 200
    # But a local context cannot be smuggled onto a legacy candidate.
    other = next(item for item in before['candidates'] if item['status'] == 'pending' and not item.get('localEvidence') and item['id'] != legacy['id'])
    assert client.post(f"/api/candidates/{other['id']}/review", json={'kind': 'reject', 'localReview': context}).status_code == 409


@pytest.mark.parametrize('payload', [
    {'kind': 'correct', 'title': ' ', 'type': 'exam', 'date': {'kind': 'date', 'date': '2027-03-12'}},
    {'kind': 'correct', 'title': 'Exam', 'type': 'exam', 'date': {'kind': 'date', 'date': '2027-02-29'}},
    {'kind': 'correct', 'title': 'Exam', 'type': 'exam', 'date': {'kind': 'week', 'week': 31}},
    {'kind': 'correct', 'title': 'Exam', 'type': 'exam', 'date': {'kind': 'exact', 'iso': '2027-03-12T25:00:00Z', 'tz': 'UTC'}},
    {'kind': 'correct', 'title': 'Exam', 'type': 'exam', 'date': {'kind': 'unknown'}},
    {'kind': 'confirm', 'excerpt': 'raw source text'},
    {'kind': 'confirm', 'rawDateText': '12 March'},
])
def test_invalid_corrections_and_raw_payloads_change_nothing(client, payload):
    _, headers, candidate_id, context = routed(client)
    before = client.get('/api/snapshot').json()
    response = review(client, candidate_id, {**payload, 'localReview': context}, headers)
    assert response.status_code in (409, 422)
    assert client.get('/api/snapshot').json() == before


def test_week_only_confirm_keeps_week_precision_and_unknown_requires_correction(client):
    _, headers, candidate_id, context = routed(client, kind='week', week=4)
    snap = review(client, candidate_id, {'kind': 'confirm', 'localReview': context}, headers).json()
    event = next(a for a in snap['assessments'] if a['id'] == 'syl-' + candidate_id)
    assert event['sources'][0]['date'] == {'kind': 'week', 'week': 4}
    body, headers = request(client)
    body['digest'] = 'b' * 64
    body['proposals'][0]['date'] = {'kind': 'unknown'}
    body['proposals'][0]['facts']['explicitDate'] = False
    route = submit(client, body, headers).json()
    unknown_id = route['routes'][0]['candidateId']
    receipt = next(r for r in route['snapshot']['localSyllabusReceipts'] if r['route']['candidateId'] == unknown_id)
    unknown_context = {**context, 'proposalFingerprint': receipt['fingerprint'], 'decisionId': 'decision-unknown'}
    before = client.get('/api/snapshot').json()
    assert review(client, unknown_id, {'kind': 'confirm', 'localReview': unknown_context}, headers).status_code == 409
    assert client.get('/api/snapshot').json() == before
    corrected = review(client, unknown_id, {'kind': 'correct', 'title': 'Exam 1', 'type': 'exam', 'date': {'kind': 'week', 'week': 9}, 'localReview': unknown_context}, headers)
    assert corrected.status_code == 200 and candidate(corrected.json(), unknown_id)['date'] == {'kind': 'week', 'week': 9}
