"""Fresh fictional teaching data. Nothing is fetched from Moodle."""

from datetime import datetime, timedelta, timezone

from backend.schemas import Snapshot


def build_sample_snapshot() -> dict:
    now = datetime.now(timezone.utc)
    stamp = now.isoformat()
    monday = now.date() - timedelta(days=now.weekday())
    date = {"kind": "exact", "iso": (now + timedelta(days=3)).isoformat(), "tz": "Asia/Almaty"}

    def assessment(id, course, title, type, sources, **extra):
        return dict(id=id, courseId=course, title=title, type=type, sources=sources,
                    personal=False, firstObservedAt=stamp, lastObservedAt=stamp, **extra)

    def evidence(source, value):
        return dict(source=source, date=value, observedAt=stamp,
                    excerpt="Fictional assessment schedule", location="Demo syllabus, page 2")

    result = {
        "courses": [
            {"id": "c-csc", "code": "CSS 215", "name": "Data Structures", "color": 1, "current": True},
            {"id": "c-math", "code": "MAT 102", "name": "Calculus II", "color": 2, "current": True},
            {"id": "c-phy", "code": "PHY 201", "name": "General Physics", "color": 3, "current": True},
            {"id": "c-old", "code": "CSS 101", "name": "Introduction to Programming (previous year)", "color": 6, "current": False},
        ],
        "assessments": [
            assessment("a1", "c-csc", "Lab 5: Hash tables", "assignment", [evidence("moodle", date)],
                       submission={"status": "draft", "evidence": "Draft, not submitted", "observedAt": stamp}),
            assessment("a2", "c-math", "Midterm exam", "exam", [evidence("syllabus", {"kind": "week", "week": 9})]),
            assessment("a3", "c-phy", "Problem set 4", "assignment",
                       [evidence("moodle", date), evidence("syllabus", {"kind": "date", "date": str(monday)})],
                       submission={"status": "reopened", "observedAt": stamp}),
            assessment("a4", "c-phy", "Final lab report", "assignment", [evidence("syllabus", {"kind": "unknown", "note": "End of semester"})],
                       submission={"status": "unknown", "observedAt": stamp}),
            {**assessment("p1", "c-csc", "Study group", "other", [evidence("personal", date)]), "personal": True},
        ],
        "overlays": [{"assessmentId": "a1", "completed": True, "hidden": False}],
        "materials": [
            {"id": "m1", "courseId": "c-csc", "section": "General", "title": "Course syllabus", "fileType": "pdf", "url": "https://moodle.sdu.edu.kz/mod/resource/view.php?id=7001", "accessible": True, "stale": False, "lastCheckedAt": stamp, "syllabusSuggestion": True},
            {"id": "m2", "courseId": "c-phy", "section": "Labs", "title": "Lab manual", "fileType": "pdf", "url": "https://moodle.sdu.edu.kz/mod/resource/view.php?id=7002", "accessible": False, "stale": True, "lastCheckedAt": stamp, "syllabusSuggestion": False},
        ],
        "documents": [{"id": "d1", "courseId": "c-math", "name": "MAT102_syllabus_ru.docx", "format": "docx", "status": "done", "progress": 100, "importedAt": stamp, "mocked": True}],
        "candidates": [
            {"id": "k1", "documentId": "d1", "courseId": "c-math", "title": "Контрольная работа", "type": "quiz", "date": {"kind": "week", "week": 8}, "rawDateText": "Неделя 8", "language": "ru", "confidence": 0.6, "excerpt": "Контрольная работа — неделя 8", "location": "MAT102_syllabus_ru.docx, table 1", "status": "pending"},
            {"id": "k2", "documentId": "d1", "courseId": "c-math", "title": "Midterm exam", "type": "exam", "date": {"kind": "week", "week": 9}, "rawDateText": "Week 9", "language": "en", "confidence": 0.7, "excerpt": "Midterm examination in week 9", "location": "MAT102_syllabus_ru.docx, table 2", "status": "pending", "matchAssessmentId": "a2"},
        ],
        "sync": [
            {"courseId": id, "status": "partial" if id == "c-phy" else "ok", "coverage": "partial" if id == "c-phy" else "full", "lastSuccessAt": stamp, "progress": 100}
            for id in ("c-csc", "c-math", "c-phy")
        ],
        "changes": [{"id": "ch1", "assessmentId": "a3", "from": {"kind": "date", "date": str(monday)}, "to": date, "detectedAt": stamp}],
        "alerts": [{"id": "alert1", "kind": "change", "assessmentId": "a3", "message": "Fictional physics deadline changed; review the source evidence.", "deliveryKey": "demo:change:a3", "createdAt": stamp, "read": False}],
        "settings": {"trackedCourseIds": ["c-csc", "c-math", "c-phy"], "semesterStart": str(monday - timedelta(weeks=5)), "semesterWeeks": 15, "timezone": "Asia/Almaty", "weights": {"exam": 3, "assignment": 2, "quiz": 1, "other": 0}, "thresholds": {"maxOutstanding": 5, "maxWeighted": 10}, "reminders": {"enabled": True, "hoursBefore": 24, "busyWeek": True}, "ai": {"enabled": False, "consentGiven": False}},
    }
    return Snapshot.model_validate(result).model_dump(by_alias=True, exclude_none=True)
