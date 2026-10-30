"""HTTP binding: business logic lives in services, state in the repository."""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, Request, HTTPException, Header

from backend import schemas as s
from backend.services import BackendService


def service(request: Request) -> BackendService:
    return request.app.state.service


Service = Annotated[BackendService, Depends(service)]


def bridge_header(binding: Annotated[str, Header(alias="X-Moodle-Helper-Bridge-Binding", description="Optional process binding precondition. Absence preserves legacy clients; mismatch rejects before parsing or service work.")] = None):
    # Enforcement is middleware, before parsing; dependency documents the wire.
    pass
# Each operation declares response models; documentation is generated from the
# actual handlers/models rather than returning a copy of the source document.
router = APIRouter(prefix="/api", dependencies=[Depends(bridge_header)], responses={"default": {"model": s.ProposedHttpError}, 422: {"model": s.ProposedHttpError}, 409: {"model": s.ProposedHttpError}})


context_router = APIRouter(prefix="/api", responses={"default": {"model": s.ProposedHttpError}, 422: {"model": s.ProposedHttpError}})


@context_router.get('/local-context', response_model=s.LocalContext, operation_id='localContext', tags=['Local data'])
def local_context(request: Request):
    if request.query_params:
        raise HTTPException(status_code=422, detail='This endpoint accepts no selectors.')
    return {'datasetId': request.app.state.service.store.dataset_id}


@router.post('/syllabus-suggestions/dismissal', response_model=s.Snapshot, response_model_exclude_none=True, operation_id='setSyllabusSuggestionDismissal', tags=['Syllabus'])
def set_syllabus_suggestion_dismissal(body: s.SyllabusSuggestionDismissal, api: Service):
    try:
        return api.set_syllabus_suggestion_dismissal(body.recordId, body.dismissed)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@context_router.get("/bridge-context", response_model=s.BridgeContext, operation_id="bridgeContext", tags=["Connection"])
def bridge_context(request: Request):
    return {"version": "1", "binding": request.app.state.bridge_binding}


@context_router.get('/collection-context', response_model=s.CollectionContext, response_model_exclude_none=True, operation_id='collectionContext', tags=['Collection'])
def collection_context(request: Request):
    return request.app.state.collection.context()


def collection_binding(binding: Annotated[str, Header(alias='X-Moodle-Helper-Bridge-Binding', description='Required process binding for collection writes.')]):
    pass


collection_router = APIRouter(prefix='/api/collection', dependencies=[Depends(collection_binding)], responses={'default': {'model':s.ProposedHttpError},422:{'model':s.ProposedHttpError},409:{'model':s.ProposedHttpError}})


def local_syllabus_binding(binding: Annotated[str, Header(alias='X-Moodle-Helper-Bridge-Binding', description='Required current process binding from /api/bridge-context.')]):
    pass


local_syllabus_router = APIRouter(prefix='/api/local-syllabus', dependencies=[Depends(local_syllabus_binding)], responses={'default': {'model': s.ProposedHttpError}, 422: {'model': s.ProposedHttpError}, 409: {'model': s.ProposedHttpError}})


@local_syllabus_router.post('/route', response_model=s.LocalSyllabusResult, response_model_exclude_none=True, operation_id='routeLocalSyllabus', tags=['Documents'])
def route_local_syllabus(body: s.LocalSyllabusInput, api: Service, request: Request):
    from backend.local_syllabus import route
    from backend.reconciliation import ReconciliationConflict
    if request.query_params:
        raise HTTPException(status_code=422, detail='This endpoint accepts no selectors.')
    try:
        return route(api, wire(body))
    except ReconciliationConflict:
        raise
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@collection_router.post('/visits', response_model=s.PageVisitToken, operation_id='beginPageVisit', tags=['Collection'])
def begin_page_visit(body: s.BeginPageVisit, request: Request):
    return request.app.state.collection.begin(wire(body))


@collection_router.post('/refresh', response_model=s.PageRefreshResponse, response_model_exclude_none=True, operation_id='ingestPageRefresh', tags=['Collection'])
def ingest_page_refresh(body: s.PageRefreshInput, request: Request):
    try:
        return request.app.state.collection.refresh(wire(body))
    except ValueError:
        from backend.collection import CollectionRejected
        raise CollectionRejected() from None


def wire(model: s.WireModel) -> dict:
    return model.model_dump(by_alias=True, exclude_unset=True, exclude_none=True)


