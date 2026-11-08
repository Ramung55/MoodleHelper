"""Generate the additive #18 wire declarations from the authoritative OpenAPI.

Legacy models remain handwritten. Rerun after a collection source schema edit.
"""
from pathlib import Path
import json
import yaml

ROOT=Path(__file__).resolve().parents[1]
schemas=yaml.safe_load((ROOT/'openapi.yaml').read_text(encoding='utf-8'))['components']['schemas']
names=list(schemas)[list(schemas).index('CollectedDateObservation'):]
def py(s):
    if '$ref' in s: return s['$ref'].split('/')[-1]
    if 'oneOf' in s: return ' | '.join(py(v) for v in s['oneOf'])
    if 'const' in s: return 'Literal['+repr(s['const'])+']'
    if 'enum' in s: return 'Literal['+', '.join(repr(v) for v in s['enum'])+']'
    return {'string':'str','integer':'Integer','boolean':'bool','array':lambda:'list['+py(s['items'])+']'}[s['type']]() if s['type']=='array' else {'string':'str','integer':'Integer','boolean':'bool'}[s['type']]
def zod(s):
    if '$ref' in s: return s['$ref'].split('/')[-1]
    if 'oneOf' in s: return 'z.union(['+', '.join(zod(v) for v in s['oneOf'])+'])'
    if 'const' in s: return 'z.literal('+json.dumps(s['const'])+')'
    if 'enum' in s: return 'z.enum('+json.dumps(s['enum'])+')'
    if s['type']=='array': return 'z.array('+zod(s['items'])+')'+('.min('+str(s['minItems'])+')' if 'minItems' in s else '')+('.max('+str(s['maxItems'])+')' if 'maxItems' in s else '')
    return {'string':'z.string()','integer':'z.number().int()','boolean':'z.boolean()'}[s['type']]
python=['# BEGIN GENERATED COLLECTION MODELS', 'class CollectionWire(WireModel):', '    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False, json_schema_extra=omit_absence_defaults)', '']
ts=['// BEGIN GENERATED COLLECTION MODELS']
for name in names:
    if name=='PageRefreshResponse': continue
    s=schemas[name]
    if s.get('type')=='object':
        python+=['class '+name+'(CollectionWire):']
        ts+=['export const '+name+' = z.object({']
        for k,v in s['properties'].items():
            optional=k not in s.get('required',[])
            p=py(v)
            minimum=v.get('minItems')
            bounds=[]
            if minimum: bounds.append('min_length='+str(minimum))
            if 'maxItems' in v: bounds.append('max_length='+str(v['maxItems']))
            default=' = None' if optional else (' = Field('+','.join(bounds)+')' if bounds else '')
            python+=['    '+k+': '+p+default]
            ts+=['  '+k+': '+zod(v)+('.optional()' if optional else '')+',']
        ts+=['}).strict();']
    else:
        python+=[name+' = '+py(s)]
        ts+=['export const '+name+' = '+zod(s)+';']
    python+=['']
    ts+=['export type '+name+' = z.infer<typeof '+name+'>;','']
python+=['# END GENERATED COLLECTION MODELS','']
ts+=['// END GENERATED COLLECTION MODELS','']
for file,begin,end,block,marker,field in [('backend/schemas.py','# BEGIN GENERATED COLLECTION MODELS','# END GENERATED COLLECTION MODELS','\n'.join(python),'class Snapshot(WireModel):','    collection: SnapshotCollection = None\n'),('frontend/src/domain/types.ts','// BEGIN GENERATED COLLECTION MODELS','// END GENERATED COLLECTION MODELS','\n'.join(ts),'export const Snapshot = z.object({','  collection: SnapshotCollection.optional(),\n')]:
    path=ROOT/file
    value=path.read_text(encoding='utf-8')
    if begin in value: value=value[:value.index(begin)]+value[value.index(end)+len(end):].lstrip('\n')
    value=value.replace(marker,block+'\n'+marker)
    if field.strip() not in value: value=value.replace(marker+'\n',marker+'\n'+field)
    if file.endswith('.py') and 'class PageRefreshResponse(' not in value:
        value+='\n\nclass PageRefreshResponse(CollectionWire):\n    snapshot: Snapshot\n    receipt: PageRefreshReceipt\n'
    path.write_text(value,encoding='utf-8')
bridge=ROOT/'shared/src/bridge.ts'
value=bridge.read_text(encoding='utf-8')
start=value.index('const schemas:')
stop=value.index('\nexport const catalog')
value=value[:start]+'const schemas: Record<string, any> = '+json.dumps(schemas)+';'+value[stop:]
value=value.replace('export export function check(schema:', 'export function check(schema:')
value=value.replace('\nfunction check(schema:', '\nexport function check(schema:')
if 'export function validSchema(' not in value:
    value+='\nexport function validSchema(name: string, value: unknown): boolean { return !!schemas[name] && fits(value) && check(schemas[name],value); }\n'
bridge.write_text(value,encoding='utf-8')
