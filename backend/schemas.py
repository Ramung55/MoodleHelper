"""Wire models corresponding to root openapi.yaml (camelCase is intentional).

Optional properties may be omitted, but JSON null is not a valid value. Strings
remain strings: the contract deliberately specifies no URL/timezone validation.
"""

from typing import Annotated, Any, ClassVar, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator


def json_integer(value: Any) -> Any:
    # JSON Schema permits 1.0 as an integer, but never true or "1".
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


Integer = Annotated[int, BeforeValidator(json_integer)]
AssessmentType = Literal["assignment", "quiz", "exam", "other"]
SubmissionStatus = Literal["submitted", "draft", "not_submitted", "reopened", "unknown"]


def omit_absence_defaults(schema: dict) -> None:
    # None is an internal placeholder for omitted fields, not a wire default.
    for field in schema.get("properties", {}).values():
        if "default" in field and field["default"] is None:
            field.pop("default")


class WireModel(BaseModel):
    nullable_properties: ClassVar[frozenset[str]] = frozenset()
    model_config = ConfigDict(strict=True, extra="ignore", allow_inf_nan=False,
                              json_schema_extra=omit_absence_defaults)

    @model_validator(mode="before")
    @classmethod
    def reject_null_properties(cls, value: Any) -> Any:
        if isinstance(value, dict):
            for name, field in cls.model_fields.items():
                key = field.alias or name
                if key in value and value[key] is None and key not in cls.nullable_properties:
                    raise ValueError(f"{key} cannot be null; omit optional properties")
        return value


class ExactDate(WireModel):
    kind: Literal["exact"]
    iso: str
    tz: str


class CalendarDate(WireModel):
    kind: Literal["date"]
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class TeachingWeek(WireModel):
    kind: Literal["week"]
    week: Integer = Field(ge=1, le=30)


class UnknownDate(WireModel):
    kind: Literal["unknown"]
    note: str = None


DateValue = Annotated[ExactDate | CalendarDate | TeachingWeek | UnknownDate, Field(discriminator="kind")]


class KnownString(WireModel):
    kind: Literal["known"]
    value: str


class KnownStrings(WireModel):
    kind: Literal["known"]
    value: list[str]


class UnknownFact(WireModel):
    kind: Literal["unknown"]


class RawCourseObservation(WireModel):
    sourceCourseId: str
    sourceUrl: str
    title: Annotated[KnownString | UnknownFact, Field(discriminator="kind")]
    termIndicators: Annotated[KnownStrings | UnknownFact, Field(discriminator="kind")]


class CourseDiscovery(RawCourseObservation):
    currentTermStatus: Literal["current", "past", "unknown"]


class CourseDiscoveryInput(WireModel):
    observations: list[RawCourseObservation]


class Course(WireModel):
    id: str
    code: str
    name: str
    color: Integer = Field(ge=1, le=6)
    current: bool
    discovery: CourseDiscovery = None


class SourceEvidence(WireModel):
    source: Literal["moodle", "syllabus", "personal"]
    date: DateValue
    excerpt: str = None
    location: str = None
    url: str = None
    observedAt: str


class SubmissionObservation(WireModel):
    status: SubmissionStatus
    evidence: str = None
    observedAt: str


class Assessment(WireModel):
    id: str
    activityId: str = None
    courseId: str
    title: str
    type: AssessmentType
    availableFrom: str = None
    sources: list[SourceEvidence] = Field(min_length=1)
    submission: SubmissionObservation = None
    personal: bool = Field(json_schema_extra={"default": False})
    firstObservedAt: str
    lastObservedAt: str


class OverlayPatch(WireModel):
    nullable_properties: ClassVar[frozenset[str]] = frozenset({"titleOverride", "dateOverride", "overrideBase"})
    titleOverride: str | None = None
    dateOverride: DateValue | None = None
    overrideBase: DateValue | None = None
    hidden: bool = None
    completed: bool = None

    @model_validator(mode="after")
    def consistent_clear(self):
        if "dateOverride" in self.model_fields_set and self.dateOverride is None and self.overrideBase is not None:
            raise ValueError("Clearing dateOverride cannot set a nonnull overrideBase")
        return self


