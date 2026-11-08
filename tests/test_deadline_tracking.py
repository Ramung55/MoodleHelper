"""Fictional observations through the real collection HTTP/SQLite path."""
from copy import deepcopy

from test_page_refresh import harness, assignment, begin, refresh, result
import pytest
from pydantic import TypeAdapter, ValidationError
from jsonschema import ValidationError as SchemaError
from backend.schemas import DeadlineStream
from test_model_inventory import zod
from concurrent.futures import ThreadPoolExecutor
import sqlite3
from sqlalchemy import URL, event
from backend.sqlite_store import SQLiteStore
from backend.collection import SyntheticCollectionContext
from backend.main import create_app
from fastapi.testclient import TestClient
from test_reconciliation import make_pair, decision
from backend.deadline_tracking import effective_sources


def ingest(client, visit, raw):
    token, headers = begin(client, visit=visit)
    return refresh(client, token, headers, result(observations=[raw]), time=raw['observedAt'])


def observed(time, value):
    raw = assignment(time)
    if value is None:
        raw['baseDates'] = {}; raw['effectiveDates'] = {}
    else:
        raw['baseDates']['due']['value'] = deepcopy(value)
        raw['effectiveDates']['due']['value'] = deepcopy(value)
    return raw


def test_order_replay_removal_and_overlay(harness):
    client, store, _ = harness
    first = observed('2026-10-27T10:00:00Z', {'kind':'date','date':'2026-11-01'})
    snap = ingest(client, 'first', first).json()['snapshot']
    stream = snap['deadlineStreams'][0]
    existing_count = len(snap['changes'])
    assessment = stream['assessmentId']
    from urllib.parse import quote
    overlay = client.patch('/api/assessments/'+quote(assessment,safe='')+'/overlay', json={'dateOverride':{'kind':'week','week':4},'hidden':True}).json()
    second = observed('2026-10-27T11:00:00Z', {'kind':'date','date':'2026-11-02'})
    snap = ingest(client, 'second', second).json()['snapshot']
    assert len(snap['changes']) == existing_count + 1
    assert snap['changes'][-1]['sourceId'] == stream['sourceId']
    assert snap['overlays'] == overlay['overlays']
    assert len(ingest(client,'replay',second).json()['snapshot']['changes']) == existing_count + 1
    unknown = observed('2026-10-27T13:00:00Z', None)
    ingest(client, 'unknown', unknown)
    late = observed('2026-10-27T12:00:00Z', {'kind':'date','date':'2026-11-03'})
    snap = ingest(client, 'late', late).json()['snapshot']
    assert snap['deadlineStreams'][0]['accepted'] == second['effectiveDates']['due']['value']
    removed = observed('2026-10-27T14:00:00Z', None); removed['syntheticDeadlineRemoval'] = True
    snap = ingest(client, 'removed', removed).json()['snapshot']
    assert snap['changes'][-1]['to'] == {'kind':'removed'}
    assert len(snap['changes']) == existing_count + 2
    assert store.read() == snap


def test_equal_instants_contradictions_and_return_to_old_value(harness):
    client, store, _ = harness
    first = observed('2026-10-27T10:00:00Z', {'kind':'exact','iso':'2026-11-01T10:00:00Z','tz':'UTC'})
    initial = ingest(client, 'initial-exact', first).json()['snapshot']
    count = len(initial['changes'])
    equivalent = observed('2026-10-27T11:00:00Z', {'kind':'exact','iso':'2026-11-01T15:00:00+05:00','tz':'Asia/Almaty'})
    snap = ingest(client, 'equivalent', equivalent).json()['snapshot']
    assert len(snap['changes']) == count
    contradiction = observed('2026-10-27T11:00:00Z', {'kind':'week','week':8})
    before = store.read()
    assert ingest(client, 'contradiction', contradiction).status_code == 409
    assert store.read() == before
    changed = observed('2026-10-27T12:00:00Z', {'kind':'week','week':8})
    assert len(ingest(client, 'week', changed).json()['snapshot']['changes']) == count + 1
    back = observed('2026-10-27T13:00:00Z', first['effectiveDates']['due']['value'])
    snap = ingest(client, 'back', back).json()['snapshot']
    assert len(snap['changes']) == count + 2
    assert snap['changes'][-1]['from'] == {'kind':'week','week':8}


