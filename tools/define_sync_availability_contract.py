"""Apply the PM-reviewed, fail-closed /api/sync source-contract clarification."""
from pathlib import Path
import yaml

path = Path(__file__).resolve().parents[1] / 'openapi.yaml'
document = yaml.safe_load(path.read_text(encoding='utf-8'))
document['components']['schemas']['SyncUnavailableError'] = {
    'type':'object', 'additionalProperties':False,
    'properties':{'message':{'type':'string', 'const':'Live course sync is unavailable until Moodle access is verified.'}},
    'required':['message']}
operation = document['paths']['/api/sync']['post']
operation['summary'] = 'Run the explicitly labeled demo sync'
operation['description'] = (
    'No request body. The startup-selected demo dataset returns a final Snapshot '
    'with fictional simulated results; it does not contact Moodle. A non-demo '
    'dataset returns HTTP 503 with the fixed message "Live course sync is unavailable '
    'until Moodle access is verified." and changes no data or queue state. '
    'Clients cannot select the dataset in this request. Real Moodle sync is '
    'unavailable pending verified identity, site evidence and safe request authority.')
operation['responses']['503'] = {
    'description': 'Moodle sync is unavailable; no work was scheduled and no data changed.',
    'content': {'application/json': {'schema': {'$ref':'#/components/schemas/SyncUnavailableError'}}}}
path.write_text(yaml.safe_dump(document, sort_keys=False, allow_unicode=True), encoding='utf-8')
