import { toYmd } from "@/domain/dates";
import type { Assessment, Snapshot } from "@/domain/types";

/**
 * Fictional demo data. Dates are generated relative to "now" so scenarios stay meaningful.
 * Covers the 15 demo scenarios from the specification (see docs/SYSTEM_DESIGN.md §10).
 */
export function buildDemoSnapshot(nowMs = Date.now()): Snapshot {
  const DAY = 86_400_000;
  const today = new Date(nowMs);
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - dow * DAY;
  const semesterStartMs = thisMonday - 5 * 7 * DAY; // current week = 6
  const semesterStart = toYmd(semesterStartMs);
  const nextMonday = thisMonday + 7 * DAY;
  const iso = (ms: number) => new Date(ms).toISOString();
  // 23:59 Almaty (UTC+5) = 18:59 UTC
  const due = (dayMs: number) => ({ kind: "exact" as const, iso: iso(dayMs + 18 * 3600_000 + 59 * 60_000), tz: "Asia/Almaty" });
  const rel = (days: number) => due(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + days * DAY);
  const obs = iso(nowMs - 2 * 3600_000);
  const old = iso(nowMs - 6 * DAY);
  const url = (id: string) => `https://moodle.sdu.edu.kz/mod/assign/view.php?id=${id}`;

  const m = (date: Assessment["sources"][0]["date"], id: string, observedAt = obs) => ({
    source: "moodle" as const,
    date,
    url: url(id),
    excerpt: "Due date shown on the Moodle activity page",
    location: "Moodle activity page",
    observedAt,
  });

  const A = (x: Partial<Assessment> & Pick<Assessment, "id" | "courseId" | "title" | "type" | "sources">): Assessment => ({
    personal: false,
    firstObservedAt: old,
    lastObservedAt: obs,
    ...x,
  });

  const assessments: Assessment[] = [
    // 1 submitted
    A({ id: "a1", activityId: "1101", courseId: "c-csc", title: "Lab 4: Linked lists", type: "assignment", sources: [m(rel(-1), "1101")], submission: { status: "submitted", evidence: "Submission status: Submitted for grading", observedAt: obs } }),
    // 2 draft due soon
    A({ id: "a2", activityId: "1102", courseId: "c-csc", title: "Lab 5: Hash tables", type: "assignment", sources: [m(rel(1), "1102")], submission: { status: "draft", evidence: "Submission status: Draft (not submitted)", observedAt: obs } }),
    // 3 reopened
    A({ id: "a3", activityId: "2201", courseId: "c-eng", title: "Essay 2: Argumentative draft", type: "assignment", sources: [m(rel(3), "2201")], submission: { status: "reopened", evidence: "Teacher reopened attempt: “Please revise the thesis and resubmit.”", observedAt: obs } }),
    // 4 quiz window
    A({ id: "a4", activityId: "3301", courseId: "c-math", title: "Quiz 3: Integration by parts", type: "quiz", availableFrom: iso(nowMs - DAY), sources: [m(rel(2), "3301")], submission: { status: "not_submitted", evidence: "No attempts yet", observedAt: obs } }),
    // 5 Moodle / syllabus conflict
    A({ id: "a5", activityId: "4401", courseId: "c-phy", title: "Problem set 4", type: "assignment", sources: [m(rel(5), "4401"), { source: "syllabus", date: rel(3), excerpt: "Problem set 4 — due Thursday of week 6", location: "PHY201_syllabus.pdf, page 3, table 2", observedAt: old }], submission: { status: "not_submitted", observedAt: obs } }),
    // 7 week-only exam
    A({ id: "a7", courseId: "c-math", title: "Midterm exam", type: "exam", sources: [{ source: "syllabus", date: { kind: "week", week: 9 }, excerpt: "Midterm examination — Week 9", location: "MAT102_syllabus.docx, table 1, row 9", observedAt: old }] }),
    // 8 changed deadline
    A({ id: "a8", activityId: "2202", courseId: "c-eng", title: "Reading response 5", type: "assignment", sources: [m(rel(6), "2202")], submission: { status: "not_submitted", observedAt: obs } }),
    // 9 hidden
    A({ id: "a9", activityId: "5501", courseId: "c-his", title: "Optional forum post", type: "other", sources: [m(rel(4), "5501")], submission: { status: "unknown", observedAt: obs } }),
    // 10 personal event
    A({ id: "p1", courseId: "c-csc", title: "Study group: data structures", type: "other", personal: true, sources: [{ source: "personal", date: rel(2), observedAt: obs }] }),
    // 15 personally completed, Moodle still draft
    A({ id: "a15", activityId: "5502", courseId: "c-his", title: "Source analysis worksheet", type: "assignment", sources: [m(rel(4), "5502")], submission: { status: "draft", evidence: "Submission status: Draft (not submitted)", observedAt: obs } }),
    // unknown date
    A({ id: "a16", courseId: "c-phy", title: "Lab report (final)", type: "assignment", sources: [{ source: "syllabus", date: { kind: "unknown", note: "“end of semester” in syllabus" }, excerpt: "Final lab report due at the end of the semester", location: "PHY201_syllabus.pdf, page 4", observedAt: old }] }),
  ];

  // 11 overloaded next week (7 outstanding)
  const heavy: [string, string, Assessment["type"], number][] = [
    ["c-csc", "Lab 6: Trees", "assignment", 0],
    ["c-math", "Quiz 4: Series", "quiz", 1],
    ["c-phy", "Problem set 5", "assignment", 1],
    ["c-eng", "Presentation slides", "assignment", 2],
    ["c-his", "Map test", "quiz", 3],
    ["c-csc", "Quiz: Complexity", "quiz", 3],
    ["c-math", "Homework 6", "assignment", 4],
  ];
  heavy.forEach(([c, t, ty, d], i) =>
    assessments.push(A({ id: `h${i}`, activityId: `90${i}`, courseId: c, title: t, type: ty, sources: [m(due(nextMonday + d * DAY), `90${i}`)], submission: { status: "not_submitted", observedAt: obs } })),
  );

  return {
    courses: [
      { id: "c-csc", code: "CSS 215", name: "Data Structures", color: 1, current: true },
      { id: "c-math", code: "MAT 102", name: "Calculus II", color: 2, current: true },
      { id: "c-phy", code: "PHY 201", name: "General Physics", color: 3, current: true },
      { id: "c-eng", code: "ENG 110", name: "Academic Writing", color: 4, current: true },
      { id: "c-his", code: "HIS 101", name: "История Казахстана", color: 5, current: true },
      { id: "c-old", code: "CSS 101", name: "Intro to Programming (last year)", color: 6, current: false },
    ],
    assessments,
    overlays: [
      { assessmentId: "a9", hidden: true, completed: false },
      { assessmentId: "a15", hidden: false, completed: true },
      { assessmentId: "a8", hidden: false, completed: false, dateOverride: rel(4), overrideBase: rel(3) },
    ],
    materials: [
      { id: "m1", courseId: "c-csc", section: "Week 1 — Introduction", title: "Course syllabus", fileType: "pdf", url: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=7001", accessible: true, stale: false, lastCheckedAt: obs, syllabusSuggestion: true },
      { id: "m2", courseId: "c-csc", section: "Week 5 — Hashing", title: "Lecture 5 slides", fileType: "pptx", url: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=7002", accessible: true, stale: false, lastCheckedAt: obs, downloadedAt: old, syllabusSuggestion: false },
      { id: "m3", courseId: "c-math", section: "General", title: "MAT102 Силлабус (RU)", fileType: "docx", url: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=7003", accessible: true, stale: false, lastCheckedAt: obs, syllabusSuggestion: true },
      { id: "m4", courseId: "c-math", section: "Week 6 — Integration", title: "Worked examples", fileType: "pdf", url: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=7004", accessible: true, stale: true, lastCheckedAt: old, syllabusSuggestion: false },
      { id: "m5", courseId: "c-phy", section: "Labs", title: "Lab manual 2026", fileType: "pdf", url: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=7005", accessible: false, stale: false, lastCheckedAt: obs, syllabusSuggestion: false },
      { id: "m6", courseId: "c-eng", section: "Readings", title: "Purdue OWL: Thesis statements", fileType: "link", url: "https://owl.purdue.edu/", accessible: true, stale: false, lastCheckedAt: obs, syllabusSuggestion: false },
      { id: "m7", courseId: "c-his", section: "Тема 3", title: "Лекция: Казахское ханство", fileType: "video", url: "https://moodle.sdu.edu.kz/mod/url/view.php?id=7007", accessible: true, stale: false, lastCheckedAt: obs, syllabusSuggestion: false },
    ],
    documents: [
      { id: "d1", courseId: "c-math", name: "MAT102_syllabus_ru.docx", format: "docx", status: "done", progress: 100, importedAt: old, mocked: true },
      { id: "d2", courseId: "c-phy", name: "PHY201_scan.pdf", format: "pdf", status: "needs_ocr", progress: 100, importedAt: old, mocked: true, error: "Pages 5–6 are scanned images. Local OCR is not available yet." },
    ],
    candidates: [
      // 6 uncertain Russian date
      { id: "k1", documentId: "d1", courseId: "c-math", title: "Контрольная работа 2", type: "quiz", date: { kind: "date", date: toYmd(thisMonday + 10 * DAY) }, rawDateText: "до 15.11 (или после консультации)", language: "ru", confidence: 0.55, excerpt: "Контрольная работа 2 — до 15.11 (или после консультации)", location: "MAT102_syllabus_ru.docx, paragraph 42", status: "pending", reason: "Ambiguous phrase “или после консультации”; year not stated" },
      { id: "k2", documentId: "d1", courseId: "c-math", title: "Quiz 3", type: "quiz", date: { kind: "week", week: 6 }, rawDateText: "Неделя 6", language: "ru", confidence: 0.7, excerpt: "Тест 3 — Неделя 6", location: "MAT102_syllabus_ru.docx, table 1, row 6", status: "pending", matchAssessmentId: "a4", reason: "Possible match with Moodle “Quiz 3: Integration by parts” — titles alone are not enough to merge" },
      { id: "k3", documentId: "d1", courseId: "c-math", title: "Итоговый экзамен", type: "exam", date: { kind: "week", week: 15 }, rawDateText: "15 неделя", language: "ru", confidence: 0.93, excerpt: "Итоговый экзамен — 15 неделя", location: "MAT102_syllabus_ru.docx, table 1, row 15", status: "auto" },
    ],
    sync: [
      { courseId: "c-csc", status: "ok", coverage: "full", lastSuccessAt: obs, progress: 100 },
      { courseId: "c-math", status: "ok", coverage: "full", lastSuccessAt: obs, progress: 100 },
      { courseId: "c-phy", status: "failed", coverage: "partial", lastSuccessAt: old, error: "Moodle returned an error for 2 of 9 activities. Earlier data kept.", progress: 100 },
      { courseId: "c-eng", status: "ok", coverage: "full", lastSuccessAt: obs, progress: 100 },
      { courseId: "c-his", status: "partial", coverage: "partial", lastSuccessAt: obs, error: "Only visited activities were read. Run “Sync all courses” for full coverage.", progress: 100 },
    ],
    changes: [{ id: "ch1", assessmentId: "a8", from: rel(3), to: rel(6), detectedAt: obs }],
    alerts: [],
    settings: {
      trackedCourseIds: ["c-csc", "c-math", "c-phy", "c-eng", "c-his"],
      semesterStart,
      semesterWeeks: 15,
      timezone: "Asia/Almaty",
      weights: { exam: 3, assignment: 2, quiz: 1, other: 0 },
      thresholds: { maxOutstanding: 5, maxWeighted: 10 },
      reminders: { enabled: true, hoursBefore: 24, busyWeek: true },
      ai: { enabled: false, consentGiven: false },
    },
  };
}
