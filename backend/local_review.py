"""Manual metadata-only review of registered local proposals, inside one store transaction."""
from copy import deepcopy
from backend.local_syllabus import digest
from backend.reconciliation import ReconciliationConflict
from backend.schemas import LocalReviewContext, LocalReviewValues
from backend.services import stamp


def apply_local_review(snapshot, candidate, decision, dataset_id):
    raw_context = decision.get('localReview')
    if raw_context is None:
        raise ReconciliationConflict('Registered local review requires its current dataset, proposal fingerprint and decision identity.')
    context = LocalReviewContext.model_validate(raw_context)
    reference = candidate['localEvidence']
    if context.datasetId != dataset_id or reference['datasetId'] != dataset_id or context.pipelineVersion != reference['pipelineVersion']:
        raise ReconciliationConflict('Local review context changed. Reconnect and inspect the original proposal.')
    receipts = [receipt for receipt in snapshot.get('localSyllabusReceipts', []) if receipt['evidence'] == reference and receipt['route']['candidateId'] == candidate['id'] and receipt['route']['documentId'] == candidate['documentId']]
    if len(receipts) != 1 or receipts[0]['fingerprint'] != context.proposalFingerprint:
        raise ReconciliationConflict('The registered server proposal fingerprint does not match this review.')
    documents = [item for item in snapshot['documents'] if item['id'] == candidate['documentId'] and item['courseId'] == reference['courseId'] and item.get('localDigest') == reference['digest'] and item['mocked'] is False]
    if len(documents) != 1 or candidate['courseId'] != reference['courseId']:
        raise ReconciliationConflict('Registered local document provenance is unavailable or inconsistent.')
    if context.evidenceMode == 'unavailable' and decision['kind'] != 'reject':
        raise ReconciliationConflict('Unavailable evidence permits Reject only.')
    if decision['kind'] != 'reject' and context.evidenceMode == 'stored-evidence-only' and not context.acknowledgedStoredOnly:
        raise ReconciliationConflict('Stored-only review requires explicit manual acknowledgement.')
    fingerprint = digest(decision)
    previous = candidate.get('localDecision')
    if previous:
        if previous['decisionId'] == context.decisionId and previous['requestFingerprint'] == fingerprint:
            return
        raise ReconciliationConflict('This local candidate already has a different committed decision. Refresh to inspect it.')
    if candidate['status'] != 'pending':
        raise ReconciliationConflict('Only pending local proposals can receive a new manual review decision.')
    original = LocalReviewValues.model_validate({key: candidate[key] for key in ['title', 'type', 'date']}).model_dump(by_alias=True, exclude_unset=True)
    chosen = original
    if decision['kind'] == 'correct':
        chosen = LocalReviewValues.model_validate({key: decision[key] for key in ['title', 'type', 'date']}).model_dump(by_alias=True, exclude_unset=True)
    if decision['kind'] != 'reject' and (not chosen['title'].strip() or chosen['date']['kind'] == 'unknown'):
        raise ReconciliationConflict('Enter a nonblank title and an explicit valid date or teaching week before confirming.')
    observed = stamp()
    receipt = dict(decisionId=context.decisionId, proposalFingerprint=context.proposalFingerprint, requestFingerprint=fingerprint, kind=decision['kind'], originalValues=deepcopy(original), evidenceMode=context.evidenceMode, acknowledgedStoredOnly=context.acknowledgedStoredOnly, decidedAt=observed)
    if decision['kind'] == 'correct': receipt['correctedValues'] = deepcopy(chosen)
    if decision['kind'] == 'reject':
        candidate['status'] = 'rejected'
    else:
        assessment_id = 'syl-' + candidate['id']
        if any(item['id'] == assessment_id for item in snapshot['assessments']):
            raise ReconciliationConflict('Registered local event identity collides with existing data. No decision was saved.')
        evidence = dict(source='syllabus', date=deepcopy(chosen['date']), location=reference['locationId'], observedAt=observed, localEvidence=deepcopy(reference), localDecisionId=context.decisionId, localReviewMode=context.evidenceMode)
        snapshot['assessments'].append(dict(id=assessment_id, courseId=candidate['courseId'], title=chosen['title'], type=chosen['type'], personal=False, sources=[evidence], firstObservedAt=observed, lastObservedAt=observed))
        candidate.update(deepcopy(chosen))
        candidate['status'] = 'corrected' if decision['kind'] == 'correct' else 'confirmed'
        receipt['assessmentId'] = assessment_id
    candidate['localDecision'] = receipt
