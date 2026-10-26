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

// BEGIN GENERATED COLLECTION MODELS
export const CollectedDateObservation = z.object({
  value: DateValue,
  rawText: z.string(),
  location: z.string(),
}).strict();
export type CollectedDateObservation = z.infer<typeof CollectedDateObservation>;

export const AssignmentDates = z.object({
  opening: CollectedDateObservation.optional(),
  due: CollectedDateObservation.optional(),
  cutoff: CollectedDateObservation.optional(),
}).strict();
export type AssignmentDates = z.infer<typeof AssignmentDates>;

export const IndividualExtension = z.object({
  field: z.enum(["opening", "due", "cutoff"]),
  date: CollectedDateObservation,
  evidence: z.string(),
  scope: z.literal("individual"),
}).strict();
export type IndividualExtension = z.infer<typeof IndividualExtension>;

export const RawAssignmentObservation = z.object({
  sourceCourseId: z.string(),
  sourceActivityId: z.string(),
  sourceCourseModuleId: z.string(),
  sourceUrl: z.string(),
  title: z.string(),
  observedAt: z.string(),
  baseDates: AssignmentDates,
  individualExtensions: z.array(IndividualExtension),
  effectiveDates: AssignmentDates,
}).strict();
export type RawAssignmentObservation = z.infer<typeof RawAssignmentObservation>;

export const CalendarActivity = z.object({
  moduleType: z.enum(["assign", "quiz"]),
  sourceActivityId: z.string(),
  sourceCourseModuleId: z.string(),
  sourceUrl: z.string(),
}).strict();
export type CalendarActivity = z.infer<typeof CalendarActivity>;

export const CalendarCandidate = z.object({
  sourceEventId: z.string(),
  sourceOccurrenceId: z.string().optional(),
  sourceSeriesId: z.string().optional(),
  sourceCourseId: z.string().optional(),
  title: z.string(),
  sourceUrl: z.string(),
  observedAt: z.string(),
  start: CollectedDateObservation.optional(),
  end: CollectedDateObservation.optional(),
  date: CollectedDateObservation.optional(),
  activity: CalendarActivity.optional(),
}).strict();
export type CalendarCandidate = z.infer<typeof CalendarCandidate>;

export const RawCalendarObservation = z.object({
  sourceEventId: z.string(),
  sourceOccurrenceId: z.string().optional(),
  sourceSeriesId: z.string().optional(),
  sourceCourseId: z.string(),
  title: z.string(),
  sourceUrl: z.string(),
  observedAt: z.string(),
  start: CollectedDateObservation.optional(),
  end: CollectedDateObservation.optional(),
  date: CollectedDateObservation.optional(),
  activity: CalendarActivity.optional(),
}).strict();
export type RawCalendarObservation = z.infer<typeof RawCalendarObservation>;

export const CollectedKnownString = z.object({
  kind: z.literal("known"),
  value: z.string(),
}).strict();
export type CollectedKnownString = z.infer<typeof CollectedKnownString>;

export const CollectedKnownFileType = z.object({
  kind: z.literal("known"),
  value: z.enum(["pdf", "docx", "pptx", "link", "video", "other"]),
}).strict();
export type CollectedKnownFileType = z.infer<typeof CollectedKnownFileType>;

export const CollectedUnknown = z.object({
  kind: z.literal("unknown"),
}).strict();
export type CollectedUnknown = z.infer<typeof CollectedUnknown>;

export const MaterialReference = z.object({
  sourcePageUrl: z.string(),
  sourceUrl: z.string(),
  destinationUrl: z.string().optional(),
  observedAt: z.string(),
  location: z.enum(["course.material", "activity.material", "folder.entry"]),
  listingScope: z.enum(["reference_only", "supplied_listing_only"]).optional(),
  listingCoverage: z.enum(["complete", "partial", "none"]).optional(),
  listingChildResourceKeys: z.array(z.string()).optional(),
}).strict();
export type MaterialReference = z.infer<typeof MaterialReference>;

