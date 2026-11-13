"""#95 visited-page refresh in the real (verified) dataset, through real HTTP and SQLite.

Bodies are shaped like the extension's live visit output (the observed-fixture
adapters are exercised in frontend/src/test/page-visit.test.ts); no Moodle request
is made here.
"""
from test_live_scan import live, quiz, ACCOUNT, ORIGIN, completed, full_scan  # noqa: F401

MISMATCH = 'The signed-in Moodle account is not the account of this dataset. Nothing was saved.'
UNCONFIRMED = 'The Moodle account could not be confirmed. Nothing was saved.'


def context(live):
    return live.client.get('/api/collection-context').json()


def begin(live, url, visit='visit-1', document='7:DOC1'):
    ctx = context(live)
    return live.client.post('/api/collection/visits', headers={'X-Moodle-Helper-Bridge-Binding': ctx['binding']},
                            json={'documentKey': document, 'visitId': visit, 'pageUrl': url, 'selectionRevision': ctx['selectionRevision']})


def quiz_result(cm, source='9001', **kwargs):
    return dict(kind='quiz', observations=[quiz(cm, source, **kwargs)], reviews=[], diagnostics=[], pages=[],
                coverage='complete', scope='visited_activity_only')


def visit_quiz(live, cm='990103', visit='visit-1', account=ACCOUNT, source='9001', document=None, **kwargs):
    url = f'{ORIGIN}/mod/quiz/view.php?id={cm}'
    started = begin(live, url, visit, document or f'7:{visit}')
    assert started.status_code == 200, started.text
    body = dict(visitToken=started.json()['visitToken'], observedAt=kwargs.get('time', '2028-03-05T10:00:00.000Z'),
                collector='quiz', result=quiz_result(cm, source, **kwargs), **({'moodleUserId': account} if account else {}))
    return live.client.post('/api/collection/refresh', headers={'X-Moodle-Helper-Bridge-Binding': context(live)['binding']}, json=body)


def quiz_records(live):
    return [r for r in live.client.get('/api/snapshot').json().get('collection', {}).get('records', []) if r['kind'] == 'quiz']


def test_matching_account_saves_the_visited_page_and_the_dashboard_shows_it(live):
    response = visit_quiz(live)
    assert response.status_code == 200, response.text
    assert response.json()['receipt']['evidenceMode'] == 'verified' and response.json()['receipt']['outcome'] == 'ok'
    snapshot = live.client.get('/api/snapshot').json()
    assert [r['observations'][0]['title'] for r in quiz_records(live)] == ['Fictional quiz 990103']
    assert any(a['title'] == 'Fictional quiz 990103' for a in snapshot['assessments'])


def test_other_or_missing_account_saves_nothing(live):
    before = live.client.get('/api/snapshot').json()
    for account, message in [('987651', MISMATCH), (None, UNCONFIRMED)]:
        response = visit_quiz(live, visit=f'v-{account}', account=account)
        assert (response.status_code, response.json()) == (409, {'message': message})
        assert ACCOUNT not in response.text and '987651' not in response.text
    assert live.client.get('/api/snapshot').json() == before


def test_unselected_course_pages_save_nothing(live):
    # 9003 (c-phy) is mapped but not selected; 9002's selected course is fine.
    assert begin(live, f'{ORIGIN}/course/view.php?id=9003').status_code == 409
    before = live.client.get('/api/snapshot').json()
    assert visit_quiz(live, cm='990104', source='9003').status_code == 409
    assert live.client.get('/api/snapshot').json() == before


def test_revisits_do_not_duplicate_and_a_changed_deadline_raises_the_existing_alert(live):
    assert visit_quiz(live, visit='a', time='2028-03-05T10:00:00.000Z').status_code == 200
    first = live.client.get('/api/snapshot').json()
    assert visit_quiz(live, visit='b', time='2028-03-05T11:00:00.000Z').status_code == 200
    again = live.client.get('/api/snapshot').json()
    assert len(quiz_records(live)) == 1
    assert [a['title'] for a in again['assessments']].count('Fictional quiz 990103') == 1
    assert len(again['changes']) == len(first['changes'])
    assert visit_quiz(live, visit='c', time='2028-03-05T12:00:00.000Z', closing='2028-03-06T09:00+05:00').status_code == 200
    changed = live.client.get('/api/snapshot').json()
    assert len(quiz_records(live)) == 1
    assert len(changed['changes']) == len(first['changes']) + 1
    change = changed['changes'][-1]
    assert change['from']['iso'].startswith('2028-03-04') and change['to']['iso'].startswith('2028-03-06')


def test_begin_returns_the_stored_title_only_for_a_synced_activity(live):
    url = f'{ORIGIN}/mod/quiz/view.php?id=990103'
    assert 'title' not in begin(live, url, 'before', '7:before').json()
    live.post('/api/sync')
    claim = live.post('/api/scan/claim', {}).json()['claim']
    assert live.post('/api/scan/finish', completed(claim, full_scan(claim['sourceCourseId'], ['990103']))).status_code == 200
    assert begin(live, url, 'after', '7:after').json()['title'] == 'Fictional quiz 990103'
    assert 'title' not in begin(live, f'{ORIGIN}/mod/quiz/view.php?id=990199', 'other', '7:other').json()


def test_a_received_id_is_never_stored(live):
    # The dataset's own id is part of its namespace (record ids) by design; a received
    # marker id must appear nowhere, saved or refused.
    assert visit_quiz(live, visit='refused', account='987651').status_code == 409
    assert visit_quiz(live, visit='saved').status_code == 200
    assert '987651' not in repr(live.client.get('/api/snapshot').json())
