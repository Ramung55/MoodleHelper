"""Pure backend retention policy, pending transactional integration in #18/#20.

These records contain caller-classified facts, not Moodle wording classification.
Inaccessible attempts are represented by the existing wire status ``unknown``.
Errors have no usable output; callers must leave their existing confirmation alone.
"""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
import re
from typing import Literal

from backend.domain_validation import validate_instant
from backend.identity import MOODLE_ORIGIN
from backend.schemas import SubmissionObservation


@dataclass(frozen=True)
class SubmissionRecord:
    course_id: str
    activity_id: str
    module_id: str
    source_url: str
    observation: SubmissionObservation


@dataclass(frozen=True)
class RetentionResult:
    ok: bool
    diagnostic: Literal['invalid_attempt', 'invalid_previous', 'identity_mismatch',
                        'conflicting_observations'] | None = None
    attempted: SubmissionRecord | None = None
    confirmed: SubmissionRecord | None = None
    stale: bool = False


def _instant(value: str) -> tuple[int, str]:
    """Exact UTC comparison without microsecond truncation or UTC year overflow.

    Fraction strings with trailing zeros removed have numeric lexicographic order
    (a missing tail is zero); whole seconds may lie outside datetime's year range.
    """
    validate_instant(value, 'observedAt')
    local = datetime.fromisoformat(value.replace('Z', '+00:00'))
    seconds = ((local.toordinal() * 24 + local.hour) * 60 + local.minute) * 60 + local.second
    offset = local.utcoffset()
    seconds -= offset.days * 86400 + offset.seconds
    match = re.search(r'\.([0-9]+)', value)
    return seconds, match[1].rstrip('0') if match else ''


def _validated(record: SubmissionRecord, *, previous: bool = False) -> tuple[int, str]:
    if type(record) is not SubmissionRecord:
        raise ValueError
    if any(type(v) is not str or re.fullmatch(r'[1-9][0-9]*', v) is None
           for v in (record.course_id, record.activity_id, record.module_id)):
        raise ValueError
    if record.source_url != f'{MOODLE_ORIGIN}/mod/assign/view.php?id={record.module_id}':
        raise ValueError
    if type(record.observation) is not SubmissionObservation:
        raise ValueError
    # Revalidate even a model modified after construction or made by model_construct.
    observation = SubmissionObservation.model_validate(record.observation.model_dump(exclude_unset=True))
    if previous and observation.status == 'unknown':
        raise ValueError
    return _instant(observation.observedAt)


def retain_submission(attempt: SubmissionRecord,
                      previous: SubmissionRecord | None = None) -> RetentionResult:
    """Return detached attempt and optional confirmation; never fetch, log or store.

    Identity includes course, activity instance, module and canonical module URL.
    Equal-state replay retains original wording/time precision. A contradictory tie
    is an error, never an arbitrary replacement. Unknown never confirms a status.
    """
    try:
        attempted_at = _validated(attempt)
    except (ValueError, TypeError, AttributeError):
        return RetentionResult(False, 'invalid_attempt')
    if previous is not None:
        try:
            previous_at = _validated(previous, previous=True)
        except (ValueError, TypeError, AttributeError):
            return RetentionResult(False, 'invalid_previous')
        if ((attempt.course_id, attempt.activity_id, attempt.module_id, attempt.source_url)
                != (previous.course_id, previous.activity_id, previous.module_id, previous.source_url)):
            return RetentionResult(False, 'identity_mismatch')
        if (attempted_at == previous_at and attempt.observation.status != 'unknown'
                and attempt.observation.status != previous.observation.status):
            return RetentionResult(False, 'conflicting_observations')
    confirmed = previous
    if attempt.observation.status != 'unknown' and (previous is None or attempted_at > previous_at):
        confirmed = attempt
    stale = previous is not None and attempt.observation.status == 'unknown' and attempted_at > previous_at
    return RetentionResult(True, attempted=deepcopy(attempt), confirmed=deepcopy(confirmed), stale=stale)