class Overlay(WireModel):
    assessmentId: str
    titleOverride: str = None
    dateOverride: DateValue = None
    overrideBase: DateValue = None
    hidden: bool = Field(json_schema_extra={"default": False})
    completed: bool = Field(json_schema_extra={"default": False})


class Material(WireModel):
    id: str
    courseId: str
    section: str
    title: str
    fileType: Literal["pdf", "docx", "pptx", "link", "video", "other"]
    url: str
    accessible: bool
    stale: bool
    lastCheckedAt: str
    downloadedAt: str = None
    syllabusSuggestion: bool = Field(json_schema_extra={"default": False})


class ImportedDocument(WireModel):
    id: str
    courseId: str
    name: str
    format: Literal["pdf", "docx"]
    status: Literal["queued", "extracting", "done", "failed", "needs_ocr"]
    progress: float = Field(ge=0, le=100)
    error: str = None
    importedAt: str
    mocked: bool


class ExtractionCandidate(WireModel):
    id: str
    documentId: str
    courseId: str
    title: str
    type: AssessmentType
    date: DateValue
    rawDateText: str
    language: Literal["en", "ru"]
    confidence: float = Field(ge=0, le=1)
    excerpt: str
    location: str
    status: Literal["pending", "confirmed", "corrected", "rejected", "auto"]
    matchAssessmentId: str = None
    reason: str = None


class CourseSyncState(WireModel):
    courseId: str
    status: Literal["ok", "partial", "failed", "never", "syncing"]
    coverage: Literal["full", "partial", "none"]
    lastSuccessAt: str = None
    error: str = None
    progress: float = Field(ge=0, le=100)


class DeadlineChange(WireModel):
    id: str
    assessmentId: str
    from_: DateValue = Field(alias="from")
    to: DateValue
    detectedAt: str


class Alert(WireModel):
    id: str
    kind: Literal["deadline", "busy_week", "change", "sync"]
    message: str
    assessmentId: str = None
    deliveryKey: str
    createdAt: str
    read: bool


class Weights(WireModel):
    exam: float
    assignment: float
    quiz: float
    other: float


class Thresholds(WireModel):
    maxOutstanding: float
    maxWeighted: float


class ReminderSettings(WireModel):
    enabled: bool
    hoursBefore: float
    busyWeek: bool


class AiSettings(WireModel):
    enabled: bool
    consentGiven: bool


class SettingsPatch(WireModel):
    trackedCourseIds: list[str] = None
    semesterStart: str = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    semesterWeeks: Integer = Field(default=None, ge=1, le=30)
    timezone: str = None
    weights: Weights = None
    thresholds: Thresholds = None
    reminders: ReminderSettings = None
    ai: AiSettings = None


class Settings(SettingsPatch):
    trackedCourseIds: list[str]
    semesterStart: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    semesterWeeks: Integer = Field(ge=1, le=30)
    timezone: str
    weights: Weights
    thresholds: Thresholds
    reminders: ReminderSettings
    ai: AiSettings


# BEGIN GENERATED COLLECTION MODELS
class CollectionWire(WireModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False, json_schema_extra=omit_absence_defaults)

class CollectedDateObservation(CollectionWire):
    value: DateValue
    rawText: str
    location: str

class AssignmentDates(CollectionWire):
    opening: CollectedDateObservation = None
    due: CollectedDateObservation = None
    cutoff: CollectedDateObservation = None

class IndividualExtension(CollectionWire):
    field: Literal['opening', 'due', 'cutoff']
    date: CollectedDateObservation
    evidence: str
    scope: Literal['individual']

