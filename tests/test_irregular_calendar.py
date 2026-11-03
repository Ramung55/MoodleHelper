from copy import deepcopy
import pytest
from backend.reconciliation import compatible_dates
from backend.schemas import TeachingCalendar
from backend.teaching_calendar import teaching_ranges

BASE = dict(startDate="2027-01-04", endDate="2027-02-28", timezone="UTC", excludedWeekStarts=[])
HOLIDAY = dict(startDate="2027-01-13", endDate="2027-01-13", numbering="preserve")
OVERRIDE = dict(week=2, startDate="2027-01-11", endDate="2027-01-16")

def test_partial_numbering_and_named_override_projection():
    def ranges(**extra):
        return teaching_ranges(TeachingCalendar.model_validate({**BASE, **extra}))
    before = ranges(partialBreaks=[HOLIDAY])
    assert [item['resolved'] for item in before] == [True] * 8
    unknown = ranges(partialBreaks=[{**HOLIDAY, 'numbering': 'unresolved'}])
    assert [item['resolved'] for item in unknown] == [True] + [False] * 7
    explicit = ranges(partialBreaks=[{**HOLIDAY, 'numbering': 'unresolved'}], weekOverrides=[OVERRIDE])
    assert [item['resolved'] for item in explicit] == [True, True] + [False] * 6
    settings = dict(timezone='UTC', teachingCalendar={**BASE, 'partialBreaks': [HOLIDAY], 'weekOverrides': [OVERRIDE]})
    week = dict(kind='week', week=2)
    assert compatible_dates(week, dict(kind='date', date='2027-01-16'), settings)
    assert not compatible_dates(week, dict(kind='date', date='2027-01-17'), settings)


@pytest.mark.parametrize('extra', [
    dict(partialBreaks=None), dict(weekOverrides=None),
    dict(partialBreaks=[{**HOLIDAY, 'numbering': 'guess'}]),
    dict(partialBreaks=[{key: val for key, val in HOLIDAY.items() if key != 'numbering'}]),
    dict(partialBreaks=[{**HOLIDAY, 'startDate': '2027-01-17', 'endDate': '2027-01-18'}]),
    dict(partialBreaks=[{**HOLIDAY, 'startDate': '2027-01-11', 'endDate': '2027-01-17'}]),
    dict(partialBreaks=[HOLIDAY, HOLIDAY]),
    dict(partialBreaks=[HOLIDAY], excludedWeekStarts=['2027-01-11']),
    dict(weekOverrides=[{**OVERRIDE, 'endDate': '2027-01-10'}]),
    dict(weekOverrides=[{**OVERRIDE, 'endDate': '2027-03-01'}]),
    dict(weekOverrides=[OVERRIDE, OVERRIDE]),
    dict(weekOverrides=[{**OVERRIDE, 'startDate': '2027-01-17', 'endDate': '2027-01-20'}]),
    dict(weekOverrides=[{**OVERRIDE, 'endDate': '2027-01-18'}]),
    dict(weekOverrides=[OVERRIDE], excludedWeekStarts=['2027-01-11']),
])
def test_invalid_complete_map_is_atomic_for_patch_and_restore(client, extra):
    good = {**BASE, 'partialBreaks': [HOLIDAY], 'weekOverrides': [OVERRIDE]}
    assert client.patch('/api/settings', json={'teachingCalendar': good}).status_code == 200
    before = client.get('/api/snapshot').json()
    bad = {**BASE, **extra}
    assert client.patch('/api/settings', json={'teachingCalendar': bad}).status_code == 422
    restore = deepcopy(before); restore['settings']['teachingCalendar'] = bad
    assert client.put('/api/snapshot', json=restore).status_code == 422
    assert client.get('/api/snapshot').json() == before


def test_older_complete_group_replacement_drops_optional_arrays_without_migration(client):
    good = {**BASE, 'partialBreaks': [HOLIDAY], 'weekOverrides': [OVERRIDE]}
    saved = client.patch('/api/settings', json={'teachingCalendar': good}).json()
    assert saved['settings']['teachingCalendar'] == good
    assert client.patch('/api/settings', json={'timezone': 'legacy'}).json()['settings']['teachingCalendar'] == good
    assert client.patch('/api/settings', json={'teachingCalendar': BASE}).json()['settings']['teachingCalendar'] == BASE
    empty = {**BASE, 'partialBreaks': [], 'weekOverrides': []}
    assert client.patch('/api/settings', json={'teachingCalendar': empty}).json()['settings']['teachingCalendar'] == empty
