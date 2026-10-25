"""HTTP binding: business logic lives in services, state in the repository."""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, Request

from backend import schemas as s
from backend.services import BackendService


def service(request: Request) -> BackendService:
    return request.app.state.service


Service = Annotated[BackendService, Depends(service)]
# Each operation declares response models; documentation is generated from the
# actual handlers/models rather than returning a copy of the source document.
router = APIRouter(prefix="/api", responses={"default": {"model": s.ProposedHttpError}, 422: {"model": s.ProposedHttpError}})


def wire(model: s.WireModel) -> dict:
    return model.model_dump(by_alias=True, exclude_unset=True, exclude_none=True)


@router.get("/connection", response_model=s.ConnectionInfo, operation_id="connection", tags=["Connection"])
def connection(api: Service):
    return api.connection()


@router.get("/snapshot", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="load", tags=["Snapshot"])
def load(api: Service):
    return api.load()


@router.put("/snapshot", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="replaceAll", tags=["Snapshot"])
def replace_all(body: s.Snapshot, api: Service):
    return api.replace_all(wire(body))


@router.put("/tracked-courses", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="setTrackedCourses", tags=["Courses"])
def tracked_courses(body: list[str], api: Service):
    return api.set_tracked_courses(body)


@router.patch("/assessments/{assessmentId}/overlay", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="updateOverlay", tags=["Assessments"])
def overlay(assessmentId: str, body: s.OverlayPatch, api: Service):
    return api.update_overlay(assessmentId, wire(body))


@router.post("/personal-events", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="addPersonalEvent", tags=["Assessments"])
def add_personal_event(body: s.PersonalEventInput, api: Service):
    return api.add_personal_event(wire(body))


@router.delete("/personal-events/{id}", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="deletePersonalEvent", tags=["Assessments"])
def delete_personal_event(id: str, api: Service):
    return api.delete_personal_event(id)


@router.post("/sync", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="syncAll", tags=["Sync"])
def sync(api: Service):
    return api.sync_all()


@router.post("/documents/import", response_model=s.ImportDocumentResponse, response_model_exclude_none=True, operation_id="importDocument", tags=["Documents"])
def import_document(body: s.ImportDocumentInput, api: Service):
    return api.import_document(body.courseId, body.fileName)


@router.post("/candidates/{candidateId}/review", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="review", tags=["Documents"])
def review(candidateId: str, body: Annotated[s.ConfirmReview | s.RejectReview | s.CorrectReview, Body(discriminator="kind")], api: Service):
    return api.review(candidateId, wire(body))


@router.post("/materials/{id}/download", response_model=s.DownloadMaterialResponse, response_model_exclude_none=True, operation_id="downloadMaterial", tags=["Materials"])
def download(id: str, api: Service):
    return api.download_material(id)


@router.put("/alerts", response_model=s.Snapshot, response_model_exclude_none=True, operation_id="saveAlerts", tags=["Alerts"])
def alerts(body: list[s.Alert], api: Service):
    return api.save_alerts([wire(alert) for alert in body])


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
