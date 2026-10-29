"""Strict validation of the additive explicit calendar; legacy fields untouched."""
from datetime import date, timedelta
import json
from pathlib import Path

SUPPORTED_TIMEZONES = frozenset(json.loads((Path(__file__).resolve().parents[1] / 'shared/src/teaching-timezones.json').read_text(encoding='utf-8')))


def validate_teaching_calendar(value):
    try:
        start, end = date.fromisoformat(value.startDate), date.fromisoformat(value.endDate)
    except (TypeError, ValueError):
        raise ValueError('Enter real calendar start and end dates.') from None
    if value.timezone not in SUPPORTED_TIMEZONES:
        raise ValueError('Choose a supported IANA calendar timezone.')
    days = (end - start).days + 1
    if days < 7 or days % 7 or days > 420:
        raise ValueError('Inclusive boundaries must form 1–60 complete seven-day calendar slots.')
    if len(set(value.excludedWeekStarts)) != len(value.excludedWeekStarts):
        raise ValueError('Use distinct excluded slot starts.')
    for excluded in value.excludedWeekStarts:
        try:
            day = date.fromisoformat(excluded)
        except (TypeError, ValueError):
            raise ValueError('Every excluded slot start must be a real calendar date.') from None
        offset = (day - start).days
        if offset < 0 or offset % 7 or offset + 6 >= days:
            raise ValueError('Excluded weeks must be aligned full seven-day slots inside calendar boundaries.')
    if not 1 <= days // 7 - len(value.excludedWeekStarts) <= 30:
        raise ValueError('The calendar must contain 1–30 nonexcluded teaching weeks.')
    slots = baseline_slots(value)
    partials = value.partialBreaks or []
    for partial in partials:
        first, last = bounded_dates(partial, start, end)
        slot = next((slot for slot in slots if slot['start'] <= first <= last <= slot['end']), None)
        if (last - first).days >= 6 or not slot or slot['week'] is None:
            raise ValueError('A partial break must be shorter than seven days within one nonexcluded anchored slot.')
    for index, partial in enumerate(partials):
        if any(partial.startDate <= other.endDate and other.startDate <= partial.endDate for other in partials[index + 1:]):
            raise ValueError('Partial breaks must not overlap, including inclusive endpoints.')
    seen = set()
    for override in value.weekOverrides or []:
        first, last = bounded_dates(override, start, end)
        if override.week in seen:
            raise ValueError('Each overridden week number must be unique.')
        seen.add(override.week)
        if any(slot['week'] is None and first <= slot['end'] and slot['start'] <= last for slot in slots):
            raise ValueError('An explicit override cannot occupy a full excluded week.')
    resolved = [item for item in teaching_ranges(value) if item['resolved']]
    for index, item in enumerate(resolved):
        for other in resolved[index + 1:]:
            if item['start'] <= other['end'] and other['start'] <= item['end']:
                raise ValueError(f"Resolved Week {item['week']} overlaps Week {other['week']}; adjust both ranges explicitly.")
    return value


def bounded_dates(item, start, end):
    try:
        first, last = date.fromisoformat(item.startDate), date.fromisoformat(item.endDate)
    except (ValueError, TypeError):
        raise ValueError('Every partial break/override needs real calendar dates.') from None
    if not start <= first <= last <= end:
        raise ValueError('Partial breaks/overrides need ordered dates wholly within semester boundaries.')
    return first, last


def baseline_slots(value):
    at, end, counter, result = date.fromisoformat(value.startDate), date.fromisoformat(value.endDate), 0, []
    for offset in range(((end - at).days + 1) // 7):
        current = at + timedelta(days=offset * 7)
        excluded = current.isoformat() in value.excludedWeekStarts
        if not excluded:
            counter += 1
        result.append(dict(start=current, end=current + timedelta(days=6), week=None if excluded else counter))
    return result


def teaching_ranges(value):
    """Resolved projection of an already structurally validated calendar; no inferred shifts."""
    partials = value.partialBreaks or []
    unknown = min((date.fromisoformat(item.startDate) for item in partials if item.numbering == 'unresolved'), default=None)
    ranges = {slot['week']: {**slot, 'resolved': unknown is None or slot['end'] < unknown} for slot in baseline_slots(value) if slot['week'] is not None}
    for override in value.weekOverrides or []:
        ranges[override.week] = dict(week=override.week, start=date.fromisoformat(override.startDate), end=date.fromisoformat(override.endDate), resolved=True)
    return [ranges[key] for key in sorted(ranges)]