export const RawMaterialObservation = z.object({
  sourcePageUrl: z.string(),
  sourceUrl: z.string(),
  destinationUrl: z.string().optional(),
  observedAt: z.string(),
  location: z.enum(["course.material", "activity.material", "folder.entry"]),
  listingScope: z.enum(["reference_only", "supplied_listing_only"]).optional(),
  listingCoverage: z.enum(["complete", "partial", "none"]).optional(),
  listingChildResourceKeys: z.array(z.string()).optional(),
  sourceCourseId: z.string(),
  sourceCourseModuleId: z.string(),
  sourceModuleType: z.enum(["resource", "url", "folder"]),
  sourceResourceId: z.string().optional(),
  sourceFileId: z.string().optional(),
  sourceFolderId: z.string().optional(),
  sourceContextId: z.string().optional(),
  resourceKey: z.string(),
  parentResourceKey: z.string().optional(),
  kind: z.enum(["file", "link", "folder"]),
  title: z.union([CollectedKnownString, CollectedUnknown]),
  section: z.union([CollectedKnownString, CollectedUnknown]),
  fileType: z.union([CollectedKnownFileType, CollectedUnknown]),
  mimeType: z.union([CollectedKnownString, CollectedUnknown]),
  references: z.array(MaterialReference),
}).strict();
export type RawMaterialObservation = z.infer<typeof RawMaterialObservation>;

export const QuizAttemptFact = z.object({
  field: z.enum(["state", "allowed", "used", "remaining", "other"]),
  rawText: z.string(),
  location: z.enum(["quiz.attemptInformation.state", "quiz.attemptInformation.allowed", "quiz.attemptInformation.used", "quiz.attemptInformation.remaining", "quiz.attemptInformation.other"]),
}).strict();
export type QuizAttemptFact = z.infer<typeof QuizAttemptFact>;

export const QuizKnownAttempts = z.object({
  kind: z.literal("known"),
  facts: z.array(QuizAttemptFact).min(1),
  unknownFields: z.array(z.enum(["state", "allowed", "used", "remaining", "other"])),
}).strict();
export type QuizKnownAttempts = z.infer<typeof QuizKnownAttempts>;

export const RawQuizObservation = z.object({
  sourceCourseId: z.string(),
  sourceActivityId: z.string(),
  sourceCourseModuleId: z.string(),
  sourceUrl: z.string(),
  title: z.string(),
  observedAt: z.string(),
  opening: CollectedDateObservation.optional(),
  closing: CollectedDateObservation.optional(),
  attemptInformation: z.union([QuizKnownAttempts, CollectedUnknown]),
}).strict();
export type RawQuizObservation = z.infer<typeof RawQuizObservation>;

export const SubmissionSourceRecord = z.object({
  sourceCourseId: z.string(),
  sourceActivityId: z.string(),
  sourceCourseModuleId: z.string(),
  sourceUrl: z.string(),
  observation: SubmissionObservation,
}).strict();
export type SubmissionSourceRecord = z.infer<typeof SubmissionSourceRecord>;

export const RetainedSubmission = z.object({
  attempted: SubmissionSourceRecord,
  confirmed: SubmissionSourceRecord.optional(),
  stale: z.boolean(),
}).strict();
export type RetainedSubmission = z.infer<typeof RetainedSubmission>;

export const CalendarSafeReview = z.object({
  kind: z.literal("calendar"),
  candidate: CalendarCandidate,
  reasons: z.array(z.enum(["collector_unavailable", "collection_disabled", "envelope_unavailable", "access_error", "collector_failed", "persistence_failed", "invalid_context", "invalid_selection", "invalid_identity", "unsupported_page", "malformed_result", "invalid_observed_at", "invalid_batch_arguments", "invalid_page", "malformed_record", "empty_marker", "site_event", "personal_event", "non_assessment", "unselected_course", "unknown_kind", "missing_course", "unreliable_course", "unknown_date", "missing_dates", "event_conflict", "unsupported_structure", "identity_mismatch", "missing_identity", "malformed_candidate", "unsafe_url", "unsafe_external_url", "missing_metadata", "type_conflict", "invalid_mime", "unsafe_label", "field_conflict", "parent_conflict", "pagination_pending", "incomplete_list", "empty_unconfirmed", "empty_conflict", "folder_contents_uninspected", "listing_conflict", "invalid_date", "unsupported_date", "duplicate_date", "malformed_assignment", "incomplete_assignment"])),
}).strict();
export type CalendarSafeReview = z.infer<typeof CalendarSafeReview>;

