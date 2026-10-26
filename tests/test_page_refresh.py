"""#18 synthetic trusted-context harness against production FastAPI and SQLite.

No test claims live Moodle identity, envelope, quiz or submission classification.
"""
from copy import deepcopy
import json
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL, text
from backend.collection import SyntheticCollectionContext
from backend.main import create_app
from backend.sqlite_store import SQLiteStore, StorageError
from backend.sample_data import build_sample_snapshot
from backend import schemas

ORIGIN='https://moodle.sdu.edu.kz'
TIME='2026-10-27T12:15:00.12+05:00'
PAGE=ORIGIN+'/mod/assign/view.php?id=303'


def assignment(time=TIME):
    date=dict(value=dict(kind='exact',iso='2026-10-28T18:30+05:00',tz='Asia/Almaty'),rawText='Displayed due',location='assignment.base.due')
    return dict(sourceCourseId='101',sourceActivityId='202',sourceCourseModuleId='303',sourceUrl=PAGE,title='Synthetic assignment',observedAt=time,baseDates={'due':date},individualExtensions=[],effectiveDates={'due':deepcopy(date)})


def result(kind='assignment', observations=None):
    return dict(kind=kind,observations=[assignment()] if observations is None else observations,reviews=[],diagnostics=[],pages=[],coverage='complete',scope='visited_activity_only' if kind in ['assignment','quiz','submission'] else 'supplied_ranges_only' if kind=='calendar' else 'supplied_pages_only')


@pytest.fixture
def harness(tmp_path):
    path=tmp_path/'synthetic-collection.sqlite3'
    store=SQLiteStore(URL.create('sqlite',database=str(path)))
    snapshot=build_sample_snapshot()
    snapshot['courses'][0]['discovery']=dict(sourceCourseId='101',sourceUrl=ORIGIN+'/course/view.php?id=101',title={'kind':'known','value':'Synthetic course'},termIndicators={'kind':'unknown'},currentTermStatus='unknown')
    snapshot['settings']['trackedCourseIds']=[snapshot['courses'][0]['id']]
    store.replace(snapshot)
    app=create_app(store,collection_provider=SyntheticCollectionContext(store.namespace))
    with TestClient(app) as client:
        yield client,store,path
    store.close()


def begin(client,page=PAGE,visit='visit-A',document='tab:document'):
    context=client.get('/api/collection-context').json()
    headers={'X-Moodle-Helper-Bridge-Binding':context['binding']}
    response=client.post('/api/collection/visits',headers=headers,json=dict(documentKey=document,visitId=visit,pageUrl=page,selectionRevision=context['selectionRevision']))
    assert response.status_code==200,response.text
    return response.json()['visitToken'],headers


def refresh(client,token,headers,value=None,collector='assignment',time=TIME):
    return client.post('/api/collection/refresh',headers=headers,json=dict(visitToken=token,observedAt=time,collector=collector,result=result() if value is None else value))


def revision(store):
    with store.engine.connect() as c:
        return c.execute(text('SELECT revision FROM snapshots WHERE namespace=:n'),{'n':store.namespace}).scalar_one()


def test_atomic_source_layer_stable_revisit_replay_and_personal_preservation(harness):
    client,store,_=harness
    before=store.read();token,headers=begin(client)
    saved=refresh(client,token,headers)
    assert saved.status_code==200,saved.text
    value=saved.json();layer=value['snapshot']['collection'];record=layer['records'][0]
    assert record['observations']==[assignment()]
    assert json.loads(record['id'])==['demo','assignment','101','assign','202']
    assert value['receipt']['evidenceMode']=='synthetic'
    for key in before: assert value['snapshot'][key]==before[key]
    rev=revision(store)
    assert refresh(client,token,headers).json()==value
    assert revision(store)==rev
    changed=result();changed['observations'][0]['title']='Updated synthetic assignment'
    assert refresh(client,token,headers,changed).status_code==409
    assert revision(store)==rev
    second,headers=begin(client,visit='visit-B')
    changed['observations'][0]['observedAt']='2026-10-28T12:00Z'
    reply=refresh(client,second,headers,changed).json()
    current=reply['snapshot']['collection']['records']
    assert len(current)==1 and len(current[0]['observations'])==2
    assert current[0]['firstObservedAt']==TIME
    assert current[0]['lastObservedAt']=='2026-10-28T12:00Z'
    older,headers=begin(client,visit='visit-C')
    old=result();old['observations'][0]['observedAt']='2026-10-20T12:00Z'
    assert refresh(client,older,headers,old).json()['snapshot']['collection']['records'][0]['lastObservedAt']=='2026-10-28T12:00Z'


