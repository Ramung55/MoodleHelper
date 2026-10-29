"""Strict validation of the additive explicit calendar; legacy fields untouched."""
from datetime import date
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
    return value
