"""Bounded visited-page ingestion. No live identity provider is implemented.

Only the isolated integration harness injects SyntheticCollectionContext. HTTP
clients cannot select a namespace, enable collection or supply a confirmation.
"""
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
import json
import re
from threading import RLock
from uuid import uuid4

from backend import schemas as s
from backend.domain_validation import validate_instant, validate_date, validate_url
from backend.identity import MOODLE_ORIGIN as ORIGIN, validate_namespace
from backend.submission_retention import SubmissionRecord, retain_submission, _instant


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


@dataclass(frozen=True)
class SyntheticCollectionContext:
    """Explicit service injection for labeled, isolated SQLite harnesses only."""
    namespace: str
    enabled: bool = True


class CollectionRejected(ValueError):
    pass


def reject():
    raise CollectionRejected('Collection context or evidence is invalid. Reconnect.')


def route(url):
    if not isinstance(url, str) or len(url) > 4096:
        reject()
    m = re.fullmatch(re.escape(ORIGIN)+r'/(course|mod/(assign|quiz|resource|url|folder))/view\.php\?id=([1-9][0-9]*)(?:#([A-Za-z0-9_-]{1,128}))?', url)
    if m:
        return (m[2] or 'course', m[3])
    if re.fullmatch(re.escape(ORIGIN)+r'/calendar/view\.php(?:\?(?:view=(?:month|day|upcoming)(?:&time=[1-9][0-9]*)?|event=[1-9][0-9]*(?:&occurrence=[1-9][0-9]*)?|course=[1-9][0-9]*))?(?:#[A-Za-z0-9_-]{1,128})?', url):
        return ('calendar', None)
    reject()


def bounded(value, depth=0):
    if depth > 24: reject()
    if isinstance(value, str) and len(value) > 8192: reject()
    if isinstance(value, list):
        if len(value) > 512: reject()
        for item in value: bounded(item, depth+1)
    if isinstance(value, dict):
        for item in value.values(): bounded(item, depth+1)


def dates(value):
    if isinstance(value, dict):
        if 'value' in value and isinstance(value['value'], dict) and 'kind' in value['value']:
            if 'rawText' in value: validate_date(value['value'])
        for child in value.values(): dates(child)
    elif isinstance(value, list):
        for child in value: dates(child)


def decimal(value):
    if not isinstance(value,str) or not re.fullmatch(r'[1-9][0-9]*', value): reject()


