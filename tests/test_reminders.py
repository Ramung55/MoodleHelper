"""#38 persisted reminder plan, ledger, catch-up and eligibility (#53 AC3, #54 AC4)."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone, tzinfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL

from backend.main import create_app
from backend.reminders import plan, local_instant, zoneinfo_resolver
from backend.sample_data import build_sample_snapshot
from backend.sqlite_store import SQLiteStore
from backend.storage import InMemoryStore


class Fixed(tzinfo):
    """Deterministic +05:00 stand-in for Asia/Almaty (no IANA data on Windows)."""
    def utcoffset(self, dt): return timedelta(hours=5)
    def dst(self, dt): return timedelta(0)
    def tzname(self, dt): return 'ALMT'


class Spring(tzinfo):
    """+01:00 until 2027-03-28 01:00Z, then +02:00 (02:00-03:00 local gap; fold back on 2027-10-31)."""
    def _offset(self, dt):
        local = dt.replace(tzinfo=None)
        gap_start, fold_start = datetime(2027, 3, 28, 2), datetime(2027, 10, 31, 2)
        if gap_start <= local < gap_start + timedelta(hours=1):
            return timedelta(hours=2 if dt.fold else 1)
        if fold_start <= local < fold_start + timedelta(hours=1):
            return timedelta(hours=1 if dt.fold else 2)
        return timedelta(hours=2) if gap_start <= local < fold_start else timedelta(hours=1)
    def utcoffset(self, dt): return self._offset(dt)
    def dst(self, dt): return timedelta(0)
    def tzname(self, dt): return 'SPR'
    def fromutc(self, dt):
        utc = dt.replace(tzinfo=None)
        summer = datetime(2027, 3, 28, 1) <= utc < datetime(2027, 10, 31, 1)
        return (utc + timedelta(hours=2 if summer else 1)).replace(tzinfo=self)


def resolver(name):
    return {'Asia/Almaty': Fixed(), 'Europe/Paris': Spring()}.get(name)


NOW = datetime(2027, 2, 10, 12, 0, tzinfo=timezone.utc)
CALENDAR = dict(startDate='2027-02-01', endDate='2027-05-23', timezone='Asia/Almaty', excludedWeekStarts=[])


def ev(value, source='moodle'):
    return dict(source=source, date=value, observedAt='2027-01-01T00:00:00Z')


def assessment(id, value, course='c-csc', type='assignment', **extra):
    return dict(id=id, courseId=course, title=f'Title {id}', type=type, personal=False,
                sources=[ev(value)], firstObservedAt='2027-01-01T00:00:00Z', lastObservedAt='2027-01-01T00:00:00Z', **extra)


def snapshot(*items, overlays=(), **reminders):
    data = build_sample_snapshot()
    data.update(assessments=list(items), overlays=list(overlays), changes=[], alerts=[], candidates=[], documents=[])
    data['settings']['teachingCalendar'] = deepcopy(CALENDAR)
    data['settings']['reminders'] = {'enabled': True, 'hoursBefore': 24, 'busyWeek': True, **reminders}
    return data


EXACT = dict(kind='exact', iso='2027-02-12T18:00:00Z', tz='Asia/Almaty')


@pytest.fixture(params=['memory', 'sqlite'])
def env(request, tmp_path):
    clock = {'now': NOW}
    def make(data):
        store = (InMemoryStore(data) if request.param == 'memory' else
                 SQLiteStore(URL.create('sqlite', database=str(tmp_path / 'r.sqlite3'))))
        if request.param == 'sqlite':
            store.replace(data)
        return store
    def app(store):
        return TestClient(create_app(store, reminder_clock=lambda: clock['now'], reminder_resolver=resolver))
    yield make, app, clock


def binding(client):
    return {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}


def items(client):
    return client.get('/api/reminders/plan').json()['items']


def dispatch(client, key, generation=None, dataset=None):
    current = client.get('/api/reminders/plan').json()
    return client.post('/api/reminders/dispatch', headers=binding(client), json=dict(
        datasetId=dataset or current['datasetId'], expectedGeneration=generation or current['generation'], idempotencyKey=key))


def test_defaults_exact_24h_date_only_previous_day_and_week_only_never_deadline():
    data = snapshot(assessment('ex', EXACT), assessment('day', {'kind': 'date', 'date': '2027-02-15'}),
                    assessment('wk', {'kind': 'week', 'week': 3}), assessment('unk', {'kind': 'unknown'}))
    result = plan(data, 'ns', 'ds', NOW, resolver)
    by = {i.get('assessmentId'): i for i in result['items']}
    assert by['ex']['dueAt'] == '2027-02-11T18:00:00Z' and by['ex']['precision'] == 'exact'
    assert by['day']['dueAt'] == '2027-02-14T04:00:00Z'  # 09:00 +05:00 the previous day
    assert by['day']['localTime'] == '2027-02-14T09:00' and by['day']['timezone'] == 'Asia/Almaty'
    assert by['day']['label'] == 'Reminder for date-only event; deadline time unknown'
    assert 'wk' not in by  # week-only: busy-week aggregate only
    assert by['unk']['reason'] == 'date_unknown' and 'dueAt' not in by['unk']


def test_omitted_new_fields_read_documented_defaults_and_legacy_lead_is_preserved():
    data = snapshot(assessment('ex', EXACT), hoursBefore=48)
    item = plan(data, 'ns', 'ds', NOW, resolver)['items'][0]
    assert item['dueAt'] == '2027-02-10T18:00:00Z'
    assert 'busyWeekLeadDays' not in data['settings']['reminders']


@pytest.mark.parametrize('hours', [-1, 721, float('inf')])
def test_invalid_legacy_lead_is_unavailable_with_reason_not_defaulted(hours):
    data = snapshot(assessment('ex', EXACT))
    data['settings']['reminders']['hoursBefore'] = hours
    result = plan(data, 'ns', 'ds', NOW, resolver)
    assert 'invalid_lead_time' in result['reasons'] and result['items'][0]['reason'] == 'invalid_lead_time'


def test_busy_week_strictly_above_threshold_n_days_before_week_start():
    many = [assessment(f'w{i}', {'kind': 'week', 'week': 4}) for i in range(6)]
    data = snapshot(*many)
    week = [i for i in plan(data, 'ns', 'ds', NOW, resolver)['items'] if i['kind'] == 'busy_week']
    assert len(week) == 1 and week[0]['week'] == 4
    assert week[0]['localTime'] == '2027-02-15T09:00'  # week 4 starts 2027-02-22, 7 days before
    data['settings']['thresholds'] = {'maxOutstanding': 6, 'maxWeighted': 100}
    assert not [i for i in plan(data, 'ns', 'ds', NOW, resolver)['items'] if i['kind'] == 'busy_week']
    data['settings']['thresholds'] = {'maxOutstanding': 5, 'maxWeighted': 100}
    data['settings']['reminders'].update(busyWeekLeadDays=2, busyWeekLocalTime='18:30')
    assert [i['localTime'] for i in plan(data, 'ns', 'ds', NOW, resolver)['items']] == ['2027-02-20T18:30']


def test_dst_gap_and_fold_stay_unresolved_never_guessed():
    zone = Spring()
    assert local_instant(datetime(2027, 3, 28).date(), '02:30', zone) is None
    assert local_instant(datetime(2027, 10, 31).date(), '02:30', zone) is None
    assert local_instant(datetime(2027, 3, 28).date(), '09:00', zone) == datetime(2027, 3, 28, 7, tzinfo=timezone.utc)
    data = snapshot(assessment('day', {'kind': 'date', 'date': '2027-03-29'}), dateOnlyLocalTime='02:30')
    data['settings']['teachingCalendar']['timezone'] = 'Europe/Paris'
    assert plan(data, 'ns', 'ds', NOW, resolver)['items'][0]['reason'] == 'local_time_ambiguous'


def test_missing_calendar_or_timezone_data_is_explicit():
    data = snapshot(assessment('day', {'kind': 'date', 'date': '2027-02-15'}))
    del data['settings']['teachingCalendar']
    result = plan(data, 'ns', 'ds', NOW, resolver)
    assert result['items'][0]['reason'] == 'calendar_missing' and 'calendar_missing' in result['reasons']
    data['settings']['teachingCalendar'] = deepcopy(CALENDAR)
    result = plan(data, 'ns', 'ds', NOW, lambda name: None)
    assert result['items'][0]['reason'] == 'timezone_data_unavailable'


def test_real_zoneinfo_resolves_with_tzdata_and_fails_closed_only_for_invalid_zone():
    assert zoneinfo_resolver('Asia/Almaty') is not None  # tzdata dependency supplies IANA data
    assert zoneinfo_resolver('Europe/Paris') is not None
    assert zoneinfo_resolver('Not/AZone') is None
    data = snapshot(assessment('day', {'kind': 'date', 'date': '2027-02-15'}))
    data['settings']['teachingCalendar']['timezone'] = 'Not/AZone'
    assert plan(data, 'ns', 'ds', NOW)['items'][0]['reason'] in ('calendar_invalid', 'timezone_data_unavailable')  # fail closed


def test_ac2_real_zone_date_only_default_time_and_busy_week():
    many = [assessment(f'd{i}', {'kind': 'date', 'date': '2027-02-23'}) for i in range(6)]
    result = plan(snapshot(*many), 'ns', 'ds', NOW)
    deadlines = [i for i in result['items'] if i['kind'] != 'busy_week']
    assert deadlines and all(i.get('reason') != 'timezone_data_unavailable' for i in result['items'])
    assert {i['dueAt'] for i in deadlines} == {'2027-02-22T04:00:00Z'}  # previous day 09:00 Asia/Almaty
    week = [i for i in result['items'] if i['kind'] == 'busy_week']
    assert len(week) == 1 and week[0]['week'] == 4 and week[0]['localTime'] == '2027-02-15T09:00'


def test_ac4_real_zone_week_only_gets_week_level_warning_only():
    many = [assessment(f'w{i}', {'kind': 'week', 'week': 4}) for i in range(6)]
    items_ = plan(snapshot(*many), 'ns', 'ds', NOW)['items']
    assert [i['kind'] for i in items_] == ['busy_week'] and items_[0]['week'] == 4
    assert items_[0]['timezone'] == 'Asia/Almaty' and items_[0]['localTime'] == '2027-02-15T09:00'


def test_hidden_and_completed_cancel_then_undo_rebuilds_same_key_with_submission_precedence():
    """#53 AC3 and #54 AC4 through the persisted scheduler."""
    base = snapshot(assessment('a', EXACT), assessment('d', EXACT, submission={'status': 'draft', 'observedAt': '2027-01-01T00:00:00Z'}),
                    assessment('s', EXACT, submission={'status': 'submitted', 'observedAt': '2027-01-01T00:00:00Z'}))
    first = {i['assessmentId']: i['deliveryKey'] for i in plan(base, 'ns', 'ds', NOW, resolver)['items']}
    assert set(first) == {'a', 'd'}  # submitted is not outstanding
    done = deepcopy(base); done['overlays'] = [dict(assessmentId=x, completed=True, hidden=False) for x in 'ads']
    assert {i['assessmentId'] for i in plan(done, 'ns', 'ds', NOW, resolver)['items']} == {'d'}  # draft precedence
    hidden = deepcopy(base); hidden['overlays'] = [dict(assessmentId=x, completed=False, hidden=True) for x in 'ads']
    assert plan(hidden, 'ns', 'ds', NOW, resolver)['items'] == []
    undone = deepcopy(base); undone['overlays'] = [dict(assessmentId=x, completed=False, hidden=False) for x in 'ads']
    assert {i['assessmentId']: i['deliveryKey'] for i in plan(undone, 'ns', 'ds', NOW, resolver)['items']} == first


