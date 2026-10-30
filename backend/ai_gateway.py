"""Optional AI extraction gateway (#43) for contract ai-extract.v1 (#42).

No provider is active: ordinary runtime is unavailable and the production budget
is 0 USD. Only a trusted ``create_app(ai_gateway=...)`` construction can enable
the deterministic local mock. Nothing here performs network I/O, and no request
or provider content is written to logs or to the admission ledger.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Awaitable, Callable, Protocol

from pydantic import ValidationError

from backend import schemas as s

log = logging.getLogger('moodle_helper.ai_gateway')

VERSION = 'ai-extract.v1'
UNAVAILABLE_REASON = 'External AI unavailable: provider not selected; no text sent.'
LEGACY_UNAVAILABLE = 'No AI gateway or provider policy is configured. No document content is sent externally.'
MOCK_PROVIDER = 'Local mock; no external provider'
MOCK_RETENTION = 'Mock demonstration; stays local. Nothing is sent or retained externally.'
MAX_EXCERPTS = 8
MAX_EXCERPT_BYTES = 2000
MAX_BODY_BYTES = 16 * 1024
MAX_INPUT_TOKENS = 20_000
MAX_OUTPUT_TOKENS = 2_000
PROMPT_OVERHEAD_TOKENS = 2_000
MAX_OUTPUT_BYTES = 64 * 1024
MAX_OUTPUT_DEPTH = 24
MAX_PROPOSALS = 50

# Fixed, sanitized failures. Messages never include submitted or provider content.
FAILURES = {
    'invalid_request': (422, 'Invalid AI request.'),
    'payload_too_large': (413, 'AI request exceeds the payload limit.'),
    'consent_mismatch': (422, 'Consent does not match the exact selected excerpts, context and destination.'),
    'context_changed': (409, 'Local dataset changed. Reconnect and consent again.'),
    'duplicate_request': (409, 'This AI request ID was already used; its outcome is recorded. Consent again to resend.'),
    'request_conflict': (409, 'This AI request ID was already used for a different payload.'),
    'concurrency_limit': (429, 'Another AI request is in progress. Wait for it to finish.'),
    'rate_limit': (429, 'AI request rate limit reached. Try again later.'),
    'budget_exhausted': (429, 'AI cost cap reached. No provider work was started.'),
    'unavailable': (503, UNAVAILABLE_REASON),
    'price_unavailable': (503, 'AI price table is missing or expired. No provider work was started.'),
    'timeout': (504, 'AI provider timed out. Nothing was retried; review and resend manually.'),
    'provider_failure': (502, 'AI provider failed. Nothing was retried; review and resend manually.'),
    'invalid_output': (502, 'AI provider returned invalid output. No proposals were accepted.'),
    'cancelled': (499, 'AI request was cancelled. No proposals were accepted.'),
}


class AiFailure(Exception):
    def __init__(self, code: str, request_id: str | None = None, retry_after: int | None = None):
        super().__init__(code)
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after

    @property
    def status(self) -> int:
        return FAILURES[self.code][0]

    def body(self) -> dict:
        message = FAILURES[self.code][1] + f' (code: {self.code}'
        if self.request_id:
            message += f'; request: {self.request_id}'
        return {'message': message + ')'}


class Provider(Protocol):
    """Adapter boundary. ``extract`` returns parsed JSON-like output or raw bytes."""

    async def extract(self, request: dict, *, max_output_tokens: int) -> dict | bytes: ...


@dataclass(frozen=True)
class PriceTable:
    version: str
    input_usd_per_million: float
    output_usd_per_million: float
    valid_until: date

    def worst_case(self) -> float:
        return (MAX_INPUT_TOKENS * self.input_usd_per_million + MAX_OUTPUT_TOKENS * self.output_usd_per_million) / 1_000_000


@dataclass
class GatewayConfig:
    mode: str = 'unavailable'  # only 'unavailable' or 'mock'; no real provider transport exists
    policy_version: str = 'mock-policy-1'
    destination: str = 'mock'
    timeout_seconds: float = 30.0
    per_minute: int = 3
    per_day: int = 20
    monthly_cap_usd: float = 0.0
    per_request_reserve_usd: float = 0.10
    prices: PriceTable | None = None
    ledger_path: str = ':memory:'
    simulated_cost: bool = True

    def __post_init__(self):
        if self.mode not in ('unavailable', 'mock'):
            raise ValueError('Only the unavailable and local mock AI modes exist.')


def mock_config(ledger_path: str, **overrides) -> GatewayConfig:
    """Simulated 10 USD/month UTC cap and 0.10 USD/request bounds; nothing is billed."""
    values = dict(mode='mock', monthly_cap_usd=10.0, ledger_path=ledger_path,
                  prices=PriceTable('mock-prices-1', 0.10, 0.50, date(2099, 12, 31)))
    values.update(overrides)
    return GatewayConfig(**values)


def canonical_payload(consent_policy: str, destination: str, excerpts: list[dict], context: dict | None) -> bytes:
    """Canonical serialization bound by consent.payloadDigest (documented in ai-gateway.md)."""
    payload = {
        'version': VERSION, 'policyVersion': consent_policy, 'destination': destination,
        'excerpts': [{k: e[k] for k in ('id', 'documentDigest', 'locationId', 'text')} for e in excerpts],
        'context': context or {},
    }
    return json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def payload_digest(consent_policy: str, destination: str, excerpts: list[dict], context: dict | None) -> str:
    return hashlib.sha256(canonical_payload(consent_policy, destination, excerpts, context)).hexdigest()


class Ledger:
    """Durable SQLite admission ledger: IDs, digests, sanitized status and cost only."""

    def __init__(self, path: str):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute('CREATE TABLE IF NOT EXISTS ai_requests (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, '
                        'status TEXT NOT NULL, created REAL NOT NULL, month TEXT NOT NULL, reserved_usd REAL NOT NULL, '
                        'cost_usd REAL, failure TEXT)')
        # A crashed in-flight lease becomes unknown and keeps its worst-case reservation; never re-executed.
        self.db.execute("UPDATE ai_requests SET status='unknown', failure='interrupted' WHERE status='running'")

    def admit(self, request_id: str, digest: str, now: float, config: GatewayConfig, reserve: float) -> None:
        month = datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                row = self.db.execute('SELECT digest FROM ai_requests WHERE request_id=?', (request_id,)).fetchone()
                if row is not None:
                    raise AiFailure('duplicate_request' if row[0] == digest else 'request_conflict', request_id)
                if self.db.execute("SELECT COUNT(*) FROM ai_requests WHERE status='running'").fetchone()[0] >= 1:
                    raise AiFailure('concurrency_limit', request_id, retry_after=int(config.timeout_seconds))
                minute = self.db.execute('SELECT COUNT(*), MIN(created) FROM ai_requests WHERE created>?', (now - 60,)).fetchone()
                if minute[0] >= config.per_minute:
                    raise AiFailure('rate_limit', request_id, retry_after=max(1, int(minute[1] + 60 - now) + 1))
                day = self.db.execute('SELECT COUNT(*), MIN(created) FROM ai_requests WHERE created>?', (now - 86400,)).fetchone()
                if day[0] >= config.per_day:
                    raise AiFailure('rate_limit', request_id, retry_after=max(1, int(day[1] + 86400 - now) + 1))
                spent = self.db.execute('SELECT COALESCE(SUM(COALESCE(cost_usd, reserved_usd)), 0) FROM ai_requests WHERE month=?', (month,)).fetchone()[0]
                if spent + reserve > config.monthly_cap_usd + 1e-12:
                    raise AiFailure('budget_exhausted', request_id)
                self.db.execute("INSERT INTO ai_requests VALUES (?, ?, 'running', ?, ?, ?, NULL, NULL)",
                                (request_id, digest, now, month, reserve))
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK')
                raise

    def finish(self, request_id: str, status: str, cost: float | None, failure: str | None = None) -> None:
        # Unknown actual cost keeps the worst-case reservation (cost stays NULL).
        with self.lock:
            self.db.execute('UPDATE ai_requests SET status=?, cost_usd=?, failure=? WHERE request_id=?',
                            (status, cost, failure, request_id))

    def rows(self) -> list[tuple]:
        with self.lock:
            return self.db.execute('SELECT request_id, digest, status, reserved_usd, cost_usd, failure FROM ai_requests ORDER BY created').fetchall()

    def close(self):
        self.db.close()


ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ISO_MONTH = re.compile(r'^\d{4}-\d{2}$')
ISO_DATETIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$')


def depth(value: Any, level: int = 1) -> int:
    if level > MAX_OUTPUT_DEPTH:
        return level
    if isinstance(value, dict):
        return max([level] + [depth(v, level + 1) for v in value.values()])
    if isinstance(value, list):
        return max([level] + [depth(v, level + 1) for v in value])
    return level


def utf16_length(text: str) -> int:
    return len(text.encode('utf-16-le')) // 2


def validate_output(raw: dict | bytes, excerpts: list[dict]) -> list[dict]:
    """Closed output validation. Any defect rejects the whole result (fail closed)."""
    if isinstance(raw, (bytes, bytearray)):
        if len(raw) > MAX_OUTPUT_BYTES:
            raise AiFailure('invalid_output')
        try:
            raw = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise AiFailure('invalid_output') from None
    try:
        encoded = json.dumps(raw, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise AiFailure('invalid_output') from None
    if len(encoded.encode('utf-8')) > MAX_OUTPUT_BYTES or depth(raw) > MAX_OUTPUT_DEPTH:
        raise AiFailure('invalid_output')
    if not isinstance(raw, dict) or set(raw) != {'proposals'} or not isinstance(raw['proposals'], list) or len(raw['proposals']) > MAX_PROPOSALS:
        raise AiFailure('invalid_output')
    by_id = {e['id']: e for e in excerpts}
    accepted = []
    for item in raw['proposals']:
        if not isinstance(item, dict):
            raise AiFailure('invalid_output')
        # The gateway, not the model, sets confirmed=false and location provenance.
        if 'confirmed' in item or any(not isinstance(ev, dict) or 'locationId' in ev for ev in item.get('evidence', []) if isinstance(item.get('evidence'), list)):
            raise AiFailure('invalid_output')
        candidate = dict(item, confirmed=False)
        if isinstance(item.get('evidence'), list):
            candidate['evidence'] = [dict(ev, locationId=by_id[ev['excerptId']]['locationId']) if isinstance(ev, dict) and ev.get('excerptId') in by_id else ev for ev in item['evidence']]
        if candidate.get('uncertaintyReason') is None:
            candidate.pop('uncertaintyReason', None)
        if isinstance(candidate.get('date'), dict) and candidate['date'].get('value') is None:
            candidate['date'] = {k: v for k, v in candidate['date'].items() if k != 'value'}
        try:
            proposal = s.AiProposal.model_validate(candidate)
        except (ValidationError, ValueError):
            raise AiFailure('invalid_output') from None
        for ev in proposal.evidence:
            excerpt = by_id.get(ev.excerptId)
            if excerpt is None or ev.end <= ev.start or ev.end > utf16_length(excerpt['text']):
                raise AiFailure('invalid_output')
        value, precision = proposal.date.value, proposal.date.precision
        try:
            if precision == 'date':
                if value is None or not ISO_DATE.match(value):
                    raise ValueError
                date.fromisoformat(value)
            elif precision == 'datetime':
                if value is None or not ISO_DATETIME.match(value):
                    raise ValueError
                datetime.fromisoformat(value.replace('Z', '+00:00'))
            elif precision == 'month':
                if value is None or not ISO_MONTH.match(value):
                    raise ValueError
                date.fromisoformat(value + '-01')
            elif value is not None:
                raise ValueError  # week/none never carry an invented calendar value
        except ValueError:
            raise AiFailure('invalid_output') from None
        if precision == 'week' and proposal.week is None:
            raise AiFailure('invalid_output')
        if precision in ('week', 'none', 'month') and not proposal.uncertain:
            raise AiFailure('invalid_output')
        if proposal.uncertain != (proposal.uncertaintyReason is not None):
            raise AiFailure('invalid_output')
        accepted.append(proposal.model_dump(exclude_none=True))
    return accepted


@dataclass
class MockProvider:
    """Deterministic, network-free provider. ``behavior`` emulates provider outcomes."""

    behavior: str = 'ok'  # ok | fail | timeout | invalid | oversize | output
    output: Any = None
    usage: tuple[int, int] | None = (1200, 300)
    delay: float = 0.0
    calls: int = 0
    cancelled: int = 0
    seen: list = field(default_factory=list)

    async def extract(self, request: dict, *, max_output_tokens: int):
        self.calls += 1
        self.seen.append(request['requestId'])
        try:
            if self.behavior == 'timeout':
                await asyncio.sleep(3600)
            if self.delay:
                await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        if self.behavior == 'fail':
            raise RuntimeError('provider exploded sk-SECRET-MARKER')  # never surfaced
        if self.behavior == 'invalid':
            return b'{"proposals": [ not json'
        if self.behavior == 'oversize':
            return b'{"proposals":[]}' + b' ' * (MAX_OUTPUT_BYTES + 1)
        if self.behavior == 'output':
            return self.output
        return {'proposals': [p for e in request['excerpts'] if (p := mock_proposal(e))]}


def mock_proposal(excerpt: dict) -> dict | None:
    """Rule-based local extraction; treats excerpt text purely as data."""
    text = excerpt['text']

    def span(match):
        prefix = text[:match.start()]
        start = utf16_length(prefix)
        return [{'excerptId': excerpt['id'], 'start': start, 'end': start + utf16_length(match.group(0))}]
    lowered = text.lower()
    kind = 'exam' if 'exam' in lowered or 'экзамен' in lowered else 'quiz' if 'quiz' in lowered or 'контрольн' in lowered else 'assignment' if any(w in lowered for w in ('due', 'deadline', 'report', 'essay', 'сдача')) else 'other'
    title = 'Mock candidate (' + kind + ')'
    if m := re.search(r'\b(\d{4})-(\d{2})-(\d{2})\b', text):
        return {'title': title, 'type': kind, 'date': {'value': m.group(0), 'precision': 'date'}, 'uncertain': False, 'evidence': span(m)}
    if m := re.search(r'\b(\d{1,2})/(\d{1,2})/(\d{4})\b', text):
        return {'title': title, 'type': kind, 'date': {'precision': 'none'}, 'uncertain': True, 'uncertaintyReason': 'ambiguous_order', 'evidence': span(m)}
    if m := re.search(r'\bweek\s+(\d{1,2})\b', text, re.I):
        week = int(m.group(1))
        if 1 <= week <= 30:
            return {'title': title, 'type': kind, 'date': {'precision': 'week'}, 'week': week, 'uncertain': True, 'uncertaintyReason': 'relative_week', 'evidence': span(m)}
    return None


class AiGateway:
    def __init__(self, config: GatewayConfig | None = None, provider: Provider | None = None, clock: Callable[[], float] = time.time):
        self.config = config or GatewayConfig()
        if self.config.mode == 'mock' and provider is None:
            raise ValueError('Mock mode requires an injected local mock provider.')
        self.provider = provider if self.config.mode == 'mock' else None
        self.clock = clock
        self.ledger = Ledger(self.config.ledger_path) if self.config.mode == 'mock' else None
        self.active = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return self.config.mode == 'mock'

    def availability(self) -> dict:
        if not self.enabled:
            return {'available': False, 'reason': LEGACY_UNAVAILABLE}
        c = self.config
        return {'available': True, 'provider': MOCK_PROVIDER, 'retention': MOCK_RETENTION, 'mode': 'mock',
                'policyVersion': c.policy_version, 'destination': c.destination,
                'limits': {'maxExcerpts': MAX_EXCERPTS, 'maxExcerptBytes': MAX_EXCERPT_BYTES, 'maxBodyBytes': MAX_BODY_BYTES,
                           'timeoutSeconds': int(c.timeout_seconds), 'perMinute': c.per_minute, 'perDay': c.per_day,
                           'concurrency': 1, 'monthlyCapUsd': c.monthly_cap_usd, 'perRequestReserveUsd': c.per_request_reserve_usd,
                           'simulatedCost': c.simulated_cost}}

    def preflight(self, body: dict, dataset_id: str) -> tuple[dict, str, float]:
        """All checks that must pass before any provider work."""
        if not self.enabled:
            raise AiFailure('unavailable')
        try:
            request = s.AiExtractRequest.model_validate(body).model_dump(exclude_none=True)
        except (ValidationError, ValueError):
            raise AiFailure('invalid_request') from None
        rid = request['requestId']
        excerpts = request['excerpts']
        if any(len(e['text'].encode('utf-8')) > MAX_EXCERPT_BYTES for e in excerpts):
            raise AiFailure('payload_too_large', rid)
        ids = [e['id'] for e in excerpts]
        if len(set(ids)) != len(ids):
            raise AiFailure('invalid_request', rid)
        if request['expectedDatasetId'] != dataset_id:
            raise AiFailure('context_changed', rid)
        consent = request['consent']
        context = request.get('context')
        digest = payload_digest(consent['policyVersion'], consent['destination'], excerpts, context)
        if (consent['approvedExcerptIds'] != ids or consent['destination'] != self.config.destination
                or consent['policyVersion'] != self.config.policy_version or consent['payloadDigest'] != digest):
            raise AiFailure('consent_mismatch', rid)
        bounds = (context or {}).get('explicitSemesterBounds') or {}
        if bounds.get('start') and bounds.get('end') and bounds['start'] > bounds['end']:
            raise AiFailure('invalid_request', rid)
        try:
            for value in bounds.values():
                date.fromisoformat(value)
        except ValueError:
            raise AiFailure('invalid_request', rid) from None
        prices = self.config.prices
        if prices is None or prices.valid_until < datetime.fromtimestamp(self.clock(), timezone.utc).date():
            raise AiFailure('price_unavailable', rid)
        input_bound = len(canonical_payload(consent['policyVersion'], consent['destination'], excerpts, context)) + PROMPT_OVERHEAD_TOKENS
        reserve = prices.worst_case()
        if input_bound > MAX_INPUT_TOKENS or reserve > self.config.per_request_reserve_usd:
            raise AiFailure('price_unavailable', rid)
        return request, digest, self.config.per_request_reserve_usd

    async def extract(self, body: dict, dataset_id: str, disconnected: Callable[[], Awaitable[bool]] | None = None) -> dict:
        request, digest, reserve = self.preflight(body, dataset_id)
        rid = request['requestId']
        if self.active.locked():
            raise AiFailure('concurrency_limit', rid, retry_after=int(self.config.timeout_seconds))
        async with self.active:
            self.ledger.admit(rid, digest, self.clock(), self.config, reserve)
            outcome, cost = 'failed', None
            try:
                raw, cost = await self._invoke(request, disconnected)
                proposals = validate_output(raw, request['excerpts'])
                outcome = 'ok'
            except AiFailure as failure:
                outcome = failure.code
                failure.request_id = rid
                log.warning('ai_extract failed request=%s code=%s', rid, failure.code)
                raise
            finally:
                self.ledger.finish(rid, outcome, cost, None if outcome == 'ok' else outcome)
        log.info('ai_extract ok request=%s proposals=%d', rid, len(proposals))
        usage = getattr(self.provider, 'usage', None)
        response = {'version': VERSION, 'requestId': rid, 'mode': 'mock', 'policyVersion': self.config.policy_version,
                    'status': 'ok', 'proposals': proposals}
        if usage is not None and cost is not None:
            response['usage'] = {'inputTokens': usage[0], 'outputTokens': usage[1], 'costUsd': round(cost, 6), 'simulated': True}
        return response

    async def _invoke(self, request: dict, disconnected) -> tuple[Any, float | None]:
        task = asyncio.ensure_future(self.provider.extract(request, max_output_tokens=MAX_OUTPUT_TOKENS))
        deadline = asyncio.get_running_loop().time() + self.config.timeout_seconds
        try:
            while not task.done():
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise AiFailure('timeout')
                await asyncio.wait({task}, timeout=min(0.05, remaining))
                if not task.done() and disconnected is not None and await disconnected():
                    raise AiFailure('cancelled')
        except BaseException:
            task.cancel()
            try:
                await task
            except BaseException:
                pass
            raise
        try:
            raw = task.result()
        except Exception:
            # Raw provider exception text/repr is never logged or returned.
            raise AiFailure('provider_failure') from None
        usage = getattr(self.provider, 'usage', None)
        prices = self.config.prices
        if usage is None or usage[0] > MAX_INPUT_TOKENS or usage[1] > MAX_OUTPUT_TOKENS:
            return raw, None  # unknown or unbounded actual cost keeps the worst-case reservation
        return raw, (usage[0] * prices.input_usd_per_million + usage[1] * prices.output_usd_per_million) / 1_000_000

    def close(self):
        if self.ledger is not None:
            self.ledger.close()