class CollectionService:
    def __init__(self, store, binding, provider=None):
        self.store, self.binding, self.provider = store, binding, provider
        self.lock = RLock()
        self.epoch = 0
        self.tokens = OrderedDict()
        self.active = {}

    def invalidate(self):
        with self.lock:
            self.epoch += 1
            self.tokens.clear()
            self.active.clear()

    def _enabled(self):
        # Deliberately no configured or caller-controlled live identity switch.
        from backend.sqlite_store import SQLiteStore
        return (isinstance(self.store, SQLiteStore) and isinstance(self.provider, SyntheticCollectionContext)
                and self.provider.enabled and self.provider.namespace == self.store.namespace)

    def _context(self, snapshot):
        mapping = []
        all_sources=[c.get('discovery',{}).get('sourceCourseId') for c in snapshot['courses']]
        for course in snapshot['courses']:
            source = course.get('discovery',{}).get('sourceCourseId')
            if course['id'] in snapshot['settings']['trackedCourseIds'] and source:
                decimal(source)
                if all_sources.count(source)!=1: reject()
                if any(c['sourceCourseId']==source for c in mapping): reject()
                mapping.append(dict(courseId=course['id'],sourceCourseId=source))
        revision = sha256(canonical([self.epoch,id(self.provider),snapshot['settings']['trackedCourseIds'],mapping]).encode()).hexdigest()
        return dict(version='1',binding=self.binding,mode='synthetic' if self._enabled() else 'disabled',selectionRevision=revision,courses=mapping,
                    **({} if self._enabled() else {'reason':'collection_disabled'}))

    def context(self):
        with self.lock:
            return self._context(self.store.read())

    def begin(self, body):
        with self.lock:
            snapshot=self.store.read()
            context = self._context(snapshot)
            if context['mode']=='disabled' or body['selectionRevision']!=context['selectionRevision'] or not context['courses']: reject()
            for field in ['documentKey','visitId']:
                if not re.fullmatch(r'[A-Za-z0-9:._-]{1,256}',body[field]): reject()
            kind, page_id = route(body['pageUrl'])
            if kind=='course' and page_id not in [c['sourceCourseId'] for c in context['courses']]: reject()
            old = self.active.get(body['documentKey'])
            if old and self.tokens[old]['body']==body:
                return {'visitToken':old}
            if any(e['body']['visitId']==body['visitId'] for e in self.tokens.values()) or any(r['visitId']==body['visitId'] for r in snapshot.get('collection',{}).get('refreshes',[])): reject()
            token = uuid4().hex
            self.tokens[token] = dict(body=deepcopy(body),revision=context['selectionRevision'],receipts={})
            self.active[body['documentKey']]=token
            while len(self.tokens)>128:
                retired, entry = self.tokens.popitem(last=False)
                if self.active.get(entry['body']['documentKey'])==retired: self.active.pop(entry['body']['documentKey'])
            return {'visitToken':token}

    def _validate_observation(self, kind, raw, page, mapping):
        item=raw['attempted'] if kind=='submission' and 'attempted' in raw else raw
        time=item['observation']['observedAt'] if kind=='submission' else item['observedAt']
        validate_instant(time,'observedAt')
        dates(item)
        source=item['sourceCourseId']
        decimal(source)
        if source not in mapping: reject()
        pagekind,pageid=route(page)
        if pagekind=='course' and source!=pageid: reject()
        if kind in ['assignment','quiz','submission']:
            for key in ['sourceActivityId','sourceCourseModuleId']: decimal(item[key])
            module='quiz' if kind=='quiz' else 'assign'
            if item['sourceUrl']!=f"{ORIGIN}/mod/{module}/view.php?id={item['sourceCourseModuleId']}": reject()
            if pagekind!=module or pageid!=item['sourceCourseModuleId']: reject()
            identity=[kind,source,module,item['sourceActivityId']]
            if kind=='assignment':
                effective=deepcopy(item['baseDates'])
                seen=set()
                for field,date in item['baseDates'].items():
                    if date['location']!=f'assignment.base.{field}': reject()
                for ext in item['individualExtensions']:
                    field=ext['field']
                    if field in seen or not ext['evidence'].strip() or ext['date']['location']!=f'assignment.individual.{field}': reject()
                    seen.add(field); effective[field]=ext['date']
                if effective!=item['effectiveDates']: reject()
            if kind=='quiz':
                for field in ['opening','closing']:
                    if field in item and item[field]['location']!='quiz.'+field: reject()
                info=item['attemptInformation']
                if info['kind']=='known':
                    info['facts']=list({canonical(f):f for f in info['facts']}.values())
                    for fact in info['facts']:
                        if fact['location']!='quiz.attemptInformation.'+fact['field'] or not fact['rawText'].strip() or re.search(r'[<>\x00-\x1f]',fact['rawText']) or unsafe_label(fact['rawText']): reject()
                    complement=sorted(set(['state','allowed','used','remaining','other'])-{f['field'] for f in info['facts']})
                    if info['unknownFields']!=complement: reject()
        elif kind=='calendar':
            decimal(item['sourceEventId'])
            for key in ['sourceOccurrenceId','sourceSeriesId']:
                if key in item: decimal(item[key])
            if ('sourceOccurrenceId' in item)!=('sourceSeriesId' in item): reject()
            expected=f"{ORIGIN}/calendar/view.php?event={item['sourceEventId']}"+('&occurrence='+item['sourceOccurrenceId'] if 'sourceOccurrenceId' in item else '')
            if item['sourceUrl']!=expected or pagekind!='calendar': reject()
            if not any(k in item for k in ['start','end','date']): reject()
            if 'date' in item and ('start' in item or 'end' in item): reject()
            for field in ['start','end','date']:
                if field in item:
                    d=item[field]
                    if d['location']!='calendar.'+field or d['value']['kind'] not in ['exact','date'] or field=='date' and d['value']['kind']!='date': reject()
            if 'start' in item and 'end' in item:
                start,end=item['start']['value'],item['end']['value']
                if start['kind']==end['kind']=='exact' and _instant(end['iso'])<_instant(start['iso']): reject()
                if start['kind']==end['kind']=='date' and end['date']<start['date']: reject()
            identity=['calendar_event',item['sourceEventId'],item.get('sourceOccurrenceId')]
            if 'activity' in item:
                validate_calendar_activity(item['activity'])
        else:
            module=item['sourceModuleType']; cm=item['sourceCourseModuleId']; decimal(cm)
            if pagekind not in ['course',module] or pagekind!='course' and pageid!=cm: reject()
            if item['sourceUrl']!=f'{ORIGIN}/mod/{module}/view.php?id={cm}': reject()
            if item['sourcePageUrl']!=page.split('#')[0]: reject()
            for key in ['sourceResourceId','sourceFileId','sourceFolderId','sourceContextId']:
                if key in item: decimal(item[key])
            for key in ['title','section']:
                if item[key]['kind']=='known' and (not item[key]['value'].strip() or unsafe_label(item[key]['value'])): reject()
            if item['mimeType']['kind']=='known' and not safe_mime(item['mimeType']['value']): reject()
            type_evidence=[]
            if item['fileType']['kind']=='known': type_evidence.append(item['fileType']['value'])
            if item['mimeType']['kind']=='known':
                mime=item['mimeType']['value']
                inferred={'application/pdf':'pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx'}.get(mime,'video' if mime.startswith('video/') else 'other')
                type_evidence.append(inferred)
            if item['kind']=='link': type_evidence.append('link')
            if item['fileType']['kind']=='known' and len(set(type_evidence))>1: reject()
            parts=[ORIGIN,source,module,'module',cm]
            if 'sourceFileId' in item: parts=[ORIGIN,source,'folder',cm,'file',item['sourceFileId']]
            if 'sourceFolderId' in item: parts=[ORIGIN,source,'folder',cm,'folder',item['sourceFolderId']]
            if item['resourceKey']!=json.dumps(parts,separators=(',',':')): reject()
            if 'parentResourceKey' in item:
                parent=json.loads(item['parentResourceKey'])
                root=[ORIGIN,source,'folder','module',cm]
                if module!='folder' or not (parent==root or len(parent)==6 and parent[:4]==[ORIGIN,source,'folder',cm] and parent[4]=='folder'): reject()
                if len(parent)==6: decimal(parent[5])
            if ('sourceFileId' in item or 'sourceFolderId' in item)!=('parentResourceKey' in item): reject()
            expected_kind='file' if 'sourceFileId' in item else 'folder' if 'sourceFolderId' in item or module=='folder' else 'link' if module=='url' else 'file'
            if item['kind']!=expected_kind: reject()
            for r in [item]+item['references']:
                if r['sourcePageUrl']!=item['sourcePageUrl'] or r['sourceUrl']!=item['sourceUrl']: reject()
                validate_instant(r['observedAt'],'observedAt')
                if 'destinationUrl' in r: safe_destination(r['destinationUrl'],module=module,cm=cm,folder=item.get('sourceFolderId'),file=item.get('sourceFileId'),context=item.get('sourceContextId'))
                if 'listingChildResourceKeys' in r:
                    if r.get('listingScope')!='supplied_listing_only': reject()
                    if len(r['listingChildResourceKeys'])!=len(set(r['listingChildResourceKeys'])): reject()
                    for child in r['listingChildResourceKeys']:
                        parsed=json.loads(child)
                        if len(parsed)!=6 or parsed[:4]!=[ORIGIN,source,'folder',cm] or parsed[4] not in ['file','folder']: reject()
                        decimal(parsed[5])
            identity=['material',item['resourceKey']]
        return canonical(validate_namespace(self.store.namespace)+identity), mapping[source], time

    def refresh(self, body):
        bounded(body)
        if len(canonical(body).encode())>1024*1024: reject()
        with self.lock:
            token=body['visitToken']; entry=self.tokens.get(token)
            if not entry or self.active.get(entry['body']['documentKey'])!=token: reject()
            if not self._enabled(): reject()
            collector=body['collector']; result=body['result']; signature=canonical(body)
            if result['kind'] not in [collector,'failed','unavailable']: reject()
            context=self.context()
            if context['selectionRevision']!=entry['revision']: reject()
            if collector in entry['receipts']:
                previous=entry['receipts'][collector]
                if previous[0]!=signature: reject()
                return {'snapshot':self.store.read(),'receipt':deepcopy(previous[1])}
            validate_instant(body['observedAt'],'observedAt')
            page=entry['body']['pageUrl']; pagekind,_=route(page)
            if collector not in {'assign':['assignment','submission'],'quiz':['quiz'],'calendar':['calendar'],'course':['material'],'resource':['material'],'url':['material'],'folder':['material']}[pagekind]: reject()
            receipt={}
            def apply(snapshot):
                nonlocal receipt
                if self.active.get(entry['body']['documentKey'])!=token: reject()
                receipt=self._merge_refresh(snapshot, entry, body)
            snapshot=self.store.mutate(apply)
            entry['receipts'][collector]=(signature,deepcopy(receipt))
            return dict(snapshot=snapshot,receipt=receipt)

    def _merge_refresh(self, snapshot, entry, body):
        """Apply collector evidence within the caller-owned transaction."""
        collector=body['collector']; result=body['result']
        page=entry['body']['pageUrl']
        current=self._context(snapshot)
        if current['selectionRevision']!=entry['revision'] or not self._enabled(): reject()
        mapping={c['sourceCourseId']:c['courseId'] for c in current['courses']}
        from datetime import date
        for page_facts in result.get('pages',[]):
            if 'range' in page_facts:
                start=date.fromisoformat(page_facts['range']['start']); end=date.fromisoformat(page_facts['range']['end'])
                if end<start or collector!='calendar': reject()
        layer=snapshot.setdefault('collection',dict(records=[],reviews=[],refreshes=[]))
        observations=result.get('observations',[])
        courseids=set(); activity=None; cm=None
        for raw in observations:
            identity,course,time=self._validate_observation(collector,raw,page,mapping)
            item=raw
            record=next((r for r in layer['records'] if r['id']==identity),None)
            if collector=='submission':
                def wrapper(v):
                    return SubmissionRecord(v['sourceCourseId'],v['sourceActivityId'],v['sourceCourseModuleId'],v['sourceUrl'],s.SubmissionObservation.model_validate(v['observation']))
                previous=None
                if record:
                    for evidence in record['observations']:
                        confirmed=evidence.get('confirmed')
                        if confirmed and (previous is None or _instant(confirmed['observation']['observedAt'])>_instant(previous['observation']['observedAt'])): previous=confirmed
                reduced=retain_submission(wrapper(raw),wrapper(previous) if previous else None)
                if not reduced.ok: reject()
                item={'attempted':raw,'stale':reduced.stale}
                if reduced.confirmed:
                    c=reduced.confirmed
                    item['confirmed']=dict(sourceCourseId=c.course_id,sourceActivityId=c.activity_id,sourceCourseModuleId=c.module_id,sourceUrl=c.source_url,observation=c.observation.model_dump(exclude_none=True))
            courseids.add(raw['sourceCourseId'])
            activity=raw.get('sourceActivityId',activity); cm=raw.get('sourceCourseModuleId',cm)
            if record is None:
                record=dict(id=identity,courseId=course,kind=collector,firstObservedAt=time,lastObservedAt=time,observations=[])
                layer['records'].append(record)
            if canonical(item) not in [canonical(x) for x in record['observations']]: record['observations'].append(deepcopy(item))
            if _instant(time)>_instant(record['lastObservedAt']): record['lastObservedAt']=time
        for index,review in enumerate(result.get('reviews',[])):
            if review['kind']!=collector or collector not in ['calendar','material']: reject()
            candidate=review.get('candidate')
            if candidate:
                # Unassociated calendar reviews stay separate; never guess a course.
                if review['kind']=='calendar':
                    validate_instant(candidate['observedAt'],'observedAt'); dates(candidate)
                    decimal(candidate['sourceEventId'])
                    expected=f"{ORIGIN}/calendar/view.php?event={candidate['sourceEventId']}"+('&occurrence='+candidate['sourceOccurrenceId'] if 'sourceOccurrenceId' in candidate else '')
                    if candidate['sourceUrl']!=expected: reject()
                    if candidate.get('sourceCourseId') and candidate['sourceCourseId'] not in mapping: reject()
                    if 'activity' in candidate: validate_calendar_activity(candidate['activity'])
                    for field in ['sourceOccurrenceId','sourceSeriesId']:
                        if field in candidate: decimal(candidate[field])
                    if ('sourceOccurrenceId' in candidate)!=('sourceSeriesId' in candidate): reject()
                else: self._validate_observation('material',candidate,page,mapping)
            r=dict(id=canonical([entry['body']['visitId'],collector,index]),visitId=entry['body']['visitId'],collector=collector,reasons=review['reasons'])
            if candidate: r['candidate']=deepcopy(candidate)
            layer['reviews'].append(r)
        outcome='unavailable' if result['kind']=='unavailable' else 'failed' if result['kind']=='failed' else 'ok' if result['coverage']=='complete' else 'partial'
        receipt=dict(visitId=entry['body']['visitId'],pageUrl=page,observedAt=body['observedAt'],collector=collector,sourceCourseIds=sorted(courseids),outcome=outcome,coverage=result.get('coverage','none'),scope=result.get('scope','visited_activity_only'),reasons=result.get('reasons',[d['reason'] for d in result.get('diagnostics',[])]),evidenceMode='synthetic',pages=result.get('pages',[]))
        if activity: receipt['sourceActivityId']=activity
        if cm: receipt['sourceCourseModuleId']=cm
        layer['refreshes'].append(receipt)
        # Fail inside the transaction, never commit a reply the fixed
        # worker transport cannot acknowledge without truncating facts.
        if len(canonical({'snapshot':snapshot,'receipt':receipt}).encode())>1024*1024: reject()
        return receipt


