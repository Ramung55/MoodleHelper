"""Authoritative reminder planning (#38) and durable delivery-request ledger.

The plan is a pure function of the current committed Snapshot, settings and
server time. Nothing about it is cached, so a committed hide, completion, date
override or source change can never leave a stale pending item behind: the next
read or dispatch simply derives the new plan. Only the delivery-request ledger
(which keys were already requested, and idempotency receipts) is persisted, in
the same SQLite transaction as the Snapshot read, so dispatch re-checks current
eligibility atomically.

Catch-up rule (documented, initial #38 policy): a due item processed within
GRACE of its reminder time gets its own delivery request. Items that are more
than GRACE overdue when processed (browser closed, device asleep, worker
restarted) are consumed together into ONE consolidated ``catch_up`` request.
Every consumed delivery key is written to the ledger, so a later restart with no
new missed items emits nothing, and an old missed set is never replayed.
These are delivery *requests*; showing an OS notification is #39.
"""
from __future__ import annotations

import json
import math
from contextlib import contextmanager
from copy import deepcopy
from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
from threading import RLock

GRACE = timedelta(minutes=15)
PAGE = 100
DEFAULT_LEAD_DAYS = 7
DEFAULT_CLOCK = '09:00'
MAX_HOURS = 720


class ReminderConflict(RuntimeError):
    pass


class ReminderInvalid(ValueError):
    pass


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_instant(value: str) -> datetime | None:
    try:
        from backend.domain_validation import validate_instant
        validate_instant(value, 'iso')
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None


def zoneinfo_resolver(name: str):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # Missing IANA data (common on Windows) or unknown key.
        return None


def local_instant(day: date, clock: str, zone) -> datetime | None:
    """Wall-clock local time to UTC; None for a DST gap or fold (never guessed)."""
    hour, minute = map(int, clock.split(':'))
    first = datetime.combine(day, time(hour, minute), tzinfo=zone)
    second = first.replace(fold=1)
    if first.utcoffset() != second.utcoffset():
        return None  # Ambiguous fold or nonexistent gap.
    roundtrip = first.astimezone(timezone.utc).astimezone(zone)
    if roundtrip.replace(tzinfo=None) != first.replace(tzinfo=None):
        return None
    return first.astimezone(timezone.utc)


