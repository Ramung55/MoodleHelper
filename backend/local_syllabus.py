"""Derived metadata routing only. This service never receives or verifies document text."""
from copy import deepcopy
from hashlib import sha256
import json
from backend.reconciliation import ReconciliationConflict
from backend.services import stamp


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def digest(value):
    return sha256(canonical(value).encode()).hexdigest()


def policy(proposal, settings):
    facts, value = proposal['facts'], proposal['date']
    reasons = []
    for flag, code in [('complete', 'incomplete_extraction'), ('evidenceRetained', 'evidence_missing'), ('traceable', 'location_missing'), ('sourceAvailable', 'source_unavailable'), ('contextVerified', 'context_unverified'), ('singleAssociation', 'association_ambiguous'), ('explicitDate', 'date_not_explicit')]:
        if not facts[flag]: reasons.append(code)
    for flag, code in [('inferredYear', 'year_inferred'), ('localeAmbiguous', 'locale_ambiguous'), ('contradictory', 'contradictory'), ('policyOrHeading', 'policy_or_heading'), ('conflictingMatch', 'conflicting_match')]:
        if facts[flag]: reasons.append(code)
    if value['kind'] == 'unknown': reasons.append('date_missing')
    if not facts['timezoneResolved']: reasons.append('timezone_unresolved')
    if value['kind'] == 'week':
        from backend.reconciliation import teaching_week_range
        reasons.append('week_only')
        if not facts['mappingResolved'] or teaching_week_range(value['week'], settings) is None: reasons.append('mapping_unresolved')
    elif not facts['mappingResolved']:
        reasons.append('mapping_unresolved')
    if not proposal.get('language'): reasons.append('language_unknown')
    if facts['ocr'] != 'none':
        reasons.append('ocr_review')
        codes = {'low_quality': 'ocr_low_quality', 'synthetic': 'ocr_synthetic', 'missing_provenance': 'ocr_provenance_missing'}
        if facts['ocr'] in codes: reasons.append(codes[facts['ocr']])
    return list(dict.fromkeys(reasons)) or ['clear_explicit']


def route(service, incoming):
    store = service.store
    if incoming['datasetId'] != store.dataset_id:
        raise ReconciliationConflict('Local dataset changed. Reconnect before routing.')
    routes = []
    def apply(snapshot):
        if not any(course['id'] == incoming['courseId'] for course in snapshot['courses']):
            raise ValueError('The selected course is unavailable.')
        unique = {}
        for proposal in incoming['proposals']:
            if not proposal['title'].strip(): raise ValueError('Derived title cannot be blank.')
            previous = unique.get(proposal['mentionId'])
            if previous is not None and canonical(previous) != canonical(proposal):
                raise ReconciliationConflict('Conflicting duplicate local mention identity.')
            unique[proposal['mentionId']] = proposal
        receipts = snapshot.setdefault('localSyllabusReceipts', [])
        document_id = 'local-d-' + digest([store.namespace, incoming['courseId'], incoming['digest']])
        document = next((item for item in snapshot['documents'] if item['id'] == document_id), None)
        if document and (document.get('localDigest') != incoming['digest'] or document['format'] != incoming['format'] or document['courseId'] != incoming['courseId']):
            raise ReconciliationConflict('Local document identity collides with existing data.')
        for mention_id, proposal in sorted(unique.items()):
            reference = {key: incoming[key] for key in ['datasetId', 'courseId', 'digest', 'pipelineVersion']}
            reference.update(mentionId=mention_id, locationId=proposal['locationId'])
            fingerprint = digest(dict(format=incoming['format'], pipelineVersion=incoming['pipelineVersion'], proposal=proposal))
            previous = [item for item in receipts if all(item['evidence'][key] == reference[key] for key in ['courseId', 'digest', 'mentionId'])]
            if previous:
                if len(previous) != 1 or previous[0]['fingerprint'] != fingerprint or previous[0]['evidence'] != reference:
                    raise ReconciliationConflict('Local proposal identity changed. Original routing audit was retained.')
                original = previous[0]['route']
                candidate = next((item for item in snapshot['candidates'] if item['id'] == original['candidateId']), None)
                if candidate is None or candidate.get('localEvidence') != reference:
                    raise ReconciliationConflict('Registered local candidate is unavailable. Restore its original dataset.')
                result = {**deepcopy(original), 'disposition': 'retained'}
                reviewed_id = 'syl-' + original['candidateId']
                if any(item['id'] == reviewed_id for item in snapshot['assessments']): result['assessmentId'] = reviewed_id
                routes.append(result)
                continue
            # New versions at the same location require a separately approved revision policy.
            if any(item['evidence']['courseId'] == reference['courseId'] and item['evidence']['digest'] == reference['digest'] and item['evidence']['locationId'] == reference['locationId'] and item['evidence']['pipelineVersion'] != reference['pipelineVersion'] for item in receipts):
                raise ReconciliationConflict('A different pipeline version already routed this location. Review a revision explicitly.')
            if document is None:
                document = dict(id=document_id, courseId=incoming['courseId'], name=f"Local {incoming['format'].upper()} {incoming['digest'][:12]}", format=incoming['format'], status='done', progress=100, importedAt=stamp(), mocked=False, localDigest=incoming['digest'])
                snapshot['documents'].append(document)
            candidate_id = 'local-k-' + digest([store.namespace, incoming['courseId'], incoming['digest'], mention_id])
            if any(item['id'] == candidate_id for item in snapshot['candidates']):
                raise ReconciliationConflict('Local candidate identity collides with existing data.')
            reasons = policy(proposal, snapshot['settings'])
            from backend.reconciliation import normalized_title
            possible_match = any(item['courseId'] == incoming['courseId'] and not item['personal'] and item['type'] == proposal['type'] and normalized_title(item['title']) == normalized_title(proposal['title']) and any(source['source'] in ['moodle', 'syllabus'] for source in item['sources']) for item in snapshot['assessments'])
            if possible_match:
                reasons = [reason for reason in reasons if reason != 'clear_explicit'] + ['conflicting_match']
                reasons = list(dict.fromkeys(reasons))
            automatic = reasons == ['clear_explicit']
            candidate = dict(id=candidate_id, documentId=document_id, courseId=incoming['courseId'], title=proposal['title'], type=proposal['type'], date=deepcopy(proposal['date']), rawDateText='', language=proposal.get('language', 'unknown'), confidence=1 if automatic else 0, excerpt='', location=proposal['locationId'], status='auto' if automatic else 'pending', reason=', '.join(reasons), localEvidence=reference)
            snapshot['candidates'].append(candidate)
            result = dict(mentionId=mention_id, documentId=document_id, candidateId=candidate_id, disposition='auto' if automatic else 'review', reasons=reasons)
            if automatic:
                assessment_id, observed = 'syl-' + candidate_id, stamp()
                if any(item['id'] == assessment_id for item in snapshot['assessments']): raise ReconciliationConflict('Local assessment identity collides with existing data.')
                evidence = dict(source='syllabus', date=deepcopy(proposal['date']), location=proposal['locationId'], observedAt=observed, localEvidence=reference)
                snapshot['assessments'].append(dict(id=assessment_id, courseId=incoming['courseId'], title=proposal['title'], type=proposal['type'], personal=False, sources=[evidence], firstObservedAt=observed, lastObservedAt=observed))
                result['assessmentId'] = assessment_id
            receipts.append(dict(evidence=reference, fingerprint=fingerprint, route=deepcopy(result)))
            routes.append(result)
    snapshot = store.mutate(apply)
    return dict(snapshot=snapshot, routes=routes)
