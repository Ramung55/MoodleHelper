"""Source-first reconciliation of local, explicitly collected facts.

All entry points operate on the caller's transaction-owned Snapshot. They never
fetch Moodle, mutate raw collection observations, or infer a dataset identity.
"""
from copy import deepcopy
from datetime import date, datetime, timezone
from hashlib import sha256
import json
import re
import unicodedata
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from types import SimpleNamespace

from backend.identity import validate_namespace, MOODLE_ORIGIN


class ReconciliationConflict(ValueError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'))


def key(namespace, *parts):
    return canonical(validate_namespace(namespace) + list(parts))


def digest(value):
    return sha256(canonical(value).encode()).hexdigest()


def instant(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            return None
        return result.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def latest(items, field='observedAt'):
    def ordering(item):
        parsed = instant(item.get(field))
        return (parsed is not None, parsed or datetime.min.replace(tzinfo=timezone.utc), canonical(item))
    return max(items, key=ordering)


def normalized_title(value):
    return ' '.join(unicodedata.normalize('NFKC', value).split()).casefold()


def date_day(value, settings):
    try:
        if value['kind'] == 'date':
            return date.fromisoformat(value['date'])
        if value['kind'] == 'exact':
            parsed = instant(value['iso'])
            zone = timezone.utc if settings['timezone'] == 'UTC' else ZoneInfo(settings['timezone'])
            return parsed.astimezone(zone).date() if parsed else None
    except (ValueError, KeyError, ZoneInfoNotFoundError, OverflowError):
        pass
    return None


def compatible_dates(a, b, settings):
    """A heuristic only: never turn an imprecise date into a deadline."""
    if a['kind'] == 'unknown' or b['kind'] == 'unknown':
        return False
    if a['kind'] == b['kind'] == 'week':
        return a['week'] == b['week']
    if a['kind'] == b['kind'] == 'exact':
        first, second = instant(a['iso']), instant(b['iso'])
        if first and first == second:
            return True  # Same instant has the same local day in any timezone.
    da, db = date_day(a, settings), date_day(b, settings)
    if da and db:
        return da == db
    week, day = (a, db) if a['kind'] == 'week' else (b, da)
    if week['kind'] != 'week' or day is None:
        return False
    try:
        start = date.fromisoformat(settings['semesterStart'])
        delta = (day - start).days
        return delta >= 0 and delta // 7 + 1 == week['week']
    except (ValueError, KeyError):
        return False


def layer(snapshot):
    return snapshot.setdefault('reconciliation', dict(sources=[], pairs=[], aliases=[],
                                                        logicalAssessments=[], logicalOverlays=[], overlayEdits=[]))


def assessment(snapshot, identifier):
    found = [a for a in snapshot['assessments'] if a['id'] == identifier]
    if len(found) != 1:
        raise ReconciliationConflict('An assessment identity is missing or ambiguous. Review the saved records and retry.')
    return found[0]


def source(snapshot, identifier):
    found = [s for s in layer(snapshot)['sources'] if s['id'] == identifier]
    if len(found) != 1:
        raise ReconciliationConflict('A source is missing or ambiguous. Refresh and retry.')
    return found[0]


def relevant_date(a, kind):
    sources = [x for x in a['sources'] if x['source'] == kind]
    return latest(sources)['date'] if sources else {'kind': 'unknown'}


def facts(snapshot, left, right):
    a, b = assessment(snapshot, left['assessmentId']), assessment(snapshot, right['assessmentId'])
    return [dict(id=s['id'], course=s['courseId'], title=normalized_title(v['title']), type=v['type'],
                 date=relevant_date(v, s['kind'])) for s, v in ((left, a), (right, b))]


def pair_fingerprint(snapshot, left, right):
    values = facts(snapshot, left, right)
    for value in values:
        date_value = value['date']
        if date_value['kind'] == 'exact' and instant(date_value['iso']):
            value['date'] = {'kind': 'exact', 'instant': instant(date_value['iso']).isoformat()}
    return digest(values)


def review_revision(snapshot, left, right):
    result = []
    for src in (left, right):
        overlays = [o for o in snapshot['overlays'] if o['assessmentId'] == src['assessmentId']]
        if len(overlays) > 1:
            raise ReconciliationConflict('Multiple personal overlays exist for one original; resolve them before matching.')
        result.append(dict(source=src['id'], overlay=overlays[0] if overlays else None,
                           submission=assessment(snapshot, src['assessmentId']).get('submission')))
    return digest(result)


def compatible(snapshot, left, right, *, allow_ambiguous=False):
    if not allow_ambiguous and (left.get('state') == 'ambiguous' or right.get('state') == 'ambiguous'):
        return False
    if left['id'] == right['id'] or left['kind'] == right['kind'] or left['courseId'] != right['courseId']:
        return False
    a, b = assessment(snapshot, left['assessmentId']), assessment(snapshot, right['assessmentId'])
    return (not a['personal'] and not b['personal'] and a['courseId'] == b['courseId'] == left['courseId']
            and a['type'] == b['type'] and a['id'] != b['id'])


def add_pair(snapshot, namespace, first, second, *, automatic=False):
    l = layer(snapshot)
    left, right = sorted((source(snapshot, first), source(snapshot, second)), key=lambda x: x['id'])
    if not compatible(snapshot, left, right):
        if automatic:
            return
        raise ReconciliationConflict('Choose two existing compatible sources from the same course.')
    for existing in l['pairs']:
        if existing['status'] == 'confirmed':
            linked = {source(snapshot, existing['left'])['assessmentId'], source(snapshot, existing['right'])['assessmentId']}
            if {left['assessmentId'], right['assessmentId']} & linked:
                if automatic:
                    return
                if {left['id'], right['id']} == {existing['left'], existing['right']}:
                    return
                raise ReconciliationConflict('One of these sources is already linked to another assessment.')
    if automatic:
        a, b = facts(snapshot, left, right)
        if not a['title'] or a['title'] != b['title'] or not compatible_dates(a['date'], b['date'], snapshot['settings']):
            return
    pair_id = key(namespace, 'pair', left['id'], right['id'])
    fingerprint = pair_fingerprint(snapshot, left, right)
    previous = [p for p in l['pairs'] if p['id'] == pair_id and p['fingerprint'] == fingerprint]
    if len(previous) > 1:
        raise ReconciliationConflict('Saved pair decisions are ambiguous; no changes were saved.')
    if previous:
        return
    # Confirmations survive changes to matching fields. Rejections retain history.
    if any(p['id'] == pair_id and p['status'] == 'confirmed' for p in l['pairs']):
        return
    l['pairs'].append(dict(id=pair_id, left=left['id'], right=right['id'], fingerprint=fingerprint,
                           reviewRevision=review_revision(snapshot, left, right), status='pending'))


def choose_overlay(snapshot, pair, left, right, choices):
    """Combine nonconflicting original overlays without mutating either."""
    overlays = snapshot['overlays']
    def get(identifier):
        found = [o for o in overlays if o['assessmentId'] == identifier]
        if len(found) > 1:
            raise ReconciliationConflict('Multiple personal overlays exist for one original; resolve them before matching.')
        return found[0] if found else {}
    first, second = get(left['assessmentId']), get(right['assessmentId'])
    result = {'assessmentId': pair['canonicalId'], 'hidden': False, 'completed': False}
    groups = {'titleOverride': ('titleOverride',), 'dateOverride': ('dateOverride', 'overrideBase'),
              'hidden': ('hidden',), 'completed': ('completed',)}
    for name, fields in groups.items():
        def value(obj):
            return {field: obj[field] for field in fields if field in obj}
        a, b = value(first), value(second)
        if a and b and a != b:
            choice = choices.get(name)
            if choice not in (left['id'], right['id']):
                raise ReconciliationConflict(f'Choose which personal {name} to keep before confirming this match.')
            picked = a if choice == left['id'] else b
        else:
            picked = a or b
        result.update(deepcopy(picked))
    return result


def choose_submission(snapshot, left, right, choices):
    first = assessment(snapshot, left['assessmentId']).get('submission')
    second = assessment(snapshot, right['assessmentId']).get('submission')
    if first and second and first != second:
        choice = choices.get('submission')
        if choice not in (left['id'], right['id']):
            raise ReconciliationConflict('Choose which submission observation to display before confirming this match.')
        return deepcopy(first if choice == left['id'] else second)
    return deepcopy(first or second)


def rebuild_logical(snapshot):
    l = layer(snapshot)
    ids = [a['id'] for a in snapshot['assessments']]
    if len(ids) != len(set(ids)):
        raise ReconciliationConflict('Duplicate assessment IDs require resolution before reconciliation.')
    aliases = {i: i for i in ids}
    logical = {a['id']: deepcopy(a) for a in snapshot['assessments']}
    overlays = {o['assessmentId']: deepcopy(o) for o in snapshot['overlays']}
    if len(overlays) != len(snapshot['overlays']):
        raise ReconciliationConflict('Duplicate personal overlays require resolution before reconciliation.')
    used = set()
    canonical_groups = set()
    for pair in l['pairs']:
        if pair['status'] != 'confirmed':
            continue
        left, right = source(snapshot, pair['left']), source(snapshot, pair['right'])
        if not compatible(snapshot, left, right, allow_ambiguous=True):
            raise ReconciliationConflict('A confirmed association is no longer compatible; no changes were saved.')
        moodle = left if left['kind'] == 'moodle' else right
        other = right if moodle is left else left
        canonical_id = moodle['assessmentId']
        if pair.get('canonicalId') != canonical_id or canonical_id in used or other['assessmentId'] in used:
            raise ReconciliationConflict('A source is already associated with another assessment.')
        used.update((canonical_id, other['assessmentId']))
        canonical_groups.add(canonical_id)
        merged = logical[canonical_id]
        original = logical.pop(other['assessmentId'])
        existing = {canonical(x) for x in merged['sources']}
        for evidence in original['sources']:
            if canonical(evidence) not in existing:
                merged['sources'].append(deepcopy(evidence)); existing.add(canonical(evidence))
        aliases[other['assessmentId']] = canonical_id
        submission = choose_submission(snapshot, left, right, pair.get('choices', {}))
        if submission:
            merged['submission'] = submission
        combined = choose_overlay(snapshot, pair, left, right, pair.get('choices', {}))
        overlays.pop(other['assessmentId'], None)
        overlays[canonical_id] = combined
    edit_ids = [edit['assessmentId'] for edit in l['overlayEdits']]
    if len(edit_ids) != len(set(edit_ids)):
        raise ReconciliationConflict('Duplicate logical overlays require resolution before reconciliation.')
    for edit in l['overlayEdits']:
        if edit['assessmentId'] not in canonical_groups:
            raise ReconciliationConflict('A logical overlay references a missing assessment.')
        overlays[edit['assessmentId']] = deepcopy(edit)
    l['aliases'] = [dict(originalId=i, canonicalId=aliases[i]) for i in ids]
    l['logicalAssessments'] = [logical[i] for i in ids if i in logical]
    l['logicalOverlays'] = list(overlays.values())


def decide(snapshot, namespace, body):
    l = layer(snapshot)
    matches = [p for p in l['pairs'] if p['id'] == body['pairId'] and p['fingerprint'] == body['fingerprint']]
    if len(matches) != 1:
        raise ReconciliationConflict('This match is stale or unavailable. Refresh and review the current evidence.')
    pair = matches[0]
    if pair['status'] != 'pending':
        if pair['status'] == ('confirmed' if body['kind'] == 'confirm' else 'rejected'):
            if body['kind'] == 'confirm' and pair.get('choices', {}) != body['choices']:
                raise ReconciliationConflict('This pair was confirmed with different choices. Refresh to see the saved decision.')
            if body['kind'] == 'reject' and body['choices']:
                raise ReconciliationConflict('A rejection cannot include personal conflict choices.')
            return
        raise ReconciliationConflict('This pair already has a different decision. Refresh to see it.')
    left, right = source(snapshot, pair['left']), source(snapshot, pair['right'])
    if not compatible(snapshot, left, right) or pair_fingerprint(snapshot, left, right) != pair['fingerprint']:
        raise ReconciliationConflict('The source evidence changed. Refresh and review it before deciding.')
    if body['reviewRevision'] != review_revision(snapshot, left, right):
        raise ReconciliationConflict('Personal data or submission evidence changed. Refresh and review it before deciding.')
    if set(body['choices']) - {'titleOverride', 'dateOverride', 'hidden', 'completed', 'submission'} or any(v not in (left['id'], right['id']) for v in body['choices'].values()):
        raise ReconciliationConflict('Personal conflict choices must refer to the two reviewed sources.')
    if body['kind'] == 'reject':
        if body['choices']:
            raise ReconciliationConflict('A rejection cannot include personal conflict choices.')
        pair['status'] = 'rejected'
    else:
        pair['canonicalId'] = (left if left['kind'] == 'moodle' else right)['assessmentId']
        choose_overlay(snapshot, pair, left, right, body['choices'])
        choose_submission(snapshot, left, right, body['choices'])
        pair['choices'] = deepcopy(body['choices'])
        pair['status'] = 'confirmed'
    rebuild_logical(snapshot)


def _positive(value):
    return isinstance(value, str) and re.fullmatch(r'[1-9][0-9]*', value) is not None


def _activity(record, namespace, courses):
    """Validate source-kind identity and exact course association; fail closed."""
    kind = record['kind']
    if kind not in ('assignment', 'quiz', 'calendar'):
        return None
    obs = record['observations']
    raw = latest(obs)
    source_course = raw.get('sourceCourseId')
    if not _positive(source_course) or courses.get(source_course) != record['courseId']:
        return None
    if any(o.get('sourceCourseId') != source_course for o in obs):
        return None
    # Snapshot restore is intentionally wire-permissive. Revalidate each raw
    # fact at the collection boundary before using it as identity evidence.
    from backend.collection import CollectionService
    validator = SimpleNamespace(store=SimpleNamespace(namespace=namespace))
    for observation in obs:
        page = (f'{MOODLE_ORIGIN}/calendar/view.php' if kind == 'calendar' else observation.get('sourceUrl', ''))
        try:
            identity, course, _ = CollectionService._validate_observation(validator, kind, deepcopy(observation), page, courses)
        except (ValueError, KeyError, TypeError):
            return None
        if identity != record['id'] or course != record['courseId']:
            return None
    if kind in ('assignment', 'quiz'):
        module = 'assign' if kind == 'assignment' else 'quiz'
        activity, cm = raw.get('sourceActivityId'), raw.get('sourceCourseModuleId')
        expected = key(namespace, kind, source_course, module, activity)
        url = f'{MOODLE_ORIGIN}/mod/{module}/view.php?id={cm}'
        if not _positive(activity) or not _positive(cm) or record['id'] != expected:
            return None
        if any(o.get('sourceActivityId') != activity or o.get('sourceCourseModuleId') != cm or o.get('sourceUrl') != url for o in obs):
            return None
        occurrence = None
    else:
        event, occurrence = raw.get('sourceEventId'), raw.get('sourceOccurrenceId')
        series = raw.get('sourceSeriesId')
        expected = key(namespace, 'calendar_event', event, occurrence)
        if not _positive(event) or record['id'] != expected or bool(occurrence) != bool(series):
            return None
        if occurrence and (not _positive(occurrence) or not _positive(series)):
            return None
        url = f'{MOODLE_ORIGIN}/calendar/view.php?event={event}' + (f'&occurrence={occurrence}' if occurrence else '')
        activity_fact = raw.get('activity')
        if not activity_fact:
            return None
        module = activity_fact.get('moduleType')
        activity, cm = activity_fact.get('sourceActivityId'), activity_fact.get('sourceCourseModuleId')
        if module not in ('assign', 'quiz') or not _positive(activity) or not _positive(cm):
            return None
        activity_url = f'{MOODLE_ORIGIN}/mod/{module}/view.php?id={cm}'
        if activity_fact.get('sourceUrl') != activity_url:
            return None
        if any(o.get('sourceEventId') != event or o.get('sourceOccurrenceId') != occurrence or
               o.get('sourceSeriesId') != series or o.get('sourceUrl') != url or o.get('activity') != activity_fact for o in obs):
            return None
    identity = key(namespace, 'activity', source_course, module, activity)
    if occurrence:
        identity = key(namespace, 'occurrence', source_course, module, activity, series, occurrence)
    return dict(identity=identity, module=module, activity=activity, cm=cm,
                occurrence=occurrence, sourceCourse=source_course, raw=raw)


def project_sources(snapshot, namespace):
    """Project validated source associations; leave unsupported records untouched."""
    records = snapshot.get('collection', {}).get('records', [])
    if not records and 'reconciliation' not in snapshot:
        return
    l = layer(snapshot)
    record_ids = [r['id'] for r in records]
    if len(record_ids) != len(set(record_ids)):
        raise ReconciliationConflict('Duplicate source records require resolution before reconciliation.')
    discovered = {}
    for course in snapshot['courses']:
        source_id = course.get('discovery', {}).get('sourceCourseId')
        if source_id:
            discovered.setdefault(source_id, []).append(course['id'])
    courses = {k: v[0] for k, v in discovered.items() if len(v) == 1 and
               sum(c['id'] == v[0] for c in snapshot['courses']) == 1}
    parsed = [(record, _activity(record, namespace, courses)) for record in records
              if record['kind'] in ('assignment', 'quiz', 'calendar')]
    parsed = [(r, a) for r, a in parsed if a]
    parsed.sort(key=lambda entry: entry[0]['kind'] == 'calendar')
    # An activity instance and module must have a one-to-one association; no
    # association is made when either side has contradictory identifiers.
    mapping = {}
    reverse = {}
    for record, a in parsed:
        if a['occurrence']:
            continue
        activity_key = (record['courseId'], a['module'], a['activity'])
        cm_key = (record['courseId'], a['module'], a['cm'])
        mapping.setdefault(activity_key, set()).add(a['cm'])
        reverse.setdefault(cm_key, set()).add(a['activity'])
    parsed = [(r, a) for r, a in parsed if a['occurrence'] or
              (len(mapping[(r['courseId'], a['module'], a['activity'])]) == 1 and
               len(reverse[(r['courseId'], a['module'], a['cm'])]) == 1)]
    authoritative = {a['identity'] for r, a in parsed if r['kind'] in ('assignment', 'quiz')}
    expected = {}
    for record, a in parsed:
        if record['kind'] == 'calendar' and not a['occurrence'] and a['identity'] not in authoritative:
            continue
        identifier = key(namespace, 'source', record['courseId'], record['kind'], record['id'])
        expected[identifier] = dict(id=identifier, courseId=record['courseId'],
            assessmentId=key(namespace, 'assessment', a['identity']), kind='moodle', recordId=record['id'])
    for candidate in snapshot['candidates']:
        documents = [d for d in snapshot['documents'] if d['id'] == candidate['documentId']]
        if len(documents) != 1 or documents[0]['courseId'] != candidate['courseId']:
            continue
        identifier = key(namespace, 'source', candidate['courseId'], 'syllabus', candidate['documentId'], candidate['id'])
        expected[identifier] = dict(id=identifier, courseId=candidate['courseId'], assessmentId=f"syl-{candidate['id']}",
            kind='syllabus', documentId=candidate['documentId'], candidateId=candidate['id'])
    # Keep the last validated projection when new raw evidence contradicts an
    # existing association. Retain every observation, but do not suggest new
    # matches from that ambiguous source until the ambiguity is resolved.
    for saved in l['sources']:
        if saved['kind'] != 'moodle' or saved['id'] in expected:
            continue
        record = next((r for r in records if r['id'] == saved.get('recordId')), None)
        if not record:
            continue
        for observation in record['observations']:
            one = {**record, 'observations': [observation]}
            activity = _activity(one, namespace, courses)
            if not activity:
                continue
            identifier = key(namespace, 'source', record['courseId'], record['kind'], record['id'])
            base = dict(id=identifier, courseId=record['courseId'], assessmentId=key(namespace, 'assessment', activity['identity']), kind='moodle', recordId=record['id'])
            if {k:v for k,v in saved.items() if k != 'state'} == base:
                expected[identifier] = {**base, 'state':'ambiguous'}
                break
    if len([c['id'] for c in snapshot['candidates']]) != len({c['id'] for c in snapshot['candidates']}):
        raise ReconciliationConflict('Duplicate candidate identities require resolution before reconciliation.')
    source_ids = [s['id'] for s in l['sources']]
    if len(source_ids) != len(set(source_ids)):
        raise ReconciliationConflict('Duplicate source associations require resolution before reconciliation.')
    for existing_source in l['sources']:
        expected_source = expected.get(existing_source['id'])
        if not expected_source or {k:v for k,v in existing_source.items() if k != 'state'} != {k:v for k,v in expected_source.items() if k != 'state'}:
            raise ReconciliationConflict('Saved source identity no longer matches its original evidence. No changes were saved.')
        existing_source.pop('state', None)
        if expected_source.get('state'):
            existing_source['state'] = expected_source['state']
        item = assessment(snapshot, existing_source['assessmentId'])
        if item['personal'] or item['courseId'] != existing_source['courseId']:
            raise ReconciliationConflict('Saved source identity conflicts with an assessment. No changes were saved.')
    pair_keys = set()
    for pair in l['pairs']:
        left, right = source(snapshot, pair['left']), source(snapshot, pair['right'])
        if pair['left'] >= pair['right'] or pair['id'] != key(namespace, 'pair', pair['left'], pair['right']) or not re.fullmatch(r'[0-9a-f]{64}', pair['fingerprint']):
            raise ReconciliationConflict('Saved pair identity is invalid. No changes were saved.')
        if (pair['id'], pair['fingerprint']) in pair_keys or not compatible(snapshot, left, right, allow_ambiguous=True):
            raise ReconciliationConflict('Saved pair is ambiguous or incompatible. No changes were saved.')
        pair_keys.add((pair['id'], pair['fingerprint']))
        if set(pair.get('choices', {})) - {'titleOverride', 'dateOverride', 'hidden', 'completed', 'submission'} or any(v not in (left['id'], right['id']) for v in pair.get('choices', {}).values()):
            raise ReconciliationConflict('Saved personal conflict choices are invalid. No changes were saved.')
    for record, a in parsed:
        if record['kind'] == 'calendar' and not a['occurrence'] and a['identity'] not in authoritative:
            continue
        assessment_id = key(namespace, 'assessment', a['identity'])
        source_id = key(namespace, 'source', record['courseId'], record['kind'], record['id'])
        association = dict(id=source_id, courseId=record['courseId'], assessmentId=assessment_id,
                           kind='moodle', recordId=record['id'])
        existing_source = [s for s in l['sources'] if s['id'] == source_id]
        if existing_source and existing_source[0] != association:
            raise ReconciliationConflict('A saved source association conflicts with current identity; no changes were saved.')
        existing = [v for v in snapshot['assessments'] if v['id'] == assessment_id]
        if len(existing) > 1 or existing and (existing[0]['personal'] or existing[0]['courseId'] != record['courseId']):
            raise ReconciliationConflict('A generated assessment ID collides with existing data; no changes were saved.')
        if not existing and any(v['id'] == assessment_id for v in snapshot['assessments']):
            raise ReconciliationConflict('Assessment identity collision; no changes were saved.')
        raw = a['raw']
        if record['kind'] == 'calendar' and not a['occurrence']:
            # Raw calendar observations remain referenced; their start/end have
            # no established deadline semantics and add no invented evidence.
            if not existing:
                continue
        else:
            if record['kind'] == 'assignment':
                observed_date = raw.get('effectiveDates', {}).get('due', {}).get('value', {'kind': 'unknown'})
            elif record['kind'] == 'quiz':
                observed_date = raw.get('closing', {}).get('value', {'kind': 'unknown'})
            else:
                observed_date = {'kind': 'unknown', 'note': 'Calendar date semantics are not known'}
            evidence = dict(source='moodle', date=deepcopy(observed_date), observedAt=raw['observedAt'], url=raw['sourceUrl'])
            if not existing:
                snapshot['assessments'].append(dict(id=assessment_id, courseId=record['courseId'],
                    title=raw['title'], type='assignment' if a['module'] == 'assign' else 'quiz',
                    sources=[evidence], personal=False, firstObservedAt=record['firstObservedAt'],
                    lastObservedAt=record['lastObservedAt']))
            else:
                item = existing[0]
                # Existing opaque assessments are never repurposed: the stable
                # source mapping must have been created by this service first.
                if not any(s['assessmentId'] == assessment_id for s in l['sources']):
                    raise ReconciliationConflict('A generated assessment ID collides with existing data; no changes were saved.')
                if canonical(evidence) not in {canonical(e) for e in item['sources']}:
                    item['sources'].append(evidence)
                if instant(raw['observedAt']) and (not instant(item['lastObservedAt']) or instant(raw['observedAt']) > instant(item['lastObservedAt'])):
                    item['title'], item['lastObservedAt'] = raw['title'], raw['observedAt']
        if not existing_source:
            l['sources'].append(association)
    for candidate in snapshot['candidates']:
        if candidate['status'] not in ('confirmed', 'corrected', 'auto'):
            continue
        document = [d for d in snapshot['documents'] if d['id'] == candidate['documentId']]
        if len(document) != 1 or document[0]['courseId'] != candidate['courseId']:
            continue
        assessment_id = f"syl-{candidate['id']}"
        if len([a for a in snapshot['assessments'] if a['id'] == assessment_id and a['courseId'] == candidate['courseId'] and not a['personal']]) != 1:
            continue
        source_id = key(namespace, 'source', candidate['courseId'], 'syllabus', candidate['documentId'], candidate['id'])
        association = dict(id=source_id, courseId=candidate['courseId'], assessmentId=assessment_id,
                           kind='syllabus', documentId=candidate['documentId'], candidateId=candidate['id'])
        previous = [s for s in l['sources'] if s['id'] == source_id]
        if previous and previous[0] != association:
            raise ReconciliationConflict('A saved syllabus association is ambiguous; no changes were saved.')
        if not previous:
            l['sources'].append(association)
    current_pairs = []
    for pair in l['pairs']:
        if pair['status'] == 'pending':
            left, right = source(snapshot, pair['left']), source(snapshot, pair['right'])
            if not compatible(snapshot, left, right) or pair['fingerprint'] != pair_fingerprint(snapshot, left, right):
                continue
            linked = set()
            for confirmed in l['pairs']:
                if confirmed['status'] == 'confirmed':
                    linked.update((source(snapshot, confirmed['left'])['assessmentId'], source(snapshot, confirmed['right'])['assessmentId']))
            if {left['assessmentId'], right['assessmentId']} & linked:
                continue
            pair['reviewRevision'] = review_revision(snapshot, left, right)
        current_pairs.append(pair)
    l['pairs'] = current_pairs
    for a in l['sources']:
        for b in l['sources']:
            if a['kind'] == 'moodle' and b['kind'] == 'syllabus':
                add_pair(snapshot, namespace, a['id'], b['id'], automatic=True)
    rebuild_logical(snapshot)
