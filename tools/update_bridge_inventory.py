"""Refresh shared validation schema inventory without changing dashboard catalog."""
import json
from pathlib import Path
import yaml

root = Path(__file__).resolve().parents[1]
schemas = yaml.safe_load((root / 'openapi.yaml').read_text(encoding='utf-8'))['components']['schemas']
path = root / 'shared/src/bridge.ts'
source = path.read_text(encoding='utf-8')
start = source.index('const schemas:')
stop = source.index('\nexport const catalog', start)
path.write_text(source[:start] + 'const schemas: Record<string, any> = ' + json.dumps(schemas) + ';' + source[stop:], encoding='utf-8')
