"""#39 dashboard alert history, conservative OS delivery ledger and safe destinations."""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import URL

from backend.alert_delivery import assertion_text, change_alert, notification_id
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from test_reminders import EXACT, NOW, assessment, binding, env, resolver, snapshot  # noqa: F401

DUE = datetime(2027, 2, 11, 18, 5, tzinfo=timezone.utc)


def dispatch(client, key):
    p = client.get('/api/reminders/plan').json()
    return client.post('/api/reminders/dispatch', headers=binding(client),
                       json=dict(datasetId=p['datasetId'], expectedGeneration=p['generation'], idempotencyKey=key)).json()


def status(client, key, state, attempt='att-1', **extra):
    p = client.get('/api/reminders/plan').json()
    return client.post('/api/reminders/delivery-status', headers=binding(client),
                       json=dict(datasetId=p['datasetId'], expectedGeneration=p['generation'], deliveryKey=key,
                                 attemptId=attempt, state=state, **extra))


def alerts(client):
    return client.get('/api/snapshot').json()['alerts']


def test_precision_wording_for_every_assertion_kind():
    assert assertion_text(EXACT) == '2027-02-12 23:00 Asia/Almaty'  # 18:00Z in +05:00 via tzdata
    assert assertion_text({'kind': 'exact', 'iso': '2027-02-12T18:00:00Z', 'tz': 'UTC'}) == '2027-02-12 18:00 UTC'
    assert assertion_text({'kind': 'date', 'date': '2027-02-12'}) == '2027-02-12 (date only, no time given)'
    assert assertion_text({'kind': 'week', 'week': 4}) == 'teaching week 4 (week only)'
    assert assertion_text({'kind': 'unknown'}) == 'unknown date'
    assert assertion_text({'kind': 'removed'}) == 'deadline removed'


def test_source_change_alert_keeps_old_new_distinct_ids_and_hidden_policy():
    data = snapshot(assessment('a', EXACT), assessment('h', EXACT), overlays=[dict(assessmentId='h', hidden=True, completed=False)])
    change = {'id': 'chg1', 'assessmentId': 'a', 'from': {'kind': 'date', 'date': '2027-02-12'}, 'to': {'kind': 'removed'},
              'detectedAt': '2027-02-10T12:00:00Z', 'sourceId': 'src-1', 'sourceObservedAt': '2027-02-10T11:00:00Z'}
    assert change_alert(data, change) is True
    assert change_alert(data, change) is False  # one row per delivery key
    alert = data['alerts'][0]
    assert alert['message'] == 'Title a: deadline removed (was 2027-02-12 (date only, no time given))'
    ctx = alert['context']
    assert ctx['change']['changeId'] == 'chg1' and ctx['change']['sourceId'] == 'src-1'
    assert ctx['change']['detectedAt'] != ctx['change']['sourceObservedAt']
    assert ctx['change']['from'] == {'kind': 'date', 'date': '2027-02-12'} and ctx['change']['to'] == {'kind': 'removed'}
    assert ctx['destination'] == 'assessment' and alert['delivery']['state'] == 'pending'
    change_alert(data, dict(change, id='chg2', assessmentId='h'))
    hidden = data['alerts'][0]
    assert hidden['context']['reason'] == 'source_change_hidden' and hidden['delivery']['state'] == 'dashboard_only'


