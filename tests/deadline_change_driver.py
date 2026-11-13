"""#106 test-only driver for the SYNTHETIC collection harness (tests.collection_network_app).

Usage: uv run python tests/deadline_change_driver.py setup | <YYYY-MM-DD> | unknown | removed | show
Talks only to the local harness (MOODLE_HELPER_DRIVER_BASE, default http://127.0.0.1:8000); never to Moodle. Each step uses observedAt=now.
"""
import json
import os
import sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from uuid import uuid4

BASE = os.environ.get('MOODLE_HELPER_DRIVER_BASE', 'http://127.0.0.1:8000')
ORIGIN = 'https://moodle.sdu.edu.kz'
PAGE = ORIGIN + '/mod/assign/view.php?id=303'


def call(method, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(BASE + path, data=data, method=method,
                      headers={'Content-Type': 'application/json', **(headers or {})})
    with urlopen(request) as response:
        return json.loads(response.read())


def setup():
    snapshot = call('GET', '/api/snapshot')
    snapshot['courses'][0]['discovery'] = dict(sourceCourseId='101', sourceUrl=ORIGIN + '/course/view.php?id=101',
        title={'kind': 'known', 'value': 'Synthetic course'}, termIndicators={'kind': 'unknown'}, currentTermStatus='unknown')
    snapshot['settings']['trackedCourseIds'] = [snapshot['courses'][0]['id']]
    binding = call('GET', '/api/bridge-context')['binding']
    call('PUT', '/api/snapshot', snapshot, {'X-Moodle-Helper-Bridge-Binding': binding})
    print('tracked course set; reminders enabled:', snapshot['settings']['reminders']['enabled'])


def step(value):
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    due = dict(value={'kind': 'date', 'date': value}, rawText='Displayed due', location='assignment.base.due')
    raw = dict(sourceCourseId='101', sourceActivityId='202', sourceCourseModuleId='303', sourceUrl=PAGE,
               title='Synthetic assignment', observedAt=now, individualExtensions=[],
               baseDates={'due': due} if value not in ('unknown', 'removed') else {},
               effectiveDates={'due': due} if value not in ('unknown', 'removed') else {})
    if value == 'removed':
        raw['syntheticDeadlineRemoval'] = True
    context = call('GET', '/api/collection-context')
    headers = {'X-Moodle-Helper-Bridge-Binding': context['binding']}
    token = call('POST', '/api/collection/visits', dict(documentKey='tab:document', visitId='v-' + uuid4().hex,
                 pageUrl=PAGE, selectionRevision=context['selectionRevision']), headers)['visitToken']
    result = dict(kind='assignment', observations=[raw], reviews=[], diagnostics=[], pages=[], coverage='complete',
                  scope='visited_activity_only')
    call('POST', '/api/collection/refresh', dict(visitToken=token, observedAt=now, collector='assignment', result=result), headers)
    show()


def show():
    snapshot = call('GET', '/api/snapshot')
    stream = (snapshot.get('deadlineStreams') or [{}])[0]
    print('assessment:', stream.get('assessmentId'), 'accepted:', stream.get('accepted'), 'established:', stream.get('established'))
    print('changes:', len(snapshot['changes']))
    for alert in snapshot['alerts']:
        if alert['kind'] == 'change':
            print(' alert:', alert['message'], '| read:', alert['read'], '| delivery:', alert.get('delivery', {}).get('state'))


if __name__ == '__main__':
    arg = sys.argv[1]
    setup() if arg == 'setup' else show() if arg == 'show' else step(arg)
