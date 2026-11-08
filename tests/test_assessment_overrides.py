"""#53: imported-assessment personal overrides survive real source ingestion and SQLite restart."""
from urllib.parse import quote

from sqlalchemy import URL

from backend.sqlite_store import SQLiteStore
from test_deadline_tracking import ingest, observed
from test_page_refresh import harness  # noqa: F401
from test_reconciliation import decision, make_pair


def overlay_of(snap, assessment_id):
    return next((o for o in snap['overlays'] if o['assessmentId'] == assessment_id), None)


def patch(client, assessment_id, body):
    response = client.patch('/api/assessments/' + quote(assessment_id, safe='') + '/overlay', json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_override_survives_ingestion_unrelated_patch_and_reset_returns_latest(harness):
    client, store, path = harness
    original = {'kind': 'date', 'date': '2026-11-01'}
    snap = ingest(client, 'ov-first', observed('2026-10-27T10:00:00Z', original)).json()['snapshot']
    aid = snap['deadlineStreams'][0]['assessmentId']
    source_before = [a for a in snap['assessments'] if a['id'] == aid]
    edited = patch(client, aid, {'titleOverride': 'My label', 'dateOverride': {'kind': 'date', 'date': '2026-11-05'}})
    assert overlay_of(edited, aid)['overrideBase'] == original
    assert [a for a in edited['assessments'] if a['id'] == aid] == source_before  # never mutates source facts
    latest = {'kind': 'date', 'date': '2026-11-03'}
    refreshed = ingest(client, 'ov-second', observed('2026-10-27T11:00:00Z', latest)).json()['snapshot']
    kept = overlay_of(refreshed, aid)
    assert kept['overrideBase'] == original and kept['dateOverride'] == {'kind': 'date', 'date': '2026-11-05'}
    assert refreshed['deadlineStreams'][0]['accepted'] == latest
    # An unrelated hide patch must not recapture the baseline (which would hide the conflict).
    hidden = overlay_of(patch(client, aid, {'hidden': True}), aid)
    assert hidden['overrideBase'] == original and hidden['hidden'] is True
    # Independent resets: date reset keeps title/hidden; title reset keeps the rest.
    date_reset = overlay_of(patch(client, aid, {'dateOverride': None}), aid)
    assert 'dateOverride' not in date_reset and 'overrideBase' not in date_reset
    assert date_reset['titleOverride'] == 'My label' and date_reset['hidden'] is True
    reset = patch(client, aid, {'titleOverride': None, 'hidden': False})
    assert overlay_of(reset, aid) == {'assessmentId': aid, 'hidden': False, 'completed': False}
    assert all(v is not None for o in reset['overlays'] for v in o.values())
    assert len([o for o in reset['overlays'] if o['assessmentId'] == aid]) == 1
    reopened = SQLiteStore(URL.create('sqlite', database=str(path)), namespace=store.namespace)
    try:
        assert reopened.read() == reset
    finally:
        reopened.close()


def test_alias_and_canonical_paths_share_one_overlay(harness):
    client, store, _ = harness
    ingest(client, 'alias-ov', observed('2026-10-27T10:00:00Z', {'kind': 'exact', 'iso': '2026-10-28T13:30:00Z', 'tz': 'UTC'}))
    _, pairs, candidate = make_pair(client)
    assert decision(client, pairs[0], 'confirm').status_code == 200
    alias = 'syl-' + candidate['id']
    via_alias = patch(client, alias, {'titleOverride': 'Alias title'})
    canonical = next(a['canonicalId'] for a in via_alias['reconciliation']['aliases'] if a['originalId'] == alias)
    via_canonical = patch(client, canonical, {'hidden': True})
    logical = [o for o in via_canonical['reconciliation']['logicalOverlays'] if o['assessmentId'] == canonical]
    assert len(logical) == 1 and logical[0]['titleOverride'] == 'Alias title' and logical[0]['hidden'] is True
    assert overlay_of(via_canonical, alias) is None
    restored = patch(client, alias, {'hidden': False, 'titleOverride': None})
    logical = [o for o in restored['reconciliation']['logicalOverlays'] if o['assessmentId'] == canonical]
    assert len(logical) == 1 and 'titleOverride' not in logical[0] and logical[0]['hidden'] is False
    assert store.read() == restored

