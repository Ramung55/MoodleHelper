"""#54: personal completion is an overlay-only fact, independent of Moodle submission status."""
from sqlalchemy import URL

from backend.sqlite_store import SQLiteStore
from test_assessment_overrides import overlay_of, patch
from test_deadline_tracking import ingest, observed
from test_page_refresh import harness  # noqa: F401
from test_reconciliation import decision, make_pair


def test_completion_patch_changes_only_completed_and_survives_restart(harness):
    client, store, path = harness
    original = {'kind': 'date', 'date': '2026-11-01'}
    snap = ingest(client, 'done-first', observed('2026-10-27T10:00:00Z', original)).json()['snapshot']
    aid = snap['deadlineStreams'][0]['assessmentId']
    edited = patch(client, aid, {'titleOverride': 'Mine', 'dateOverride': {'kind': 'date', 'date': '2026-11-05'}})
    before = overlay_of(edited, aid)
    done = patch(client, aid, {'completed': True})
    assert overlay_of(done, aid) == {**before, 'completed': True}  # no baseline recapture, no erased edit
    # Every other field of the snapshot (source facts, submission evidence, other overlays) is byte-equivalent.
    def strip(s):
        other = lambda items: [o for o in items if o['assessmentId'] != aid]
        rec = {**s['reconciliation'], 'logicalOverlays': other(s['reconciliation'].get('logicalOverlays', []))}
        return {**s, 'overlays': other(s['overlays']), 'reconciliation': rec}
    assert strip(done) == strip(edited)
    # A later source refresh keeps the personal check.
    refreshed = ingest(client, 'done-second', observed('2026-10-27T11:00:00Z', {'kind': 'date', 'date': '2026-11-03'})).json()['snapshot']
    assert overlay_of(refreshed, aid)['completed'] is True
    undone = patch(client, aid, {'completed': False})
    assert overlay_of(undone, aid) == {**overlay_of(refreshed, aid), 'completed': False}
    reopened = SQLiteStore(URL.create('sqlite', database=str(path)), namespace=store.namespace)
    try:
        assert reopened.read() == undone
    finally:
        reopened.close()


def test_completion_through_alias_targets_the_logical_overlay(harness):
    client, store, _ = harness
    ingest(client, 'alias-done', observed('2026-10-27T10:00:00Z', {'kind': 'exact', 'iso': '2026-10-28T13:30:00Z', 'tz': 'UTC'}))
    _, pairs, candidate = make_pair(client)
    assert decision(client, pairs[0], 'confirm').status_code == 200
    alias = 'syl-' + candidate['id']
    snap = patch(client, alias, {'completed': True})
    canonical = next(a['canonicalId'] for a in snap['reconciliation']['aliases'] if a['originalId'] == alias)
    logical = [o for o in snap['reconciliation']['logicalOverlays'] if o['assessmentId'] == canonical]
    assert len(logical) == 1 and logical[0]['completed'] is True
    assert overlay_of(snap, alias) is None
    assert store.read() == snap