def test_api_hide_complete_override_reschedule_and_cancel_atomically(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        before = items(client)[0]
        assert before['status'] == 'scheduled'
        client.patch('/api/assessments/a/overlay', json={'hidden': True})
        assert items(client) == []
        client.patch('/api/assessments/a/overlay', json={'hidden': False, 'completed': True})
        assert items(client) == []
        client.patch('/api/assessments/a/overlay', json={'completed': False})
        assert items(client) == [before]
        client.patch('/api/assessments/a/overlay', json={'dateOverride': {'kind': 'date', 'date': '2027-02-20'}})
        moved = items(client)[0]
        assert moved['precision'] == 'date' and moved['dueAt'] == '2027-02-19T04:00:00Z' and moved['deliveryKey'] != before['deliveryKey']
        client.patch('/api/assessments/a/overlay', json={'dateOverride': None})
        assert items(client)[0]['deliveryKey'] == before['deliveryKey']


def test_source_change_reschedules(env):
    make, app, clock = env
    data = snapshot(assessment('a', EXACT))
    with app(make(data)) as client:
        old = items(client)[0]
        changed = client.get('/api/snapshot').json()
        changed['assessments'][0]['sources'] = [ev(dict(EXACT, iso='2027-02-13T18:00:00Z'))]
        client.put('/api/snapshot', json=changed)
        new = items(client)[0]
        assert new['dueAt'] == '2027-02-12T18:00:00Z' and new['deliveryKey'] != old['deliveryKey']


def test_dispatch_on_time_once_then_receipt_and_stale_generation(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        assert dispatch(client, 'k1').json()['requests'] == []
        clock['now'] = datetime(2027, 2, 11, 18, 5, tzinfo=timezone.utc)
        response = dispatch(client, 'k2').json()
        assert [r['kind'] for r in response['requests']] == ['deadline'] and response['replayed'] is False
        again = dispatch(client, 'k2').json()
        assert again['replayed'] is True and again['requests'] == response['requests']
        assert dispatch(client, 'k3').json()['requests'] == []
        assert items(client)[0]['status'] == 'requested'
        stale = dispatch(client, 'k4', generation='g-stale')
        assert stale.status_code == 409
        assert dispatch(client, 'k5', dataset='other-dataset').status_code == 409


def test_binding_required_before_writes(env):
    make, app, clock = env
    with app(make(snapshot())) as client:
        plan_ = client.get('/api/reminders/plan').json()
        body = dict(datasetId=plan_['datasetId'], expectedGeneration=plan_['generation'], idempotencyKey='x')
        assert client.post('/api/reminders/dispatch', json=body).status_code == 409
        assert client.post('/api/reminders/dispatch', json=body, headers={'X-Moodle-Helper-Bridge-Binding': 'old'}).status_code == 409
        assert client.post('/api/reminders/dispatch', json={**body, 'dueAt': 'x'}, headers=binding(client)).status_code == 422
        assert client.post('/api/reminders/reconcile', json={'datasetId': plan_['datasetId']}, headers=binding(client)).json()['generation'] == plan_['generation']


def test_restart_missed_items_become_one_catch_up_and_never_replay(tmp_path):
    clock = {'now': NOW}
    url = URL.create('sqlite', database=str(tmp_path / 'restart.sqlite3'))
    data = snapshot(assessment('a', EXACT), assessment('b', dict(EXACT, iso='2027-02-12T20:00:00Z')),
                    assessment('c', dict(EXACT, iso='2027-02-20T20:00:00Z')))
    store = SQLiteStore(url); store.replace(data)
    with TestClient(create_app(store, reminder_clock=lambda: clock['now'], reminder_resolver=resolver)) as client:
        assert dispatch(client, 'boot-1').json()['requests'] == []
    store.close()
    clock['now'] = datetime(2027, 2, 13, 9, tzinfo=timezone.utc)  # browser was closed; a and b missed
    for attempt in range(3):  # three restarts with fresh worker keys
        store = SQLiteStore(url)
        with TestClient(create_app(store, reminder_clock=lambda: clock['now'], reminder_resolver=resolver)) as client:
            response = dispatch(client, f'restart-{attempt}').json()
            if attempt == 0:
                assert [(r['kind'], r['total']) for r in response['requests']] == [('catch_up', 2)]
                assert {t['assessmentId'] for t in response['requests'][0]['targets']} == {'a', 'b'}
            else:
                assert response['requests'] == []
            assert response['nextWakeAt'] == '2027-02-19T20:00:00Z'
            statuses = {i['assessmentId']: i['status'] for i in items(client)}
            assert statuses == {'a': 'requested', 'b': 'requested', 'c': 'scheduled'}
        store.close()


def test_delete_local_data_cancels_pending(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        assert items(client)
        client.delete('/api/local-data')
        assert items(client) == []


def test_new_settings_fields_validate_atomically(env):
    make, app, clock = env
    with app(make(snapshot())) as client:
        before = client.get('/api/snapshot').json()
        for bad in [{'busyWeekLeadDays': 31}, {'dateOnlyLocalTime': '24:00'}, {'busyWeekLocalTime': '9:00'}]:
            body = {'reminders': {'enabled': True, 'hoursBefore': 24, 'busyWeek': True, **bad}}
            assert client.patch('/api/settings', json=body).status_code == 422
        assert client.get('/api/snapshot').json() == before
        ok = {'enabled': True, 'hoursBefore': 12, 'busyWeek': False, 'busyWeekLeadDays': 3, 'dateOnlyLocalTime': '20:15', 'busyWeekLocalTime': '08:00'}
        assert client.patch('/api/settings', json={'reminders': ok}).json()['settings']['reminders'] == ok


def test_plan_pagination_cursor_bound_to_generation(env):
    make, app, clock = env
    many = [assessment(f'x{i:03}', dict(EXACT, iso=f'2027-03-01T{i % 24:02}:00:00Z')) for i in range(120)]
    with app(make(snapshot(*many, busyWeek=False))) as client:
        first = client.get('/api/reminders/plan?limit=100').json()
        assert len(first['items']) == 100 and 'nextCursor' in first
        second = client.get(f"/api/reminders/plan?cursor={first['nextCursor']}").json()
        assert len(second['items']) == 20
        client.patch('/api/settings', json={'reminders': {'enabled': True, 'hoursBefore': 1, 'busyWeek': False}})
        assert client.get(f"/api/reminders/plan?cursor={first['nextCursor']}").status_code == 409
