from copy import deepcopy


def test_mock_import_digest_replay_is_scoped_and_collision_fails(client):
    digest = 'a' * 64
    body = {'courseId': 'c-csc', 'fileName': 'invented.pdf', 'contentDigest': digest}
    first = client.post('/api/documents/import', json=body)
    assert first.status_code == 200
    saved = first.json()['snapshot']
    second = client.post('/api/documents/import', json={**body, 'fileName': 'renamed.pdf'})
    assert second.status_code == 200
    assert second.json()['snapshot'] == saved
    other = client.post('/api/documents/import', json={**body, 'courseId': 'c-phy'})
    assert other.status_code == 200
    assert len(other.json()['snapshot']['documents']) == len(saved['documents']) + 1
    damaged = deepcopy(other.json()['snapshot'])
    document = next(d for d in damaged['documents'] if d['name'] == 'invented.pdf' and d['courseId'] == 'c-csc')
    damaged['candidates'] = [c for c in damaged['candidates'] if c['documentId'] != document['id']]
    assert client.put('/api/snapshot', json=damaged).status_code == 200
    assert client.post('/api/documents/import', json=body).status_code == 409
    assert client.get('/api/snapshot').json() == damaged
