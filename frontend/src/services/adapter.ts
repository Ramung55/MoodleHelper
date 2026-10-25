import type { AssessmentType, ConnectionState, DateValue, Overlay, Settings, Snapshot } from "@/domain/types";

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

export type ReviewDecision =
  | { kind: "confirm" }
  | { kind: "reject" }
  | { kind: "correct"; title: string; date: DateValue; type: AssessmentType };

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

  setTrackedCourses(ids: string[]): Promise<Snapshot>;
  updateOverlay(assessmentId: string, patch: OverlayPatch): Promise<Snapshot>;
  addPersonalEvent(input: PersonalEventInput): Promise<Snapshot>;
  deletePersonalEvent(id: string): Promise<Snapshot>;

  syncAll(onProgress: (s: Snapshot) => void): Promise<Snapshot>;

  importDocument(courseId: string, fileName: string, onProgress: (s: Snapshot) => void): Promise<{ snapshot: Snapshot; result: ImportResult }>;
  review(candidateId: string, decision: ReviewDecision): Promise<Snapshot>;

  downloadMaterial(id: string): Promise<{ snapshot: Snapshot; supported: boolean; message: string }>;

  saveAlerts(alerts: Snapshot["alerts"]): Promise<Snapshot>;
  updateSettings(patch: Partial<Settings>): Promise<Snapshot>;

  /** Atomic replace after a validated restore */
  replaceAll(s: Snapshot): Promise<Snapshot>;
  deleteLocalData(): Promise<Snapshot>;
  resetDemo?(): Promise<Snapshot>;

  aiAvailability(): Promise<AiAvailability>;
}