def validate_calendar_activity(a):
    decimal(a['sourceActivityId']); decimal(a['sourceCourseModuleId'])
    if a['moduleType'] not in ['assign','quiz'] or a['sourceUrl']!=f"{ORIGIN}/mod/{a['moduleType']}/view.php?id={a['sourceCourseModuleId']}": reject()


def unsafe_label(value):
    return bool(re.search(r'[A-Za-z][A-Za-z0-9+.-]*://|(?:^|\s)(?:javascript:|data:|file:|mailto:|//|/course/|/mod/|/pluginfile\.php/)',value,re.I))


def private_part(value):
    return bool(re.search(r'(?:^|[._~-])(?:token|access|sesskey|auth|authorization|key|api|signature|secret|password|credential|bearer)(?:$|[._~-])|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32}',value,re.I))


def filename(value):
    import unicodedata
    from urllib.parse import unquote,quote
    decoded=unquote(value,errors='strict')
    if not decoded or decoded in ['.','..'] or quote(decoded,safe="~!*'()-._")!=value or private_part(decoded): return False
    if any(unicodedata.category(c)[0] not in ['L','M','N'] and c not in " ._~!$&'()+,;=@-" for c in decoded): return False
    return not re.search(r'(?:^|[ ._~!$&\'()+,;=@-])(?:token|access|sesskey|auth|authorization|key|api|signature|secret|password|credential|bearer)(?:$|[ ._~!$&\'()+,;=@-])',decoded,re.I)