@router.get("/connection", response_model=s.ConnectionInfo, operation_id="connection", tags=["Connection"])
def connection(api: Service):
    return api.connection()


@router.post('/reconciliation/pairs', response_model=s.Snapshot, response_model_exclude_none=True, operation_id='proposeReconciliationPair', tags=['Assessments'])
def propose_reconciliation(body: s.ReconciliationSelection, api: Service):
    try:
        return api.propose_reconciliation(wire(body))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post('/syllabus-revisions/preview', response_model=s.SyllabusRevisionPreview, operation_id='previewSyllabusRevision', tags=['Assessments'])
def preview_syllabus_revision(body: s.SyllabusRevisionSelection, api: Service):
    return api.preview_syllabus_revision(wire(body))


@router.post('/syllabus-revisions/confirm', response_model=s.Snapshot, response_model_exclude_none=True, operation_id='confirmSyllabusRevision', tags=['Assessments'])
def confirm_syllabus_revision(body: s.SyllabusRevisionDecision, api: Service):
    return api.confirm_syllabus_revision(wire(body))


@router.post('/reconciliation/decisions', response_model=s.Snapshot, response_model_exclude_none=True, operation_id='decideReconciliationPair', tags=['Assessments'])
def decide_reconciliation(body: s.ReconciliationDecision, api: Service):
    try:
        return api.decide_reconciliation(wire(body))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/snapshot", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="load", tags=["Snapshot"])
def load(api: Service):
    return api.load()


@router.put("/snapshot", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="replaceAll", tags=["Snapshot"])
def replace_all(body: s.Snapshot, api: Service):
    return api.replace_all(wire(body))


@router.post("/courses/discovery", response_model=s.Snapshot, response_model_exclude_none=True,
             operation_id="ingestCourseDiscovery", tags=["Courses"], responses={503: {"model": s.ProposedHttpError}})
def ingest_course_discovery(body: s.CourseDiscoveryInput, api: Service):
    try:
        return api.ingest_course_discovery([wire(observation) for observation in body.observations])
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.put("/tracked-courses", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="setTrackedCourses", tags=["Courses"])
def tracked_courses(body: list[str], api: Service):
    return api.set_tracked_courses(body)


@router.patch("/assessments/{assessmentId:path}/overlay", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="updateOverlay", tags=["Assessments"])
def overlay(assessmentId: str, body: s.OverlayPatch, api: Service):
    return api.update_overlay(assessmentId, body.model_dump(by_alias=True, exclude_unset=True))


@router.post("/personal-events", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="addPersonalEvent", tags=["Assessments"])
def add_personal_event(body: s.PersonalEventInput, api: Service):
    return api.add_personal_event(wire(body))


@router.delete("/personal-events/{id:path}", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="deletePersonalEvent", tags=["Assessments"])
def delete_personal_event(id: str, api: Service):
    return api.delete_personal_event(id)


@router.post("/sync", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="syncAll", tags=["Sync"], responses={503:{'model':s.SyncUnavailableError}})
def sync(api: Service):
    return api.sync_all()


@router.post("/documents/import", response_model=s.ImportDocumentResponse, response_model_exclude_none=True, operation_id="importDocument", tags=["Documents"])
def import_document(body: s.ImportDocumentInput, api: Service):
    try:
        return api.import_document(body.courseId, body.fileName, body.contentDigest)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


def review_binding(binding: Annotated[str, Header(alias='X-Moodle-Helper-Bridge-Binding', description='Optional for legacy/mock decisions; REQUIRED current process binding for registered local candidates.')] = None):
    pass


@router.post("/candidates/{candidateId:path}/review", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="review", tags=["Documents"], dependencies=[Depends(review_binding)])
def review(candidateId: str, body: Annotated[s.ConfirmReview | s.RejectReview | s.CorrectReview, Body(discriminator="kind")], api: Service):
    try:
        return api.review(candidateId, wire(body))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/materials/{id:path}/download", response_model=s.DownloadMaterialResponse, response_model_exclude_none=True, operation_id="downloadMaterial", tags=["Materials"])
def download(id: str, api: Service):
    return api.download_material(id)


@router.put("/alerts", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="saveAlerts", tags=["Alerts"])
def alerts(body: list[s.Alert], api: Service):
    return api.save_alerts([wire(alert) for alert in body])


