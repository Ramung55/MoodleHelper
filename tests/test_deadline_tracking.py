"""Fictional observations through the real collection HTTP/SQLite path."""
from copy import deepcopy

from test_page_refresh import harness, assignment, begin, refresh, result
import pytest
from pydantic import TypeAdapter, ValidationError
from jsonschema import ValidationError as SchemaError
from backend.schemas import DeadlineStream
from test_model_inventory import zod


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