class RawAssignmentObservation(CollectionWire):
    sourceCourseId: str
    sourceActivityId: str
    sourceCourseModuleId: str
    sourceUrl: str
    title: str
    observedAt: str
    baseDates: AssignmentDates
    individualExtensions: list[IndividualExtension]
    effectiveDates: AssignmentDates

class CalendarActivity(CollectionWire):
    moduleType: Literal['assign', 'quiz']
    sourceActivityId: str
    sourceCourseModuleId: str
    sourceUrl: str

class CalendarCandidate(CollectionWire):
    sourceEventId: str
    sourceOccurrenceId: str = None
    sourceSeriesId: str = None
    sourceCourseId: str = None
    title: str
    sourceUrl: str
    observedAt: str
    start: CollectedDateObservation = None
    end: CollectedDateObservation = None
    date: CollectedDateObservation = None
    activity: CalendarActivity = None

class RawCalendarObservation(CollectionWire):
    sourceEventId: str
    sourceOccurrenceId: str = None
    sourceSeriesId: str = None
    sourceCourseId: str
    title: str
    sourceUrl: str
    observedAt: str
    start: CollectedDateObservation = None
    end: CollectedDateObservation = None
    date: CollectedDateObservation = None
    activity: CalendarActivity = None

class CollectedKnownString(CollectionWire):
    kind: Literal['known']
    value: str

class CollectedKnownFileType(CollectionWire):
    kind: Literal['known']
    value: Literal['pdf', 'docx', 'pptx', 'link', 'video', 'other']

class CollectedUnknown(CollectionWire):
    kind: Literal['unknown']

class MaterialReference(CollectionWire):
    sourcePageUrl: str
    sourceUrl: str
    destinationUrl: str = None
    observedAt: str
    location: Literal['course.material', 'activity.material', 'folder.entry']
    listingScope: Literal['reference_only', 'supplied_listing_only'] = None
    listingCoverage: Literal['complete', 'partial', 'none'] = None
    listingChildResourceKeys: list[str] = None

class RawMaterialObservation(CollectionWire):
    sourcePageUrl: str
    sourceUrl: str
    destinationUrl: str = None
    observedAt: str
    location: Literal['course.material', 'activity.material', 'folder.entry']
    listingScope: Literal['reference_only', 'supplied_listing_only'] = None
    listingCoverage: Literal['complete', 'partial', 'none'] = None
    listingChildResourceKeys: list[str] = None
    sourceCourseId: str
    sourceCourseModuleId: str
    sourceModuleType: Literal['resource', 'url', 'folder']
    sourceResourceId: str = None
    sourceFileId: str = None
    sourceFolderId: str = None
    sourceContextId: str = None
    resourceKey: str
    parentResourceKey: str = None
    kind: Literal['file', 'link', 'folder']
    title: CollectedKnownString | CollectedUnknown
    section: CollectedKnownString | CollectedUnknown
    fileType: CollectedKnownFileType | CollectedUnknown
    mimeType: CollectedKnownString | CollectedUnknown
    references: list[MaterialReference]

class QuizAttemptFact(CollectionWire):
    field: Literal['state', 'allowed', 'used', 'remaining', 'other']
    rawText: str
    location: Literal['quiz.attemptInformation.state', 'quiz.attemptInformation.allowed', 'quiz.attemptInformation.used', 'quiz.attemptInformation.remaining', 'quiz.attemptInformation.other']

class QuizKnownAttempts(CollectionWire):
    kind: Literal['known']
    facts: list[QuizAttemptFact] = Field(min_length=1)
    unknownFields: list[Literal['state', 'allowed', 'used', 'remaining', 'other']]

class RawQuizObservation(CollectionWire):
    sourceCourseId: str
    sourceActivityId: str
    sourceCourseModuleId: str
    sourceUrl: str
    title: str
    observedAt: str
    opening: CollectedDateObservation = None
    closing: CollectedDateObservation = None
    attemptInformation: QuizKnownAttempts | CollectedUnknown

