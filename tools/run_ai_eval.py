"""One bounded, owner-approved free-plan evaluation of the #42 nonprivate fixtures.

Usage (backend environment only; the key is never passed on the command line):
    $env:GROQ_API_KEY = '<your key>'
    uv run python tools/run_ai_eval.py                 # Groq openai/gpt-oss-120b (default)
    $env:MOODLE_HELPER_AI_MODEL = 'openai/gpt-oss-20b' # optional, from the same fixed allowlist
    uv run python tools/run_ai_eval.py --provider gemini  # dormant Gemini path (GEMINI_API_KEY)

Sends only the nonprivate synthetic fixture texts in _docs/architecture/ai-contract-eval-fixtures.json,
one request per case, with no retries. Groq cases are spaced 21 s apart (at most 3 per minute, under the
free plan's 8K tokens per minute); a 429 is recorded as rate_limit and not retried. Stops before a request
when the running cost would pass COST_CAP_USD. Writes dated results to
_docs/architecture/ai-contract-eval-results.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.ai_gateway import (GEMINI_MODEL, MAX_OUTPUT_TOKENS, AiFailure, GeminiProvider, GroqProvider,  # noqa: E402
                                ProviderError, gemini_config, groq_config, groq_model, validate_output)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / '_docs/architecture/ai-contract-eval-fixtures.json'
RESULTS = ROOT / '_docs/architecture/ai-contract-eval-results.json'
COST_CAP_USD = 0.0  # free plan/tier: any nonzero price table stops the run
GROQ_SPACING_SECONDS = 21


def judge(expect: dict, text: str, proposals: list[dict]) -> list[str]:
    """Return the expectation keys the result fails; an empty list is a pass."""
    failed = []
    if 'proposals' in expect and len(proposals) != expect['proposals']:
        failed.append('proposals')
    if expect.get('proposals') == 0:
        return failed
    if not proposals:
        return failed + ['proposals']
    p = proposals[0]
    value = p['date'].get('value')
    if 'date' in expect and value != expect['date']:
        failed.append('date')
    for key in ('precision',):
        if key in expect and p['date']['precision'] != expect[key]:
            failed.append(key)
    for key in ('type', 'uncertain', 'uncertaintyReason'):
        if key in expect and p.get(key) != expect[key]:
            failed.append(key)
    if 'title' in expect and expect['title'].lower() not in p['title'].lower():
        failed.append('title')
    if 'evidenceSpan' in expect:
        ev = p['evidence'][0]
        units = text.encode('utf-16-le')
        span = units[ev['start'] * 2:ev['end'] * 2].decode('utf-16-le', errors='replace')
        if expect['evidenceSpan'] not in span:
            failed.append('evidenceSpan')
    if p.get('confirmed') is not False:
        failed.append('confirmed')
    return failed


def setup(provider_name: str, env, opener=None):
    """Return the provider, its gateway config (price table), the model and the result labels."""
    if provider_name == 'groq':
        model = groq_model(env.get('MOODLE_HELPER_AI_MODEL'))
        provider = GroqProvider(api_key=env['GROQ_API_KEY'], model=model, opener=opener)
        return provider, groq_config(':memory:', model), model, {'tier': 'free', 'reasoningEffort': 'low'}
    provider = GeminiProvider(api_key=env['GEMINI_API_KEY'])
    return provider, gemini_config(':memory:'), GEMINI_MODEL, {'tier': 'free', 'thinkingLevel': 'LOW'}


async def main(argv=None, env=None, results: Path = RESULTS, sleep=asyncio.sleep, opener=None) -> int:
    args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    args.add_argument('--provider', choices=('groq', 'gemini'), default='groq')
    provider_name = args.parse_args(argv).provider
    env = os.environ if env is None else env
    key_name = 'GROQ_API_KEY' if provider_name == 'groq' else 'GEMINI_API_KEY'
    if not env.get(key_name):
        print(f'{key_name} is not set; nothing was sent.')
        return 2
    data = json.loads(FIXTURES.read_text(encoding='utf-8'))
    provider, config, model, labels = setup(provider_name, env, opener)
    prices = config.prices
    spent, rows = 0.0, []
    for index, case in enumerate(data['cases']):
        if spent + prices.worst_case() > COST_CAP_USD + 1e-12:
            print(f'stopped before {case["id"]}: cost cap {COST_CAP_USD} USD')
            break
        if index and provider_name == 'groq':
            await sleep(GROQ_SPACING_SECONDS)
        excerpt = {'id': 'ex-0', 'documentDigest': '0' * 64, 'locationId': 'loc-0', 'text': case['text']}
        request = {'requestId': case['id'], 'excerpts': [excerpt], 'context': data['context']}
        row = {'id': case['id'], 'lang': case['lang']}
        try:
            raw = await asyncio.wait_for(provider.extract(request, max_output_tokens=MAX_OUTPUT_TOKENS), 30)
            proposals = validate_output(raw, [excerpt])
            failed = judge(case['expect'], case['text'], proposals)
            row.update(outcome='pass' if not failed else 'fail', failed=failed, proposals=proposals)
        except (AiFailure, ProviderError) as failure:
            status = getattr(failure, 'http_status', None)
            row.update(outcome='fail', failed=[failure.code + (f':{status}' if status else '')])
        except asyncio.TimeoutError:
            row.update(outcome='fail', failed=['timeout'])
        except Exception as error:  # noqa: BLE001 - recorded by class name and HTTP code/status only, never the message
            detail = ':'.join(str(v) for v in (getattr(error, 'code', None), getattr(error, 'status', None)) if v)
            row.update(outcome='fail', failed=['provider_failure:' + type(error).__name__ + (':' + detail if detail else '')])
        usage = provider.usage
        cost = prices.worst_case() if usage is None else (usage[0] * prices.input_usd_per_million + usage[1] * prices.output_usd_per_million) / 1e6
        spent += cost
        row.update(inputTokens=usage and usage[0], outputTokens=usage and usage[1], costUsd=round(cost, 6))
        rows.append(row)
        print(f'{case["id"]:16} {row["outcome"]:4} {",".join(row["failed"])}')
    result = {'label': f'{provider_name}:{model} run of the #42 nonprivate fixtures', 'provider': provider_name, 'model': model,
              **labels, 'ranAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'fixturesVersion': data['version'],
              'priceTable': prices.version, 'totalCostUsd': round(spent, 6),
              'passed': sum(r['outcome'] == 'pass' for r in rows), 'cases': rows}
    results.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{result["passed"]}/{len(rows)} passed, {spent:.6f} USD; wrote {results.name}')
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