@pytest.mark.parametrize('change', [
    {'accepted': {'kind':'unknown'}, 'acceptedAt':'t', 'sourceUrl':'u'},
    {'accepted': {'kind':'removed'}},
    {'acceptedAt':'t'},
    {'established':True},
])
def test_invalid_stream_shapes_are_rejected_everywhere(change, contract, contract_validator):
    state = {'sourceId':'s','assessmentId':'a','watermark':'t','established':False, **change}
    with pytest.raises(ValidationError):
        TypeAdapter(DeadlineStream).validate_python(state)
    with pytest.raises(SchemaError):
        contract_validator(contract['components']['schemas']['DeadlineStream'], state)
    assert not zod('DeadlineStream', state)['success']


def test_write_failure_concurrent_replay_and_restart(harness):
    client, store, path = harness
    initial = observed('2026-10-27T10:00:00Z', {'kind':'week','week':4})
    baseline = ingest(client, 'baseline', initial).json()['snapshot']
    count = len(baseline['changes'])
    changed = observed('2026-10-27T11:00:00Z', {'kind':'week','week':5})
    def fail_after_update(connection, cursor, statement, parameters, context, many):
        if statement.startswith('UPDATE snapshots'):
            raise sqlite3.OperationalError('simulated failure after write')
    event.listen(store.engine, 'after_cursor_execute', fail_after_update)
    try:
        assert ingest(client, 'failed-write', changed).status_code == 503
    finally:
        event.remove(store.engine, 'after_cursor_execute', fail_after_update)
    assert store.read() == baseline
    other = SQLiteStore(URL.create('sqlite', database=str(path)), namespace=store.namespace)
    try:
        def submit(repo, name):
            with TestClient(create_app(repo, collection_provider=SyntheticCollectionContext(repo.namespace))) as c:
                return ingest(c, name, changed).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = [executor.submit(submit, repo, name) for repo, name in [(store,'writer-a'),(other,'writer-b')]]
            assert [x.result() for x in results] == [200, 200]
        saved = other.read()
        assert saved == store.read()
        assert len(saved['changes']) == count + 1
    finally:
        other.close()
    reopened = SQLiteStore(URL.create('sqlite', database=str(path)), namespace=store.namespace)
    try:
        assert reopened.read() == saved
    finally:
        reopened.close()


def test_confirmed_alias_overlay_history_and_restore(harness):
    client, store, _ = harness
    first = observed('2026-10-27T10:00:00Z', {'kind':'exact','iso':'2026-10-28T13:30:00Z','tz':'UTC'})
    ingest(client, 'alias-baseline', first)
    _, pairs, candidate = make_pair(client)
    assert len(pairs) == 1
    confirmed = decision(client, pairs[0], 'confirm')
    assert confirmed.status_code == 200
    from urllib.parse import quote
    alias = 'syl-' + candidate['id']
    overlay = client.patch('/api/assessments/'+quote(alias,safe='')+'/overlay', json={'dateOverride':{'kind':'week','week':7},'completed':True}).json()
    edited = deepcopy(overlay['reconciliation']['logicalOverlays'])
    updated = observed('2026-10-27T11:00:00Z', {'kind':'date','date':'2026-11-04'})
    result = ingest(client, 'alias-change', updated).json()['snapshot']
    assert result['reconciliation']['logicalOverlays'] == edited
    alias_record = next(a for a in result['reconciliation']['aliases'] if a['originalId'] == alias)
    change = result['changes'][-1]
    assert change['assessmentId'] == alias_record['canonicalId']
    assert change['from'] == first['effectiveDates']['due']['value']
    assert change['to'] == updated['effectiveDates']['due']['value']
    # #39: restored notification records are history, never pending OS replay.
    from backend.alert_delivery import neutralize_imported
    expected = neutralize_imported(deepcopy(result))
    assert all(a.get('delivery', {}).get('state') != 'pending' for a in expected['alerts'])
    assert client.put('/api/snapshot', json=result).json() == expected
    assert store.read() == expected


