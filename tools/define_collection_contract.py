"""One-time #18 source-contract authoring; models are generated separately."""
from pathlib import Path
import yaml

P = Path(__file__).resolve().parents[1] / 'openapi.yaml'
doc = yaml.safe_load(P.read_text(encoding='utf-8'))
S = doc['components']['schemas']
ref = lambda n: {'$ref': '#/components/schemas/' + n}
text = {'type': 'string'}
boolean = {'type': 'boolean'}
integer = {'type': 'integer'}
enum = lambda *v: {'type': 'string', 'enum': list(v)}
lit = lambda v: {'type': 'string', 'const': v}
arr = lambda v, minimum=0: {'type':'array','items':v, **({'minItems':minimum} if minimum else {})}
union = lambda *v: {'oneOf': [ref(x) for x in v]}
def obj(name, fields, optional=()):
    S[name] = {'type':'object','additionalProperties':False,'properties':fields,'required':[k for k in fields if k not in optional]}
    if not S[name]['required']: S[name].pop('required')
    return ref(name)

obj('CollectedDateObservation',dict(value=ref('DateValue'),rawText=text,location=text))
obj('AssignmentDates',{k:ref('CollectedDateObservation') for k in ['opening','due','cutoff']},['opening','due','cutoff'])
obj('IndividualExtension',dict(field=enum('opening','due','cutoff'),date=ref('CollectedDateObservation'),evidence=text,scope=lit('individual')))
ids=dict(sourceCourseId=text,sourceActivityId=text,sourceCourseModuleId=text,sourceUrl=text)
obj('RawAssignmentObservation',dict(**ids,title=text,observedAt=text,baseDates=ref('AssignmentDates'),individualExtensions=arr(ref('IndividualExtension')),effectiveDates=ref('AssignmentDates')))
obj('CalendarActivity',dict(moduleType=enum('assign','quiz'),sourceActivityId=text,sourceCourseModuleId=text,sourceUrl=text))
cal=dict(sourceEventId=text,sourceOccurrenceId=text,sourceSeriesId=text,sourceCourseId=text,title=text,sourceUrl=text,observedAt=text,start=ref('CollectedDateObservation'),end=ref('CollectedDateObservation'),date=ref('CollectedDateObservation'),activity=ref('CalendarActivity'))
opt=['sourceOccurrenceId','sourceSeriesId','sourceCourseId','start','end','date','activity']
obj('CalendarCandidate',cal,opt)
obj('RawCalendarObservation',cal,[x for x in opt if x!='sourceCourseId'])
for name, value in [('CollectedKnownString',text),('CollectedKnownFileType',enum('pdf','docx','pptx','link','video','other'))]:
    obj(name,dict(kind=lit('known'),value=value))
obj('CollectedUnknown',dict(kind=lit('unknown')))
meta=union('CollectedKnownString','CollectedUnknown')
coverage=enum('complete','partial','none')
reference=dict(sourcePageUrl=text,sourceUrl=text,destinationUrl=text,observedAt=text,location=enum('course.material','activity.material','folder.entry'),listingScope=enum('reference_only','supplied_listing_only'),listingCoverage=coverage,listingChildResourceKeys=arr(text))
refopt=['destinationUrl','listingScope','listingCoverage','listingChildResourceKeys']
obj('MaterialReference',reference,refopt)
obj('RawMaterialObservation',dict(**reference,sourceCourseId=text,sourceCourseModuleId=text,sourceModuleType=enum('resource','url','folder'),sourceResourceId=text,sourceFileId=text,sourceFolderId=text,sourceContextId=text,resourceKey=text,parentResourceKey=text,kind=enum('file','link','folder'),title=meta,section=meta,fileType=union('CollectedKnownFileType','CollectedUnknown'),mimeType=meta,references=arr(ref('MaterialReference'))),refopt+['sourceResourceId','sourceFileId','sourceFolderId','sourceContextId','parentResourceKey'])
fields=['state','allowed','used','remaining','other']
obj('QuizAttemptFact',dict(field=enum(*fields),rawText=text,location=enum(*['quiz.attemptInformation.'+x for x in fields])))
obj('QuizKnownAttempts',dict(kind=lit('known'),facts=arr(ref('QuizAttemptFact'),1),unknownFields=arr(enum(*fields))))
obj('RawQuizObservation',dict(**ids,title=text,observedAt=text,opening=ref('CollectedDateObservation'),closing=ref('CollectedDateObservation'),attemptInformation=union('QuizKnownAttempts','CollectedUnknown')),['opening','closing'])
obj('SubmissionSourceRecord',dict(**ids,observation=ref('SubmissionObservation')))
obj('RetainedSubmission',dict(attempted=ref('SubmissionSourceRecord'),confirmed=ref('SubmissionSourceRecord'),stale=boolean),['confirmed'])
collectors=['assignment','calendar','material','quiz','submission']
reason_values='collector_unavailable collection_disabled envelope_unavailable access_error collector_failed persistence_failed invalid_context invalid_selection invalid_identity unsupported_page malformed_result invalid_observed_at invalid_batch_arguments invalid_page malformed_record empty_marker site_event personal_event non_assessment unselected_course unknown_kind missing_course unreliable_course unknown_date missing_dates event_conflict invalid_selection unsupported_structure identity_mismatch missing_identity malformed_candidate unsafe_url unsafe_external_url missing_metadata type_conflict invalid_mime unsafe_label field_conflict parent_conflict pagination_pending incomplete_list empty_unconfirmed empty_conflict folder_contents_uninspected listing_conflict invalid_date unsupported_date duplicate_date malformed_assignment incomplete_assignment'.split()
reasons=arr(enum(*dict.fromkeys(reason_values)))
obj('CalendarSafeReview',dict(kind=lit('calendar'),candidate=ref('CalendarCandidate'),reasons=reasons))
obj('MaterialSafeReview',dict(kind=lit('material'),candidate=ref('RawMaterialObservation'),reasons=reasons),['candidate'])
obj('CollectionReview',dict(id=text,visitId=text,collector=enum(*collectors),reasons=reasons,candidate=union('CalendarCandidate','RawMaterialObservation')),['candidate'])
obj('CollectionDiagnostic',dict(reason=enum(*dict.fromkeys(reason_values)),pageIndex=integer,recordIndex=integer),['recordIndex'])
obj('CollectionRange',dict(start=text,end=text))
obj('CollectionPage',dict(coverage=coverage,candidateCount=integer,paginationPending=boolean,range=ref('CollectionRange'),pageIndex=integer),['range','pageIndex'])
for kind,raw in zip(collectors,['RawAssignmentObservation','RawCalendarObservation','RawMaterialObservation','RawQuizObservation','SubmissionSourceRecord']):
    obj(kind.title()+'RefreshResult',dict(kind=lit(kind),observations=arr(ref(raw)),reviews=arr(union('CalendarSafeReview','MaterialSafeReview')),diagnostics=arr(ref('CollectionDiagnostic')),pages=arr(ref('CollectionPage')),coverage=coverage,scope=enum('visited_activity_only','supplied_pages_only','supplied_ranges_only')))
    persisted='RetainedSubmission' if kind=='submission' else raw
    obj('Normalized'+kind.title()+'Record',dict(id=text,courseId=text,kind=lit(kind),firstObservedAt=text,lastObservedAt=text,observations=arr(ref(persisted),1)))
