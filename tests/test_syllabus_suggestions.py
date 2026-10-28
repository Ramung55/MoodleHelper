from copy import deepcopy
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from backend.identity import namespace_key


def record():
    ref = dict(sourcePageUrl='https://moodle.sdu.edu.kz/course/view.php?id=101', sourceUrl='https://moodle.sdu.edu.kz/mod/resource/view.php?id=201', observedAt='2026-10-25T12:00:00Z', location='course.material')
    obs = dict(**ref, sourceCourseId='101', sourceCourseModuleId='201', sourceModuleType='resource', resourceKey='stable-key', kind='file', title={'kind':'known','value':'Syllabus'}, section={'kind':'unknown'}, fileType={'kind':'known','value':'pdf'}, mimeType={'kind':'unknown'}, references=[deepcopy(ref)])
    return dict(id='stable-id', courseId='c-csc', kind='material', firstObservedAt=ref['observedAt'], lastObservedAt=ref['observedAt'], observations=[obs])


def test_dismiss_restore_is_atomic_and_scoped_across_reopening(tmp_path):
    url = f"sqlite:///{(tmp_path / 'data.db').as_posix()}"
    other_ns = namespace_key('moodle', origin='https://moodle.sdu.edu.kz', profile_label='other', stable_user_id='7')
    a, b = SQLiteStore(url), SQLiteStore(url, other_ns)
    for store in (a, b):
        store.mutate(lambda s: s.update(collection={'records':[record()], 'reviews':[], 'refreshes':[]}))
    client = TestClient(create_app(a))
    assert client.post('/api/syllabus-suggestions/dismissal', json={'recordId':'missing','dismissed':True}).status_code == 422
    assert client.post('/api/syllabus-suggestions/dismissal', json={'recordId':'stable-id','dismissed':True, 'namespace':other_ns}).status_code == 422
    assert client.post('/api/syllabus-suggestions/dismissal', json={'recordId':'stable-id','dismissed':True}).json()['dismissedSyllabusSuggestions'] == ['stable-id']
    assert not b.read().get('dismissedSyllabusSuggestions')
    a.close(); a = SQLiteStore(url)
    assert a.read()['dismissedSyllabusSuggestions'] == ['stable-id']
    a.mutate(lambda s: s['collection']['records'][0]['observations'][0]['title'].update(value='Changed title'))
    assert a.read()['dismissedSyllabusSuggestions'] == ['stable-id']
    client = TestClient(create_app(a))
    assert client.post('/api/syllabus-suggestions/dismissal', json={'recordId':'stable-id','dismissed':False}).json()['dismissedSyllabusSuggestions'] == []
    a.close(); b.close()
