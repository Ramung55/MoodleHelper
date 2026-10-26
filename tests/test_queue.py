import concurrent.futures
import sqlite3
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import URL
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from backend.identity import namespace_key

@pytest.fixture
def env(tmp_path):
    store=SQLiteStore(URL.create('sqlite',database=str(tmp_path/'queue.db')))
    clock=[1000]
    app=create_app(store,queue_clock=lambda:clock[0])
    with TestClient(app) as c:
        binding=c.get('/api/bridge-context').json()['binding']
        yield c,store,clock,{'X-Moodle-Helper-Bridge-Binding':binding}
    store.close()

def post(c,h,path,body): return c.post('/api/queue/'+path,headers=h,json=body)
def start(c,h,key,ids): return post(c,h,'runs',{'idempotencyKey':key,'courseIds':ids})
def token(claim): return {'jobId':claim['job']['id'],'generation':claim['generation'],'token':claim['token']}
def claim(c,h): return post(c,h,'claim',{}).json()['claim']

def test_queue_persistence_idempotency_and_stale_claim(env):
    c,store,clock,h=env
    before=c.get('/api/snapshot').json()
    run=start(c,h,'one',['c-csc','c-math']).json()
    assert start(c,h,'one',['c-math','c-csc']).json()['id']==run['id']
    assert start(c,h,'one',['c-csc']).status_code==409
    assert start(c,h,'bad',['missing']).status_code==422
    assert start(c,h,'dup',['c-csc','c-csc']).status_code==422
    first=claim(c,h)
    assert post(c,h,'finish',{**token(first),'outcome':'completed'}).status_code==200
    second=claim(c,h); clock[0]+=61
    newer=claim(c,h)
    assert newer['job']['id']==second['job']['id'] and newer['generation']>second['generation']
    assert post(c,h,'finish',{**token(second),'outcome':'completed'}).status_code==409
    assert post(c,h,'finish',{**token(newer),'outcome':'completed'}).status_code==200
    result=c.get('/api/queue/runs/'+run['id']).json()
    assert result['status']=='completed' and result['progress']['completed']==2
    assert len({j['result']['id'] for j in result['jobs']})==2
    assert c.get('/api/snapshot').json()==before
    assert post(c,h,'runs/'+run['id']+'/cancel',{}).json()['status']=='completed'
    assert start(c,h,'later',['c-csc']).json()['jobs'][0]['id'] != first['job']['id']

def test_overlapping_cancellation_and_finish(env):
    c,store,clock,h=env
    a=start(c,h,'a',['c-csc','c-math']).json()
    b=start(c,h,'b',['c-csc']).json()
    assert next(j['id'] for j in a['jobs'] if j['courseId']=='c-csc')==b['jobs'][0]['id']
    active=claim(c,h)
    cancelled=post(c,h,'runs/'+a['id']+'/cancel',{}).json()
    assert cancelled['status']=='cancelled'
    if active['job']['courseId']=='c-csc':
        assert post(c,h,'finish',{**token(active),'outcome':'completed'}).status_code==200
        assert c.get('/api/queue/runs/'+b['id']).json()['status']=='completed'
    else:
        assert post(c,h,'finish',{**token(active),'outcome':'completed'}).status_code==409
        active=claim(c,h)
        assert post(c,h,'finish',{**token(active),'outcome':'completed'}).status_code==200
    assert post(c,h,'runs/'+a['id']+'/cancel',{}).json()['status']=='cancelled'

def test_real_discovered_course_id(env):
    c,store,clock,h=env
    observation={'sourceCourseId':'123','sourceUrl':'https://moodle.sdu.edu.kz/course/view.php?id=123','title':{'kind':'known','value':'Course'},'termIndicators':{'kind':'unknown'}}
    response=c.post('/api/courses/discovery',json={'observations':[observation]})
    assert response.status_code==200
    course=next(x for x in response.json()['courses'] if x.get('discovery',{}).get('sourceCourseId')=='123')
    assert course['id'].startswith('[')
    assert start(c,h,'discovered',[course['id']]).status_code==200

def test_rollback_and_binding(env,monkeypatch):
    c,store,clock,h=env
    assert start(c,{},'no-binding',['c-csc']).status_code==409
    run=start(c,h,'rollback',['c-csc']).json(); active=claim(c,h)
    svc=c.app.state.queue; execute=svc.execute
    def broken(conn,sql,*args):
        if sql.startswith('UPDATE queue_jobs SET state=?,error_code='): raise RuntimeError('injected')
        return execute(conn,sql,*args)
    monkeypatch.setattr(svc,'execute',broken)
    with pytest.raises(RuntimeError): post(c,h,'finish',{**token(active),'outcome':'completed'})
    monkeypatch.setattr(svc,'execute',execute)
    assert c.get('/api/queue/runs/'+run['id']).json()['jobs'][0]['state']=='running'
    with store.engine.connect() as db: assert db.exec_driver_sql('SELECT count(*) FROM queue_results').scalar_one()==0
    assert post(c,h,'finish',{**token(active),'outcome':'completed'}).status_code==200

def test_two_starts_share_atomically(env):
    c,store,clock,h=env
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda key:start(c,h,key,['c-csc','c-math']).json(),['a','b']))
    assert {j['id'] for j in results[0]['jobs']}=={j['id'] for j in results[1]['jobs']}

def test_namespace_and_restart(tmp_path):
    url=URL.create('sqlite',database=str(tmp_path/'queue.db'))
    first=SQLiteStore(url); other=SQLiteStore(url,namespace_key('moodle',origin='https://moodle.sdu.edu.kz',profile_label='p',stable_user_id='u'))
    try:
        with TestClient(create_app(first)) as c:
            h={'X-Moodle-Helper-Bridge-Binding':c.get('/api/bridge-context').json()['binding']}
            run=start(c,h,'a',['c-csc']).json(); active=claim(c,h)
        with TestClient(create_app(first)) as c:
            assert post(c,h,'renew',token(active)).status_code==409
            assert c.get('/api/queue/runs/'+run['id']).json()['status']=='running'
        with TestClient(create_app(other)) as c:
            assert c.get('/api/queue/runs/'+run['id']).status_code==404
    finally: first.close(); other.close()
