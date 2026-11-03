"""Invented examples through real FastAPI and the transactional SQLite store."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import sqlite3

from backend.collection import SyntheticCollectionContext
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from fastapi.testclient import TestClient
from sqlalchemy import URL, event
from backend.identity import namespace_key, MOODLE_ORIGIN

from test_page_refresh import harness, begin, refresh, result, assignment, ORIGIN, PAGE, TIME


def collect_assignment(client, visit='assignment'):
    token, headers = begin(client, visit=visit)
    response = refresh(client, token, headers)
    assert response.status_code == 200, response.text
    return response.json()['snapshot']


def calendar(occurrence=None, time=TIME):
    raw = dict(sourceEventId='501', sourceCourseId='101', title='Synthetic assignment', observedAt=time,
               sourceUrl=ORIGIN+'/calendar/view.php?event=501',
               date=dict(value={'kind':'date','date':'2026-10-28'},rawText='October 28',location='calendar.date'),
               activity=dict(moduleType='assign',sourceActivityId='202',sourceCourseModuleId='303',sourceUrl=PAGE))
    if occurrence:
        raw.update(sourceOccurrenceId=occurrence, sourceSeriesId='900', sourceUrl=raw['sourceUrl']+'&occurrence='+occurrence)
    return raw


def collect_calendar(client, raw, visit):
    token, headers = begin(client, ORIGIN+'/calendar/view.php', visit=visit)
    response = refresh(client, token, headers, result('calendar',[raw]), 'calendar')
    assert response.status_code == 200, response.text
    return response.json()['snapshot']


def make_pair(client, title='Synthetic assignment', due=None, digest='a'*64):
    due = due or {'kind':'exact','iso':'2026-10-28T13:30:00Z','tz':'UTC'}
    imported = client.post('/api/documents/import', json={'courseId':'c-csc','fileName':'fictional.pdf','contentDigest':digest})
    assert imported.status_code == 200, imported.text
    candidate = imported.json()['snapshot']['candidates'][-1]
    reviewed = client.post(f"/api/candidates/{candidate['id']}/review", json={'kind':'correct','title':title,'date':due,'type':'assignment'})
    assert reviewed.status_code == 200, reviewed.text
    snap = reviewed.json()
    pending = [p for p in snap['reconciliation']['pairs'] if p['status'] == 'pending']
    return snap, pending, candidate


def decision(client, pair, kind, choices=None):
    return client.post('/api/reconciliation/decisions', json={'pairId':pair['id'],'fingerprint':pair['fingerprint'],'reviewRevision':pair['reviewRevision'],'kind':kind,'choices':choices or {}})


def test_shared_activity_raw_evidence_and_occurrences_remain_distinct(harness):
    client,store,_=harness
    first=collect_assignment(client)
    merged=collect_calendar(client,calendar(),'calendar')
    r=merged['reconciliation']; sources=r['sources']
    assignment_source=next(x for x in sources if 'assignment' in x['recordId'])
    calendar_source=next(x for x in sources if 'calendar_event' in x['recordId'])
    assert assignment_source['assessmentId']==calendar_source['assessmentId']
    logical=[x for x in r['logicalAssessments'] if x['id']==assignment_source['assessmentId']]
    assert len(logical)==1 and logical[0]['sources'][0]['date']==assignment()['effectiveDates']['due']['value']
    assert len([x for x in merged['collection']['records'] if x['id'] in [assignment_source['recordId'],calendar_source['recordId']]])==2
    recurrence=collect_calendar(client,calendar('1'),'occurrence-one')
    later=collect_calendar(client,calendar('2'),'occurrence-two')
    ids={s['assessmentId'] for s in later['reconciliation']['sources'] if 'calendar_event' in s['recordId']}
    assert len(ids)==3
    assert recurrence['collection']['records'][0] == first['collection']['records'][0]
    assert store.read()==later


def test_conflicting_module_identity_retains_raw_facts_and_fails_closed(harness):
    client,_,_=harness
    first=collect_assignment(client)
    saved_source=first['reconciliation']['sources'][0]
    changed=assignment('2026-10-28T12:00:00Z')
    changed['sourceCourseModuleId']='304';changed['sourceUrl']=ORIGIN+'/mod/assign/view.php?id=304'
    token,headers=begin(client,changed['sourceUrl'],visit='module-conflict')
    response=refresh(client,token,headers,result(observations=[changed]),time=changed['observedAt'])
    assert response.status_code==200,response.text
    snap=response.json()['snapshot']; record=snap['collection']['records'][0]
    assert len(record['observations'])==2
    source=next(x for x in snap['reconciliation']['sources'] if x['id']==saved_source['id'])
    assert source['state']=='ambiguous' and source['assessmentId']==saved_source['assessmentId']
    assert next(a for a in snap['assessments'] if a['id']==source['assessmentId'])['sources'][0]['date']==assignment()['effectiveDates']['due']['value']
    _,pairs,_=make_pair(client)
    assert not pairs


def test_pair_confirm_replay_dates_and_alias_overlay_survive_restart(harness):
    client,store,path=harness
    collect_assignment(client)
    snap,pairs,candidate=make_pair(client)
    assert len(pairs)==1
    pair=pairs[0]
    done=decision(client,pair,'confirm')
    assert done.status_code==200,done.text
    saved=done.json(); layer=saved['reconciliation']
    group=next(x for x in layer['logicalAssessments'] if x['id']==next(p for p in layer['pairs'] if p['id']==pair['id'])['canonicalId'])
    assert {x['source'] for x in group['sources']}=={'moodle','syllabus'}
    assert len(group['sources'])==2
    alias=next(x for x in layer['aliases'] if x['originalId']==f"syl-{candidate['id']}")
    original=deepcopy(saved['overlays'])
    updated=client.patch('/api/assessments/'+alias['originalId']+'/overlay',json={'hidden':True,'dateOverride':{'kind':'week','week':9}})
    assert updated.status_code==200,updated.text
    assert updated.json()['overlays']==original
    overlay=next(x for x in updated.json()['reconciliation']['logicalOverlays'] if x['assessmentId']==alias['canonicalId'])
    assert overlay['hidden'] and overlay['overrideBase']==assignment()['effectiveDates']['due']['value']
    restored=client.put('/api/snapshot',json=updated.json())
    assert restored.status_code==200 and restored.json()==updated.json()
    assert decision(client,pair,'confirm').status_code==200
    reopened=SQLiteStore(URL.create('sqlite',database=str(path)),namespace=store.namespace)
    try:
        assert reopened.read()==store.read()
        with TestClient(create_app(reopened,collection_provider=SyntheticCollectionContext(reopened.namespace))) as second:
            assert second.get('/api/snapshot').json()==store.read()
            assert decision(second,pair,'reject').status_code==409
    finally: reopened.close()


def test_reject_is_pair_specific_replay_and_changed_evidence(harness):
    client,store,_=harness
    collect_assignment(client)
    snap,pairs,_=make_pair(client)
    pair=pairs[0]
    rejected=decision(client,pair,'reject');assert rejected.status_code==200
    assert decision(client,pair,'reject').status_code==200
    replay=collect_assignment(client,'assignment-replay')
    assert not [p for p in replay['reconciliation']['pairs'] if p['status']=='pending']
    # Another independent candidate is not suppressed by that pair's rejection.
    _,other,_=make_pair(client,digest='b'*64)
    assert len(other)==1 and other[0]['id']!=pair['id']
    before=store.read()
    assert decision(client,pair,'confirm').status_code==409
    assert store.read()==before


def test_explicit_different_day_pair_and_conflicting_overlays(harness):
    client,store,_=harness
    collect_assignment(client)
    snap,pairs,candidate=make_pair(client,due={'kind':'date','date':'2026-11-04'})
    assert not pairs
    src=snap['reconciliation']['sources'];m=next(x for x in src if x['kind']=='moodle');sy=next(x for x in src if x['kind']=='syllabus')
    for source,title in [(m,'My Moodle title'),(sy,'My syllabus title')]:
        response=client.patch('/api/assessments/'+__import__('urllib.parse').parse.quote(source['assessmentId'],safe='')+'/overlay',json={'titleOverride':title})
        assert response.status_code==200,response.text
    proposed=client.post('/api/reconciliation/pairs',json={'left':m['id'],'right':sy['id']})
    assert proposed.status_code==200,proposed.text
    pair=next(p for p in proposed.json()['reconciliation']['pairs'] if p['status']=='pending')
    before=store.read(); assert decision(client,pair,'confirm').status_code==409; assert store.read()==before
    ok=decision(client,pair,'confirm',{'titleOverride':sy['id']});assert ok.status_code==200,ok.text
    l=ok.json()['reconciliation']; group=next(p for p in l['pairs'] if p['id']==pair['id'])
    assert next(o for o in l['logicalOverlays'] if o['assessmentId']==group['canonicalId'])['titleOverride']=='My syllabus title'
    assert len([o for o in ok.json()['overlays'] if o['assessmentId'] in [m['assessmentId'],sy['assessmentId']]])==2


def test_stale_personal_data_and_submission_collisions_need_explicit_review(harness):
    from urllib.parse import quote
    client,store,_=harness
    collect_assignment(client);snap,pairs,_=make_pair(client);old=pairs[0]
    source=next(s for s in snap['reconciliation']['sources'] if s['kind']=='syllabus')
    response=client.patch('/api/assessments/'+quote(source['assessmentId'],safe='')+'/overlay',json={'completed':True})
    assert response.status_code==200
    before=store.read();assert decision(client,old,'confirm').status_code==409;assert store.read()==before
    current=next(p for p in before['reconciliation']['pairs'] if p['status']=='pending')
    # Explicit Snapshot restore introduces two distinct pre-existing observations;
    # both originals survive and the student selects the displayed observation.
    data=deepcopy(before);m=next(s for s in data['reconciliation']['sources'] if s['kind']=='moodle')
    for src,status in [(m,'draft'),(source,'submitted')]:
        next(a for a in data['assessments'] if a['id']==src['assessmentId'])['submission']={'status':status,'observedAt':'2026-10-27T12:00:00Z'}
    restored=client.put('/api/snapshot',json=data);assert restored.status_code==200,restored.text
    refreshed=next(p for p in restored.json()['reconciliation']['pairs'] if p['status']=='pending')
    assert refreshed['reviewRevision']!=current['reviewRevision']
    before=store.read();assert decision(client,refreshed,'confirm').status_code==409;assert store.read()==before
    done=decision(client,refreshed,'confirm',{'submission':source['id']});assert done.status_code==200,done.text
    logical=done.json()['reconciliation']['logicalAssessments']
    assert next(a for a in logical if a['id']==m['assessmentId'])['submission']['status']=='submitted'
    assert next(a for a in done.json()['assessments'] if a['id']==m['assessmentId'])['submission']['status']=='draft'
    assert next(a for a in done.json()['assessments'] if a['id']==source['assessmentId'])['submission']['status']=='submitted'


def test_changed_matching_evidence_reopens_rejected_pair_without_erasing_history(harness):
    client,store,_=harness
    assert client.patch('/api/settings',json={'timezone':'UTC'}).status_code==200
    collect_assignment(client)
    _,pairs,_=make_pair(client)
    pair=pairs[0];assert decision(client,pair,'reject').status_code==200
    changed=assignment('2026-10-28T14:00:00Z')
    due=deepcopy(changed['effectiveDates']['due'])
    due['value']={'kind':'exact','iso':'2026-10-28T14:00:00Z','tz':'UTC'}
    changed['baseDates']['due']=deepcopy(due);changed['effectiveDates']['due']=deepcopy(due)
    token,headers=begin(client,visit='changed-evidence')
    response=refresh(client,token,headers,result(observations=[changed]),time=changed['observedAt'])
    assert response.status_code==200,response.text
    states=[p for p in response.json()['snapshot']['reconciliation']['pairs'] if p['id']==pair['id']]
    assert {p['status'] for p in states}=={'rejected','pending'}
    assert len({p['fingerprint'] for p in states})==2
    assert decision(client,pair,'reject').status_code==200
    assert len(store.read()['collection']['records'][0]['observations'])==2


def test_missing_moodle_date_does_not_replace_known_syllabus(harness):
    from backend.services import source_date
    client,_,_=harness
    collect_assignment(client); _,pairs,_=make_pair(client)
    assert decision(client,pairs[0],'confirm').status_code==200
    unknown=assignment('2026-10-29T14:00:00Z');unknown['baseDates']={};unknown['effectiveDates']={}
    token,headers=begin(client,visit='unknown-due')
    response=refresh(client,token,headers,result(observations=[unknown]),time=unknown['observedAt'])
    assert response.status_code==200,response.text
    logical=response.json()['snapshot']['reconciliation']['logicalAssessments']
    canonical_id=next(p['canonicalId'] for p in response.json()['snapshot']['reconciliation']['pairs'] if p['id']==pairs[0]['id'])
    group=next(a for a in logical if a['id']==canonical_id)
    assert source_date(group['sources'])=={'kind':'exact','iso':'2026-10-28T13:30:00Z','tz':'UTC'}


def test_competing_decisions_serialize_and_failure_after_write_rolls_back(harness):
    client,store,path=harness
    collect_assignment(client);_,pairs,_=make_pair(client);pair=pairs[0]
    before=store.read()
    def fail_after_write(connection,cursor,statement,parameters,context,many):
        if statement.startswith('UPDATE snapshots'):
            raise sqlite3.OperationalError('simulated failure after update')
    event.listen(store.engine,'after_cursor_execute',fail_after_write)
    try:
        assert decision(client,pair,'confirm').status_code==503
    finally:
        event.remove(store.engine,'after_cursor_execute',fail_after_write)
    assert store.read()==before
    other=SQLiteStore(URL.create('sqlite',database=str(path)),namespace=store.namespace)
    try:
        def act(kind, repo):
            with TestClient(create_app(repo)) as contender:
                return decision(contender,pair,kind).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            a=executor.submit(act,'confirm',store);b=executor.submit(act,'reject',other)
            assert sorted([a.result(),b.result()])==[200,409]
        saved=store.read()
        assert saved==other.read()
        assert len([p for p in saved['reconciliation']['pairs'] if p['id']==pair['id'] and p['status'] in ('confirmed','rejected')])==1
    finally: other.close()


def test_competing_extraction_decisions_are_atomic_and_replay_safe(harness):
    client,store,path=harness
    imported=client.post('/api/documents/import',json={'courseId':'c-csc','fileName':'fictional.pdf','contentDigest':'e'*64})
    candidate=imported.json()['snapshot']['candidates'][-1]
    other=SQLiteStore(URL.create('sqlite',database=str(path)),namespace=store.namespace)
    try:
        def act(kind, repo):
            with TestClient(create_app(repo)) as contender:
                return contender.post(f"/api/candidates/{candidate['id']}/review",json={'kind':kind}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            a=executor.submit(act,'confirm',store);b=executor.submit(act,'reject',other)
            assert sorted([a.result(),b.result()])==[200,409]
        saved=store.read();status=next(c['status'] for c in saved['candidates'] if c['id']==candidate['id'])
        assert status in ('confirmed','rejected')
        assert sum(a['id']==f"syl-{candidate['id']}" for a in saved['assessments'])==int(status=='confirmed')
        assert client.post(f"/api/candidates/{candidate['id']}/review",json={'kind':'confirm' if status=='confirmed' else 'reject'}).json()==saved
        assert client.post(f"/api/candidates/{candidate['id']}/review",json={'kind':'reject' if status=='confirmed' else 'confirm'}).status_code==409
        assert store.read()==saved==other.read()
    finally: other.close()


def test_namespace_isolation_and_foreign_restore_fails_closed(harness):
    client,store,path=harness
    collect_assignment(client);original=store.read()
    foreign=namespace_key('moodle',origin=MOODLE_ORIGIN,profile_label='synthetic-B',stable_user_id='2')
    other=SQLiteStore(URL.create('sqlite',database=str(path)),namespace=foreign)
    try:
        before=other.read()
        assert before['assessments']==[]
        with TestClient(create_app(other)) as second:
            response=second.put('/api/snapshot',json=original)
            assert response.status_code==409
        assert other.read()==before and store.read()==original
    finally: other.close()