def test_overlay_and_source_ingestion_race_preserves_both(harness):
    client, store, path = harness
    initial = observed('2026-10-27T10:00:00Z', {'kind':'week','week':4})
    baseline = ingest(client, 'overlay-race-baseline', initial).json()['snapshot']
    assessment_id = baseline['deadlineStreams'][0]['assessmentId']
    changed = observed('2026-10-27T11:00:00Z', {'kind':'week','week':5})
    other = SQLiteStore(URL.create('sqlite', database=str(path)), namespace=store.namespace)
    try:
        def source_write():
            with TestClient(create_app(store, collection_provider=SyntheticCollectionContext(store.namespace))) as c:
                return ingest(c, 'overlay-race-source', changed).status_code
        def overlay_write():
            from urllib.parse import quote
            with TestClient(create_app(other)) as c:
                return c.patch('/api/assessments/'+quote(assessment_id,safe='')+'/overlay', json={'hidden':True,'completed':True}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            source = executor.submit(source_write); overlay = executor.submit(overlay_write)
            assert source.result() == overlay.result() == 200
        saved = store.read()
        assert saved['deadlineStreams'][0]['accepted'] == {'kind':'week','week':5}
        assert next(x for x in saved['overlays'] if x['assessmentId']==assessment_id)['hidden']
        assert next(x for x in saved['overlays'] if x['assessmentId']==assessment_id)['completed']
    finally:
        other.close()


def test_independent_stream_projection_never_revives_removed_raw_date(harness):
    client, _, _ = harness
    raw = observed('2026-10-27T10:00:00Z', {'kind':'week','week':4})
    snap = ingest(client, 'stream-projection', raw).json()['snapshot']
    original = snap['deadlineStreams'][0]
    assessment = next(a for a in snap['assessments'] if a['id'] == original['assessmentId'])
    second = deepcopy(snap['reconciliation']['sources'][0])
    second['id'] = original['sourceId'] + '-second'
    snap['reconciliation']['sources'].append(second)
    state = deepcopy(original); state.update(sourceId=second['id'], accepted={'kind':'week','week':9})
    snap['deadlineStreams'].append(state)
    assert effective_sources(snap, assessment)[-1]['date'] == {'kind':'week','week':9}
    state['accepted'] = {'kind':'removed'}
    assert effective_sources(snap, assessment)[-1]['date'] == {'kind':'week','week':4}
    original['accepted'] = {'kind':'removed'}
    assert not [s for s in effective_sources(snap, assessment) if s['source']=='moodle']


def test_unknown_only_watermark_and_provisional_removal(harness):
    client, _, _ = harness
    unknown = observed('2026-10-27T10:00:00Z', None)
    snap = ingest(client, 'unknown-first', unknown).json()['snapshot']
    count = len(snap['changes'])
    assert snap['deadlineStreams'][0]['watermark'] == unknown['observedAt']
    assert 'accepted' not in snap['deadlineStreams'][0]
    older = observed('2026-10-27T09:00:00Z', {'kind':'week','week':3})
    assert 'accepted' not in ingest(client, 'old-known', older).json()['snapshot']['deadlineStreams'][0]
    removal = observed('2026-10-27T11:00:00Z', None); removal['syntheticDeadlineRemoval'] = True
    snap = ingest(client, 'first-removal', removal).json()['snapshot']
    assert len(snap['changes']) == count and not snap['deadlineStreams'][0]['established']
    known = observed('2026-10-27T12:00:00Z', {'kind':'week','week':4})
    snap = ingest(client, 'first-known', known).json()['snapshot']
    assert len(snap['changes']) == count and snap['deadlineStreams'][0]['established']


def test_submicrosecond_exact_values_and_order_are_not_collapsed(harness):
    client, _, _ = harness
    first = observed('2026-10-27T10:00:00.0000001Z', {'kind':'exact','iso':'2026-11-01T10:00:00.0000001Z','tz':'UTC'})
    snap = ingest(client, 'submicro-first', first).json()['snapshot']
    count = len(snap['changes'])
    second = observed('2026-10-27T10:00:00.0000002Z', {'kind':'exact','iso':'2026-11-01T10:00:00.0000002Z','tz':'UTC'})
    snap = ingest(client, 'submicro-second', second).json()['snapshot']
    assert len(snap['changes']) == count + 1