def digest(*parts) -> str:
    return sha256(json.dumps(parts, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()[:40]


def is_outstanding(assessment: dict, overlay: dict | None) -> bool:
    """Shared #36 eligibility; mirrors frontend isOutstanding."""
    if overlay and overlay.get('hidden'):
        return False
    status = None if assessment.get('personal') else (assessment.get('submission') or {}).get('status')
    if status in ('draft', 'not_submitted', 'reopened'):
        return True
    if overlay and overlay.get('completed'):
        return False
    return status != 'submitted'


def logical_views(snapshot: dict) -> list[dict]:
    from backend.deadline_tracking import effective_sources
    from backend.services import source_date
    layer = snapshot.get('reconciliation')
    assessments = layer['logicalAssessments'] if layer else snapshot['assessments']
    overlays = {o['assessmentId']: o for o in (layer['logicalOverlays'] if layer else snapshot['overlays'])}
    tracked = set(snapshot['settings']['trackedCourseIds'])
    views = []
    for assessment in sorted(assessments, key=lambda a: a['id']):
        if not (assessment.get('personal') or assessment['courseId'] in tracked):
            continue
        overlay = overlays.get(assessment['id'])
        sources = effective_sources(snapshot, assessment)
        effective = (overlay or {}).get('dateOverride') or (source_date(sources) if sources else {'kind': 'unknown'})
        views.append(dict(assessment=assessment, overlay=overlay, date=effective,
                          title=(overlay or {}).get('titleOverride') or assessment['title'],
                          hidden=bool((overlay or {}).get('hidden')), outstanding=is_outstanding(assessment, overlay)))
    return views


def settings_of(snapshot: dict) -> dict:
    reminders = snapshot['settings']['reminders']
    return dict(enabled=reminders['enabled'], hoursBefore=reminders['hoursBefore'], busyWeek=reminders['busyWeek'],
                busyWeekLeadDays=reminders.get('busyWeekLeadDays', DEFAULT_LEAD_DAYS),
                dateOnlyLocalTime=reminders.get('dateOnlyLocalTime', DEFAULT_CLOCK),
                busyWeekLocalTime=reminders.get('busyWeekLocalTime', DEFAULT_CLOCK))


def plan(snapshot: dict, namespace: str, dataset_id: str, now: datetime, resolver=zoneinfo_resolver) -> dict:
    """Pure normative planner. Returns all items (unpaged) plus generation."""
    from backend import schemas
    from backend.teaching_calendar import teaching_ranges
    config = settings_of(snapshot)
    reasons: list[str] = []
    items: list[dict] = []
    hours = config['hoursBefore']
    if not config['enabled']:
        reasons.append('disabled')
    lead_ok = isinstance(hours, (int, float)) and math.isfinite(hours) and 0 <= hours <= MAX_HOURS
    if not lead_ok:
        reasons.append('invalid_lead_time')
    calendar, ranges, zone, calendar_reason = None, [], None, None
    raw_calendar = snapshot['settings'].get('teachingCalendar')
    if raw_calendar is None:
        calendar_reason = 'calendar_missing'
    else:
        try:
            calendar = schemas.TeachingCalendar.model_validate(raw_calendar)
            ranges = [r for r in teaching_ranges(calendar) if r['resolved']]
            zone = resolver(calendar.timezone)
            if zone is None:
                calendar_reason = 'timezone_data_unavailable'
        except ValueError:
            calendar_reason = 'calendar_invalid'
            calendar = None
    if calendar_reason:
        reasons.append(calendar_reason)
    tz_name = calendar.timezone if calendar else None
    semantic = dict(namespace=namespace, tz=tz_name)

    def week_of_day(day: date):
        found = [r for r in ranges if r['start'] <= day <= r['end']]
        return found[0] if len(found) == 1 else None

    def mapped(value: dict):
        if value['kind'] == 'week':
            return next((r for r in ranges if r['week'] == value['week']), None)
        if value['kind'] == 'date':
            try:
                return week_of_day(date.fromisoformat(value['date']))
            except ValueError:
                return None
        if value['kind'] == 'exact' and zone is not None:
            at = parse_instant(value['iso'])
            return week_of_day(at.astimezone(zone).date()) if at else None
        return None

    views = logical_views(snapshot)
    if config['enabled']:
        for view in views:
            if view['hidden'] or not view['outstanding']:
                continue  # Hidden / non-actionable completed: no pending reminder.
            value, target = view['date'], view['assessment']['id']
            base = dict(kind='deadline', assessmentId=target)
            if value['kind'] == 'week':
                continue  # Week-only: week-level warnings only (busy_week), never a deadline reminder.
            key = digest('deadline', semantic, target, value, hours if value['kind'] == 'exact' else config['dateOnlyLocalTime'])
            item = dict(base, id='rd-' + digest('deadline', target)[:32], deliveryKey='rk-' + key)
            if value['kind'] == 'exact':
                deadline = parse_instant(value['iso'])
                item.update(precision='exact', label='Reminder before exact deadline')
                if deadline is None:
                    item.update(reason='date_unknown')
                elif not lead_ok:
                    item.update(reason='invalid_lead_time')
                else:
                    item.update(dueAt=iso(deadline - timedelta(hours=hours)))
            elif value['kind'] == 'date':
                item.update(precision='date', label='Reminder for date-only event; deadline time unknown',
                            localTime=f"{(date.fromisoformat(value['date']) - timedelta(days=1)).isoformat()}T{config['dateOnlyLocalTime']}")
                if calendar_reason:
                    item.update(reason=calendar_reason)
                else:
                    item['timezone'] = tz_name
                    at = local_instant(date.fromisoformat(value['date']) - timedelta(days=1), config['dateOnlyLocalTime'], zone)
                    item.update(dueAt=iso(at)) if at else item.update(reason='local_time_ambiguous')
            else:
                item.update(precision='unknown', label='Deadline unknown; no reminder', reason='date_unknown')
            items.append(item)
        if config['busyWeek'] and not calendar_reason:
            weights = snapshot['settings']['weights']
            thresholds = snapshot['settings']['thresholds']
            if any(not isinstance(weights.get(k), (int, float)) or not math.isfinite(weights[k]) or weights[k] < 0
                   for k in ('exam', 'assignment', 'quiz', 'other')):
                reasons.append('invalid_weights')
            else:
                load = {r['week']: [0, 0.0, r] for r in ranges}
                for view in views:
                    if view['hidden'] or not view['outstanding']:
                        continue
                    slot = mapped(view['date'])
                    if slot is not None:
                        load[slot['week']][0] += 1
                        load[slot['week']][1] += weights[view['assessment']['type']]
                for week, (count, weighted, slot) in sorted(load.items()):
                    if not (count > thresholds['maxOutstanding'] or weighted > thresholds['maxWeighted']):
                        continue
                    day = slot['start'] - timedelta(days=config['busyWeekLeadDays'])
                    key = digest('busy_week', semantic, week, slot['start'].isoformat(), config['busyWeekLeadDays'], config['busyWeekLocalTime'])
                    item = dict(id='rw-' + digest('busy_week', week)[:32], deliveryKey='rk-' + key, kind='busy_week',
                                week=week, precision='week', timezone=tz_name,
                                localTime=f"{day.isoformat()}T{config['busyWeekLocalTime']}",
                                label=f'Busy teaching week {week} starts {slot["start"].isoformat()}')
                    at = local_instant(day, config['busyWeekLocalTime'], zone)
                    item.update(dueAt=iso(at)) if at else item.update(reason='local_time_ambiguous')
                    items.append(item)
    items.sort(key=lambda i: (i.get('dueAt') is None, i.get('dueAt') or '', i['id']))
    generation = 'g-' + digest(dataset_id, config, tz_name, items)
    return dict(datasetId=dataset_id, generation=generation, serverTime=iso(now), enabled=config['enabled'],
                reasons=reasons, items=items)


class MemoryLedger:
    def __init__(self):
        self._lock = RLock()
        self.requested: dict[str, str] = {}
        self.receipts: dict[str, str] = {}

    @contextmanager
    def transaction(self, store):
        with self._lock:
            requested, receipts = dict(self.requested), dict(self.receipts)
            self._store = store
            try:
                yield store.read(), self
            except BaseException:
                self.requested, self.receipts = requested, receipts
                raise

    def is_requested(self, key):
        return key in self.requested

    def mark(self, key, request_id):
        self.requested[key] = request_id

    def receipt(self, idem):
        value = self.receipts.get(idem)
        return json.loads(value) if value else None

    def save_receipt(self, idem, response):
        self.receipts[idem] = json.dumps(response)

    def save_snapshot(self, snapshot):
        self._store.replace(snapshot)


class SqlLedger:
    """Namespace-scoped rows in the Snapshot database; same BEGIN IMMEDIATE boundary."""

    def __init__(self, store):
        self.store = store

    @contextmanager
    def transaction(self, store):
        from sqlalchemy import text
        from sqlalchemy.exc import SQLAlchemyError
        import sqlite3
        from backend.sqlite_store import storage_failure
        try:
            with store._transaction() as connection:
                saved = connection.execute(text('SELECT snapshot FROM snapshots WHERE namespace=:namespace'), store._key).scalar_one()
                yield store._decode(saved), _Rows(connection, store.namespace)
        except (SQLAlchemyError, sqlite3.Error) as exc:
            raise storage_failure(exc) from exc

    def requested_keys(self):
        from sqlalchemy import text
        with self.store.engine.connect() as connection:
            return set(connection.execute(text('SELECT delivery_key FROM reminder_requests WHERE namespace=:namespace'),
                                          self.store._key).scalars())


class _Rows:
    def __init__(self, connection, namespace):
        self.connection, self.namespace = connection, namespace

    def is_requested(self, key):
        from sqlalchemy import text
        return self.connection.execute(text('SELECT 1 FROM reminder_requests WHERE namespace=:n AND delivery_key=:k'),
                                       {'n': self.namespace, 'k': key}).first() is not None

    def mark(self, key, request_id):
        from sqlalchemy import text
        self.connection.execute(text('INSERT INTO reminder_requests(namespace,delivery_key,request_id) VALUES(:n,:k,:r)'),
                                {'n': self.namespace, 'k': key, 'r': request_id})

    def receipt(self, idem):
        from sqlalchemy import text
        value = self.connection.execute(text('SELECT response FROM reminder_receipts WHERE namespace=:n AND idem=:i'),
                                        {'n': self.namespace, 'i': idem}).scalar_one_or_none()
        return json.loads(value) if value else None

    def save_receipt(self, idem, response):
        from sqlalchemy import text
        self.connection.execute(text('INSERT INTO reminder_receipts(namespace,idem,response) VALUES(:n,:i,:r)'),
                                {'n': self.namespace, 'i': idem, 'r': json.dumps(response)})

    def save_snapshot(self, snapshot):
        # Same BEGIN IMMEDIATE transaction as the ledger rows (#39 atomic alert insert).
        from sqlalchemy import text
        from backend.storage import InMemoryStore
        validated = InMemoryStore._validated(snapshot)
        self.connection.execute(text('UPDATE snapshots SET snapshot=:s,revision=revision+1 WHERE namespace=:n'),
                                {'n': self.namespace, 's': json.dumps(validated, ensure_ascii=False, allow_nan=False)})


class ReminderService:
    def __init__(self, store, clock=None, resolver=zoneinfo_resolver):
        self.store = store
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.resolver = resolver
        self.ledger = SqlLedger(store) if hasattr(store, 'engine') else MemoryLedger()

    def _with_status(self, current: dict, rows, now: datetime) -> dict:
        result = deepcopy(current)
        wake = None
        for item in result['items']:
            if 'dueAt' not in item:
                item['status'] = 'unscheduled'
            elif rows.is_requested(item['deliveryKey']):
                item['status'] = 'requested'
            elif parse_instant(item['dueAt']) <= now:
                item['status'] = 'due'
                wake = now
            else:
                item['status'] = 'scheduled'
                at = parse_instant(item['dueAt'])
                wake = at if wake is None or at < wake else wake
        if wake is not None:
            result['nextWakeAt'] = iso(wake)
        return result

    def read_plan(self, cursor: str | None = None, limit: int = PAGE) -> dict:
        now = self.clock()
        with self.ledger.transaction(self.store) as (snapshot, rows):
            current = self._with_status(plan(snapshot, self.store.namespace, self.store.dataset_id, now, self.resolver), rows, now)
            current['pendingDeliveries'] = alert_delivery.pending(snapshot, self.store.namespace)
        items = current['items']
        start = 0
        if cursor is not None:
            # Cursor is bound to the generation; a changed plan is a stale cursor.
            prefix, _, offset = cursor.partition('.')
            if prefix != current['generation'][:24] or not offset.isdigit():
                raise ReminderConflict('Reminder plan changed. Reload from the first page.')
            start = int(offset)
        page = items[start:start + limit]
        result = dict(current, items=page)
        if start + limit < len(items):
            result['nextCursor'] = f"{current['generation'][:24]}.{start + limit}"
        return result

    def _check(self, dataset_id: str):
        if dataset_id != self.store.dataset_id:
            raise ReminderConflict('Local dataset changed. Reconnect before scheduling reminders.')

    def reconcile(self, body: dict) -> dict:
        self._check(body['datasetId'])
        # A changed expectedGeneration is the reason to reconcile: return the
        # current authority so the worker replaces its wakeup mirror.
        return self.read_plan()

    def dispatch(self, body: dict) -> dict:
        self._check(body['datasetId'])
        now = self.clock()
        with self.ledger.transaction(self.store) as (snapshot, rows):
            idem = body['idempotencyKey']
            saved = rows.receipt(idem)
            if saved is not None:
                if saved['datasetId'] != body['datasetId']:
                    raise ReminderConflict('Idempotency key belongs to another context.')
                return dict(saved, replayed=True, pendingDeliveries=alert_delivery.pending(snapshot, self.store.namespace))
            current = plan(snapshot, self.store.namespace, self.store.dataset_id, now, self.resolver)
            if current['generation'] != body['expectedGeneration']:
                raise ReminderConflict('Reminder plan changed. Reconcile before dispatching.')
            due = [i for i in current['items'] if 'dueAt' in i and parse_instant(i['dueAt']) <= now
                   and not rows.is_requested(i['deliveryKey'])]
            on_time = [i for i in due if now - parse_instant(i['dueAt']) <= GRACE]
            missed = [i for i in due if now - parse_instant(i['dueAt']) > GRACE]
            if len(on_time) >= PAGE:
                missed, on_time = due, []
            requests = []

            def target(item):
                return {k: item[k] for k in ('deliveryKey', 'kind', 'assessmentId', 'week', 'dueAt') if k in item} | {'itemId': item['id']}
            dates = {v['assessment']['id']: v['date'] for v in logical_views(snapshot)}

            def alert_target(item):
                return dict(target(item), precision=item.get('precision'), date=dates.get(item.get('assessmentId')))
            created = False
            for item in on_time:
                request_id = 'rq-' + digest('single', item['deliveryKey'])[:32]
                rows.mark(item['deliveryKey'], request_id)
                requests.append(dict(requestId=request_id, kind=item['kind'], state='requested', total=1, targets=[target(item)]))
                created |= alert_delivery.reminder_alert(snapshot, item['kind'], [alert_target(item)], request_id, now)
            if missed:
                keys = sorted(i['deliveryKey'] for i in missed)
                request_id = 'rq-' + digest('catch_up', self.store.namespace, keys)[:32]
                for item in missed:
                    rows.mark(item['deliveryKey'], request_id)
                requests.append(dict(requestId=request_id, kind='catch_up', state='requested', total=len(missed),
                                     targets=[target(i) for i in missed[:PAGE]]))
                created |= alert_delivery.reminder_alert(snapshot, 'catch_up', [alert_target(i) for i in missed], request_id, now)
            if created:
                rows.save_snapshot(snapshot)
            status = self._with_status(current, rows, now)
            response = dict(datasetId=current['datasetId'], generation=current['generation'], serverTime=iso(now),
                            replayed=False, requests=requests[:PAGE])
            if 'nextWakeAt' in status:
                response['nextWakeAt'] = status['nextWakeAt']
            rows.save_receipt(idem, response)
            # Pending OS deliveries are listed live (never from the stored receipt), so a
            # lost dispatch response is picked up on the next wake without a re-request.
            return dict(response, pendingDeliveries=alert_delivery.pending(snapshot, self.store.namespace))

    def delivery_status(self, body: dict) -> dict:
        """Atomic OS-attempt reservation and fixed outcome acknowledgements (#39)."""
        self._check(body['datasetId'])
        now = self.clock()
        with self.ledger.transaction(self.store) as (snapshot, rows):
            current = plan(snapshot, self.store.namespace, self.store.dataset_id, now, self.resolver)
            if current['generation'] != body['expectedGeneration']:
                raise ReminderConflict('Reminder plan changed. Reconcile before delivering.')
            alert = next((a for a in snapshot['alerts'] if a['deliveryKey'] == body['deliveryKey']), None)
            if alert is None or not alert.get('delivery'):
                raise ReminderConflict('Alert is no longer available for delivery.')
            delivery, wanted, attempt = alert['delivery'], body['state'], body['attemptId']
            nid = alert_delivery.notification_id(self.store.namespace, alert['deliveryKey'])

            def receipt(reserved=False):
                result = dict(deliveryKey=alert['deliveryKey'], notificationId=nid, state=alert['delivery']['state'], reserved=reserved)
                if reserved:
                    result.update(title=alert_delivery.TITLE, message=alert['message'][:300])
                return result
            if delivery['state'] == wanted and delivery.get('attemptId') == attempt:
                return receipt()  # Duplicate acknowledgement: no-op, never a second reservation.
            if wanted in ('issued', 'denied'):
                if delivery['state'] != 'pending':
                    return receipt()  # Already reserved or finished by some attempt: no new OS create.
                update = dict(channel='os', state=wanted, attemptId=attempt, updatedAt=alert_delivery.now_iso(now))
                if wanted == 'denied':
                    update['errorCode'] = 'permission_denied'
                elif not snapshot['settings']['reminders']['enabled']:
                    update.update(channel='dashboard', state='dashboard_only', errorCode='disabled')
                elif not alert_delivery.still_eligible(snapshot, alert):
                    update.update(channel='dashboard', state='dashboard_only', errorCode='ineligible')
                elif now - (parse_instant(alert['createdAt']) or now) > alert_delivery.STALE:
                    update.update(channel='dashboard', state='dashboard_only', errorCode='stale')
                alert['delivery'] = update
                rows.save_snapshot(snapshot)
                return receipt(reserved=update['state'] == 'issued')
            # shown / failed: only the attempt that holds the reservation may finish it.
            if delivery['state'] != 'issued' or delivery.get('attemptId') != attempt:
                raise ReminderConflict('Delivery attempt does not hold this reservation.')
            update = dict(delivery, state=wanted, updatedAt=alert_delivery.now_iso(now))
            if wanted == 'failed':
                update['errorCode'] = body.get('fixedErrorCode') or 'create_failed'
            alert['delivery'] = update
            rows.save_snapshot(snapshot)
            return receipt()

    def notification_target(self, body: dict) -> dict:
        """Closed destination for a clicked notification; never a URL from the payload."""
        self._check(body['datasetId'])
        snapshot = self.store.read()
        for alert in snapshot['alerts']:
            if alert_delivery.notification_id(self.store.namespace, alert['deliveryKey']) != body['notificationId']:
                continue
            context = alert.get('context') or {}
            target = context.get('assessmentId') or alert.get('assessmentId')
            if context.get('destination') == 'week' and context.get('week'):
                return dict(destination='week', week=context['week'])
            if context.get('destination', 'assessment') == 'assessment' and target:
                return dict(destination='assessment', assessmentId=target)
            break
        return dict(destination='alerts')


from backend import alert_delivery  # noqa: E402  (after definitions: alert_delivery imports helpers from here)