def test_A_B_A_active_tokens_and_no_late_commit(harness):
    client,store,_=harness
    a,h=begin(client);b,_=begin(client,visit='visit-B');a2,_=begin(client,visit='visit-A-again')
    rev=revision(store)
    for token in [a,b]: assert refresh(client,token,h).status_code==409
    assert revision(store)==rev
    assert refresh(client,a2,h).status_code==200
    assert len(store.read()['collection']['refreshes'])==1


@pytest.mark.parametrize('change',['selection','mapping','provider','process','deletion','restore'])
def test_context_change_invalidates_unresolved_work(harness,change):
    client,store,_=harness;token,h=begin(client);before=store.read()
    if change=='selection': client.put('/api/tracked-courses',json=[])
    elif change=='mapping':
        store.mutate(lambda s:s['courses'][0]['discovery'].update(sourceCourseId='102'))
    elif change=='provider': client.app.state.collection.provider=SyntheticCollectionContext(store.namespace,False)
    elif change=='process': h={'X-Moodle-Helper-Bridge-Binding':'0'*32}
    elif change=='deletion': client.delete('/api/local-data')
    else: client.put('/api/snapshot',json=before)
    rev=revision(store)
    assert refresh(client,token,h).status_code==409
    assert revision(store)==rev


def test_binding_required_before_body_parsing_and_no_HTTP_enable(harness):
    client,store,_=harness;rev=revision(store)
    for path in ['/api/collection/visits','/api/collection/refresh']:
        assert client.post(path,content='malformed-private-sentinel').status_code==409
    context=client.get('/api/collection-context').json()
    for extra in ['namespace','mode','stableUserId','provider']:
        payload=dict(documentKey='doc',visitId='visit',pageUrl=PAGE,selectionRevision=context['selectionRevision'],**{extra:'sentinel'})
        response=client.post('/api/collection/visits',headers={'X-Moodle-Helper-Bridge-Binding':context['binding']},json=payload)
        assert response.status_code==422 and 'sentinel' not in response.text
    assert revision(store)==rev
    with TestClient(create_app(store)) as disabled:
        ctx=disabled.get('/api/collection-context').json();assert ctx['mode']=='disabled'
        response=disabled.post('/api/collection/visits',headers={'X-Moodle-Helper-Bridge-Binding':ctx['binding']},json=dict(documentKey='doc',visitId='visit',pageUrl=PAGE,selectionRevision=ctx['selectionRevision']))
        assert response.status_code==409


def test_oversized_observation_batch_fails_atomically_without_truncation(harness):
    client,store,_=harness;token,h=begin(client);rev=revision(store)
    r=result(observations=[assignment() for _ in range(513)])
    assert refresh(client,token,h,r).status_code==409 and revision(store)==rev


@pytest.mark.parametrize('path',['https://other.example/mod/assign/view.php?id=303',ORIGIN+'/my/',ORIGIN+'/course/view.php?id=999',ORIGIN+'/mod/assign/view.php?id=303&sesskey=sentinel'])
def test_unsupported_routes_have_zero_writes(harness,path):
    client,store,_=harness;context=client.get('/api/collection-context').json();rev=revision(store)
    response=client.post('/api/collection/visits',headers={'X-Moodle-Helper-Bridge-Binding':context['binding']},json=dict(documentKey='doc',visitId='visit',pageUrl=path,selectionRevision=context['selectionRevision']))
    assert response.status_code==409 and revision(store)==rev


@pytest.mark.parametrize('field,value',[('sourceCourseId','999'),('sourceActivityId','0'),('sourceCourseModuleId','304'),('sourceUrl',PAGE+'&sesskey=sentinel'),('observedAt','2026-02-30T12:00Z')])
def test_domain_identity_time_negatives_are_atomic(harness,field,value):
    client,store,_=harness;token,h=begin(client);r=result();r['observations'][0][field]=value;rev=revision(store)
    response=refresh(client,token,h,r)
    assert response.status_code in [409,422] and revision(store)==rev
    assert 'sentinel' not in response.text


def test_full_inventory_ambiguity_not_just_selected_courses(harness):
    client,store,_=harness
    def duplicate(s): s['courses'][1]['discovery']=deepcopy(s['courses'][0]['discovery'])
    store.mutate(duplicate)
    assert client.get('/api/collection-context').status_code==409


