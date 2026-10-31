"""#39 dashboard alert history and conservative OS-delivery state.

The dashboard Alert is always persisted first, inside the same Snapshot write
that created its cause (a #22 source change or a #38 dispatch). OS display is an
optional channel recorded in ``Alert.delivery``:

    pending --issued(reserve, one attemptId)--> issued --> shown | failed
    pending --denied--> denied
    pending --(ineligible/stale/disabled at reserve)--> dashboard_only

Only a ``pending`` alert can be reserved, and only once. A worker crash or lost
HTTP response after reservation leaves ``issued`` (reported as unknown outcome);
it is never re-created, so the policy is at-most-once OS issuance, not
guaranteed display. Restored/imported snapshots never replay OS delivery.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.reminders import digest, is_outstanding

STALE = timedelta(hours=1)
TITLE = 'Moodle Helper'
TERMINAL_OS = {'shown', 'failed', 'denied', 'dashboard_only'}


def now_iso(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def notification_id(namespace: str, delivery_key: str) -> str:
    """Stable opaque id; NOT the duplicate guard (create with an existing id replaces it)."""
    return 'mhn-' + digest('notification', namespace, delivery_key)[:32]


def assertion_text(value: dict | None) -> str:
    """Precision-preserving wording shared with the frontend describeAssertion."""
    kind = (value or {}).get('kind')
    if kind == 'removed':
        return 'deadline removed'
    if kind == 'exact':
        try:
            at = datetime.fromisoformat(value['iso'].replace('Z', '+00:00'))
            zone_name = value.get('tz') or 'UTC'
            try:
                from zoneinfo import ZoneInfo
                local = at.astimezone(ZoneInfo(zone_name))
            except Exception:
                local, zone_name = at.astimezone(timezone.utc), 'UTC'
            return f"{local.strftime('%Y-%m-%d %H:%M')} {zone_name}"
        except (ValueError, TypeError, KeyError):
            return 'unknown date'
    if kind == 'date':
        return f"{value['date']} (date only, no time given)"
    if kind == 'week':
        return f"teaching week {value['week']} (week only)"
    return 'unknown date'


def _assessment(snapshot: dict, assessment_id: str):
    layer = snapshot.get('reconciliation') or {}
    for collection, overlays in ((layer.get('logicalAssessments') or [], layer.get('logicalOverlays') or []),
                                 (snapshot['assessments'], snapshot['overlays'])):
        for item in collection:
            if item['id'] == assessment_id:
                return item, next((o for o in overlays if o['assessmentId'] == assessment_id), None)
    return None, None


def _os_delivery(snapshot: dict, eligible: bool, now: datetime) -> dict:
    enabled = snapshot['settings']['reminders']['enabled']
    if enabled and eligible:
        return dict(channel='os', state='pending', updatedAt=now_iso(now))
    return dict(channel='dashboard', state='dashboard_only', updatedAt=now_iso(now),
                errorCode='disabled' if not enabled else 'ineligible')


def _insert(snapshot: dict, alert: dict) -> bool:
    if any(existing['deliveryKey'] == alert['deliveryKey'] for existing in snapshot['alerts']):
        return False  # One history row per unique delivery key.
    snapshot['alerts'].insert(0, alert)
    return True


def change_alert(snapshot: dict, change: dict, now: datetime | None = None) -> bool:
    """Called in the same Snapshot mutation that appends a #22 change record."""
    now = now or datetime.now(timezone.utc)
    assessment, overlay = _assessment(snapshot, change['assessmentId'])
    hidden = bool((overlay or {}).get('hidden'))
    title = ((overlay or {}).get('titleOverride') or (assessment or {}).get('title')) or 'An assessment'
    evidence = {k: change[k] for k in ('sourceId', 'sourceObservedAt') if change.get(k)}
    context = dict(destination='assessment', reason='source_change_hidden' if hidden else 'source_change',
                   assessmentId=change['assessmentId'],
                   change=dict(changeId=change['id'], detectedAt=change['detectedAt'], **evidence,
                               **{'from': change['from']}, to=change['to']))
    if assessment and assessment.get('courseId'):
        context['courseId'] = assessment['courseId']
    removed = change['to'].get('kind') == 'removed'
    message = (f"{title}: deadline removed (was {assertion_text(change['from'])})" if removed else
               f"{title} changed from {assertion_text(change['from'])} to {assertion_text(change['to'])}")
    # Hidden items keep inspectable history but never a fresh OS notice.
    return _insert(snapshot, dict(id='al-change-' + change['id'], kind='change', message=message[:300],
                                  assessmentId=change['assessmentId'], deliveryKey='change:' + change['id'],
                                  createdAt=now_iso(now), read=False, context=context,
                                  delivery=_os_delivery(snapshot, not hidden, now)))


