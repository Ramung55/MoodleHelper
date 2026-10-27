"""Local adapter behavior, independent of HTTP and the concrete repository."""

from copy import deepcopy
from hashlib import sha256
import re

from backend.identity import collector_entity_key, namespace_key
from datetime import datetime, timezone
from uuid import uuid4

from backend.sample_data import build_sample_snapshot
from backend.storage import SnapshotStore


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def source_date(sources: list[dict]) -> dict:
    priority = {"moodle": 0, "syllabus": 1, "personal": 2}

    def observed(source):
        try:
            return datetime.fromisoformat(source["observedAt"].replace("Z", "+00:00")).timestamp()
        except (ValueError, OverflowError, OSError):
            # The wire schema permits arbitrary timestamp strings. Unparseable
            # values retain stable input order rather than causing an error.
            return 0

    return sorted(sources, key=lambda s: (priority[s["source"]], -observed(s)))[0]["date"]


SYNC_UNAVAILABLE = 'Live course sync is unavailable until Moodle access is verified.'


class SyncUnavailable(RuntimeError):
    pass


class BackendService:
    def __init__(self, store: SnapshotStore):
        self.store = store

    def connection(self) -> dict:
        if self.store.namespace != namespace_key():
            return {'state': 'disconnected', 'extensionDetected': False, 'message': SYNC_UNAVAILABLE}
        return {"state": "demo", "extensionDetected": False,
                "message": "Local fictional demo data. Chrome extension not connected; nothing is collected from Moodle."}

    def load(self) -> dict:
        return self.store.read()

    def replace_all(self, snapshot: dict) -> dict:
        return self.store.replace(snapshot)

    def ingest_course_discovery(self, observations: list[dict]) -> dict:
        # Validate the full batch before mutation; raw wire shape stays permissive
        # for backwards-compatible Snapshot restore.
        incoming = {}
        for observation in observations:
            source_id = observation["sourceCourseId"]
            if not re.fullmatch(r"[1-9][0-9]*", source_id):
                raise ValueError("sourceCourseId must be a canonical positive decimal string")
            if observation["sourceUrl"] != f"https://moodle.sdu.edu.kz/course/view.php?id={source_id}":
                raise ValueError("sourceUrl must exactly match the canonical course URL and sourceCourseId")
            for field in ("title", "termIndicators"):
                fact = observation[field]
                if fact["kind"] == "known":
                    values = [fact["value"]] if field == "title" else fact["value"]
                    if not values or any(not value or " ".join(value.split()) != value for value in values):
                        raise ValueError(f"{field} requires normalized nonblank known values")
            if source_id in incoming and incoming[source_id] != observation:
                raise ValueError("Conflicting duplicate observations for one sourceCourseId")
            incoming[source_id] = observation

        def apply(snapshot):
            if not incoming:
                return
            mappings = {}
            for course in snapshot["courses"]:
                if "discovery" in course:
                    source_id = course["discovery"]["sourceCourseId"]
                    if source_id in mappings:
                        raise ValueError("Ambiguous saved sourceCourseId mapping; no discovery was saved")
                    mappings[source_id] = course
            for source_id, observation in incoming.items():
                identifier = collector_entity_key(self.store.namespace, "course", course_id=source_id)
                mapped = mappings.get(source_id)
                if mapped is not None and sum(c["id"] == mapped["id"] for c in snapshot["courses"]) != 1:
                    raise ValueError("Ambiguous saved course identifier; no discovery was saved")
                collision = next((c for c in snapshot["courses"] if c["id"] == identifier), None)
                if collision is not None and collision is not mapped:
                    raise ValueError("Course identity collision; no discovery was saved")
                if mapped is not None and mapped["discovery"]["sourceUrl"] != observation["sourceUrl"]:
                    raise ValueError("Saved source identity has conflicting URL; no discovery was saved")
                if mapped is None:
                    mapped = {"id": identifier, "code": f"Course {source_id}",
                              "color": 1 + int(sha256(source_id.encode()).hexdigest(), 16) % 6}
                    snapshot["courses"].append(mapped)
                mapped.update(name=(observation["title"]["value"] if observation["title"]["kind"] == "known"
                                    else "Title unavailable"), current=False,
                              discovery={**deepcopy(observation), "currentTermStatus": "unknown"})
        return self.store.mutate(apply)

    def set_tracked_courses(self, ids: list[str]) -> dict:
        return self.update_settings({"trackedCourseIds": ids})

    def update_settings(self, patch: dict) -> dict:
        def apply(s):
            s["settings"].update(patch)
        return self.store.mutate(apply)

    def update_overlay(self, id: str, patch: dict) -> dict:
        def apply(s):
            current = next((o for o in s["overlays"] if o["assessmentId"] == id),
                           {"assessmentId": id, "hidden": False, "completed": False})
            current.update(patch)
            for key in ("titleOverride", "dateOverride", "overrideBase"):
                if current.get(key) is None:
                    current.pop(key, None)
            if "dateOverride" in patch:
                assessment = next((a for a in s["assessments"] if a["id"] == id), None)
                if patch["dateOverride"] is not None and assessment:
                    current["overrideBase"] = source_date(assessment["sources"])
                else:
                    current.pop("overrideBase", None)
            s["overlays"] = [o for o in s["overlays"] if o["assessmentId"] != id] + [current]
        return self.store.mutate(apply)

    def add_personal_event(self, event: dict) -> dict:
        def apply(s):
            t = stamp()
            s["assessments"].append({"id": f"p-{uuid4().hex}", "courseId": event["courseId"],
                                     "title": event["title"], "type": event["type"], "personal": True,
                                     "sources": [{"source": "personal", "date": event["date"], "observedAt": t}],
                                     "firstObservedAt": t, "lastObservedAt": t})
        return self.store.mutate(apply)

    def delete_personal_event(self, id: str) -> dict:
        def apply(s):
            s["assessments"] = [a for a in s["assessments"] if not (a["id"] == id and a["personal"])]
            s["overlays"] = [o for o in s["overlays"] if o["assessmentId"] != id]
        return self.store.mutate(apply)

    def sync_all(self) -> dict:
        if self.store.namespace != namespace_key():
            raise SyncUnavailable(SYNC_UNAVAILABLE)
        def apply(s):
            for state in s["sync"]:
                if state["courseId"] not in s["settings"]["trackedCourseIds"]:
                    continue
                state["progress"] = 100
                if state["courseId"] == "c-phy":
                    state.update(status="failed", error="Simulated Moodle error for 2 of 9 activities. Earlier data kept.")
                else:
                    state.update(status="ok", coverage="full", lastSuccessAt=stamp())
                    state.pop("error", None)
        return self.store.mutate(apply)

    def import_document(self, course_id: str, file_name: str) -> dict:
        extension = file_name.lower().split(".")[-1]
        if extension not in ("pdf", "docx"):
            reason = ("Legacy .doc files are not supported. Save it as .docx or PDF and try again."
                      if extension == "doc" else f'".{extension}" files are not supported. Import a text-based PDF or a DOCX syllabus.')
            return {"snapshot": self.load(), "result": {"ok": False, "reason": reason}}

        def apply(s):
            id = f"d-{uuid4().hex}"
            s["documents"].append({"id": id, "courseId": course_id, "name": file_name,
                                   "format": extension, "status": "done", "progress": 100,
                                   "importedAt": stamp(), "mocked": True})
            s["candidates"].append({"id": f"k-{id}", "documentId": id, "courseId": course_id,
                                    "title": "Assignment (from imported syllabus)", "type": "assignment",
                                    "date": {"kind": "week", "week": 8}, "rawDateText": "Week 8", "language": "en",
                                    "confidence": 0.6, "excerpt": "Assignment due in week 8 (mock extraction)",
                                    "location": f"{file_name}, page 2", "status": "pending",
                                    "reason": "Mock extraction — verify against the document"})
        return {"snapshot": self.store.mutate(apply), "result": {"ok": True}}

    def review(self, id: str, decision: dict) -> dict:
        def apply(s):
            candidate = next((c for c in s["candidates"] if c["id"] == id), None)
            if candidate is None:
                return
            if decision["kind"] == "reject":
                candidate["status"] = "rejected"
                return
            if decision["kind"] == "correct":
                candidate.update({key: decision[key] for key in ("title", "date", "type")})
            t = stamp()
            evidence = {"source": "syllabus", "date": candidate["date"], "excerpt": candidate["excerpt"],
                        "location": candidate["location"], "observedAt": t}
            matched = next((a for a in s["assessments"] if a["id"] == candidate.get("matchAssessmentId")), None)
            if matched:
                matched["sources"].append(evidence)
            else:
                s["assessments"].append({"id": f"syl-{id}", "courseId": candidate["courseId"],
                                         "title": candidate["title"], "type": candidate["type"], "personal": False,
                                         "sources": [evidence], "firstObservedAt": t, "lastObservedAt": t})
            candidate["status"] = "corrected" if decision["kind"] == "correct" else "confirmed"
        return self.store.mutate(apply)

    def download_material(self, id: str) -> dict:
        s = self.load()
        material = next((m for m in s["materials"] if m["id"] == id), None)
        message = ("Downloads need the Chrome extension. In demo mode nothing is downloaded."
                   if material and material["accessible"] else
                   "This resource is not accessible. Log in to Moodle and try again.")
        return {"snapshot": s, "supported": False, "message": message}

    def save_alerts(self, alerts: list[dict]) -> dict:
        def apply(s):
            s["alerts"] = alerts
        return self.store.mutate(apply)

    def delete_local_data(self) -> dict:
        def apply(s):
            s.pop('collection', None)
            for key in s:
                if key != "settings":
                    s[key] = []
            s["settings"]["trackedCourseIds"] = []
        return self.store.mutate(apply)

    def reset_demo(self) -> dict:
        return self.store.replace(build_sample_snapshot())

    def ai_availability(self) -> dict:
        return {"available": False, "reason": "No AI gateway or provider policy is configured. No document content is sent externally."}
