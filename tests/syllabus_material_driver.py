"""#107 test-only driver for the SYNTHETIC collection harness (tests.collection_network_app).

Usage: uv run python tests/syllabus_material_driver.py setup | post | show
Posts one course-page material refresh with a synthetic "Syllabus" PDF and a synthetic non-syllabus PDF.
Talks only to the local harness (MOODLE_HELPER_DRIVER_BASE, default http://127.0.0.1:8000); never to Moodle.
"""
import sys
from datetime import datetime, timezone
from uuid import uuid4

from deadline_change_driver import ORIGIN, call, setup

PAGE = ORIGIN + '/course/view.php?id=101'


def material(cm, title):
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    url = f'{ORIGIN}/mod/resource/view.php?id={cm}'
    ref = dict(sourcePageUrl=PAGE, sourceUrl=url, observedAt=now, location='course.material', destinationUrl=url)
    return dict(ref, sourceCourseId='101', sourceCourseModuleId=cm, sourceModuleType='resource',
                resourceKey=f'["{ORIGIN}","101","resource","module","{cm}"]', kind='file',
                title={'kind': 'known', 'value': title}, section={'kind': 'unknown'},
                fileType={'kind': 'known', 'value': 'pdf'}, mimeType={'kind': 'unknown'}, references=[dict(ref)])


def post():
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    context = call('GET', '/api/collection-context')
    headers = {'X-Moodle-Helper-Bridge-Binding': context['binding']}
    token = call('POST', '/api/collection/visits', dict(documentKey='tab:document', visitId='v-' + uuid4().hex,
                 pageUrl=PAGE, selectionRevision=context['selectionRevision']), headers)['visitToken']
    # Non-syllabus first, so the ranking (not the posting order) puts the syllabus on top.
    result = dict(kind='material', observations=[material('402', 'Lecture 1'), material('401', 'Syllabus')],
                  reviews=[], diagnostics=[], pages=[], coverage='complete', scope='supplied_pages_only')
    call('POST', '/api/collection/refresh', dict(visitToken=token, observedAt=now, collector='material', result=result), headers)
    show()


def show():
    for record in call('GET', '/api/snapshot')['collection']['records']:
        if record['kind'] == 'material':
            o = record['observations'][-1]
            print('material:', o['title'].get('value'), o['fileType'].get('value'), '| course:', record['courseId'])


if __name__ == '__main__':
    {'setup': setup, 'post': post, 'show': show}[sys.argv[1]]()