def reminder_alert(snapshot: dict, kind: str, targets: list[dict], request_id: str, now: datetime) -> bool:
    """One dashboard row per #38 delivery request (single or consolidated catch-up)."""
    if kind == 'catch_up':
        count = len(targets)
        return _insert(snapshot, dict(id='al-' + request_id, kind='deadline', deliveryKey='catch-' + request_id,
                                      message=f'{count} reminder{"s" if count != 1 else ""} came due while Chrome was closed. Review them here.',
                                      createdAt=now_iso(now), read=False,
                                      context=dict(destination='alerts', reason='catch_up'),
                                      delivery=_os_delivery(snapshot, True, now)))
    target = targets[0]
    if target['kind'] == 'busy_week':
        context = dict(destination='week', reason='busy_week', week=target['week'], precision='week')
        message = f"Teaching week {target['week']} looks busy. Plan ahead."
        alert = dict(id='al-' + request_id, kind='busy_week', message=message, deliveryKey=target['deliveryKey'],
                     createdAt=now_iso(now), read=False, context=context)
    else:
        assessment, overlay = _assessment(snapshot, target['assessmentId'])
        title = ((overlay or {}).get('titleOverride') or (assessment or {}).get('title')) or 'An assessment'
        precision = target.get('precision') or 'exact'
        context = dict(destination='assessment', reason='deadline_due', assessmentId=target['assessmentId'], precision=precision)
        if assessment and assessment.get('courseId'):
            context['courseId'] = assessment['courseId']
        when = assertion_text(target.get('date')) if target.get('date') else 'soon'
        alert = dict(id='al-' + request_id, kind='deadline', message=f'{title} is due {when}'[:300],
                     assessmentId=target['assessmentId'], deliveryKey=target['deliveryKey'],
                     createdAt=now_iso(now), read=False, context=context)
    alert['delivery'] = _os_delivery(snapshot, True, now)
    return _insert(snapshot, alert)


def still_eligible(snapshot: dict, alert: dict) -> bool:
    """Recheck hidden/completed/context state immediately before reservation."""
    context = alert.get('context') or {}
    target = context.get('assessmentId') or alert.get('assessmentId')
    if not target:
        return True
    assessment, overlay = _assessment(snapshot, target)
    if assessment is None:
        return False
    if (overlay or {}).get('hidden'):
        return False
    if alert['kind'] == 'deadline':
        return is_outstanding(assessment, overlay)
    return True


def pending(snapshot: dict, namespace: str, limit: int = 20) -> list[dict]:
    out = []
    for alert in snapshot['alerts']:
        delivery = alert.get('delivery') or {}
        if delivery.get('channel') == 'os' and delivery.get('state') == 'pending':
            out.append(dict(deliveryKey=alert['deliveryKey'], notificationId=notification_id(namespace, alert['deliveryKey'])))
    return [p for p in out if _opaque(p['deliveryKey'])][:limit]


def _opaque(value: str) -> bool:
    import re
    return bool(re.fullmatch(r'[A-Za-z0-9._~:-]{1,160}', value))


def neutralize_imported(snapshot: dict) -> dict:
    """Imported/restored notification records are history, never replay instructions (#55)."""
    for alert in snapshot.get('alerts') or []:
        delivery = alert.get('delivery')
        if delivery and delivery.get('state') in ('pending', 'issued'):
            alert['delivery'] = dict(channel='dashboard', state='dashboard_only' if delivery['state'] == 'pending' else 'unknown',
                                     updatedAt=delivery.get('updatedAt') or now_iso(), errorCode='stale')
    return snapshot


def merge_legacy_save(previous: list[dict], incoming: list[dict]) -> list[dict]:
    """Legacy PUT /alerts: client cannot forge or roll back delivery state or context."""
    by_id = {a['id']: a for a in previous}
    merged = []
    for alert in incoming:
        alert = dict(alert)
        old = by_id.get(alert['id'])
        for field in ('delivery', 'context'):
            if old is not None and field in old:
                alert[field] = old[field]
            elif old is None and field == 'delivery':
                alert.pop(field, None)
        merged.append(alert)
    return merged