@router.post("/alerts/update", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="updateAlerts", tags=["Alerts"])
def update_alerts(body: s.AlertUpdateInput, api: Service):
    return api.update_alerts(body.ids, body.action)


@router.patch("/settings", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="updateSettings", tags=["Settings"])
def settings(body: s.SettingsPatch, api: Service):
    return api.update_settings(wire(body))


@router.delete("/local-data", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="deleteLocalData", tags=["Local data"])
def delete_local_data(api: Service):
    return api.delete_local_data()


@router.post("/demo/reset", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="resetDemo", tags=["Demo"])
def reset_demo(api: Service):
    return api.reset_demo()


@router.get("/ai/availability", response_model=s.AiAvailability, operation_id="aiAvailability", tags=["AI availability"])
def ai_availability(api: Service):
    return api.ai_availability()

# Queue operations require the current process binding for writes.
queue_router = APIRouter(prefix='/api/queue', responses={'default': {'model':s.ProposedHttpError}, 404:{'model':s.ProposedHttpError}, 409:{'model':s.ProposedHttpError}, 422:{'model':s.ProposedHttpError}, 503:{'model':s.ProposedHttpError}})

def queue(request: Request): return request.app.state.queue

def queue_binding(binding: Annotated[str, Header(alias='X-Moodle-Helper-Bridge-Binding', description='Required current backend process binding. A stale or absent binding returns 409 before processing.')]): pass

@queue_router.get('/current', response_model=s.QueueCurrent, response_model_exclude_none=True, operation_id='currentQueueRun', tags=['Queue'])
def current_queue(request:Request): return queue(request).current()

@queue_router.post('/current', response_model=s.QueueRun, response_model_exclude_none=True, operation_id='startCurrentQueueRun', tags=['Queue'], dependencies=[Depends(queue_binding)])
def start_current_queue(body:s.ScanStart, request:Request): return queue(request).start(body.idempotencyKey, [], selected=True)

@queue_router.post('/runs', response_model=s.QueueRun, response_model_exclude_none=True, operation_id='startQueueRun', tags=['Queue'], dependencies=[Depends(queue_binding)])
def start_queue(body:s.QueueStart, request:Request): return queue(request).start(body.idempotencyKey,body.courseIds)

@queue_router.get('/runs/{runId}', response_model=s.QueueRun, response_model_exclude_none=True, operation_id='readQueueRun', tags=['Queue'])
def read_queue(runId:s.QueueId, request:Request, cursor:s.QueueId=None, limit:Annotated[int, __import__('fastapi').Query(ge=1,le=100)]=100): return queue(request).read(runId,cursor,limit)

@queue_router.post('/runs/{runId}/cancel', response_model=s.QueueRun, response_model_exclude_none=True, operation_id='cancelQueueRun', tags=['Queue'], dependencies=[Depends(queue_binding)])
def cancel_queue(runId:s.QueueId, request:Request): return queue(request).cancel(runId)

@queue_router.post('/claim', response_model=s.QueueClaimResponse, response_model_exclude_none=True, operation_id='claimQueueJob', tags=['Queue'], dependencies=[Depends(queue_binding)])
def claim_queue(body:s.QueueClaimInput, request:Request): return queue(request).claim()

@queue_router.post('/renew', response_model=s.QueueRenewResponse, operation_id='renewQueueClaim', tags=['Queue'], dependencies=[Depends(queue_binding)])
def renew_queue(body:s.QueueClaimToken, request:Request): return queue(request).renew(body.jobId,body.generation,body.token)

@queue_router.post('/finish', response_model=s.QueueJob, response_model_exclude_none=True, operation_id='finishQueueClaim', tags=['Queue'], dependencies=[Depends(queue_binding)])
def finish_queue(body:s.QueueFinish, request:Request): return queue(request).finish(body.jobId,body.generation,body.token,body.outcome,body.errorCode)

scan_router = APIRouter(prefix='/api/scan', responses={'default': {'model':s.ProposedHttpError}, 404:{'model':s.ProposedHttpError}, 409:{'model':s.ProposedHttpError}, 422:{'model':s.ProposedHttpError}, 503:{'model':s.ProposedHttpError}})
def scan(request: Request): return request.app.state.scan

@scan_router.post('/runs', response_model=s.ScanRun, response_model_exclude_none=True, operation_id='startScanRun', tags=['Scan'], dependencies=[Depends(queue_binding)])
def start_scan(body:s.ScanStart, request:Request): return scan(request).start(body.idempotencyKey)

