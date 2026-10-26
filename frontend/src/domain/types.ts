import { z } from "zod";

/** Four date forms are kept separate; never collapse week/unknown into an exact time. */
export const DateValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), iso: z.string(), tz: z.string() }),
  z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ kind: z.literal("week"), week: z.number().int().min(1).max(30) }),
  z.object({ kind: z.literal("unknown"), note: z.string().optional() }),
]);
export type DateValue = z.infer<typeof DateValue>;

export const AssessmentType = z.enum(["assignment", "quiz", "exam", "other"]);
export type AssessmentType = z.infer<typeof AssessmentType>;

export const SubmissionStatus = z.enum(["submitted", "draft", "not_submitted", "reopened", "unknown"]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

export const KnownString = z.object({ kind: z.literal("known"), value: z.string() });
export const KnownStrings = z.object({ kind: z.literal("known"), value: z.array(z.string()) });
export const UnknownFact = z.object({ kind: z.literal("unknown") });
export const RawCourseObservation = z.object({
  sourceCourseId: z.string(),
  sourceUrl: z.string(),
  title: z.discriminatedUnion("kind", [KnownString, UnknownFact]),
  termIndicators: z.discriminatedUnion("kind", [KnownStrings, UnknownFact]),
});
export type RawCourseObservation = z.infer<typeof RawCourseObservation>;
export const CourseDiscovery = RawCourseObservation.extend({
  currentTermStatus: z.enum(["current", "past", "unknown"]),
});
export const CourseDiscoveryInput = z.object({ observations: z.array(RawCourseObservation) });

export const Course = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  color: z.number().int().min(1).max(6),
  current: z.boolean(),
  discovery: CourseDiscovery.optional(),
});
export type Course = z.infer<typeof Course>;

export const SourceEvidence = z.object({
  source: z.enum(["moodle", "syllabus", "personal"]),
  date: DateValue,
  excerpt: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  observedAt: z.string(),
});
export type SourceEvidence = z.infer<typeof SourceEvidence>;

export const SubmissionObservation = z.object({
  status: SubmissionStatus,
  evidence: z.string().optional(),
  observedAt: z.string(),
});
export type SubmissionObservation = z.infer<typeof SubmissionObservation>;

export const Assessment = z.object({
  id: z.string(),
  activityId: z.string().optional(),
  courseId: z.string(),
  title: z.string(),
  type: AssessmentType,
  /** Moodle quiz/assignment open time, when known */
  availableFrom: z.string().optional(),
  sources: z.array(SourceEvidence).min(1),
  submission: SubmissionObservation.optional(),
  personal: z.boolean().default(false),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
});
export type Assessment = z.infer<typeof Assessment>;

/** Personal layer. Never mutates source facts. */
export const Overlay = z.object({
  assessmentId: z.string(),
  titleOverride: z.string().optional(),
  dateOverride: DateValue.optional(),
  /** Source date at the time the override was set; used to detect source changes underneath */
  overrideBase: DateValue.optional(),
  hidden: z.boolean().default(false),
  completed: z.boolean().default(false),
});
export type Overlay = z.infer<typeof Overlay>;

export const Material = z.object({
  id: z.string(),
  courseId: z.string(),
  section: z.string(),
  title: z.string(),
  fileType: z.enum(["pdf", "docx", "pptx", "link", "video", "other"]),
  url: z.string(),
  accessible: z.boolean(),
  stale: z.boolean(),
  lastCheckedAt: z.string(),
  downloadedAt: z.string().optional(),
  syllabusSuggestion: z.boolean().default(false),
});
export type Material = z.infer<typeof Material>;

export const ImportedDocument = z.object({
  id: z.string(),
  courseId: z.string(),
  name: z.string(),
  format: z.enum(["pdf", "docx"]),
  status: z.enum(["queued", "extracting", "done", "failed", "needs_ocr"]),
  progress: z.number().min(0).max(100),
  error: z.string().optional(),
  importedAt: z.string(),
  mocked: z.boolean(),
});
export type ImportedDocument = z.infer<typeof ImportedDocument>;

export const ExtractionCandidate = z.object({
  id: z.string(),
  documentId: z.string(),
  courseId: z.string(),
  title: z.string(),
  type: AssessmentType,
  date: DateValue,
  rawDateText: z.string(),
  language: z.enum(["en", "ru"]),
  confidence: z.number().min(0).max(1),
  excerpt: z.string(),
  location: z.string(),
  status: z.enum(["pending", "confirmed", "corrected", "rejected", "auto"]),
  matchAssessmentId: z.string().optional(),
  reason: z.string().optional(),
});
export type ExtractionCandidate = z.infer<typeof ExtractionCandidate>;

export const CourseSyncState = z.object({
  courseId: z.string(),
  status: z.enum(["ok", "partial", "failed", "never", "syncing"]),
  coverage: z.enum(["full", "partial", "none"]),
  lastSuccessAt: z.string().optional(),
  error: z.string().optional(),
  progress: z.number().min(0).max(100),
});
export type CourseSyncState = z.infer<typeof CourseSyncState>;

export const DeadlineChange = z.object({
  id: z.string(),
  assessmentId: z.string(),
  from: DateValue,
  to: DateValue,
  detectedAt: z.string(),
});
export type DeadlineChange = z.infer<typeof DeadlineChange>;

export const Alert = z.object({
  id: z.string(),
  kind: z.enum(["deadline", "busy_week", "change", "sync"]),
  message: z.string(),
  assessmentId: z.string().optional(),
  deliveryKey: z.string(),
  createdAt: z.string(),
  read: z.boolean(),
});
export type Alert = z.infer<typeof Alert>;

export const Settings = z.object({
  trackedCourseIds: z.array(z.string()),
  semesterStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  semesterWeeks: z.number().int().min(1).max(30),
  timezone: z.string(),
  weights: z.object({ exam: z.number(), assignment: z.number(), quiz: z.number(), other: z.number() }),
  thresholds: z.object({ maxOutstanding: z.number(), maxWeighted: z.number() }),
  reminders: z.object({ enabled: z.boolean(), hoursBefore: z.number(), busyWeek: z.boolean() }),
  ai: z.object({ enabled: z.boolean(), consentGiven: z.boolean() }),
});
export type Settings = z.infer<typeof Settings>;

export const ConnectionState = z.enum(["demo", "connected", "disconnected", "error"]);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const Snapshot = z.object({
  courses: z.array(Course),
  assessments: z.array(Assessment),
  overlays: z.array(Overlay),
  materials: z.array(Material),
  documents: z.array(ImportedDocument),
  candidates: z.array(ExtractionCandidate),
  sync: z.array(CourseSyncState),
  changes: z.array(DeadlineChange),
  alerts: z.array(Alert),
  settings: Settings,
});
export type Snapshot = z.infer<typeof Snapshot>;
