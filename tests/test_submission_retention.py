"""Evidence-independent policy checks; no claim of observed Moodle wording."""
from copy import deepcopy
from dataclasses import replace

import pytest

from backend.schemas import SubmissionObservation
from backend.submission_retention import SubmissionRecord, retain_submission


def record(status='submitted', at='2026-10-26T12:00:00Z', **changes):
    return replace(SubmissionRecord('1', '20', '300',
                   'https://moodle.sdu.edu.kz/mod/assign/view.php?id=300',
                   SubmissionObservation(status=status, observedAt=at, evidence='UNVERIFIED test wording')), **changes)


@pytest.mark.parametrize('status', ['submitted', 'draft', 'not_submitted', 'reopened', 'unknown'])
def test_no_prior(status):
    attempt = record(status)
    result = retain_submission(attempt)
    assert result.ok and result.attempted == attempt and not result.stale
    assert result.confirmed == (None if status == 'unknown' else attempt)


@pytest.mark.parametrize('status', ['submitted', 'draft', 'not_submitted', 'reopened', 'unknown'])
@pytest.mark.parametrize('relation', [-1, 0, 1])
def test_temporal_policy(status, relation):
    attempt = record(status, f'2026-10-26T12:00:0{relation + 1}Z')
    previous = record(at='2026-10-26T12:00:01Z')
    result = retain_submission(attempt, previous)
    conflict = relation == 0 and status not in ('submitted', 'unknown')
    assert result.ok is not conflict
    if conflict:
        assert result.diagnostic == 'conflicting_observations'
        assert result.attempted is result.confirmed is None
    else:
        assert result.confirmed == (attempt if relation > 0 and status != 'unknown' else previous)
        assert result.stale is (relation > 0 and status == 'unknown')
        assert result.attempted == attempt


@pytest.mark.parametrize('prior,attempt', [
    ('2026-01-01T00:00:00.0000001Z', '2026-01-01T00:00:00.0000002Z'),
    ('2026-01-01T00:00:00.999999999999999998Z', '2026-01-01T00:00:00.999999999999999999Z'),
    ('0001-01-01T00:00:00+23:59', '0001-01-01T00:00:00.0000001+23:59'),
    ('9999-12-31T23:59:59.1-23:59', '9999-12-31T23:59:59.11-23:59'),
])
def test_exact_ordering_at_submicrosecond_and_year_boundaries(prior, attempt):
    previous, latest = record(at=prior), record('draft', attempt)
    assert retain_submission(latest, previous).confirmed == latest
    assert retain_submission(previous, latest).confirmed == latest
    assert retain_submission(record('unknown', attempt), previous).stale
    assert not retain_submission(record('unknown', prior), latest).stale


@pytest.mark.parametrize('equivalent', ['2026-10-26T17:00:00+05:00', '2026-10-26T12:00:00.000000000Z', '2026-10-26T12:00Z'])
def test_offset_and_fraction_equivalent_replay_preserves_previous(equivalent):
    previous = record()
    attempt = record(at=equivalent)
    attempt.observation.evidence = 'different replay wording'
    assert retain_submission(attempt, previous).confirmed == previous
    assert retain_submission(record('draft', equivalent), previous).diagnostic == 'conflicting_observations'
    assert not retain_submission(record('unknown', equivalent), previous).stale


@pytest.mark.parametrize('field,value', [(field, value) for field in ('course_id', 'activity_id', 'module_id')
                                      for value in ('', '0', '01', '-1', '1.0', ' 1', '١', 1, True, None)])
def test_exact_positive_string_ids(field, value):
    assert retain_submission(record(**{field: value})).diagnostic == 'invalid_attempt'


@pytest.mark.parametrize('url', [
    'https://moodle.sdu.edu.kz/mod/assign/view.php?id=20',
    'https://moodle.sdu.edu.kz/mod/assign/view.php?id=0300',
    'http://moodle.sdu.edu.kz/mod/assign/view.php?id=300',
    'https://moodle.sdu.edu.kz:443/mod/assign/view.php?id=300',
    'https://user:SECRET@moodle.sdu.edu.kz/mod/assign/view.php?id=300',
    'https://evil.test/mod/assign/view.php?id=300',
    'https://moodle.sdu.edu.kz/mod/assign/view.php?id=300&token=SECRET',
    'https://moodle.sdu.edu.kz/mod/assign/view.php?id=300#fragment',
    'https://moodle.sdu.edu.kz/mod/quiz/view.php?id=300', None,
])
def test_only_canonical_matching_assignment_url(url):
    result = retain_submission(record(source_url=url))
    assert result.diagnostic == 'invalid_attempt'
    assert 'SECRET' not in repr(result)


@pytest.mark.parametrize('at', ['', '2026-10-26', '2026-10-26T12:00:00', '2026-02-30T00:00Z',
                              '2026-01-01T12:00+05:99', '2026-01-01T24:00Z', '0000-01-01T00:00Z', None])
def test_invalid_time_returns_fixed_error(at):
    attempt = record()
    attempt.observation.observedAt = at
    assert retain_submission(attempt).diagnostic == 'invalid_attempt'


@pytest.mark.parametrize('change', [dict(course_id='2'), dict(activity_id='21'),
                                  dict(module_id='301', source_url='https://moodle.sdu.edu.kz/mod/assign/view.php?id=301')])
def test_identity_agreement(change):
    assert retain_submission(record(**change), record()).diagnostic == 'identity_mismatch'


def test_invalid_previous_and_mutated_wire_values():
    assert retain_submission(record(), record('unknown')).diagnostic == 'invalid_previous'
    assert retain_submission(record(), {}).diagnostic == 'invalid_previous'
    assert retain_submission({}).diagnostic == 'invalid_attempt'
    invalid = record()
    invalid.observation.status = 'inaccessible'
    assert retain_submission(invalid).diagnostic == 'invalid_attempt'
    assert retain_submission(record(), invalid).diagnostic == 'invalid_previous'


def test_detached_outputs_and_no_input_mutation(capsys, monkeypatch):
    # An inaccessible page is supplied as unknown; this helper never reads a page.
    previous, attempt = record('reopened'), record('unknown', '2026-10-26T12:01Z')
    before = deepcopy((previous, attempt))
    def forbidden(*args, **kwargs):
        raise AssertionError('unexpected external effect')
    monkeypatch.setattr('builtins.open', forbidden)
    monkeypatch.setattr('socket.socket', forbidden)
    result = retain_submission(attempt, previous)
    assert result.stale and result.confirmed == previous
    assert (previous, attempt) == before
    result.confirmed.observation.evidence = 'changed'
    result.attempted.observation.status = 'draft'
    assert (previous, attempt) == before
    known = retain_submission(previous)
    known.attempted.observation.evidence = 'changed again'
    assert known.confirmed.observation.evidence == previous.observation.evidence
    assert capsys.readouterr() == ('', '')
