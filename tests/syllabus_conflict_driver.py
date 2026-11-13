"""#108 test-only driver for the SYNTHETIC collection harness (tests.collection_network_app).

Usage: uv run python tests/syllabus_conflict_driver.py setup | post | show
`post` sends one assignment refresh per synthetic activity: "Assignment 1" due 2026-10-30 (differs from the
syllabus fixture) and "Задание 1" due 2026-10-29 (same as the fixture). Date only; observedAt=now.
Talks only to the local harness (MOODLE_HELPER_DRIVER_BASE, default http://127.0.0.1:8000); never to Moodle.
"""
import sys
from datetime import datetime, timezone
from uuid import uuid4

from deadline_change_driver import ORIGIN, call, setup

ASSIGNMENTS = [('211', '311', 'Assignment 1', '2026-10-30'), ('212', '312', 'Задание 1', '2026-10-29')]


def post():
    for activity, cm, title, date in ASSIGNMENTS:
        now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        page = f'{ORIGIN}/mod/assign/view.php?id={cm}'
        due = dict(value={'kind': 'date', 'date': date}, rawText='Displayed due', location='assignment.base.due')
        raw = dict(sourceCourseId='101', sourceActivityId=activity, sourceCourseModuleId=cm, sourceUrl=page, title=title,
                   observedAt=now, individualExtensions=[], baseDates={'due': due}, effectiveDates={'due': due})
        context = call('GET', '/api/collection-context')
        headers = {'X-Moodle-Helper-Bridge-Binding': context['binding']}
        token = call('POST', '/api/collection/visits', dict(documentKey='tab:document', visitId='v-' + uuid4().hex,
                     pageUrl=page, selectionRevision=context['selectionRevision']), headers)['visitToken']
        result = dict(kind='assignment', observations=[raw], reviews=[], diagnostics=[], pages=[], coverage='complete',
                      scope='visited_activity_only')
        call('POST', '/api/collection/refresh', dict(visitToken=token, observedAt=now, collector='assignment', result=result), headers)
    show()


def show():
    snapshot = call('GET', '/api/snapshot')
    course = snapshot['settings']['trackedCourseIds'][0]
    for a in snapshot['assessments']:
        if a['courseId'] == course:
            print('assessment:', a['title'], '|', ', '.join(f"{s['source']} {s['date']}" for s in a['sources']))
    data = snapshot.get('reconciliation') or {}
    print('sources:', len(data.get('sources', [])), '| pairs:', [p['status'] for p in data.get('pairs', [])])


if __name__ == '__main__':
    {'setup': setup, 'post': post, 'show': show}[sys.argv[1]]()
