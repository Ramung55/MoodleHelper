"""Transactional reduction of explicitly collected deadline observations."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from backend.reconciliation import instant


def assertion(kind, raw):
    if raw.get('syntheticDeadlineRemoval') is True:
        return {'kind': 'removed'}
    date = (raw.get('effectiveDates', {}).get('due') if kind == 'assignment'
            else raw.get('closing') if kind == 'quiz' else None)
    value = date.get('value') if date else None
    return value if value and value['kind'] != 'unknown' else None


def equal(a, b):
    if a['kind'] != b['kind']:
        return False
    if a['kind'] == 'exact':
        return instant(a['iso']) == instant(b['iso'])
    return a == b


def effective_sources(snapshot, assessment):
    """Derive current evidence without making retained raw facts authoritative."""
    layer = snapshot.get('reconciliation', {})
    aliases = {x['originalId']: x['canonicalId'] for x in layer.get('aliases', [])}
    canonical = aliases.get(assessment['id'], assessment['id'])
    associations = [s for s in layer.get('sources', []) if s['kind'] == 'moodle' and
                    aliases.get(s['assessmentId'], s['assessmentId']) == canonical]
    if not associations:
        return assessment['sources']
    states = {s['sourceId']: s for s in snapshot.get('deadlineStreams', [])}
    records = {r['id']: r for r in snapshot.get('collection', {}).get('records', [])}
    current = [s for s in assessment['sources'] if s['source'] != 'moodle']
    untracked = []
    candidates = []
    for association in associations:
        state = states.get(association['id'])
        if state:
            value = state.get('accepted')
            if value and value['kind'] != 'removed':
                candidates.append((association['id'], dict(source='moodle', date=value, observedAt=state['acceptedAt'], url=state['sourceUrl'])))
        elif association.get('state') != 'ambiguous':
            record = records.get(association.get('recordId'), {})
            urls = {v.get('sourceUrl') for v in record.get('observations', [])}
            untracked.append((association, urls))
    for evidence in assessment['sources']:
        if evidence['source'] != 'moodle' or not evidence.get('url'):
            continue
        owners = [s for s in associations if any(v.get('sourceUrl') == evidence['url']
                  for v in records.get(s.get('recordId'), {}).get('observations', []))]
        if len(owners) == 1 and any(owners[0]['id'] == s['id'] for s, _ in untracked):
            candidates.append((owners[0]['id'], evidence))
    if candidates:
        _, evidence = max(candidates, key=lambda item: (instant(item[1]['observedAt']) or datetime.min.replace(tzinfo=timezone.utc), item[0]))
        current.append(evidence)
    return current


def apply_observations(snapshot, incoming):
    """Called after source associations exist, within collection's transaction."""
    if not incoming:
        return
    sources = {s['recordId']: s for s in snapshot['reconciliation']['sources']
               if s.get('recordId') and s.get('state') != 'ambiguous'}
    grouped = {}
    for record_id, kind, raw in incoming:
        source = sources.get(record_id)
        if source and kind in ('assignment', 'quiz'):
            grouped.setdefault(source['id'], (source, []) )[1].append((kind, raw))
    states = snapshot.setdefault('deadlineStreams', [])
    for source_id, (source, observations) in grouped.items():
        observations.sort(key=lambda item: instant(item[1]['observedAt']))
        # Never select one of two conflicting assertions at the same instant.
        assertions = {}
        for kind, raw in observations:
            value = assertion(kind, raw)
            at = instant(raw['observedAt'])
            if value is not None and at in assertions and not equal(value, assertions[at]):
                raise ValueError('Conflicting source deadline observations have the same time.')
            if value is not None:
                assertions[at] = value
        found = [x for x in states if x['sourceId'] == source_id]
        if len(found) > 1:
            raise ValueError('Duplicate deadline stream.')
        state = found[0] if found else None
        if state is None:
            last = observations[-1][1]
            state = dict(sourceId=source_id, assessmentId=source['assessmentId'],
                         watermark=last['observedAt'], established=False)
            known = [(kind, raw) for kind, raw in observations if assertion(kind, raw) is not None]
            if known:
                kind, raw = known[-1]; value = assertion(kind, raw)
                state.update(accepted=deepcopy(value), acceptedAt=raw['observedAt'], sourceUrl=raw['sourceUrl'],
                             established=value['kind'] != 'removed')
            states.append(state)
            continue
        for kind, raw in observations:
            at = instant(raw['observedAt']); watermark = instant(state['watermark'])
            value = assertion(kind, raw)
            if at < watermark:
                continue
            old = state.get('accepted')
            if value is not None and old is not None and at == instant(state['acceptedAt']) and not equal(old, value):
                raise ValueError('Conflicting source deadline observations have the same time.')
            if at > watermark:
                state['watermark'] = raw['observedAt']
            if value is None:
                continue
            if old is not None and state['established'] and not equal(old, value):
                snapshot['changes'].append(dict(id=uuid4().hex, assessmentId=state['assessmentId'],
                    **{'from':deepcopy(old)}, to=deepcopy(value), detectedAt=datetime.now(timezone.utc).isoformat(),
                    sourceId=source_id, sourceUrl=raw['sourceUrl'], sourceObservedAt=raw['observedAt']))
            state.update(accepted=deepcopy(value), acceptedAt=raw['observedAt'], sourceUrl=raw['sourceUrl'])
            if value['kind'] != 'removed':
                state['established'] = True
