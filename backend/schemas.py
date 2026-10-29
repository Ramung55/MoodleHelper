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


class LocalClosed(WireModel):
    model_config = ConfigDict(extra='forbid')


LocalOpaque = Annotated[str, Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')]
LocalDigest = Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
LocalVersion = Literal['local-syllabus-1']
LocalPolicyReason = Literal['clear_explicit', 'incomplete_extraction', 'evidence_missing', 'location_missing', 'source_unavailable', 'context_unverified', 'association_ambiguous', 'date_missing', 'date_not_explicit', 'year_inferred', 'locale_ambiguous', 'contradictory', 'policy_or_heading', 'conflicting_match', 'mapping_unresolved', 'timezone_unresolved', 'language_unknown', 'ocr_review', 'ocr_low_quality', 'ocr_synthetic', 'ocr_provenance_missing', 'week_only']


class LocalPolicyFacts(LocalClosed):
    complete: bool
    evidenceRetained: bool
    traceable: bool
    sourceAvailable: bool
    contextVerified: bool
    singleAssociation: bool
    explicitDate: bool
    inferredYear: bool
    localeAmbiguous: bool
    contradictory: bool
    policyOrHeading: bool
    conflictingMatch: bool
    mappingResolved: bool
    timezoneResolved: bool
    ocr: Literal['none', 'review', 'low_quality', 'synthetic', 'missing_provenance']


class LocalExactDate(LocalClosed):
    kind: Literal['exact']
    iso: str = Field(min_length=1, max_length=128)
    tz: str = Field(min_length=1, max_length=100)

    @model_validator(mode='after')
    def calendar_valid(self):
        from datetime import datetime
        import re
        from backend.teaching_calendar import SUPPORTED_TIMEZONES
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', self.iso) or self.tz not in SUPPORTED_TIMEZONES:
            raise ValueError('Use a resolved explicit instant and supported timezone.')
        try:
            datetime.fromisoformat(self.iso.replace('Z', '+00:00'))
        except ValueError:
            raise ValueError('The explicit timestamp is not calendar-valid.') from None
        return self


class LocalCalendarDate(LocalClosed):
    kind: Literal['date']
    date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')

    @model_validator(mode='after')
    def calendar_valid(self):
        from datetime import date
        date.fromisoformat(self.date)
        return self


class LocalTeachingWeek(LocalClosed):
    kind: Literal['week']
    week: Integer = Field(ge=1, le=30)


class LocalUnknownDate(LocalClosed):
    kind: Literal['unknown']


LocalSyllabusDate = Annotated[LocalExactDate | LocalCalendarDate | LocalTeachingWeek | LocalUnknownDate, Field(discriminator='kind')]


class LocalSyllabusProposal(LocalClosed):
    mentionId: LocalOpaque
    locationId: LocalOpaque
    title: str = Field(min_length=1, max_length=512)
    type: AssessmentType
    date: LocalSyllabusDate
    language: Literal['en', 'ru'] = None
    facts: LocalPolicyFacts


class LocalSyllabusInput(LocalClosed):
    datasetId: str = Field(min_length=1, max_length=128)
    courseId: str = Field(min_length=1, max_length=128)
    digest: LocalDigest
    format: Literal['pdf', 'docx']
    pipelineVersion: LocalVersion
    proposals: list[LocalSyllabusProposal] = Field(max_length=1000)


class LocalEvidenceRef(LocalClosed):
    datasetId: str = Field(min_length=1, max_length=128)
    courseId: str = Field(min_length=1, max_length=128)
    digest: LocalDigest
    mentionId: LocalOpaque
    locationId: LocalOpaque
    pipelineVersion: LocalVersion


class LocalSyllabusRoute(LocalClosed):
    mentionId: str
    documentId: str
    candidateId: str
    assessmentId: str = None
    disposition: Literal['auto', 'review', 'retained']
    reasons: list[LocalPolicyReason] = Field(max_length=32)


class LocalRoutingReceipt(LocalClosed):
    evidence: LocalEvidenceRef
    fingerprint: LocalDigest
    route: LocalSyllabusRoute


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
    localEvidence: LocalEvidenceRef = None
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
    localDigest: LocalDigest = None
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
    language: Literal["en", "ru", "unknown"]
    confidence: float = Field(ge=0, le=1)
    excerpt: str
    location: str
    status: Literal["pending", "confirmed", "corrected", "rejected", "auto"]
    matchAssessmentId: str = None
    reason: str = None
    localEvidence: LocalEvidenceRef = None


class CourseSyncState(WireModel):
    courseId: str
    status: Literal["ok", "partial", "failed", "never", "syncing"]
    coverage: Literal["full", "partial", "none"]
    lastSuccessAt: str = None
    error: str = None
    progress: float = Field(ge=0, le=100)


class DeadlineRemoved(WireModel):
    kind: Literal['removed']


DeadlineAssertion = DateValue | DeadlineRemoved
AcceptedDeadlineAssertion = ExactDate | CalendarDate | TeachingWeek | DeadlineRemoved
KnownDateValue = ExactDate | CalendarDate | TeachingWeek


class SyllabusRevisionSelection(WireModel):
    sourceId: str
    candidateId: str


class SyllabusRevisionDecision(SyllabusRevisionSelection):
    revision: Integer = Field(ge=0)
    fingerprint: str


class SyllabusRevisionEvidence(WireModel):
    documentId: str
    documentName: str
    candidateId: str
    title: str
    date: KnownDateValue
    excerpt: str
    location: str
    observedAt: str
    mocked: bool


class SyllabusRevisionPreview(SyllabusRevisionDecision):
    target: SyllabusRevisionEvidence
    incoming: SyllabusRevisionEvidence


class SyllabusRevisionLink(WireModel):
    candidateId: str
    documentId: str
    memberSourceId: str
    assessmentId: str
    date: KnownDateValue
    decidedAt: str
    revision: Integer = Field(ge=1)
    fingerprint: str


class SyllabusRevisionStream(WireModel):
    sourceId: str
    assessmentId: str
    revision: Integer = Field(ge=1)
    links: list[SyllabusRevisionLink] = Field(min_length=1)


class DeadlineStreamEmpty(WireModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False, json_schema_extra=omit_absence_defaults)
    sourceId: str
    assessmentId: str
    watermark: str
    established: Literal[False]


class DeadlineStreamAccepted(WireModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False, json_schema_extra=omit_absence_defaults)
    sourceId: str
    assessmentId: str
    watermark: str
    established: bool
    accepted: AcceptedDeadlineAssertion
    acceptedAt: str
    sourceUrl: str


DeadlineStream = DeadlineStreamEmpty | DeadlineStreamAccepted


class DeadlineChange(WireModel):
    id: str
    assessmentId: str
    from_: DeadlineAssertion = Field(alias="from")
    to: DeadlineAssertion
    detectedAt: str
    sourceId: str = None
    sourceUrl: str = None
    sourceObservedAt: str = None
    sourceKind: Literal['moodle', 'syllabus'] = None
    sourceDocumentId: str = None
    sourceCandidateId: str = None


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


class PartialTeachingBreak(WireModel):
    model_config = ConfigDict(extra='forbid')
    startDate: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    endDate: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    numbering: Literal['preserve', 'unresolved']


class TeachingWeekOverride(WireModel):
    model_config = ConfigDict(extra='forbid')
    week: Integer = Field(ge=1, le=30)
    startDate: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    endDate: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')


class TeachingCalendar(WireModel):
    model_config = ConfigDict(extra='forbid')
    startDate: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    endDate: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    timezone: str = Field(min_length=1, max_length=100)
    excludedWeekStarts: list[Annotated[str, Field(pattern=r'^\d{4}-\d{2}-\d{2}$')]] = Field(max_length=59, json_schema_extra={'uniqueItems': True})
    partialBreaks: list[PartialTeachingBreak] = Field(default=None, max_length=60)
    weekOverrides: list[TeachingWeekOverride] = Field(default=None, max_length=30)

    @model_validator(mode='after')
    def valid_calendar(self):
        from backend.teaching_calendar import validate_teaching_calendar
        return validate_teaching_calendar(self)


class SettingsPatch(WireModel):
    trackedCourseIds: list[str] = None
    semesterStart: str = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    semesterWeeks: Integer = Field(default=None, ge=1, le=30)
    timezone: str = None
    teachingCalendar: TeachingCalendar = None
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


class ReconciliationSelection(WireModel):
    left: str
    right: str


class ReconciliationDecision(WireModel):
    pairId: str
    fingerprint: str
    reviewRevision: str
    kind: Literal['confirm', 'reject']
    choices: dict[str, str]


class ReconciliationSource(WireModel):
    id: str
    courseId: str
    assessmentId: str
    kind: Literal['moodle', 'syllabus']
    state: Literal['ambiguous'] = None
    recordId: str = None
    documentId: str = None
    candidateId: str = None


class ReconciliationPair(WireModel):
    id: str
    left: str
    right: str
    fingerprint: str
    reviewRevision: str
    status: Literal['pending', 'confirmed', 'rejected']
    canonicalId: str = None
    choices: dict[str, str] = None


class ReconciliationAlias(WireModel):
    originalId: str
    canonicalId: str


class Reconciliation(WireModel):
    sources: list[ReconciliationSource]
    pairs: list[ReconciliationPair]
    aliases: list[ReconciliationAlias]
    logicalAssessments: list[Assessment]
    logicalOverlays: list[Overlay]
    overlayEdits: list[Overlay]


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
    syntheticDeadlineRemoval: Literal[True] = None
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
    syntheticDeadlineRemoval: Literal[True] = None
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
    reviews: list[CalendarSafeReview | MaterialSafeReview] = Field(max_length=0)
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only']

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
    reviews: list[CalendarSafeReview]
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['supplied_ranges_only']

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
    reviews: list[MaterialSafeReview]
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['supplied_pages_only']

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
    reviews: list[CalendarSafeReview | MaterialSafeReview] = Field(max_length=0)
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only']

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
    reviews: list[CalendarSafeReview | MaterialSafeReview] = Field(max_length=0)
    diagnostics: list[CollectionDiagnostic]
    pages: list[CollectionPage]
    coverage: Literal['complete', 'partial', 'none']
    scope: Literal['visited_activity_only']

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

class SyllabusSuggestionDismissal(CollectionWire):
    recordId: str = Field(min_length=1, max_length=8192)
    dismissed: bool


class Snapshot(WireModel):
    localSyllabusReceipts: list[LocalRoutingReceipt] = None
    dismissedSyllabusSuggestions: list[str] = None
    collection: SnapshotCollection = None
    reconciliation: Reconciliation = None
    deadlineStreams: list[DeadlineStream] = None
    syllabusRevisions: list[SyllabusRevisionStream] = None
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


class LocalSyllabusResult(LocalClosed):
    snapshot: Snapshot
    routes: list[LocalSyllabusRoute] = Field(max_length=1000)


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
    contentDigest: str = Field(default=None, pattern=r'^[0-9a-f]{64}$')


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


class LocalContext(WireModel):
    model_config = ConfigDict(extra='forbid')
    datasetId: str


class BridgeContext(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    version: Literal["1"]
    binding: str = Field(pattern=r"^[0-9a-f]{32}$")


class PageRefreshResponse(CollectionWire):
    snapshot: Snapshot
    receipt: PageRefreshReceipt

# Mock queue models are closed and independent of Snapshot wire records.
QueueId = Annotated[str, Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9._~-]+$')]
QueueCourseId = Annotated[str, Field(min_length=1, max_length=8192, pattern=r'\S')]
QueueState = Literal['pending', 'running', 'completed', 'failed', 'cancelled']
QueueCount = Annotated[int, Field(ge=0)]
QueueGeneration = Annotated[int, Field(ge=1)]

class QueueModel(WireModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False, json_schema_extra=omit_absence_defaults)

class QueueStart(QueueModel):
    idempotencyKey: QueueId
    courseIds: list[QueueCourseId] = Field(min_length=1, max_length=100, json_schema_extra={'uniqueItems':True})
    @model_validator(mode='after')
    def unique_courses(self):
        if len(set(self.courseIds)) != len(self.courseIds): raise ValueError('Duplicate course ID')
        return self

class QueueClaimInput(QueueModel): pass
class QueueClaimToken(QueueModel):
    jobId: QueueId
    generation: QueueGeneration
    token: QueueId
class QueueFinish(QueueClaimToken):
    outcome: Literal['completed','failed']
    errorCode: Literal['mock_failure'] = None
class QueueProgress(QueueModel):
    pending: QueueCount
    running: QueueCount
    completed: QueueCount
    failed: QueueCount
    cancelled: QueueCount
    total: QueueCount
class QueueResult(QueueModel):
    id: QueueId
    summary: str = Field(min_length=1,max_length=256)
class QueueJob(QueueModel):
    id: QueueId
    courseId: QueueCourseId
    state: QueueState
    attempts: QueueCount
    generation: QueueCount
    errorCode: Literal['mock_failure'] = None
    result: QueueResult = None
class QueueRun(QueueModel):
    id: QueueId
    idempotencyKey: QueueId
    courseIds: list[QueueCourseId] = Field(min_length=1,max_length=100,json_schema_extra={'uniqueItems':True})
    createdAt: QueueCount
    status: QueueState
    cancelled: bool
    progress: QueueProgress
    jobs: list[QueueJob] = Field(max_length=100)
    nextCursor: QueueId = None
class QueueCurrent(QueueModel):
    courseIds: list[QueueCourseId] = Field(max_length=100, json_schema_extra={'uniqueItems':True})
    run: QueueRun = None
    lastFailedRun: QueueRun = None
class QueueClaim(QueueModel):
    job: QueueJob
    token: QueueId
    generation: QueueGeneration
    expiresAt: QueueCount
class QueueClaimResponse(QueueModel):
    claim: QueueClaim = None
    unfinished: bool
class QueueRenewResponse(QueueModel):
    expiresAt: QueueCount

ScanReason = Literal['undiscovered','unsupported_page','collector_unavailable','access_error','signed_out','forbidden','request_failed','limit_reached','invalid_context']
ScanCollector = Literal['assignment','calendar','material','quiz','submission']
ScanError = Literal['signed_out','request_failed','invalid_context']
ScanRevision = Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]

def scan_page_schema(record=False, result_refs=None):
    choice = lambda *v: {'type':'string', 'enum':list(v)}
    conditions = [
        {'if': {'properties': {'outcome': {'const':'undiscovered'}}, 'required':['outcome']}, 'then': {'not': {'required':['observedAt']}}, 'else': {'required':['observedAt']}},
        {'if': {'required':['collector']}, 'then': {'required':['result']}},
        {'if': {'required':['result']}, 'then': {'required':['collector'], 'properties': {'outcome':choice('ok','partial')}}},
        {'if': {'properties': {'outcome':choice('failed','unavailable','forbidden','signed_out','undiscovered')}, 'required':['outcome']}, 'then': {'properties': {'coverage':choice('partial','none'), 'reasons':{'minItems':1}}, 'not':{'required':['result']}}},
        {'if': {'properties': {'pageType':{'const':'unsupported'}}, 'required':['pageType']}, 'then': {'properties': {'coverage':choice('partial','none'), 'reasons':{'contains':{'const':'unsupported_page'}}}}},
        {'if': {'properties': {'outcome':{'const':'failed'}}, 'required':['outcome']}, 'then': {'properties':{'reasons':{'contains':choice('access_error','request_failed','invalid_context')}}}},
        {'if': {'properties': {'outcome':{'const':'partial'}}, 'required':['outcome']}, 'then': {'properties': {'coverage':choice('partial','none'),'reasons':{'minItems':1}}}},
        {'if': {'properties': {'coverage':{'const':'complete'}}, 'required':['coverage']}, 'then': {'required':['collector','result','pageUrl']}},
    ]
    for index, kind in enumerate(('assignment','calendar','material','quiz','submission')):
        conditions.append({'if':{'properties':{'collector':{'const':kind}},'required':['collector']},
            'then':{'properties':{'result':result_refs[index] if result_refs else {}},'required':['pageUrl']}})
    for state,reason in [('unavailable','collector_unavailable'),('forbidden','forbidden'),('signed_out','signed_out'),('undiscovered','undiscovered')]:
        conditions.append({'if':{'properties':{'outcome':{'const':state}},'required':['outcome']},'then':{'properties':{'reasons':{'contains':{'const':reason}}}}})
    return {'allOf': [conditions[0], *conditions[3:7], *conditions[-4:]] if record else conditions}

def scan_list_schema():
    return {'allOf':[{'if':{'anyOf':[
        {'properties':{'incompleteReasons':{'contains':{'const':'signed_out'}}}},
        {'properties':{'pages':{'contains':{'properties':{'outcome':{'const':'signed_out'}},'required':['outcome']}}}}]},
        'then':{'required':['signInGuidance','signInUrl']},
        'else':{'not':{'anyOf':[{'required':['signInGuidance']},{'required':['signInUrl']}]}}}]}

def input_page_json_schema(schema):
    omit_absence_defaults(schema)
    refs = schema['properties']['result']['anyOf']
    schema.update(scan_page_schema(result_refs=refs))

class ScanStart(QueueModel):
    idempotencyKey: QueueId

class ScanJob(QueueModel):
    id: QueueId
    courseId: QueueCourseId
    state: QueueState
    attempts: QueueCount
    generation: QueueCount
    errorCode: ScanError = None

class ScanRun(QueueModel):
    id: QueueId
    idempotencyKey: QueueId
    courseIds: list[QueueCourseId] = Field(min_length=1,max_length=100,json_schema_extra={'uniqueItems':True})
    createdAt: QueueCount
    status: QueueState
    cancelled: bool
    progress: QueueProgress
    jobs: list[ScanJob] = Field(max_length=100)
    nextCursor: QueueId = None

class ScanClaim(QueueModel):
    job: ScanJob
    token: QueueId
    generation: QueueGeneration
    expiresAt: QueueCount
    sourceCourseId: str = Field(pattern=r'^[1-9][0-9]{0,127}$')
    selectionRevision: ScanRevision

class ScanClaimResponse(QueueModel):
    unfinished: bool
    claim: ScanClaim = None

class ScanPageInput(QueueModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False, json_schema_extra=input_page_json_schema)
    pageType: Literal['course','assignment','calendar','material','quiz','submission','unsupported']
    scope: Literal['visited_activity_only','supplied_pages_only','supplied_ranges_only','unknown']
    outcome: Literal['ok','partial','failed','unavailable','forbidden','signed_out','undiscovered']
    coverage: Literal['complete','partial','none']
    reasons: list[ScanReason] = Field(max_length=9,json_schema_extra={'uniqueItems':True})
    observedAt: str = Field(default=None,json_schema_extra={'format':'date-time'})
    pageUrl: str = Field(default=None,min_length=1,max_length=4096,json_schema_extra={'format':'uri'})
    collector: ScanCollector = None
    result: AssignmentRefreshResult | CalendarRefreshResult | MaterialRefreshResult | QuizRefreshResult | SubmissionRefreshResult = None

    @model_validator(mode='after')
    def valid_evidence(self):
        from backend.domain_validation import validate_instant
        if len(set(self.reasons)) != len(self.reasons): raise ValueError('Duplicate reason')
        if self.outcome == 'undiscovered':
            if self.observedAt is not None: raise ValueError('Undiscovered page has time')
        else:
            if self.observedAt is None: raise ValueError('Checked page requires time')
            validate_instant(self.observedAt,'observedAt')
        if (self.collector is None) != (self.result is None): raise ValueError('Collector/result mismatch')
        if self.result is not None and (self.result.kind != self.collector or self.pageUrl is None or self.outcome not in ('ok','partial')):
            raise ValueError('Invalid collector evidence')
        if self.coverage == 'complete' and self.result is None: raise ValueError('Complete coverage requires collector evidence')
        required = {'unavailable':'collector_unavailable','forbidden':'forbidden','signed_out':'signed_out','undiscovered':'undiscovered'}
        if self.outcome in required and required[self.outcome] not in self.reasons: raise ValueError('Missing reason')
        if self.outcome == 'failed' and not set(self.reasons) & {'access_error','request_failed','invalid_context'}: raise ValueError('Missing reason')
        if self.outcome in ('failed','unavailable','forbidden','signed_out','undiscovered','partial') and (self.coverage == 'complete' or not self.reasons): raise ValueError('Inconsistent coverage')
        if self.pageType == 'unsupported' and (self.coverage == 'complete' or 'unsupported_page' not in self.reasons): raise ValueError('Invalid unsupported page')
        if self.result is not None and (self.coverage != self.result.coverage or self.scope != self.result.scope): raise ValueError('Inconsistent collector coverage')
        return self

class ScanFinish(QueueClaimToken):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False, json_schema_extra=lambda schema: (omit_absence_defaults(schema), schema.update({'allOf':[{'if':{'properties':{'outcome':{'const':'failed'}},'required':['outcome']},'then':{'required':['errorCode']},'else':{'not':{'required':['errorCode']}}}]})))
    selectionRevision: ScanRevision
    outcome: Literal['completed','failed']
    pages: list[ScanPageInput] = Field(max_length=100)
    incompleteReasons: list[ScanReason] = Field(max_length=9,json_schema_extra={'uniqueItems':True})
    errorCode: ScanError = None
    @model_validator(mode='after')
    def valid_finish(self):
        if (self.outcome == 'failed') != (self.errorCode is not None): raise ValueError('Invalid error code')
        if len(set(self.incompleteReasons)) != len(self.incompleteReasons): raise ValueError('Duplicate reason')
        if any(reason not in self.incompleteReasons for page in self.pages for reason in page.reasons): raise ValueError('Missing coverage reason')
        found = {page.pageType for page in self.pages}
        if not {'course','assignment','calendar','material','quiz','submission'} <= found and 'undiscovered' not in self.incompleteReasons:
            raise ValueError('Missing discovery reason')
        return self