obj('UnavailableRefreshResult',dict(kind=lit('unavailable'),reasons=reasons))
obj('FailedRefreshResult',dict(kind=lit('failed'),reasons=reasons))
S['CollectorResult']=union(*[k.title()+'RefreshResult' for k in collectors],'UnavailableRefreshResult','FailedRefreshResult')
S['NormalizedSourceRecord']=union(*['Normalized'+k.title()+'Record' for k in collectors])
obj('PageRefreshReceipt',dict(visitId=text,pageUrl=text,observedAt=text,collector=enum(*collectors),sourceCourseIds=arr(text),sourceActivityId=text,sourceCourseModuleId=text,outcome=enum('ok','partial','failed','unavailable'),coverage=coverage,scope=enum('visited_activity_only','supplied_pages_only','supplied_ranges_only'),reasons=reasons,evidenceMode=enum('synthetic','verified'),pages=arr(ref('CollectionPage'))),['sourceActivityId','sourceCourseModuleId'])
obj('SnapshotCollection',dict(records=arr(ref('NormalizedSourceRecord')),reviews=arr(ref('CollectionReview')),refreshes=arr(ref('PageRefreshReceipt'))))
S['Snapshot']['properties']['collection']=ref('SnapshotCollection')
obj('CollectionCourse',dict(courseId=text,sourceCourseId=text))
obj('CollectionContext',dict(version=lit('1'),binding=text,mode=enum('disabled','synthetic','verified'),selectionRevision=text,courses=arr(ref('CollectionCourse')),reason=enum('collection_disabled','invalid_context','invalid_selection')),['reason'])
obj('BeginPageVisit',dict(documentKey=text,visitId=text,pageUrl=text,selectionRevision=text))
obj('PageVisitToken',dict(visitToken=text))
obj('PageRefreshInput',dict(visitToken=text,observedAt=text,collector=enum(*collectors),result=ref('CollectorResult')))
obj('PageRefreshResponse',dict(snapshot=ref('Snapshot'),receipt=ref('PageRefreshReceipt')))
for method,path,operation,request,response in [('get','/api/collection-context','collectionContext',None,'CollectionContext'),('post','/api/collection/visits','beginPageVisit','BeginPageVisit','PageVisitToken'),('post','/api/collection/refresh','ingestPageRefresh','PageRefreshInput','PageRefreshResponse')]:
    op=dict(operationId=operation,tags=['Collection'],security=[],responses={'200':{'description':'Collection result','content':{'application/json':{'schema':ref(response)}}}})
    for code in ['default','422','409']:
        op['responses'][code]={'description':'Safe collection error','content':{'application/json':{'schema':ref('ProposedHttpError')}}}
    if request:
        op['requestBody']={'required':True,'content':{'application/json':{'schema':ref(request)}}}
        op['parameters']=[{'name':'X-Moodle-Helper-Bridge-Binding','in':'header','required':True,'schema':{'type':'string'},'description':'Required process binding for collection writes.'}]
    doc['paths'][path]={method:op}
P.write_text(yaml.safe_dump(doc,sort_keys=False,allow_unicode=True),encoding='utf-8')