export const MaterialSafeReview = z.object({
  kind: z.literal("material"),
  candidate: RawMaterialObservation.optional(),
  reasons: z.array(z.enum(["collector_unavailable", "collection_disabled", "envelope_unavailable", "access_error", "collector_failed", "persistence_failed", "invalid_context", "invalid_selection", "invalid_identity", "unsupported_page", "malformed_result", "invalid_observed_at", "invalid_batch_arguments", "invalid_page", "malformed_record", "empty_marker", "site_event", "personal_event", "non_assessment", "unselected_course", "unknown_kind", "missing_course", "unreliable_course", "unknown_date", "missing_dates", "event_conflict", "unsupported_structure", "identity_mismatch", "missing_identity", "malformed_candidate", "unsafe_url", "unsafe_external_url", "missing_metadata", "type_conflict", "invalid_mime", "unsafe_label", "field_conflict", "parent_conflict", "pagination_pending", "incomplete_list", "empty_unconfirmed", "empty_conflict", "folder_contents_uninspected", "listing_conflict", "invalid_date", "unsupported_date", "duplicate_date", "malformed_assignment", "incomplete_assignment"])),
}).strict();
export type MaterialSafeReview = z.infer<typeof MaterialSafeReview>;

export const CollectionReview = z.object({
  id: z.string(),
  visitId: z.string(),
  collector: z.enum(["assignment", "calendar", "material", "quiz", "submission"]),
  reasons: z.array(z.enum(["collector_unavailable", "collection_disabled", "envelope_unavailable", "access_error", "collector_failed", "persistence_failed", "invalid_context", "invalid_selection", "invalid_identity", "unsupported_page", "malformed_result", "invalid_observed_at", "invalid_batch_arguments", "invalid_page", "malformed_record", "empty_marker", "site_event", "personal_event", "non_assessment", "unselected_course", "unknown_kind", "missing_course", "unreliable_course", "unknown_date", "missing_dates", "event_conflict", "unsupported_structure", "identity_mismatch", "missing_identity", "malformed_candidate", "unsafe_url", "unsafe_external_url", "missing_metadata", "type_conflict", "invalid_mime", "unsafe_label", "field_conflict", "parent_conflict", "pagination_pending", "incomplete_list", "empty_unconfirmed", "empty_conflict", "folder_contents_uninspected", "listing_conflict", "invalid_date", "unsupported_date", "duplicate_date", "malformed_assignment", "incomplete_assignment"])),
  candidate: z.union([CalendarCandidate, RawMaterialObservation]).optional(),
}).strict();
export type CollectionReview = z.infer<typeof CollectionReview>;

export const CollectionDiagnostic = z.object({
  reason: z.enum(["collector_unavailable", "collection_disabled", "envelope_unavailable", "access_error", "collector_failed", "persistence_failed", "invalid_context", "invalid_selection", "invalid_identity", "unsupported_page", "malformed_result", "invalid_observed_at", "invalid_batch_arguments", "invalid_page", "malformed_record", "empty_marker", "site_event", "personal_event", "non_assessment", "unselected_course", "unknown_kind", "missing_course", "unreliable_course", "unknown_date", "missing_dates", "event_conflict", "unsupported_structure", "identity_mismatch", "missing_identity", "malformed_candidate", "unsafe_url", "unsafe_external_url", "missing_metadata", "type_conflict", "invalid_mime", "unsafe_label", "field_conflict", "parent_conflict", "pagination_pending", "incomplete_list", "empty_unconfirmed", "empty_conflict", "folder_contents_uninspected", "listing_conflict", "invalid_date", "unsupported_date", "duplicate_date", "malformed_assignment", "incomplete_assignment"]),
  pageIndex: z.number().int(),
  recordIndex: z.number().int().optional(),
}).strict();
export type CollectionDiagnostic = z.infer<typeof CollectionDiagnostic>;

