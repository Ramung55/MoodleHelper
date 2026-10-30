"""Explicit user-confirmed syllabus revision decisions, inside Snapshot transactions."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from backend.deadline_tracking import equal
from backend.domain_validation import validate_date
from backend.reconciliation import ReconciliationConflict, assessment, canonical, digest, key, source
from backend import alert_delivery


def fail():
    raise ReconciliationConflict('The revision is unavailable or changed. Refresh and review the sources again; no changes were saved.')


class Replay(Exception):
    pass


def one(items):
    if len(items) != 1:
        fail()
    return items[0]


def evidence(snapshot, src):
    candidate = one([x for x in snapshot['candidates'] if x['id'] == src.get('candidateId')])
    document = one([x for x in snapshot['documents'] if x['id'] == src.get('documentId')])
    original = assessment(snapshot, src['assessmentId'])
    if (candidate['documentId'] != document['id'] or candidate['courseId'] != src['courseId'] or
        document['courseId'] != src['courseId'] or candidate['status'] not in ('confirmed','corrected','auto') or
        original['id'] != 'syl-'+candidate['id'] or original['personal'] or
        original['courseId'] != src['courseId'] or original['type'] != candidate['type'] or
        candidate['date']['kind'] == 'unknown'):
        fail()
    try:
        value = validate_date(candidate['date'])
    except ValueError:
        fail()
    matches = [v for v in original['sources'] if v['source'] == 'syllabus' and
               v['date'] == candidate['date'] and v.get('excerpt') == candidate['excerpt'] and
               v.get('location') == candidate['location']]
    original_evidence = one(matches)
    return dict(documentId=document['id'], documentName=document['name'], candidateId=candidate['id'],
                title=candidate['title'], date=value, excerpt=candidate['excerpt'], location=candidate['location'],
                observedAt=original_evidence['observedAt'], mocked=document['mocked'])


def preview(snapshot, namespace, body):
    layer = snapshot.get('reconciliation')
    if not layer:
        fail()
    target = source(snapshot, body['sourceId'])
    incoming = one([s for s in layer['sources'] if s.get('candidateId') == body['candidateId'] and s['kind'] == 'syllabus'])
    if target['kind'] != 'syllabus' or incoming['id'] == target['id'] or incoming['courseId'] != target['courseId']:
        fail()
    for src in (target, incoming):
        expected = key(namespace, 'source', src['courseId'], 'syllabus', src.get('documentId'), src.get('candidateId'))
        if src['id'] != expected or src.get('state') or len([c for c in snapshot['courses'] if c['id'] == src['courseId']]) != 1:
            fail()
    target_ev, incoming_ev = evidence(snapshot, target), evidence(snapshot, incoming)
    if assessment(snapshot, target['assessmentId'])['type'] != assessment(snapshot, incoming['assessmentId'])['type']:
        fail()
    streams = snapshot.get('syllabusRevisions', [])
    if len({v['sourceId'] for v in streams}) != len(streams): fail()
    if any(link['memberSourceId'] in (target['id'], incoming['id']) for stream in streams for link in stream['links']): fail()
    if any(v['sourceId'] == incoming['id'] for v in streams): fail()
    if any(incoming['id'] in (p['left'],p['right']) for p in layer['pairs']): fail()
    incoming_id = incoming['assessmentId']
    if (any(x['assessmentId'] == incoming_id for x in snapshot['overlays']) or
        any(x['assessmentId'] == incoming_id for x in layer['overlayEdits']) or
        assessment(snapshot, incoming_id).get('submission')): fail()
    aliases = [x for x in layer['aliases'] if x['originalId'] == incoming_id]
    if len(aliases) != 1 or aliases[0]['canonicalId'] != incoming_id: fail()
    stream = next((x for x in streams if x['sourceId'] == target['id']), None)
    revision = stream['revision'] if stream else 0
    if stream:
        if stream['assessmentId'] != target['assessmentId'] or revision != len(stream['links']): fail()
        last = stream['links'][-1]
        last_source = source(snapshot, last['memberSourceId'])
        target_ev = evidence(snapshot, last_source)
        if target_ev['date'] != last['date']: fail()
    fingerprint = digest(dict(selection=body, revision=revision, snapshot=snapshot))
    return dict(sourceId=target['id'], candidateId=incoming_ev['candidateId'], revision=revision,
                fingerprint=fingerprint, target=target_ev, incoming=incoming_ev)


def confirm(snapshot, namespace, body):
    streams = snapshot.get('syllabusRevisions', [])
    for stream in streams:
        for link in stream['links']:
            if link['candidateId'] == body['candidateId']:
                if (stream['sourceId'] == body['sourceId'] and link['revision'] == body['revision'] + 1 and
                    link['fingerprint'] == body['fingerprint']):
                    raise Replay()
                fail()
    offered = preview(snapshot, namespace, {'sourceId':body['sourceId'], 'candidateId':body['candidateId']})
    if offered['revision'] != body['revision'] or offered['fingerprint'] != body['fingerprint']:
        fail()
    target = source(snapshot, body['sourceId'])
    member = one([s for s in snapshot['reconciliation']['sources'] if s.get('candidateId') == body['candidateId'] and s['kind'] == 'syllabus'])
    state = next((v for v in streams if v['sourceId'] == target['id']), None)
    if state is None:
        streams = snapshot.setdefault('syllabusRevisions', [])
        state = dict(sourceId=target['id'], assessmentId=target['assessmentId'], revision=0, links=[])
        streams.append(state)
    revision = state['revision'] + 1
    now = datetime.now(timezone.utc).isoformat()
    link = dict(candidateId=member['candidateId'],documentId=member['documentId'],memberSourceId=member['id'],
                assessmentId=member['assessmentId'],date=deepcopy(offered['incoming']['date']),
                decidedAt=now,revision=revision,fingerprint=body['fingerprint'])
    state['links'].append(link); state['revision'] = revision
    if not equal(offered['target']['date'], offered['incoming']['date']):
        snapshot['changes'].append(dict(id=uuid4().hex,assessmentId=target['assessmentId'],
            **{'from':deepcopy(offered['target']['date'])},to=deepcopy(offered['incoming']['date']),
            detectedAt=now,sourceId=target['id'],sourceKind='syllabus',sourceDocumentId=member['documentId'],
            sourceCandidateId=member['candidateId'],sourceObservedAt=offered['incoming']['observedAt']))
        alert_delivery.change_alert(snapshot, snapshot['changes'][-1])  # #39