class ScanPageRecord(QueueModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False, json_schema_extra=lambda schema: (omit_absence_defaults(schema), schema.update(scan_page_schema(True))))
    ordinal: Annotated[int, Field(ge=0,le=99)]
    pageType: Literal['course','assignment','calendar','material','quiz','submission','unsupported']
    scope: Literal['visited_activity_only','supplied_pages_only','supplied_ranges_only','unknown']
    outcome: Literal['ok','partial','failed','unavailable','forbidden','signed_out','undiscovered']
    coverage: Literal['complete','partial','none']
    reasons: list[ScanReason] = Field(max_length=9,json_schema_extra={'uniqueItems':True})
    observedAt: str = Field(default=None,json_schema_extra={'format':'date-time'})
    pageUrl: str = Field(default=None,min_length=1,max_length=4096,json_schema_extra={'format':'uri'})
    collector: ScanCollector = None

class ScanPageList(QueueModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False, json_schema_extra=lambda schema: (omit_absence_defaults(schema), schema.update(scan_list_schema())))
    pages: list[ScanPageRecord] = Field(max_length=100)
    incompleteReasons: list[ScanReason] = Field(max_length=9,json_schema_extra={'uniqueItems':True})
    nextCursor: QueueId = None
    signInGuidance: Literal['Sign in to SDU Moodle to continue.'] = None
    signInUrl: Literal['https://moodle.sdu.edu.kz/login/index.php'] = None

class SyncUnavailableError(QueueModel):
    message: Literal['Live course sync is unavailable until Moodle access is verified.']

