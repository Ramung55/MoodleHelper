import type { RawCourseObservation } from "@/domain/types";
import type { AssessmentType, ConnectionState, DateValue, Overlay, Settings, Snapshot } from "@/domain/types";
import type { LocalReviewContext, SyllabusRevisionDecision, SyllabusRevisionPreview } from "@/domain/types";

export interface ConnectionInfo {
  state: ConnectionState;
  /** Shown verbatim to the student */
  message: string;
  extensionDetected: boolean;
}

export interface PersonalEventInput {
  courseId: string;
  title: string;
  type: AssessmentType;
  date: DateValue;
}

/** localReview is required by the backend only for registered local (#31) candidates. */
export type ReviewDecision = (
  | { kind: "confirm" }
  | { kind: "reject" }
  | { kind: "correct"; title: string; date: DateValue; type: AssessmentType }
) & { localReview?: LocalReviewContext };

export type ImportResult = { ok: true } | { ok: false; reason: string };

export type AiAvailability = { available: false; reason: string } | { available: true; provider: string; retention: string };

/** Omission retains values; explicit undefined/null override keys request clearing. */
export type OverlayPatch = Partial<Pick<Overlay, "hidden" | "completed">> & {
  titleOverride?: string | null | undefined;
  dateOverride?: DateValue | null | undefined;
  overrideBase?: DateValue | null | undefined;
};

/**
 * The single services layer. Every data operation the dashboard performs goes through this contract.
 * Implementations: DemoAdapter (local fixtures) and ExtensionAdapter (future Chrome extension).
 * The website never receives Moodle passwords, cookies or session tokens through it.
 */
export interface MoodleHelperAdapter {
  readonly kind: "demo" | "extension";
  readonly storage?: "browser" | "backend";
  connection(): Promise<ConnectionInfo>;
  load(): Promise<Snapshot>;

  ingestCourseDiscovery(observations: RawCourseObservation[]): Promise<Snapshot>;
  setTrackedCourses(ids: string[]): Promise<Snapshot>;
  updateOverlay(assessmentId: string, patch: OverlayPatch): Promise<Snapshot>;
  addPersonalEvent(input: PersonalEventInput): Promise<Snapshot>;
  deletePersonalEvent(id: string): Promise<Snapshot>;

  syncAll(onProgress: (s: Snapshot) => void): Promise<Snapshot>;

  importDocument(courseId: string, fileName: string, onProgress: (s: Snapshot) => void, contentDigest?: string): Promise<{ snapshot: Snapshot; result: ImportResult }>;
  review(candidateId: string, decision: ReviewDecision): Promise<Snapshot>;
  proposeReconciliation(left: string, right: string): Promise<Snapshot>;
  decideReconciliation(pairId: string, fingerprint: string, reviewRevision: string, kind: "confirm" | "reject", choices: Record<string, string>): Promise<Snapshot>;
  previewSyllabusRevision(sourceId: string, candidateId: string): Promise<SyllabusRevisionPreview>;
  confirmSyllabusRevision(decision: SyllabusRevisionDecision): Promise<Snapshot>;

  downloadMaterial(id: string): Promise<{ snapshot: Snapshot; supported: boolean; message: string }>;

  saveAlerts(alerts: Snapshot["alerts"]): Promise<Snapshot>;
  /** #39 narrow idempotent mark-read/delete; never overwrites concurrently appended alerts or delivery state. */
  updateAlerts(ids: string[], action: "read" | "delete"): Promise<Snapshot>;
  setSyllabusSuggestionDismissal(recordId: string, dismissed: boolean): Promise<Snapshot>;
  updateSettings(patch: Partial<Settings>): Promise<Snapshot>;

  /** Atomic replace after a validated restore */
  replaceAll(s: Snapshot): Promise<Snapshot>;
  deleteLocalData(): Promise<Snapshot>;
  resetDemo?(): Promise<Snapshot>;

  aiAvailability(): Promise<AiAvailability>;
  /** #38 backend-derived reminder plan (first page). Optional: demo mode has no durable scheduler. */
  reminderPlan?(): Promise<import("@/domain/types").ReminderPlan>;
  /** #55 authoritative restore preview context; HTTP-only, absent from the bridge catalog. */
  restoreContext?(): Promise<RestoreContext>;
  /** #55 atomic validated restore. Throws RestoreOutcomeUnknown when a commit may have happened. */
  restoreBackup?(request: RestoreRequest): Promise<RestoreResult>;
  /** #56 read-only lifecycle context; HTTP-only. */
  dataContext?(): Promise<DataContext>;
  /** #56 confirmed full erasure; HTTP-only. Throws EraseOutcomeUnknown when a commit may have happened. */
  eraseLocalData?(request: EraseRequest): Promise<EraseResult>;
  eraseStatus?(eraseId: string): Promise<EraseStatus>;
  acknowledgeErase?(eraseId: string, component: "dashboard", state: "complete" | "failed"): Promise<EraseStatus>;
}

export type CleanupState = "pending" | "complete" | "failed";
export type EraseCleanup = { backend: "complete"; dashboard: CleanupState; extension: CleanupState };
export type DataContext = { datasetId: string; epoch: number; revision: number; lifecycle: "active" | "cleanup_pending" | "complete"; erasure?: { eraseId: string; cleanup: EraseCleanup } | undefined };
export type EraseRequest = { idempotencyKey: string; expectedDatasetId: string; expectedEpoch: number; expectedRevision: number };
export type EraseResult = { eraseId: string; datasetId: string; epoch: number; revision: number; snapshot: Snapshot; cleanup: EraseCleanup };
export type EraseStatus = { eraseId: string; datasetId: string; epoch: number; current: boolean; cleanup: EraseCleanup };
/** Network loss after sending: the erase may have committed; retry the same key to read the receipt. */
export class EraseOutcomeUnknown extends Error {
  constructor() { super("Deletion outcome unknown; checking the receipt."); this.name = "EraseOutcomeUnknown"; }
}

export type RestoreContext = { datasetId: string; epoch: number; revision: number };
export type RestoreRequest = { idempotencyKey: string; expectedDatasetId: string; expectedEpoch: number; expectedRevision: number; backup: unknown };
export type RestoreResult = { snapshot: Snapshot; datasetId: string; epoch: number; revision: number; restoreId: string; remindersRebuilt: boolean; reminderGeneration: string; replayed: boolean };
/** Network loss or unreadable response after sending: the restore may or may not have committed. */
export class RestoreOutcomeUnknown extends Error {
  constructor() { super("Restore outcome unknown; checking receipt."); this.name = "RestoreOutcomeUnknown"; }
}
