"""Explicit fictional syllabus revisions through FastAPI and SQLite."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import sqlite3
from sqlalchemy import event, URL
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.sqlite_store import SQLiteStore
from test_page_refresh import harness
from test_reconciliation import collect_assignment, make_pair, decision


def preview(client, source, candidate):
    return client.post('/api/syllabus-revisions/preview',json={'sourceId':source,'candidateId':candidate})


def confirm(client, offered):
    return client.post('/api/syllabus-revisions/confirm',json={k:offered[k] for k in ('sourceId','candidateId','revision','fingerprint')})


def test_reviewed_revision_preserves_alias_evidence_and_retry(harness):
    client,store,_ = harness
    collect_assignment(client)
    snap,pairs,original=make_pair(client)
    assert decision(client,pairs[0],'confirm').status_code==200
    snap,_,incoming=make_pair(client,due={'kind':'week','week':9},digest='b'*64)
    target=next(s for s in snap['reconciliation']['sources'] if s.get('candidateId')==original['id'])
    offered=preview(client,target['id'],incoming['id'])
    assert offered.status_code==200,offered.text
    result=confirm(client,offered.json()); assert result.status_code==200,result.text
    saved=result.json(); link=saved['syllabusRevisions'][0]
    assert link['revision']==1 and link['links'][0]['candidateId']==incoming['id']
    assert saved['changes'][-1]['sourceKind']=='syllabus'
    assert saved['changes'][-1]['to']=={'kind':'week','week':9}
    aliases={a['originalId']:a['canonicalId'] for a in saved['reconciliation']['aliases']}
    assert aliases['syl-'+incoming['id']]==aliases['syl-'+original['id']]
    assert confirm(client,offered.json()).json()==saved
    assert store.read()==saved
    assert client.put('/api/snapshot',json=saved).json()==saved


def test_stale_retry_multiple_revisions_and_return(harness):
    client,store,_=harness
    collect_assignment(client); snap,pairs,original=make_pair(client)
    assert decision(client,pairs[0],'confirm').status_code==200
    snap,_,first=make_pair(client,due={'kind':'week','week':9},digest='b'*64)
    target=next(s for s in snap['reconciliation']['sources'] if s.get('candidateId')==original['id'])
    offered=preview(client,target['id'],first['id']).json()
    assert confirm(client,offered).status_code==200
    snap,_,second=make_pair(client,due={'kind':'week','week':10},digest='c'*64)
    next_offer=preview(client,target['id'],second['id']).json()
    assert next_offer['revision']==1 and next_offer['target']['candidateId']==first['id']
    assert confirm(client,next_offer).status_code==200
    before=store.read()
    assert confirm(client,offered).json()==before
    assert store.read()==before
    snap,_,third=make_pair(client,due={'kind':'week','week':9},digest='d'*64)
    offer=preview(client,target['id'],third['id']).json()
    saved=confirm(client,offer).json()
    assert [c['to'] for c in saved['changes'] if c.get('sourceKind')=='syllabus'][-3:]==[{'kind':'week','week':9},{'kind':'week','week':10},{'kind':'week','week':9}]
    assert len(saved['syllabusRevisions'][0]['links'])==3


def test_write_failure_and_stale_precondition_rollback(harness):
    client,store,_=harness
    collect_assignment(client); snap,pairs,original=make_pair(client)
    decision(client,pairs[0],'confirm')
    snap,_,incoming=make_pair(client,due={'kind':'week','week':9},digest='b'*64)
    target=next(s for s in snap['reconciliation']['sources'] if s.get('candidateId')==original['id'])
    offer=preview(client,target['id'],incoming['id']).json(); before=store.read()
    def fail_after_update(conn,cursor,statement,params,context,many):
        if statement.startswith('UPDATE snapshots'): raise sqlite3.OperationalError('failure after update')
    event.listen(store.engine,'after_cursor_execute',fail_after_update)
    try: assert confirm(client,offer).status_code==503
    finally: event.remove(store.engine,'after_cursor_execute',fail_after_update)
    assert store.read()==before
    assert client.patch('/api/settings',json={'semesterWeeks':17}).status_code==200
    before=store.read(); assert confirm(client,offer).status_code==409
    assert store.read()==before


def test_concurrent_candidate_ownership_and_wrong_course(harness):
    client,store,path=harness
    collect_assignment(client);snap,pairs,original=make_pair(client);decision(client,pairs[0],'confirm')
    snap,_,incoming=make_pair(client,due={'kind':'week','week':9},digest='b'*64)
    target=next(s for s in snap['reconciliation']['sources'] if s.get('candidateId')==original['id'])
    offer=preview(client,target['id'],incoming['id']).json()
    other=SQLiteStore(URL.create('sqlite',database=str(path)),namespace=store.namespace)
    try:
        def submit(repo):
            with TestClient(create_app(repo)) as contender: return confirm(contender,offer).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs=[pool.submit(submit,repo) for repo in (store,other)]
            assert [j.result() for j in jobs]==[200,200]
        saved=store.read(); assert len(saved['syllabusRevisions'][0]['links'])==1
        assert len([x for x in saved['changes'] if x.get('sourceKind')=='syllabus'])==1
        assert preview(client,target['id'],incoming['id']).status_code==409
        assert other.read()==saved
    finally: other.close()