@scan_router.get('/runs/{runId}', response_model=s.ScanRun, response_model_exclude_none=True, operation_id='readScanRun', tags=['Scan'])
def read_scan(runId:s.QueueId, request:Request, cursor:s.QueueId=None, limit:Annotated[int, __import__('fastapi').Query(ge=1,le=100)]=100): return scan(request).read(runId,cursor,limit)

@scan_router.post('/runs/{runId}/cancel', response_model=s.ScanRun, response_model_exclude_none=True, operation_id='cancelScanRun', tags=['Scan'], dependencies=[Depends(queue_binding)])
def cancel_scan(runId:s.QueueId, request:Request): return scan(request).cancel(runId)

@scan_router.post('/claim', response_model=s.ScanClaimResponse, response_model_exclude_none=True, operation_id='claimScanJob', tags=['Scan'], dependencies=[Depends(queue_binding)])
def claim_scan(body:s.QueueClaimInput, request:Request): return scan(request).claim()

@scan_router.post('/renew', response_model=s.QueueRenewResponse, operation_id='renewScanClaim', tags=['Scan'], dependencies=[Depends(queue_binding)])
def renew_scan(body:s.QueueClaimToken, request:Request): return scan(request).renew(body.jobId,body.generation,body.token)

@scan_router.post('/finish', response_model=s.ScanJob, response_model_exclude_none=True, operation_id='finishScanClaim', tags=['Scan'], dependencies=[Depends(queue_binding)])
def finish_scan(body:s.ScanFinish, request:Request): return scan(request).finish(wire(body))

@scan_router.get('/jobs/{jobId}/pages', response_model=s.ScanPageList, response_model_exclude_none=True, operation_id='readScanJobPages', tags=['Scan'])
def read_scan_pages(jobId:s.QueueId, request:Request, cursor:s.QueueId=None, limit:Annotated[int, __import__('fastapi').Query(ge=1,le=100)]=100): return scan(request).pages(jobId,cursor,limit)

reminder_router = APIRouter(prefix='/api/reminders', responses={'default': {'model': s.ProposedHttpError}, 409: {'model': s.ProposedHttpError}, 422: {'model': s.ProposedHttpError}, 503: {'model': s.ProposedHttpError}})


def reminders(request: Request):
    return request.app.state.reminders


def reminder_binding(binding: Annotated[str, Header(alias='X-Moodle-Helper-Bridge-Binding', description='Required current process binding from /api/bridge-context. Absent or stale returns 409 before processing.')]):
    pass


@reminder_router.get('/plan', response_model=s.ReminderPlan, response_model_exclude_none=True, operation_id='reminderPlan', tags=['Reminders'])
def reminder_plan(request: Request, cursor: s.ReminderOpaqueId = None, limit: Annotated[int, __import__('fastapi').Query(ge=1, le=100)] = 100):
    return reminders(request).read_plan(cursor, limit)


@reminder_router.post('/reconcile', response_model=s.ReminderPlan, response_model_exclude_none=True, operation_id='reconcileReminders', tags=['Reminders'], dependencies=[Depends(reminder_binding)])
def reconcile_reminders(body: s.ReminderReconcileInput, request: Request):
    return reminders(request).reconcile(wire(body))


@reminder_router.post('/dispatch', response_model=s.ReminderDispatchResult, response_model_exclude_none=True, operation_id='dispatchReminders', tags=['Reminders'], dependencies=[Depends(reminder_binding)])
def dispatch_reminders(body: s.ReminderDispatchInput, request: Request):
    return reminders(request).dispatch(wire(body))


@reminder_router.post('/delivery-status', response_model=s.ReminderDeliveryReceipt, response_model_exclude_none=True, operation_id='reminderDeliveryStatus', tags=['Reminders'], dependencies=[Depends(reminder_binding)])
def reminder_delivery_status(body: s.ReminderDeliveryStatusInput, request: Request):
    return reminders(request).delivery_status(wire(body))


@reminder_router.post('/notification-target', response_model=s.ReminderNotificationTarget, response_model_exclude_none=True, operation_id='reminderNotificationTarget', tags=['Reminders'], dependencies=[Depends(reminder_binding)])
def reminder_notification_target(body: s.ReminderNotificationTargetInput, request: Request):
    return reminders(request).notification_target(wire(body))
