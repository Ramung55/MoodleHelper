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

def test_mock_worker_cannot_claim_or_finish_scan_jobs(env):
    c, store, clock, h = env
    with store._transaction() as db:
        db.exec_driver_sql("INSERT INTO queue_runs(namespace,id,idem,course_ids,created,kind) VALUES(?,?,?,?,?,'scan')",
                           (store.namespace, 'scan-run', 'scan-key', '[\"c-csc\"]', 1))
        db.exec_driver_sql("INSERT INTO queue_jobs(namespace,id,course_id,created,state,kind,generation,token,expires) VALUES(?,?,?,?,'running','scan',1,'claim',?)",
                           (store.namespace, 'scan-job', 'c-csc', 1, 2000))
        db.exec_driver_sql('INSERT INTO queue_links(namespace,run_id,job_id) VALUES(?,?,?)',
                           (store.namespace, 'scan-run', 'scan-job'))
    assert post(c, h, 'claim', {}).json() == {'unfinished': False}
    claim_token = {'jobId': 'scan-job', 'generation': 1, 'token': 'claim'}
    assert post(c, h, 'renew', claim_token).status_code == 409
    assert post(c, h, 'finish', {**claim_token, 'outcome': 'completed'}).status_code == 409
    assert start(c, h, 'scan-key', ['c-math']).status_code == 409
    assert start(c, h, 'other-key', ['c-csc', 'c-math']).status_code == 409
    assert c.get('/api/queue/runs/scan-run').status_code == 404
    with store.engine.connect() as db:
        assert db.exec_driver_sql("SELECT count(*) FROM queue_runs WHERE idem='other-key'").scalar_one() == 0
        assert db.exec_driver_sql("SELECT state FROM queue_jobs WHERE id='scan-job'").scalar_one() == 'running'

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

def test_chunked_body_is_bounded_and_binding_precedes_read(env):
    import asyncio
    import httpx
    c,store,clock,h=env
    async def check():
        transport=httpx.ASGITransport(app=c.app)
        async with httpx.AsyncClient(transport=transport,base_url='http://test') as client:
            reads=[]
            async def chunks():
                for i in range(20):
                    reads.append(i)
                    yield b'x' * 131072
            response=await client.post('/api/queue/runs',headers=h,content=chunks())
            assert response.status_code==422 and len(reads)==9
            reads.clear()
            response=await client.post('/api/queue/runs',content=chunks())
            assert response.status_code==409 and reads==[]
            response=await client.post('/api/queue/runs',headers=h,content=b'{')
            assert response.status_code==422
    asyncio.run(check())

def test_version_two_migrates_snapshot_and_revision(tmp_path):
    from backend.sample_data import build_sample_snapshot
    import json
    path=tmp_path/'old.db'; original=build_sample_snapshot()
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)')
        db.execute('INSERT INTO schema_version VALUES(1,2)')
        db.execute('CREATE TABLE snapshots (namespace TEXT PRIMARY KEY, snapshot TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)')
        db.execute('INSERT INTO snapshots VALUES(?,?,?)',(namespace_key(),json.dumps(original),42))
    store=SQLiteStore(URL.create('sqlite',database=str(path)))
    try:
        assert store.read()==original
        with sqlite3.connect(path) as db:
            assert db.execute('SELECT version FROM schema_version').fetchone()==(6,)
            assert db.execute('SELECT revision FROM snapshots').fetchone()==(42,)
    finally: store.close()

def test_cancel_finish_race_and_paging(env):
    c,store,clock,h=env
    run=start(c,h,'race',['c-csc']).json(); active=claim(c,h)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        finish=pool.submit(post,c,h,'finish',{**token(active),'outcome':'completed'})
        cancel=pool.submit(post,c,h,'runs/'+run['id']+'/cancel',{})
        finish_result=finish.result(); cancel_result=cancel.result()
    assert finish_result.status_code in (200,409)
    result=c.get('/api/queue/runs/'+run['id']).json()
    if finish_result.status_code==200:
        assert result['jobs'][0]['result'] and result['status']=='completed'
    else:
        assert result['status']=='cancelled' and 'result' not in result['jobs'][0]
    run=start(c,h,'paged',['c-csc','c-math','c-phy']).json()
    page=c.get('/api/queue/runs/'+run['id'],params={'limit':1}).json()
    second=c.get('/api/queue/runs/'+run['id'],params={'limit':1,'cursor':page['nextCursor']}).json()
    assert page['jobs'][0]['id']!=second['jobs'][0]['id'] and page['progress']['total']==3
    assert c.get('/api/queue/runs/'+run['id'],params={'limit':101}).status_code==422

def test_invalid_concurrency_configuration(monkeypatch):
    for value in ('0','5','1.0','true',''):
        monkeypatch.setenv('MOODLE_HELPER_QUEUE_CONCURRENCY',value)
        with pytest.raises(ValueError,match='integer from 1 to 4'): create_app()

def test_global_cap_and_renewal_across_instances(tmp_path,monkeypatch):
    monkeypatch.setenv('MOODLE_HELPER_QUEUE_CONCURRENCY','2')
    url=URL.create('sqlite',database=str(tmp_path/'global.db'));a=SQLiteStore(url);b=SQLiteStore(url); clock=[1000]
    try:
        with TestClient(create_app(a,queue_clock=lambda:clock[0])) as one, TestClient(create_app(b,queue_clock=lambda:clock[0])) as two:
            h1={'X-Moodle-Helper-Bridge-Binding':one.get('/api/bridge-context').json()['binding']};h2={'X-Moodle-Helper-Bridge-Binding':two.get('/api/bridge-context').json()['binding']}
            run=start(one,h1,'global',['c-csc','c-math','c-phy']).json()
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                replies=list(pool.map(lambda pair:post(pair[0],pair[1],'claim',{}).json(),[(one,h1),(two,h2),(one,h1)]))
            claims=[x['claim'] for x in replies if 'claim' in x]
            assert len(claims)==2 and all(x['unfinished'] for x in replies)
            clock[0]+=30
            assert post(one,h1,'renew',token(claims[0])).json()['expiresAt']==1090
            clock[0]=1061
            replacement=claim(two,h2)
            assert replacement['job']['id']==claims[1]['job']['id']
            assert post(one,h1,'renew',token(claims[1])).status_code==409
            assert post(one,h1,'renew',token(claims[0])).status_code==200
    finally: a.close(); b.close()