def test_dispatch_persists_dashboard_alert_then_reserves_exactly_once(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        clock['now'] = DUE
        result = dispatch(client, 'k1')
        [row] = alerts(client)
        assert row['kind'] == 'deadline' and row['context']['destination'] == 'assessment' and row['delivery']['state'] == 'pending'
        assert 'Title a is due 2027-02-12' in row['message']
        assert result['pendingDeliveries'] == [dict(deliveryKey=row['deliveryKey'], notificationId=result['pendingDeliveries'][0]['notificationId'])]
        # Lost dispatch response: the next reconcile still lists the pending delivery.
        p = client.post('/api/reminders/reconcile', headers=binding(client), json={'datasetId': result['datasetId']}).json()
        assert p['pendingDeliveries'][0]['deliveryKey'] == row['deliveryKey']
        first = status(client, row['deliveryKey'], 'issued', 'att-1').json()
        assert first['reserved'] is True and first['title'] == 'Moodle Helper' and first['message'] == row['message']
        # Worker restart / duplicate alarm with a new attempt cannot reserve again.
        second = status(client, row['deliveryKey'], 'issued', 'att-2').json()
        assert second['reserved'] is False and second['state'] == 'issued'
        assert status(client, row['deliveryKey'], 'shown', 'att-2').status_code == 409
        assert status(client, row['deliveryKey'], 'shown', 'att-1').json()['state'] == 'shown'
        assert status(client, row['deliveryKey'], 'shown', 'att-1').json()['state'] == 'shown'  # idempotent ack
        assert alerts(client)[0]['delivery']['state'] == 'shown'
        assert client.get('/api/reminders/plan').json()['pendingDeliveries'] == []
        assert len(alerts(client)) == 1 and dispatch(client, 'k2')['requests'] == []


def test_denied_failed_and_ineligible_states_are_truthful(env):
    make, app, clock = env
    data = snapshot(assessment('a', EXACT), assessment('b', dict(EXACT, iso='2027-02-12T18:02:00Z')),
                    assessment('c', dict(EXACT, iso='2027-02-12T18:04:00Z')))
    with app(make(data)) as client:
        clock['now'] = DUE
        dispatch(client, 'k1')
        rows = {r['assessmentId']: r for r in alerts(client)}
        assert status(client, rows['a']['deliveryKey'], 'denied').json()['state'] == 'denied'
        assert status(client, rows['b']['deliveryKey'], 'issued').json()['reserved'] is True
        failed = status(client, rows['b']['deliveryKey'], 'failed', fixedErrorCode='create_failed').json()
        assert failed['state'] == 'failed'
        assert status(client, rows['b']['deliveryKey'], 'failed', fixedErrorCode='https://x').status_code == 422
        client.patch('/api/assessments/c/overlay', json={'hidden': True})
        hidden = status(client, rows['c']['deliveryKey'], 'issued').json()
        assert hidden['reserved'] is False and hidden['state'] == 'dashboard_only'
        states = {r['assessmentId']: (r['delivery']['state'], r['delivery'].get('errorCode')) for r in alerts(client)}
        assert states == {'a': ('denied', 'permission_denied'), 'b': ('failed', 'create_failed'), 'c': ('dashboard_only', 'ineligible')}


def test_stale_generation_and_other_dataset_cannot_update(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        clock['now'] = DUE
        dispatch(client, 'k1')
        key = alerts(client)[0]['deliveryKey']
        p = client.get('/api/reminders/plan').json()
        body = dict(datasetId=p['datasetId'], expectedGeneration='g-stale', deliveryKey=key, attemptId='a1', state='issued')
        assert client.post('/api/reminders/delivery-status', headers=binding(client), json=body).status_code == 409
        assert client.post('/api/reminders/delivery-status', headers=binding(client), json=dict(body, expectedGeneration=p['generation'], datasetId='other')).status_code == 409
        assert client.post('/api/reminders/delivery-status', json=dict(body, expectedGeneration=p['generation'])).status_code == 409  # no binding
        assert client.post('/api/reminders/delivery-status', headers=binding(client), json=dict(body, expectedGeneration=p['generation'], url='http://x')).status_code == 422
        assert alerts(client)[0]['delivery']['state'] == 'pending'


def test_old_pending_becomes_stale_dashboard_only(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        clock['now'] = DUE
        dispatch(client, 'k1')
        clock['now'] = DUE + timedelta(hours=2)
        key = alerts(client)[0]['deliveryKey']
        assert status(client, key, 'issued').json() | {} == status(client, key, 'issued', 'z').json() | {'reserved': False}
        assert alerts(client)[0]['delivery']['errorCode'] == 'stale'


def test_notification_target_is_closed_mapping(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        clock['now'] = DUE
        result = dispatch(client, 'k1')
        nid = result['pendingDeliveries'][0]['notificationId']
        ds = result['datasetId']
        target = client.post('/api/reminders/notification-target', headers=binding(client), json={'datasetId': ds, 'notificationId': nid}).json()
        assert target == {'destination': 'assessment', 'assessmentId': 'a'}
        assert client.post('/api/reminders/notification-target', headers=binding(client), json={'datasetId': ds, 'notificationId': 'mhn-unknown'}).json() == {'destination': 'alerts'}
        assert client.post('/api/reminders/notification-target', headers=binding(client), json={'datasetId': 'other', 'notificationId': nid}).status_code == 409


def test_restore_never_replays_and_legacy_save_cannot_forge_delivery(env):
    make, app, clock = env
    with app(make(snapshot(assessment('a', EXACT)))) as client:
        clock['now'] = DUE
        dispatch(client, 'k1')
        snap = client.get('/api/snapshot').json()
        restored = client.put('/api/snapshot', json=snap).json()
        assert restored['alerts'][0]['delivery']['state'] == 'dashboard_only'
        assert client.get('/api/reminders/plan').json()['pendingDeliveries'] == []
        forged = [dict(restored['alerts'][0], delivery=dict(channel='os', state='pending', updatedAt='x')),
                  dict(id='new', kind='sync', message='m', deliveryKey='n', createdAt='x', read=False,
                       delivery=dict(channel='os', state='pending', updatedAt='x'))]
        saved = client.put('/api/alerts', json=forged).json()['alerts']
        assert saved[0]['delivery']['state'] == 'dashboard_only' and 'delivery' not in saved[1]


def test_mark_read_and_delete_are_narrow_and_keep_delivery_state(env):
    make, app, clock = env
    data = snapshot(assessment('a', EXACT), assessment('b', dict(EXACT, iso='2027-02-12T18:02:00Z')))
    with app(make(data)) as client:
        clock['now'] = DUE
        dispatch(client, 'k1')
        ids = [r['id'] for r in alerts(client)]
        stale_view = alerts(client)
        status(client, stale_view[0]['deliveryKey'], 'issued')
        read = client.post('/api/alerts/update', json={'ids': [ids[0]], 'action': 'read'}).json()['alerts']
        assert read[0]['read'] is True and read[0]['delivery']['state'] == 'issued'  # concurrent update survives
        again = client.post('/api/alerts/update', json={'ids': [ids[0]], 'action': 'read'}).json()['alerts']
        assert again == read
        left = client.post('/api/alerts/update', json={'ids': [ids[1]], 'action': 'delete'}).json()['alerts']
        assert [a['id'] for a in left] == [ids[0]]
        assert client.post('/api/alerts/update', json={'ids': [], 'action': 'read'}).status_code == 422


def test_catch_up_one_consolidated_alert_survives_sqlite_restart(tmp_path):
    clock = {'now': NOW}
    url = URL.create('sqlite', database=str(tmp_path / 'n.sqlite3'))
    store = SQLiteStore(url)
    store.replace(snapshot(assessment('a', EXACT), assessment('b', dict(EXACT, iso='2027-02-12T20:00:00Z'))))
    clock['now'] = datetime(2027, 2, 13, 9, tzinfo=timezone.utc)
    with TestClient(create_app(store, reminder_clock=lambda: clock['now'], reminder_resolver=resolver)) as client:
        dispatch(client, 'boot')
        [row] = alerts(client)
        assert row['context'] == {'destination': 'alerts', 'reason': 'catch_up'} and row['message'].startswith('2 reminders')
        status(client, row['deliveryKey'], 'issued', 'w1')
    store.close()
    store = SQLiteStore(url)
    with TestClient(create_app(store, reminder_clock=lambda: clock['now'], reminder_resolver=resolver)) as client:
        assert dispatch(client, 'boot2')['requests'] == []
        [row] = alerts(client)
        assert row['delivery']['state'] == 'issued'  # unknown outcome after crash: never re-created
        assert status(client, row['deliveryKey'], 'issued', 'w2').json()['reserved'] is False
        assert row['deliveryKey'] not in [p['deliveryKey'] for p in client.get('/api/reminders/plan').json()['pendingDeliveries']]
        assert notification_id(store.namespace, row['deliveryKey']).startswith('mhn-')
    store.close()
