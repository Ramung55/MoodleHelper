"""#126 test-only driver for the SYNTHETIC collection harness (tests.collection_network_app).

Usage: uv run python tests/submission_status_driver.py setup
       uv run python tests/submission_status_driver.py assign <cmid> <title>
       uv run python tests/submission_status_driver.py status <cmid> <case> [observedAt]
       uv run python tests/submission_status_driver.py show
Cases: draft, reopened (upstream fixtures, status cell byte-identical), submitted (observed fixture),
new / graded / draftword (draft fixture with only the status cell replaced by an unrecognised one).
Each status step runs the REAL extension adapter (tests/submission_status_adapter.ts, bun + jsdom) on the
synthetic page; no status is hand-written. Talks only to the local harness; never to Moodle.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

BASE = os.environ.get('MOODLE_HELPER_DRIVER_BASE', 'http://127.0.0.1:8000')
ORIGIN = 'https://moodle.sdu.edu.kz'
COURSE = '1260'
ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / 'fixtures' / 'moodle'
DRAFT_CELL = '<td class="submissionstatusdraft">Draft (not submitted)</td>'
UNRECOGNISED = {'new': '<td class="submissionstatusnew">No submission</td>',
                'graded': '<td class="submissionstatusmarked">Graded</td>',
                'draftword': '<td class="submissionstatusdraft">Draft</td>'}


def call(method, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(BASE + path, data=data, method=method,
                      headers={'Content-Type': 'application/json', **(headers or {})})
    with urlopen(request) as response:
        return json.loads(response.read())


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def page(cmid):
    return f'{ORIGIN}/mod/assign/view.php?id={cmid}'


def html(case, cmid):
    source = {'reopened': 'upstream/assign-reopened.html', 'submitted': 'observed/assign-submitted.html'}.get(case, 'upstream/assign-draft.html')
    text = (FIXTURES / source).read_text(encoding='utf-8')
    if case in UNRECOGNISED:
        assert DRAFT_CELL in text
        text = text.replace(DRAFT_CELL, UNRECOGNISED[case])
    elif case not in ('draft', 'reopened', 'submitted'):
        raise SystemExit('unknown case ' + case)
    marker = 'cmid-990101 course-9001'
    assert marker in text
    return text.replace(marker, f'cmid-{cmid} course-{COURSE}')


def refresh(cmid, collector, result, observed_at):
    context = call('GET', '/api/collection-context')
    headers = {'X-Moodle-Helper-Bridge-Binding': context['binding']}
    token = call('POST', '/api/collection/visits', dict(documentKey='tab:' + uuid4().hex, visitId='v-' + uuid4().hex,
                 pageUrl=page(cmid), selectionRevision=context['selectionRevision']), headers)['visitToken']
    try:
        response = call('POST', '/api/collection/refresh', dict(visitToken=token, observedAt=observed_at, collector=collector, result=result), headers)
        print('refresh', collector, cmid, 'HTTP 200 receipt:', json.dumps(response['receipt']))
    except HTTPError as error:
        print('refresh', collector, cmid, 'HTTP', error.code, error.read().decode()[:300])


def setup():
    snapshot = call('GET', '/api/snapshot')
    snapshot['courses'][0]['discovery'] = dict(sourceCourseId=COURSE, sourceUrl=f'{ORIGIN}/course/view.php?id={COURSE}',
        title={'kind': 'known', 'value': 'Synthetic #126 course'}, termIndicators={'kind': 'unknown'}, currentTermStatus='unknown')
    snapshot['settings']['trackedCourseIds'] = [snapshot['courses'][0]['id']]
    binding = call('GET', '/api/bridge-context')['binding']
    call('PUT', '/api/snapshot', snapshot, {'X-Moodle-Helper-Bridge-Binding': binding})
    print('tracked course', snapshot['courses'][0]['id'], 'sourceCourseId', COURSE)


def assign(cmid, title):
    at = now()
    due = dict(value={'kind': 'date', 'date': '2026-12-01'}, rawText='Displayed due', location='assignment.base.due')
    raw = dict(sourceCourseId=COURSE, sourceActivityId=cmid, sourceCourseModuleId=cmid, sourceUrl=page(cmid), title=title,
               observedAt=at, individualExtensions=[], baseDates={'due': due}, effectiveDates={'due': due})
    refresh(cmid, 'assignment', dict(kind='assignment', observations=[raw], reviews=[], diagnostics=[], pages=[],
            coverage='complete', scope='visited_activity_only'), at)


def status(cmid, case, observed_at=None):
    at = observed_at or now()
    out = subprocess.run(['bun', str(ROOT / 'submission_status_adapter.ts'), COURSE, cmid, at],
                         input=html(case, cmid), capture_output=True, text=True, encoding='utf-8', check=True).stdout
    result = json.loads(out)
    print('adapter output:', json.dumps(result['observations'][0]['observation'] if result.get('observations') else result))
    refresh(cmid, 'submission', result, at)


def show():
    snapshot = call('GET', '/api/snapshot')
    overlays = {o['assessmentId']: o for o in snapshot['overlays']}
    # The dashboard reads the logical view (frontend/src/lib/app-store.tsx).
    for a in (snapshot.get('reconciliation') or {}).get('logicalAssessments') or snapshot['assessments']:
        if a['title'].startswith('Synthetic #126'):
            print(a['title'], '|', json.dumps(a.get('submission')), '| stale:', a.get('submissionStale'),
                  '| completed:', overlays.get(a['id'], {}).get('completed', False))
    for record in snapshot.get('collection', {}).get('records', []):
        if record['kind'] == 'submission':
            print(' record', record['id'][-12:], [(o['attempted']['observation']['status'], o['attempted']['observation']['observedAt'])
                  for o in record['observations']])


if __name__ == '__main__':
    command, args = sys.argv[1], sys.argv[2:]
    {'setup': setup, 'assign': assign, 'status': status, 'show': show}[command](*args)