export const CollectionRange = z.object({
  start: z.string(),
  end: z.string(),
}).strict();
export type CollectionRange = z.infer<typeof CollectionRange>;

export const CollectionPage = z.object({
  coverage: z.enum(["complete", "partial", "none"]),
  candidateCount: z.number().int(),
  paginationPending: z.boolean(),
  range: CollectionRange.optional(),
  pageIndex: z.number().int().optional(),
}).strict();
export type CollectionPage = z.infer<typeof CollectionPage>;

export const AssignmentRefreshResult = z.object({
  kind: z.literal("assignment"),
  observations: z.array(RawAssignmentObservation),
  reviews: z.array(z.union([CalendarSafeReview, MaterialSafeReview])),
  diagnostics: z.array(CollectionDiagnostic),
  pages: z.array(CollectionPage),
  coverage: z.enum(["complete", "partial", "none"]),
  scope: z.enum(["visited_activity_only", "supplied_pages_only", "supplied_ranges_only"]),
}).strict();
export type AssignmentRefreshResult = z.infer<typeof AssignmentRefreshResult>;

export const NormalizedAssignmentRecord = z.object({
  id: z.string(),
  courseId: z.string(),
  kind: z.literal("assignment"),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  observations: z.array(RawAssignmentObservation).min(1),
}).strict();
export type NormalizedAssignmentRecord = z.infer<typeof NormalizedAssignmentRecord>;

export const CalendarRefreshResult = z.object({
  kind: z.literal("calendar"),
  observations: z.array(RawCalendarObservation),
  reviews: z.array(z.union([CalendarSafeReview, MaterialSafeReview])),
  diagnostics: z.array(CollectionDiagnostic),
  pages: z.array(CollectionPage),
  coverage: z.enum(["complete", "partial", "none"]),
  scope: z.enum(["visited_activity_only", "supplied_pages_only", "supplied_ranges_only"]),
}).strict();
export type CalendarRefreshResult = z.infer<typeof CalendarRefreshResult>;

export const NormalizedCalendarRecord = z.object({
  id: z.string(),
  courseId: z.string(),
  kind: z.literal("calendar"),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  observations: z.array(RawCalendarObservation).min(1),
}).strict();
export type NormalizedCalendarRecord = z.infer<typeof NormalizedCalendarRecord>;

export const MaterialRefreshResult = z.object({
  kind: z.literal("material"),
  observations: z.array(RawMaterialObservation),
  reviews: z.array(z.union([CalendarSafeReview, MaterialSafeReview])),
  diagnostics: z.array(CollectionDiagnostic),
  pages: z.array(CollectionPage),
  coverage: z.enum(["complete", "partial", "none"]),
  scope: z.enum(["visited_activity_only", "supplied_pages_only", "supplied_ranges_only"]),
}).strict();
export type MaterialRefreshResult = z.infer<typeof MaterialRefreshResult>;

export const NormalizedMaterialRecord = z.object({
  id: z.string(),
  courseId: z.string(),
  kind: z.literal("material"),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  observations: z.array(RawMaterialObservation).min(1),
}).strict();
export type NormalizedMaterialRecord = z.infer<typeof NormalizedMaterialRecord>;

export const QuizRefreshResult = z.object({
  kind: z.literal("quiz"),
  observations: z.array(RawQuizObservation),
  reviews: z.array(z.union([CalendarSafeReview, MaterialSafeReview])),
  diagnostics: z.array(CollectionDiagnostic),
  pages: z.array(CollectionPage),
  coverage: z.enum(["complete", "partial", "none"]),
  scope: z.enum(["visited_activity_only", "supplied_pages_only", "supplied_ranges_only"]),
}).strict();
export type QuizRefreshResult = z.infer<typeof QuizRefreshResult>;