class SubmissionSourceRecord(CollectionWire):
    sourceCourseId: str
    sourceActivityId: str
    sourceCourseModuleId: str
    sourceUrl: str
    observation: SubmissionObservation

class RetainedSubmission(CollectionWire):
    attempted: SubmissionSourceRecord
    confirmed: SubmissionSourceRecord = None
    stale: bool

class CalendarSafeReview(CollectionWire):
    kind: Literal['calendar']
    candidate: CalendarCandidate
    reasons: list[Literal['collector_unavailable', 'collection_disabled', 'envelope_unavailable', 'access_error', 'collector_failed', 'persistence_failed', 'invalid_context', 'invalid_selection', 'invalid_identity', 'unsupported_page', 'malformed_result', 'invalid_observed_at', 'invalid_batch_arguments', 'invalid_page', 'malformed_record', 'empty_marker', 'site_event', 'personal_event', 'non_assessment', 'unselected_course', 'unknown_kind', 'missing_course', 'unreliable_course', 'unknown_date', 'missing_dates', 'event_conflict', 'unsupported_structure', 'identity_mismatch', 'missing_identity', 'malformed_candidate', 'unsafe_url', 'unsafe_external_url', 'missing_metadata', 'type_conflict', 'invalid_mime', 'unsafe_label', 'field_conflict', 'parent_conflict', 'pagination_pending', 'incomplete_list', 'empty_unconfirmed', 'empty_conflict', 'folder_contents_uninspected', 'listing_conflict', 'invalid_date', 'unsupported_date', 'duplicate_date', 'malformed_assignment', 'incomplete_assignment']]

class MaterialSafeReview(CollectionWire):
    kind: Literal['material']
    candidate: RawMaterialObservation = None
    reasons: list[Literal['collector_unavailable', 'collection_disabled', 'envelope_unavailable', 'access_error', 'collector_failed', 'persistence_failed', 'invalid_context', 'invalid_selection', 'invalid_identity', 'unsupported_page', 'malformed_result', 'invalid_observed_at', 'invalid_batch_arguments', 'invalid_page', 'malformed_record', 'empty_marker', 'site_event', 'personal_event', 'non_assessment', 'unselected_course', 'unknown_kind', 'missing_course', 'unreliable_course', 'unknown_date', 'missing_dates', 'event_conflict', 'unsupported_structure', 'identity_mismatch', 'missing_identity', 'malformed_candidate', 'unsafe_url', 'unsafe_external_url', 'missing_metadata', 'type_conflict', 'invalid_mime', 'unsafe_label', 'field_conflict', 'parent_conflict', 'pagination_pending', 'incomplete_list', 'empty_unconfirmed', 'empty_conflict', 'folder_contents_uninspected', 'listing_conflict', 'invalid_date', 'unsupported_date', 'duplicate_date', 'malformed_assignment', 'incomplete_assignment']]

class CollectionReview(CollectionWire):
    id: str
    visitId: str
    collector: Literal['assignment', 'calendar', 'material', 'quiz', 'submission']
    reasons: list[Literal['collector_unavailable', 'collection_disabled', 'envelope_unavailable', 'access_error', 'collector_failed', 'persistence_failed', 'invalid_context', 'invalid_selection', 'invalid_identity', 'unsupported_page', 'malformed_result', 'invalid_observed_at', 'invalid_batch_arguments', 'invalid_page', 'malformed_record', 'empty_marker', 'site_event', 'personal_event', 'non_assessment', 'unselected_course', 'unknown_kind', 'missing_course', 'unreliable_course', 'unknown_date', 'missing_dates', 'event_conflict', 'unsupported_structure', 'identity_mismatch', 'missing_identity', 'malformed_candidate', 'unsafe_url', 'unsafe_external_url', 'missing_metadata', 'type_conflict', 'invalid_mime', 'unsafe_label', 'field_conflict', 'parent_conflict', 'pagination_pending', 'incomplete_list', 'empty_unconfirmed', 'empty_conflict', 'folder_contents_uninspected', 'listing_conflict', 'invalid_date', 'unsupported_date', 'duplicate_date', 'malformed_assignment', 'incomplete_assignment']]
    candidate: CalendarCandidate | RawMaterialObservation = None

