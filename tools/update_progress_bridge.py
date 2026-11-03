"""Add the fixed issue-21 bridge operations from the source API contract."""
import json
from pathlib import Path
import yaml

root = Path(__file__).resolve().parents[1]
doc = yaml.safe_load((root / 'openapi.yaml').read_text(encoding='utf-8'))
path = root / 'shared/src/bridge.ts'
source = path.read_text(encoding='utf-8')
start = source.index('export const catalog = ') + len('export const catalog = ')
end = source.index(' as const;', start)
catalog = json.loads(source[start:end])
for name, method, route in [
    ('currentMockRun', 'get', '/api/queue/current'),
    ('startMockRun', 'post', '/api/queue/current'),
    ('cancelMockRun', 'post', '/api/queue/runs/{runId}/cancel'),
]:
    op = doc['paths'][route][method]
    catalog[name] = {'method': method.upper(), 'path':route,
        'body':op.get('requestBody', {}).get('content', {}).get('application/json', {}).get('schema'),
        'result':op['responses']['200']['content']['application/json']['schema']}
path.write_text(source[:start] + json.dumps(catalog) + source[end:], encoding='utf-8')
