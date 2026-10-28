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
    from backend.reconciliation import latest
    priority = {"moodle": 0, "syllabus": 1, "personal": 2}
    newest = [latest([s for s in sources if s['source'] == kind])
              for kind in sorted(priority, key=priority.get) if any(s['source'] == kind for s in sources)]
    return next((source["date"] for source in newest if source["date"]["kind"] != "unknown"), newest[0]["date"] if newest else {'kind': 'unknown'})


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

    def propose_reconciliation(self, selection: dict) -> dict:
        from backend.reconciliation import add_pair, rebuild_logical
        def apply(snapshot):
            add_pair(snapshot, self.store.namespace, selection['left'], selection['right'])
            rebuild_logical(snapshot)
        return self.store.mutate(apply)

    def decide_reconciliation(self, decision: dict) -> dict:
        from backend.reconciliation import decide
        return self.store.mutate(lambda snapshot: decide(snapshot, self.store.namespace, decision))

    def preview_syllabus_revision(self, selection: dict) -> dict:
        from backend.syllabus_revision import preview
        return preview(self.store.read(), self.store.namespace, selection)

    def confirm_syllabus_revision(self, decision: dict) -> dict:
        from backend.syllabus_revision import Replay, confirm
        try:
            return self.store.mutate(lambda snapshot: confirm(snapshot, self.store.namespace, decision))
        except Replay:
            return self.store.read()

    def replace_all(self, snapshot: dict) -> dict:
        if 'reconciliation' in snapshot:
            from backend.reconciliation import project_sources
            snapshot = deepcopy(snapshot)
            project_sources(snapshot, self.store.namespace)
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

    def set_syllabus_suggestion_dismissal(self, record_id: str, dismissed: bool) -> dict:
        def apply(snapshot):
            records = [r for r in snapshot.get('collection', {}).get('records', [])
                       if r['kind'] == 'material' and r['id'] == record_id]
            if len(records) != 1 or not any(o['kind'] != 'folder' for o in records[0]['observations']):
                raise ValueError('Suggestion is no longer available. Refresh and try again.')
            ids = set(snapshot.get('dismissedSyllabusSuggestions', []))
            if dismissed:
                ids.add(record_id)
            else:
                ids.discard(record_id)
            snapshot['dismissedSyllabusSuggestions'] = sorted(ids)
        return self.store.mutate(apply)

    def update_settings(self, patch: dict) -> dict:
        def apply(s):
            s["settings"].update(patch)
        return self.store.mutate(apply)

    def update_overlay(self, id: str, patch: dict) -> dict:
        def apply(s):
            reconciliation = s.get('reconciliation')
            aliases = reconciliation['aliases'] if reconciliation else []
            resolved = next((a['canonicalId'] for a in aliases if a['originalId'] == id), id)
            group = [a for a in aliases if a['canonicalId'] == resolved]
            if reconciliation and len(group) > 1:
                current = next((deepcopy(o) for o in reconciliation['logicalOverlays'] if o['assessmentId'] == resolved),
                               {'assessmentId': resolved, 'hidden': False, 'completed': False})
                current.update(patch)
                for key in ('titleOverride', 'dateOverride', 'overrideBase'):
                    if current.get(key) is None:
                        current.pop(key, None)
                if 'dateOverride' in patch:
                    logical = next(a for a in reconciliation['logicalAssessments'] if a['id'] == resolved)
                    if patch['dateOverride'] is None:
                        current.pop('overrideBase', None)
                    else:
                        from backend.deadline_tracking import effective_sources
                        current['overrideBase'] = source_date(effective_sources(s, logical))
                reconciliation['overlayEdits'] = [o for o in reconciliation['overlayEdits'] if o['assessmentId'] != resolved] + [current]
                return
            current = next((o for o in s["overlays"] if o["assessmentId"] == id),
                           {"assessmentId": id, "hidden": False, "completed": False})
            current.update(patch)
            for key in ("titleOverride", "dateOverride", "overrideBase"):
                if current.get(key) is None:
                    current.pop(key, None)
            if "dateOverride" in patch:
                assessment = next((a for a in s["assessments"] if a["id"] == id), None)
                if patch["dateOverride"] is not None and assessment:
                    from backend.deadline_tracking import effective_sources
                    current["overrideBase"] = source_date(effective_sources(s, assessment))
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

    def import_document(self, course_id: str, file_name: str, content_digest: str | None = None) -> dict:
        extension = file_name.lower().split(".")[-1]
        if extension not in ("pdf", "docx"):
            reason = ("Legacy .doc files are not supported. Save it as .docx or PDF and try again."
                      if extension == "doc" else f'".{extension}" files are not supported. Import a text-based PDF or a DOCX syllabus.')
            return {"snapshot": self.load(), "result": {"ok": False, "reason": reason}}

        def apply(s):
            import json
            if content_digest and sum(c['id'] == course_id for c in s['courses']) != 1:
                raise ValueError('Select an existing, unambiguous course before importing.')
            key = json.dumps([self.store.namespace, course_id, content_digest], separators=(',', ':'))
            id = f"d-mock-{sha256(key.encode()).hexdigest()}" if content_digest else f"d-{uuid4().hex}"
            existing = [d for d in s['documents'] if d['id'] == id]
            if existing:
                if len(existing) != 1 or existing[0]['courseId'] != course_id or not existing[0]['mocked']:
                    raise ValueError('Mock document identity collision; import was not saved.')
                candidate = [c for c in s['candidates'] if c['id'] == f'k-{id}']
                if len(candidate) != 1 or candidate[0]['documentId'] != id or candidate[0]['courseId'] != course_id:
                    raise ValueError('Mock candidate identity collision; import was not saved.')
                return
            if any(c['id'] == f'k-{id}' for c in s['candidates']):
                raise ValueError('Mock candidate identity collision; import was not saved.')
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
            candidates = [c for c in s["candidates"] if c["id"] == id]
            if not candidates:
                return
            if len(candidates) != 1:
                raise ValueError('Candidate identity is ambiguous. No review was saved.')
            candidate = candidates[0]
            if candidate['status'] != 'pending':
                same = (decision['kind'] == 'reject' and candidate['status'] == 'rejected' or
                        decision['kind'] == 'confirm' and candidate['status'] == 'confirmed' or
                        decision['kind'] == 'correct' and candidate['status'] == 'corrected' and
                        all(candidate[k] == decision[k] for k in ('title', 'date', 'type')))
                if same:
                    return
                raise ValueError('This candidate already has a different decision. Refresh and review it.')
            if decision['kind'] == 'reject':
                candidate['status'] = 'rejected'
                return
            if decision["kind"] == "correct":
                candidate.update({key: decision[key] for key in ("title", "date", "type")})
            t = stamp()
            evidence = {"source": "syllabus", "date": candidate["date"], "excerpt": candidate["excerpt"],
                        "location": candidate["location"], "observedAt": t}
            # Preserve the legacy same-syllabus candidate review behavior when
            # the existing target is unambiguous and has no Moodle evidence.
            # Moodle/syllabus association always requires a separate pair review.
            targets = [a for a in s['assessments'] if a['id'] == candidate.get('matchAssessmentId')]
            if (len(targets) == 1 and targets[0]['courseId'] == candidate['courseId'] and
                    targets[0]['type'] == candidate['type'] and not targets[0]['personal'] and
                    all(source['source'] == 'syllabus' for source in targets[0]['sources'])):
                targets[0]['sources'].append(evidence)
                candidate['status'] = 'corrected' if decision['kind'] == 'correct' else 'confirmed'
                return
            if any(a['id'] == f'syl-{id}' for a in s['assessments']):
                raise ValueError('Candidate assessment identity collides with existing data. No review was saved.')
            s["assessments"].append({"id": f"syl-{id}", "courseId": candidate["courseId"],
                                     "title": candidate["title"], "type": candidate["type"], "personal": False,
                                     "sources": [evidence], "firstObservedAt": t, "lastObservedAt": t})
            candidate["status"] = "corrected" if decision["kind"] == "correct" else "confirmed"
            from backend.reconciliation import layer
            layer(s)
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
            s.pop('reconciliation', None)
            s.pop('deadlineStreams', None)
            s.pop('syllabusRevisions', None)
            for key in s:
                if key != "settings":
                    s[key] = []
            s["settings"]["trackedCourseIds"] = []
        return self.store.mutate(apply)

    def reset_demo(self) -> dict:
        return self.store.replace(build_sample_snapshot())

    def ai_availability(self) -> dict:
        return {"available": False, "reason": "No AI gateway or provider policy is configured. No document content is sent externally."}