class CollectionDiagnostic(CollectionWire):
    reason: Literal['collector_unavailable', 'collection_disabled', 'envelope_unavailable', 'access_error', 'collector_failed', 'persistence_failed', 'invalid_context', 'invalid_selection', 'invalid_identity', 'unsupported_page', 'malformed_result', 'invalid_observed_at', 'invalid_batch_arguments', 'invalid_page', 'malformed_record', 'empty_marker', 'site_event', 'personal_event', 'non_assessment', 'unselected_course', 'unknown_kind', 'missing_course', 'unreliable_course', 'unknown_date', 'missing_dates', 'event_conflict', 'unsupported_structure', 'identity_mismatch', 'missing_identity', 'malformed_candidate', 'unsafe_url', 'unsafe_external_url', 'missing_metadata', 'type_conflict', 'invalid_mime', 'unsafe_label', 'field_conflict', 'parent_conflict', 'pagination_pending', 'incomplete_list', 'empty_unconfirmed', 'empty_conflict', 'folder_contents_uninspected', 'listing_conflict', 'invalid_date', 'unsupported_date', 'duplicate_date', 'malformed_assignment', 'incomplete_assignment']
    pageIndex: Integer
    recordIndex: Integer = None

class CollectionRange(CollectionWire):
    start: str
    end: str

class CollectionPage(CollectionWire):
    coverage: Literal['complete', 'partial', 'none']
    candidateCount: Integer
    paginationPending: bool
    range: CollectionRange = None
    pageIndex: Integer = None

class AssignmentRefreshResult(CollectionWire):
    kind: Literal['assignment']
    observations: list[RawAssignmentObservation]
    reviews: list[CalendarSafeReview | MaterialSafeReview]
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only', 'supplied_pages_only', 'supplied_ranges_only']

class NormalizedAssignmentRecord(CollectionWire):
    id: str
    courseId: str
    kind: Literal['assignment']
    firstObservedAt: str
    lastObservedAt: str
    observations: list[RawAssignmentObservation] = Field(min_length=1)

class CalendarRefreshResult(CollectionWire):
    kind: Literal['calendar']
    observations: list[RawCalendarObservation]
    reviews: list[CalendarSafeReview | MaterialSafeReview]
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only', 'supplied_pages_only', 'supplied_ranges_only']

class NormalizedCalendarRecord(CollectionWire):
    id: str
    courseId: str
    kind: Literal['calendar']
    firstObservedAt: str
    lastObservedAt: str
    observations: list[RawCalendarObservation] = Field(min_length=1)

class MaterialRefreshResult(CollectionWire):
    kind: Literal['material']
    observations: list[RawMaterialObservation]
    reviews: list[CalendarSafeReview | MaterialSafeReview]
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only', 'supplied_pages_only', 'supplied_ranges_only']

class NormalizedMaterialRecord(CollectionWire):
    id: str
    courseId: str
    kind: Literal['material']
    firstObservedAt: str
    lastObservedAt: str
    observations: list[RawMaterialObservation] = Field(min_length=1)

class QuizRefreshResult(CollectionWire):
    kind: Literal['quiz']
    observations: list[RawQuizObservation]
    reviews: list[CalendarSafeReview | MaterialSafeReview]
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only', 'supplied_pages_only', 'supplied_ranges_only']

class NormalizedQuizRecord(CollectionWire):
    id: str
    courseId: str
    kind: Literal['quiz']
    firstObservedAt: str
    lastObservedAt: str
    observations: list[RawQuizObservation] = Field(min_length=1)

class SubmissionRefreshResult(CollectionWire):
    kind: Literal['submission']
    observations: list[SubmissionSourceRecord]
    reviews: list[CalendarSafeReview | MaterialSafeReview]
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only', 'supplied_pages_only', 'supplied_ranges_only']

