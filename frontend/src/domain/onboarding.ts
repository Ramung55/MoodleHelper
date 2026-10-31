/**
 * #46 first-run onboarding coordinator logic. Completion is derived from authoritative
 * facts (saved selection, explicit calendar, current capability); the only persisted
 * state is a navigation hint `{version, visitedStepIds, choices}` scoped to the local
 * dataset and lifecycle epoch. It never stores identity, session IDs, tokens or consent.
 */
import type { Snapshot } from "./types";
import { BridgeError, type ErrorCode } from "../../../shared/src/bridge";

export const STEP_IDS = ["connection", "courses", "sync", "calendar", "notifications", "privacy"] as const;
export type StepId = (typeof STEP_IDS)[number];

export type ExtensionStatus =
  | { kind: "checking" }
  | { kind: "missing"; message: string }
  | { kind: "incompatible"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "backend_unavailable"; message: string }
  | { kind: "ready"; moodleCollection: "unavailable" | "ready" };

export type Hello = { backend: "ready" | "unavailable"; localRepository: "ready" | "unavailable"; moodleCollection: "unavailable" | "ready" };

/** Classify the existing correlated, versioned BridgeClient handshake (not the boolean probe). */
export function classifyHandshake(outcome: { ok: true; hello: Hello } | { ok: false; error: unknown }): ExtensionStatus {
  if (outcome.ok) {
    if (outcome.hello.backend !== "ready" || outcome.hello.localRepository !== "ready") return { kind: "backend_unavailable", message: new BridgeError("BACKEND_UNAVAILABLE").message };
    return { kind: "ready", moodleCollection: outcome.hello.moodleCollection };
  }
  const code: ErrorCode | null = outcome.error instanceof BridgeError ? outcome.error.code : null;
  const message = code ? new BridgeError(code).message : "Reload the dashboard and reconnect.";
  if (code === "MISSING_EXTENSION") return { kind: "missing", message };
  if (code === "UNSUPPORTED_VERSION" || code === "RECONNECT_REQUIRED" || code === "INVALID_RESPONSE") return { kind: "incompatible", message };
  if (code === "BACKEND_UNAVAILABLE") return { kind: "backend_unavailable", message };
  return { kind: "unavailable", message };
}

export const MOODLE_LOGIN_URL = "https://moodle.sdu.edu.kz/login/index.php";

/** Only a trusted normalized signed_out signal with provenance may claim "signed out". */
export type MoodleAccessSignal = { state: "signed_out" | "signed_in"; source: string; context: string };
export function moodleSignIn(signal: MoodleAccessSignal | null | undefined): { kind: "signed_out" | "signed_in" | "unverified"; message: string } {
  if (signal && signal.source && signal.context) {
    if (signal.state === "signed_out") return { kind: "signed_out", message: `Moodle reported you are signed out (${signal.source}, ${signal.context}). Sign in to SDU Moodle in Chrome, then check again.` };
    return { kind: "signed_in", message: `Moodle access confirmed (${signal.source}, ${signal.context}).` };
  }
  return { kind: "unverified", message: "Moodle sign-in status not verified; open Moodle/check connection." };
}

export type Choice = "skipped" | "declined" | "acknowledged";
export type Hint = { version: 1; visitedStepIds: StepId[]; choices: Partial<Record<StepId, Choice>> };
export const emptyHint = (): Hint => ({ version: 1, visitedStepIds: [], choices: {} });

export function parseHint(raw: string | null): Hint {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || v.version !== 1 || !Array.isArray(v.visitedStepIds) || typeof v.choices !== "object" || !v.choices) return emptyHint();
    const visitedStepIds = v.visitedStepIds.filter((s: unknown): s is StepId => (STEP_IDS as readonly unknown[]).includes(s));
    const choices: Hint["choices"] = {};
    for (const id of STEP_IDS) if (["skipped", "declined", "acknowledged"].includes(v.choices[id])) choices[id] = v.choices[id];
    return { version: 1, visitedStepIds, choices };
  } catch { return emptyHint(); }
}

/** Storage key scoped to dataset and lifecycle epoch; erase (#56) or restore (#55) changes it. */
export const hintKey = (scope: { datasetId: string; epoch: number }) => `mh-onboarding:${scope.datasetId}:${scope.epoch}`;

export type StepState = "done" | "choice" | "blocked" | "todo";
export type Facts = { snap: Snapshot; extension: ExtensionStatus; liveSync: "unavailable" | "ready"; hint: Hint };

/** Derive each step's state; data contradicting a hint wins (a hint never proves success). */
export function deriveSteps({ snap, extension, liveSync, hint }: Facts): Record<StepId, StepState> {
  const choice = (id: StepId): StepState | null => (hint.choices[id] ? "choice" : null);
  const sync = snap.settings.trackedCourseIds.length && snap.sync.some((s) => snap.settings.trackedCourseIds.includes(s.courseId) && s.status === "ok" && s.lastSuccessAt && liveSync === "ready");
  return {
    connection: extension.kind === "ready" ? "done" : choice("connection") ?? "todo",
    courses: snap.settings.trackedCourseIds.length ? "done" : "todo",
    sync: sync ? "done" : choice("sync") ?? (liveSync === "unavailable" ? "blocked" : "todo"),
    calendar: snap.settings.teachingCalendar ? "done" : "todo",
    notifications: choice("notifications") ?? "todo",
    privacy: hint.choices.privacy === "acknowledged" ? "done" : "todo",
  };
}

/** Resume at the first unfinished step; blocked or chosen steps don't trap the student. */
export function resumeStep(states: Record<StepId, StepState>): StepId | null {
  return STEP_IDS.find((id) => states[id] === "todo") ?? null;
}

export function withChoice(hint: Hint, id: StepId, c: Choice): Hint {
  return { ...hint, choices: { ...hint.choices, [id]: c }, visitedStepIds: hint.visitedStepIds.includes(id) ? hint.visitedStepIds : [...hint.visitedStepIds, id] };
}
export function withVisit(hint: Hint, id: StepId): Hint {
  return hint.visitedStepIds.includes(id) ? hint : { ...hint, visitedStepIds: [...hint.visitedStepIds, id] };
}