export const NormalizedQuizRecord = z.object({
  id: z.string(),
  courseId: z.string(),
  kind: z.literal("quiz"),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  observations: z.array(RawQuizObservation).min(1),
}).strict();
export type NormalizedQuizRecord = z.infer<typeof NormalizedQuizRecord>;

export const SubmissionRefreshResult = z.object({
  kind: z.literal("submission"),
  observations: z.array(SubmissionSourceRecord),
  reviews: z.array(z.union([CalendarSafeReview, MaterialSafeReview])),
  diagnostics: z.array(CollectionDiagnostic),
  pages: z.array(CollectionPage),
  coverage: z.enum(["complete", "partial", "none"]),
  scope: z.enum(["visited_activity_only", "supplied_pages_only", "supplied_ranges_only"]),
}).strict();
export type SubmissionRefreshResult = z.infer<typeof SubmissionRefreshResult>;

export const NormalizedSubmissionRecord = z.object({
  id: z.string(),
  courseId: z.string(),
  kind: z.literal("submission"),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  observations: z.array(RetainedSubmission).min(1),
}).strict();
export type NormalizedSubmissionRecord = z.infer<typeof NormalizedSubmissionRecord>;

export const UnavailableRefreshResult = z.object({
  kind: z.literal("unavailable"),
  reasons: z.array(z.enum(["collector_unavailable", "collection_disabled", "envelope_unavailable", "access_error", "collector_failed", "persistence_failed", "invalid_context", "invalid_selection", "invalid_identity", "unsupported_page", "malformed_result", "invalid_observed_at", "invalid_batch_arguments", "invalid_page", "malformed_record", "empty_marker", "site_event", "personal_event", "non_assessment", "unselected_course", "unknown_kind", "missing_course", "unreliable_course", "unknown_date", "missing_dates", "event_conflict", "unsupported_structure", "identity_mismatch", "missing_identity", "malformed_candidate", "unsafe_url", "unsafe_external_url", "missing_metadata", "type_conflict", "invalid_mime", "unsafe_label", "field_conflict", "parent_conflict", "pagination_pending", "incomplete_list", "empty_unconfirmed", "empty_conflict", "folder_contents_uninspected", "listing_conflict", "invalid_date", "unsupported_date", "duplicate_date", "malformed_assignment", "incomplete_assignment"])),
}).strict();
export type UnavailableRefreshResult = z.infer<typeof UnavailableRefreshResult>;

export const FailedRefreshResult = z.object({
  kind: z.literal("failed"),
  reasons: z.array(z.enum(["collector_unavailable", "collection_disabled", "envelope_unavailable", "access_error", "collector_failed", "persistence_failed", "invalid_context", "invalid_selection", "invalid_identity", "unsupported_page", "malformed_result", "invalid_observed_at", "invalid_batch_arguments", "invalid_page", "malformed_record", "empty_marker", "site_event", "personal_event", "non_assessment", "unselected_course", "unknown_kind", "missing_course", "unreliable_course", "unknown_date", "missing_dates", "event_conflict", "unsupported_structure", "identity_mismatch", "missing_identity", "malformed_candidate", "unsafe_url", "unsafe_external_url", "missing_metadata", "type_conflict", "invalid_mime", "unsafe_label", "field_conflict", "parent_conflict", "pagination_pending", "incomplete_list", "empty_unconfirmed", "empty_conflict", "folder_contents_uninspected", "listing_conflict", "invalid_date", "unsupported_date", "duplicate_date", "malformed_assignment", "incomplete_assignment"])),
}).strict();
export type FailedRefreshResult = z.infer<typeof FailedRefreshResult>;

export const CollectorResult = z.union([AssignmentRefreshResult, CalendarRefreshResult, MaterialRefreshResult, QuizRefreshResult, SubmissionRefreshResult, UnavailableRefreshResult, FailedRefreshResult]);
export type CollectorResult = z.infer<typeof CollectorResult>;