class NormalizedSubmissionRecord(CollectionWire):
    id: str
    courseId: str
    kind: Literal['submission']
    firstObservedAt: str
    lastObservedAt: str
    observations: list[RetainedSubmission] = Field(min_length=1)

class UnavailableRefreshResult(CollectionWire):
    kind: Literal['unavailable']
    reasons: list[Literal['collector_unavailable', 'collection_disabled', 'envelope_unavailable', 'access_error', 'collector_failed', 'persistence_failed', 'invalid_context', 'invalid_selection', 'invalid_identity', 'unsupported_page', 'malformed_result', 'invalid_observed_at', 'invalid_batch_arguments', 'invalid_page', 'malformed_record', 'empty_marker', 'site_event', 'personal_event', 'non_assessment', 'unselected_course', 'unknown_kind', 'missing_course', 'unreliable_course', 'unknown_date', 'missing_dates', 'event_conflict', 'unsupported_structure', 'identity_mismatch', 'missing_identity', 'malformed_candidate', 'unsafe_url', 'unsafe_external_url', 'missing_metadata', 'type_conflict', 'invalid_mime', 'unsafe_label', 'field_conflict', 'parent_conflict', 'pagination_pending', 'incomplete_list', 'empty_unconfirmed', 'empty_conflict', 'folder_contents_uninspected', 'listing_conflict', 'invalid_date', 'unsupported_date', 'duplicate_date', 'malformed_assignment', 'incomplete_assignment']]

class FailedRefreshResult(CollectionWire):
    kind: Literal['failed']
    reasons: list[Literal['collector_unavailable', 'collection_disabled', 'envelope_unavailable', 'access_error', 'collector_failed', 'persistence_failed', 'invalid_context', 'invalid_selection', 'invalid_identity', 'unsupported_page', 'malformed_result', 'invalid_observed_at', 'invalid_batch_arguments', 'invalid_page', 'malformed_record', 'empty_marker', 'site_event', 'personal_event', 'non_assessment', 'unselected_course', 'unknown_kind', 'missing_course', 'unreliable_course', 'unknown_date', 'missing_dates', 'event_conflict', 'unsupported_structure', 'identity_mismatch', 'missing_identity', 'malformed_candidate', 'unsafe_url', 'unsafe_external_url', 'missing_metadata', 'type_conflict', 'invalid_mime', 'unsafe_label', 'field_conflict', 'parent_conflict', 'pagination_pending', 'incomplete_list', 'empty_unconfirmed', 'empty_conflict', 'folder_contents_uninspected', 'listing_conflict', 'invalid_date', 'unsupported_date', 'duplicate_date', 'malformed_assignment', 'incomplete_assignment']]

CollectorResult = AssignmentRefreshResult | CalendarRefreshResult | MaterialRefreshResult | QuizRefreshResult | SubmissionRefreshResult | UnavailableRefreshResult | FailedRefreshResult

NormalizedSourceRecord = NormalizedAssignmentRecord | NormalizedCalendarRecord | NormalizedMaterialRecord | NormalizedQuizRecord | NormalizedSubmissionRecord