def test_restart_snapshot_restore_deletion_and_safe_failure_receipts(harness):
    client,store,path=harness;token,h=begin(client)
    assert refresh(client,token,h).status_code==200
    failed,h=begin(client,visit='failed')
    assert refresh(client,failed,h,{'kind':'failed','reasons':['collector_failed']}).status_code==200
    unavailable,h=begin(client,visit='unavailable')
    assert refresh(client,unavailable,h,{'kind':'unavailable','reasons':['collector_unavailable']}).status_code==200
    saved=store.read()
    assert len(saved['collection']['records'])==1
    assert [x['outcome'] for x in saved['collection']['refreshes']]==['ok','failed','unavailable']
    reopened=SQLiteStore(URL.create('sqlite',database=str(path)))
    assert reopened.read()==saved
    with TestClient(create_app(reopened,collection_provider=SyntheticCollectionContext(store.namespace))) as new:
        ctx=new.get('/api/collection-context').json()
        assert refresh(new,token,{'X-Moodle-Helper-Bridge-Binding':ctx['binding']}).status_code==409
        assert new.put('/api/snapshot',json=saved).json()==saved
        assert 'collection' not in new.delete('/api/local-data').json()
        assert new.put('/api/snapshot',json=saved).json()==saved
        assert 'collection' not in new.post('/api/demo/reset').json()
    reopened.close()


def test_storage_failure_rolls_back_and_returns_no_private_error(harness,monkeypatch):
    client,store,_=harness;token,h=begin(client);before=store.read()
    def fail(operation):
        value=deepcopy(before);operation(value)
        raise StorageError('Database unavailable. No save was confirmed.')
    monkeypatch.setattr(store,'mutate',fail)
    response=refresh(client,token,h)
    assert response.status_code==503 and store.read()==before


def test_submission_reduction_unknown_keeps_confirmation_and_rejects_conflicting_tie(harness):
    client,store,_=harness
    def attempted(status,time):
        return dict(sourceCourseId='101',sourceActivityId='202',sourceCourseModuleId='303',sourceUrl=PAGE,observation=dict(status=status,observedAt=time,evidence='Synthetic classified attempt'))
    for visit,status,time in [('one','submitted','2026-10-25T12:00Z'),('two','unknown',TIME)]:
        token,h=begin(client,visit=visit)
        response=refresh(client,token,h,result('submission',[attempted(status,time)]),'submission')
        assert response.status_code==200,response.text
    record=store.read()['collection']['records'][0]
    latest=record['observations'][-1]
    assert latest['stale'] and latest['confirmed']['observation']['status']=='submitted'
    token,h=begin(client,visit='three');rev=revision(store)
    assert refresh(client,token,h,result('submission',[attempted('draft','2026-10-25T12:00Z')]),'submission').status_code==409
    assert revision(store)==rev


def material():
    reference=dict(sourcePageUrl=ORIGIN+'/course/view.php?id=101',sourceUrl=ORIGIN+'/mod/resource/view.php?id=201',destinationUrl=ORIGIN+'/pluginfile.php/700/mod_resource/content/1/lecture.pdf',observedAt=TIME,location='course.material')
    return dict(**reference,sourceCourseId='101',sourceCourseModuleId='201',sourceModuleType='resource',sourceContextId='700',resourceKey=json.dumps([ORIGIN,'101','resource','module','201'],separators=(',',':')),kind='file',title={'kind':'known','value':'Synthetic lecture'},section={'kind':'unknown'},fileType={'kind':'unknown'},mimeType={'kind':'unknown'},references=[deepcopy(reference)])


@pytest.mark.parametrize('destination',[
    'https://docs.example:443/lecture.pdf','https://docs.example/a/%74oken.pdf','https://docs.example/lecture.pdf?id='+'a'*32,
    'https://docs.example/lecture.pdf?id=a.b.c','https://docs.example/lecture.pdf?id=a&id=b','https://docs.example/lecture.pdf?sesskey=sentinel',
    ORIGIN+'/pluginfile.php/700/mod_folder/content/1/lecture.pdf',ORIGIN+'/pluginfile.php/999/mod_resource/content/1/lecture.pdf',ORIGIN+'/pluginfile.php/700/mod_resource/content/1/%74oken.pdf',
])
def test_material_privacy_rejects_observations_and_review_candidates(harness,destination):
    client,store,_=harness
    for review in [False,True]:
        token,h=begin(client,ORIGIN+'/course/view.php?id=101',visit='review' if review else 'observation')
        raw=material();raw['destinationUrl']=destination
        r=result('material',[] if review else [raw])
        if review:r['reviews']=[{'kind':'material','reasons':['missing_metadata'],'candidate':raw}]
        rev=revision(store);response=refresh(client,token,h,r,'material')
        assert response.status_code==409,response.text
        assert revision(store)==rev and 'sentinel' not in response.text