export const NormalizedSourceRecord = z.union([NormalizedAssignmentRecord, NormalizedCalendarRecord, NormalizedMaterialRecord, NormalizedQuizRecord, NormalizedSubmissionRecord]);
export type NormalizedSourceRecord = z.infer<typeof NormalizedSourceRecord>;

export const PageRefreshReceipt = z.object({
  visitId: z.string(),
  pageUrl: z.string(),
  observedAt: z.string(),
  collector: z.enum(["assignment", "calendar", "material", "quiz", "submission"]),
  sourceCourseIds: z.array(z.string()),
  sourceActivityId: z.string().optional(),
  sourceCourseModuleId: z.string().optional(),
  outcome: z.enum(["ok", "partial", "failed", "unavailable"]),
  coverage: z.enum(["complete", "partial", "none"]),
  scope: z.enum(["visited_activity_only", "supplied_pages_only", "supplied_ranges_only"]),
  reasons: z.array(z.enum(["collector_unavailable", "collection_disabled", "envelope_unavailable", "access_error", "collector_failed", "persistence_failed", "invalid_context", "invalid_selection", "invalid_identity", "unsupported_page", "malformed_result", "invalid_observed_at", "invalid_batch_arguments", "invalid_page", "malformed_record", "empty_marker", "site_event", "personal_event", "non_assessment", "unselected_course", "unknown_kind", "missing_course", "unreliable_course", "unknown_date", "missing_dates", "event_conflict", "unsupported_structure", "identity_mismatch", "missing_identity", "malformed_candidate", "unsafe_url", "unsafe_external_url", "missing_metadata", "type_conflict", "invalid_mime", "unsafe_label", "field_conflict", "parent_conflict", "pagination_pending", "incomplete_list", "empty_unconfirmed", "empty_conflict", "folder_contents_uninspected", "listing_conflict", "invalid_date", "unsupported_date", "duplicate_date", "malformed_assignment", "incomplete_assignment"])),
  evidenceMode: z.enum(["synthetic", "verified"]),
  pages: z.array(CollectionPage),
}).strict();
export type PageRefreshReceipt = z.infer<typeof PageRefreshReceipt>;

export const SnapshotCollection = z.object({
  records: z.array(NormalizedSourceRecord),
  reviews: z.array(CollectionReview),
  refreshes: z.array(PageRefreshReceipt),
}).strict();
export type SnapshotCollection = z.infer<typeof SnapshotCollection>;

export const CollectionCourse = z.object({
  courseId: z.string(),
  sourceCourseId: z.string(),
}).strict();
export type CollectionCourse = z.infer<typeof CollectionCourse>;

export const CollectionContext = z.object({
  version: z.literal("1"),
  binding: z.string(),
  mode: z.enum(["disabled", "synthetic", "verified"]),
  selectionRevision: z.string(),
  courses: z.array(CollectionCourse),
  reason: z.enum(["collection_disabled", "invalid_context", "invalid_selection"]).optional(),
}).strict();
export type CollectionContext = z.infer<typeof CollectionContext>;

export const BeginPageVisit = z.object({
  documentKey: z.string(),
  visitId: z.string(),
  pageUrl: z.string(),
  selectionRevision: z.string(),
}).strict();
export type BeginPageVisit = z.infer<typeof BeginPageVisit>;

export const PageVisitToken = z.object({
  visitToken: z.string(),
}).strict();
export type PageVisitToken = z.infer<typeof PageVisitToken>;

export const PageRefreshInput = z.object({
  visitToken: z.string(),
  observedAt: z.string(),
  collector: z.enum(["assignment", "calendar", "material", "quiz", "submission"]),
  result: CollectorResult,
}).strict();
export type PageRefreshInput = z.infer<typeof PageRefreshInput>;

// END GENERATED COLLECTION MODELS

export const Snapshot = z.object({
  collection: SnapshotCollection.optional(),
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