class PageRefreshReceipt(CollectionWire):
    visitId: str
    pageUrl: str
    observedAt: str
    collector: Literal['assignment', 'calendar', 'material', 'quiz', 'submission']
    sourceCourseIds: list[str]
    sourceActivityId: str = None
    sourceCourseModuleId: str = None
    outcome: Literal['ok', 'partial', 'failed', 'unavailable']
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only', 'supplied_pages_only', 'supplied_ranges_only']
    reasons: list[Literal['collector_unavailable', 'collection_disabled', 'envelope_unavailable', 'access_error', 'collector_failed', 'persistence_failed', 'invalid_context', 'invalid_selection', 'invalid_identity', 'unsupported_page', 'malformed_result', 'invalid_observed_at', 'invalid_batch_arguments', 'invalid_page', 'malformed_record', 'empty_marker', 'site_event', 'personal_event', 'non_assessment', 'unselected_course', 'unknown_kind', 'missing_course', 'unreliable_course', 'unknown_date', 'missing_dates', 'event_conflict', 'unsupported_structure', 'identity_mismatch', 'missing_identity', 'malformed_candidate', 'unsafe_url', 'unsafe_external_url', 'missing_metadata', 'type_conflict', 'invalid_mime', 'unsafe_label', 'field_conflict', 'parent_conflict', 'pagination_pending', 'incomplete_list', 'empty_unconfirmed', 'empty_conflict', 'folder_contents_uninspected', 'listing_conflict', 'invalid_date', 'unsupported_date', 'duplicate_date', 'malformed_assignment', 'incomplete_assignment']]
    evidenceMode: Literal['synthetic', 'verified']
    pages: list[CollectionPage]

class SnapshotCollection(CollectionWire):
    records: list[NormalizedSourceRecord]
    reviews: list[CollectionReview]
    refreshes: list[PageRefreshReceipt]

class CollectionCourse(CollectionWire):
    courseId: str
    sourceCourseId: str

class CollectionContext(CollectionWire):
    version: Literal['1']
    binding: str
    mode: Literal['disabled', 'synthetic', 'verified']
    selectionRevision: str
    courses: list[CollectionCourse]
    reason: Literal['collection_disabled', 'invalid_context', 'invalid_selection'] = None

class BeginPageVisit(CollectionWire):
    documentKey: str
    visitId: str
    pageUrl: str
    selectionRevision: str

class PageVisitToken(CollectionWire):
    visitToken: str

class PageRefreshInput(CollectionWire):
    visitToken: str
    observedAt: str
    collector: Literal['assignment', 'calendar', 'material', 'quiz', 'submission']
    result: CollectorResult

# END GENERATED COLLECTION MODELS

class Snapshot(WireModel):
    collection: SnapshotCollection = None
    courses: list[Course]
    assessments: list[Assessment]
    overlays: list[Overlay]
    materials: list[Material]
    documents: list[ImportedDocument]
    candidates: list[ExtractionCandidate]
    sync: list[CourseSyncState]
    changes: list[DeadlineChange]
    alerts: list[Alert]
    settings: Settings


class ConnectionInfo(WireModel):
    state: Literal["demo", "connected", "disconnected", "error"]
    message: str
    extensionDetected: bool


class PersonalEventInput(WireModel):
    courseId: str
    title: str
    type: AssessmentType
    date: DateValue


class ConfirmReview(WireModel):
    kind: Literal["confirm"]


class RejectReview(WireModel):
    kind: Literal["reject"]


class CorrectReview(WireModel):
    kind: Literal["correct"]
    title: str
    date: DateValue
    type: AssessmentType


ReviewDecision = Annotated[ConfirmReview | RejectReview | CorrectReview, Field(discriminator="kind")]


class ImportDocumentInput(WireModel):
    courseId: str
    fileName: str


class ImportSuccess(WireModel):
    ok: Literal[True]


class ImportFailure(WireModel):
    ok: Literal[False]
    reason: str


class ImportDocumentResponse(WireModel):
    snapshot: Snapshot
    result: ImportSuccess | ImportFailure


class DownloadMaterialResponse(WireModel):
    snapshot: Snapshot
    supported: bool
    message: str


class AiUnavailable(WireModel):
    available: Literal[False]
    reason: str


class AiAvailable(WireModel):
    available: Literal[True]
    provider: str
    retention: str


AiAvailability = AiUnavailable | AiAvailable


class ProposedHttpError(WireModel):
    message: str


class BridgeContext(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    version: Literal["1"]
    binding: str = Field(pattern=r"^[0-9a-f]{32}$")


class PageRefreshResponse(CollectionWire):
    snapshot: Snapshot
    receipt: PageRefreshReceipt
