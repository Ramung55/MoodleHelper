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
        for course in snapshot['courses']:
            source = course.get('discovery',{}).get('sourceCourseId')
            if course['id'] in snapshot['settings']['trackedCourseIds'] and source:
                decimal(source)
                if any(c['sourceCourseId']==source for c in mapping): reject()
                mapping.append(dict(courseId=course['id'],sourceCourseId=source))
        revision = sha256(canonical([self.epoch, snapshot['settings']['trackedCourseIds'],mapping]).encode()).hexdigest()
        return dict(version='1',binding=self.binding,mode='synthetic' if self._enabled() else 'disabled',selectionRevision=revision,courses=mapping,
                    **({} if self._enabled() else {'reason':'collection_disabled'}))

    def context(self):
        with self.lock:
            return self._context(self.store.read())

    def begin(self, body):
        with self.lock:
            context = self.context()
            if context['mode']=='disabled' or body['selectionRevision']!=context['selectionRevision'] or not context['courses']: reject()
            for field in ['documentKey','visitId']:
                if not re.fullmatch(r'[A-Za-z0-9:._-]{1,256}',body[field]): reject()
            kind, page_id = route(body['pageUrl'])
            if kind=='course' and page_id not in [c['sourceCourseId'] for c in context['courses']]: reject()
            old = self.active.get(body['documentKey'])
            if old and self.tokens[old]['body']==body:
                return {'visitToken':old}
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
                    for fact in info['facts']:
                        if fact['location']!='quiz.attemptInformation.'+fact['field'] or not fact['rawText'].strip(): reject()
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
            identity=['calendar_event',item['sourceEventId'],item.get('sourceOccurrenceId')]
            if 'activity' in item:
                a=item['activity']; decimal(a['sourceActivityId']); decimal(a['sourceCourseModuleId'])
                if a['sourceUrl']!=f"{ORIGIN}/mod/{a['moduleType']}/view.php?id={a['sourceCourseModuleId']}": reject()
        else:
            module=item['sourceModuleType']; cm=item['sourceCourseModuleId']; decimal(cm)
            if pagekind not in ['course',module] or pagekind!='course' and pageid!=cm: reject()
            if item['sourceUrl']!=f'{ORIGIN}/mod/{module}/view.php?id={cm}': reject()
            if item['sourcePageUrl']!=page.split('#')[0]: reject()
            for key in ['sourceResourceId','sourceFileId','sourceFolderId','sourceContextId']:
                if key in item: decimal(item[key])
            parts=[ORIGIN,source,module,'module',cm]
            if 'sourceFileId' in item: parts=[ORIGIN,source,'folder',cm,'file',item['sourceFileId']]
            if 'sourceFolderId' in item: parts=[ORIGIN,source,'folder',cm,'folder',item['sourceFolderId']]
            if item['resourceKey']!=json.dumps(parts,separators=(',',':')): reject()
            for r in [item]+item['references']:
                if r['sourcePageUrl']!=item['sourcePageUrl'] or r['sourceUrl']!=item['sourceUrl']: reject()
                validate_instant(r['observedAt'],'observedAt')
                if 'destinationUrl' in r: safe_destination(r['destinationUrl'])
                if 'listingChildResourceKeys' in r:
                    if r.get('listingScope')!='supplied_listing_only': reject()
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
                current=self._context(snapshot)
                if current['selectionRevision']!=entry['revision'] or not self._enabled() or self.active.get(entry['body']['documentKey'])!=token: reject()
                mapping={c['sourceCourseId']:c['courseId'] for c in current['courses']}
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
                    candidate=review.get('candidate')
                    if candidate:
                        # Unassociated calendar reviews stay separate; never guess a course.
                        if review['kind']=='calendar':
                            validate_instant(candidate['observedAt'],'observedAt'); dates(candidate)
                            decimal(candidate['sourceEventId'])
                            expected=f"{ORIGIN}/calendar/view.php?event={candidate['sourceEventId']}"+('&occurrence='+candidate['sourceOccurrenceId'] if 'sourceOccurrenceId' in candidate else '')
                            if candidate['sourceUrl']!=expected: reject()
                            if candidate.get('sourceCourseId') and candidate['sourceCourseId'] not in mapping: reject()
                        else: self._validate_observation('material',candidate,page,mapping)
                    r=dict(id=canonical([entry['body']['visitId'],collector,index]),visitId=entry['body']['visitId'],collector=collector,reasons=review['reasons'])
                    if candidate: r['candidate']=deepcopy(candidate)
                    layer['reviews'].append(r)
                outcome='unavailable' if result['kind']=='unavailable' else 'failed' if result['kind']=='failed' else 'ok' if result['coverage']=='complete' else 'partial'
                receipt=dict(visitId=entry['body']['visitId'],pageUrl=page,observedAt=body['observedAt'],collector=collector,sourceCourseIds=sorted(courseids),outcome=outcome,coverage=result.get('coverage','none'),scope=result.get('scope','visited_activity_only'),reasons=result.get('reasons',[d['reason'] for d in result.get('diagnostics',[])]),evidenceMode='synthetic',pages=result.get('pages',[]))
                if activity: receipt['sourceActivityId']=activity
                if cm: receipt['sourceCourseModuleId']=cm
                layer['refreshes'].append(receipt)
            snapshot=self.store.mutate(apply)
            entry['receipts'][collector]=(signature,deepcopy(receipt))
            return dict(snapshot=snapshot,receipt=receipt)


def safe_destination(url):
    validate_url(url)
    if len(url)>4096 or re.search(r'(?:token|sesskey|password|authorization|signature|secret|credential)',url,re.I): reject()
    from urllib.parse import urlsplit, parse_qsl
    parsed=urlsplit(url)
    if parsed.hostname=='moodle.sdu.edu.kz':
        if not (re.fullmatch(r'/pluginfile\.php/[1-9][0-9]*/mod_(?:resource|folder)/content/[1-9][0-9]*/[^?#]+',parsed.path) and parsed.query in ['', 'forcedownload=1'] or
                re.fullmatch(r'/mod/(?:resource|url|folder)/view\.php',parsed.path) and re.fullmatch(r'id=[1-9][0-9]*(?:&folder=[1-9][0-9]*)?',parsed.query)): reject()
    elif any(k not in ['id','page','lang','v'] for k,v in parse_qsl(parsed.query)): reject()