def safe_mime(value):
    trusted=['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.presentationml.presentation']
    return value in trusted or len(value)<=127 and re.fullmatch(r'[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*',value) and all(not private_part(p) for p in value.split('/'))


def safe_destination(url, *, module, cm, folder=None, file=None, context=None):
    validate_url(url)
    if len(url)>4096 or re.search(r'[\s\\\x00-\x1f\x7f]',url): reject()
    from urllib.parse import urlsplit
    parsed=urlsplit(url)
    if parsed.port or not url.startswith('https://'+parsed.netloc+'/') or parsed.netloc!=parsed.netloc.lower(): reject()
    # Child folders use #17's safeFolder boundary before any generic root/file
    # handling. Even a valid mod_folder pluginfile URL cannot identify a folder.
    if folder:
        if file or module!='folder' or url!=f'{ORIGIN}/mod/folder/view.php?id={cm}&folder={folder}': reject()
        return
    if parsed.hostname=='moodle.sdu.edu.kz':
        if parsed.fragment: reject()
        match=re.fullmatch(r'/pluginfile\.php/([1-9][0-9]*)/mod_(resource|folder)/content/[1-9][0-9]*/([^?#]+)',parsed.path)
        if match:
            if match[2]!=module or context and context!=match[1] or parsed.query not in ['', 'forcedownload=1'] or not all(filename(x) for x in match[3].split('/')): reject()
        else:
            # A destination is a link target, not the source module identity.
            # #17 accepts any canonical course/material activity target for a
            # root module. Folder file children remain pluginfile-only, and
            # folder children above retain their exact parent-module binding.
            if file or not re.fullmatch(re.escape(ORIGIN)+r'/(?:course|mod/(?:resource|url|folder))/view\.php\?id=[1-9][0-9]*',url): reject()
    else:
        if file or folder: reject()
        if parsed.path!='/' and not all(filename(v) for v in parsed.path[1:].removesuffix('/').split('/')): reject()
        seen=set()
        if '?' in url.split('#')[0]:
            for part in parsed.query.split('&'):
                m=re.fullmatch(r'(id|page|lang|v)=([A-Za-z0-9._~-]+)',part)
                if not m or m[1] in seen or private_part(m[2]): reject()
                seen.add(m[1])
        if '#' in url and (not re.fullmatch(r'[A-Za-z0-9._~-]+',parsed.fragment) or private_part(parsed.fragment)): reject()