def test_material_unknowns_and_safe_unicode_office_preserved(harness):
    client,store,_=harness;token,h=begin(client,ORIGIN+'/course/view.php?id=101')
    raw=material();raw['destinationUrl']=ORIGIN+'/pluginfile.php/700/mod_resource/content/1/%D0%A3%D1%80%D0%BE%D0%BA.pptx'
    raw['mimeType']={'kind':'known','value':'application/vnd.openxmlformats-officedocument.presentationml.presentation'}
    response=refresh(client,token,h,result('material',[raw]),'material')
    assert response.status_code==200,response.text
    assert store.read()['collection']['records'][0]['observations']==[raw]


@pytest.mark.parametrize('field,value',[
    ('title',{'kind':'known','value':'https://private.example/token-sentinel'}),
    ('section',{'kind':'known','value':'javascript:private-sentinel'}),
    ('mimeType',{'kind':'known','value':'application/private-token-sentinel'}),
    ('parentResourceKey','["wrong","parent"]'),
    ('sourceContextId','999'),
])
def test_material_metadata_parent_and_context_revalidated_for_records_and_reviews(harness,field,value):
    client,store,_=harness
    for review in [False,True]:
        token,h=begin(client,ORIGIN+'/course/view.php?id=101',visit='bad-review' if review else 'bad-record')
        raw=material();raw[field]=value;r=result('material',[] if review else [raw])
        if review:r['reviews']=[dict(kind='material',candidate=raw,reasons=['missing_metadata'])]
        rev=revision(store);response=refresh(client,token,h,r,'material')
        assert response.status_code==409 and revision(store)==rev
        assert 'sentinel' not in response.text


def test_committed_visit_uuid_cannot_be_reused_after_replacement_or_restart(harness):
    client,store,path=harness;token,h=begin(client);assert refresh(client,token,h).status_code==200
    begin(client,visit='other-visit')
    context=client.get('/api/collection-context').json()
    body=dict(documentKey='tab:document',visitId='visit-A',pageUrl=PAGE,selectionRevision=context['selectionRevision'])
    assert client.post('/api/collection/visits',headers=h,json=body).status_code==409
    with TestClient(create_app(store,collection_provider=SyntheticCollectionContext(store.namespace))) as restarted:
        c=restarted.get('/api/collection-context').json();body['selectionRevision']=c['selectionRevision']
        assert restarted.post('/api/collection/visits',headers={'X-Moodle-Helper-Bridge-Binding':c['binding']},json=body).status_code==409


def test_calendar_review_activity_privacy_and_cross_kind_review_reject(harness):
    client,store,_=harness
    candidate=dict(sourceEventId='501',sourceUrl=ORIGIN+'/calendar/view.php?event=501',observedAt=TIME,title='Synthetic unresolved event',activity=dict(moduleType='assign',sourceActivityId='202',sourceCourseModuleId='303',sourceUrl=PAGE+'&sesskey=sentinel'))
    token,h=begin(client,ORIGIN+'/calendar/view.php')
    r=result('calendar',[]);r['reviews']=[dict(kind='calendar',candidate=candidate,reasons=['missing_course'])]
    assert refresh(client,token,h,r,'calendar').status_code==409
    candidate.pop('activity')
    assert refresh(client,token,h,r,'calendar').status_code==200
    assert store.read()['collection']['records']==[]
    token,h=begin(client,visit='assignment-with-calendar');r=result();r['reviews']=[dict(kind='calendar',candidate=candidate,reasons=['missing_course'])]
    rev=revision(store)
    assert refresh(client,token,h,r).status_code in [409,422] and revision(store)==rev


def test_quiz_attempt_unknown_complement_precision_and_canonical_fact_replay(harness):
    client,store,_=harness;page=ORIGIN+'/mod/quiz/view.php?id=404';token,h=begin(client,page)
    fact=dict(field='allowed',rawText='Synthetic visible attempt allowance',location='quiz.attemptInformation.allowed')
    quiz=dict(sourceCourseId='101',sourceActivityId='505',sourceCourseModuleId='404',sourceUrl=page,title='Synthetic quiz',observedAt=TIME,opening=dict(value={'kind':'date','date':'2026-10-01'},rawText='Opens October 1',location='quiz.opening'),attemptInformation=dict(kind='known',facts=[fact,deepcopy(fact)],unknownFields=['other','remaining','state','used']))
    response=refresh(client,token,h,result('quiz',[quiz]),'quiz')
    assert response.status_code==200,response.text
    saved=store.read()['collection']['records'][0]['observations'][0]
    assert len(saved['attemptInformation']['facts'])==1 and 'closing' not in saved
    assert saved['opening']==quiz['opening']
    token,h=begin(client,page,visit='invalid-complement');quiz['attemptInformation']['unknownFields']=[]
    assert refresh(client,token,h,result('quiz',[quiz]),'quiz').status_code==409
