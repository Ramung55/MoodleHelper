import type { ConnectionInfo } from "@/services/adapter";

/** #46: dashboard messages with the extension detected; demo text stays demo, live sync is named only when available. */
export const EXTENSION_MESSAGES = {
  demo: "Extension detected. This is the fictional demo dataset; Sync all runs a demo sync and nothing is read from Moodle.",
  live: "Extension detected. Live sync is ready: Sync all scans the selected courses read-only through the extension; sign in to SDU Moodle in Chrome first.",
} as const;

/**
 * #46: live sync is available only for the real (non-demo) dataset, with the extension
 * detected and the backend in its verified collection mode (where Sync all runs a real scan).
 */
export function connectionWithExtension(
  c: ConnectionInfo,
  detected: boolean,
  mode?: string,
): ConnectionInfo {
  if (!detected) return c;
  if (c.state === "demo")
    return { ...c, extensionDetected: true, message: EXTENSION_MESSAGES.demo };
  return mode === "verified"
    ? { ...c, extensionDetected: true, liveSync: true, message: EXTENSION_MESSAGES.live }
    : { ...c, extensionDetected: true };
}

/** "(demo)" marks the demo dataset only; an unknown connection counts as demo. */
export const syncAllLabel = (conn: ConnectionInfo | null) =>
  !conn || conn.state === "demo" ? "Sync all courses (demo)" : "Sync all courses";

/** #87 S1: the one short shell banner line; the full `conn.message` stays under Settings → Details. */
export function shellNotice(conn: ConnectionInfo | null): string | null {
  if (!conn) return null;
  if (conn.state === "demo") return "Demo data — nothing is read from Moodle.";
  return conn.liveSync
    ? "Connected to Moodle Helper. Sync reads your selected courses."
    : "Extension not connected. Saved data is shown.";
}

type SyncEntry = {
  courseId: string;
  status: string;
  coverage: string;
  lastSuccessAt?: string | undefined;
};

/**
 * #87 O1: one line for the Overview sync card from the selected courses' sync entries:
 * a running sync, failed courses, or how many are fully scanned.
 */
export function syncSummaryLine(tracked: string[], sync: SyncEntry[]): string {
  const entries = tracked.map((id) => sync.find((s) => s.courseId === id));
  if (entries.some((e) => e?.status === "syncing")) return "Sync running…";
  const failed = entries.filter((e) => e?.status === "failed").length;
  if (failed) return `Last sync failed for ${failed} ${failed === 1 ? "course" : "courses"}`;
  const full = entries.filter((e) => e?.status === "ok" && e.coverage === "full").length;
  return `${full} of ${tracked.length} ${tracked.length === 1 ? "course" : "courses"} fully scanned`;
}

/** #87 O1: the earliest full-coverage success of every selected course, or undefined (shown as `Never`). */
export function lastFullSyncAt(tracked: string[], sync: SyncEntry[]): number | undefined {
  if (!tracked.length) return undefined;
  const times = tracked
    .map((id) => sync.find((s) => s.courseId === id))
    .map((e) => (e?.coverage === "full" && e.lastSuccessAt ? Date.parse(e.lastSuccessAt) : NaN));
  return times.every(Number.isFinite) ? Math.min(...times) : undefined;
}

/** #87 S2: every Sync all button shows `Checking…` (disabled) until extension detection finishes. */
export const syncButtonLabel = (
  conn: ConnectionInfo | null,
  syncing: boolean,
  detecting: boolean,
) => (detecting ? "Checking…" : syncing ? "Syncing…" : syncAllLabel(conn));

/** #87 T1: the one dataset line on Settings → Connection & sync. */
export function datasetLine(conn: ConnectionInfo | null): string {
  if (!conn) return "Loading…";
  return conn.state === "demo" ? "Demo data" : "Connected · Your data";
}

/** #87 T1 / #49 AC3: the extension status in one line (default view). */
export function extensionLine(conn: ConnectionInfo | null): string {
  if (!conn) return "Checking extension…";
  if (conn.liveSync) return "Extension connected. Sync reads your selected courses.";
  if (conn.extensionDetected)
    return conn.state === "demo"
      ? "Extension connected. Demo sync only."
      : "Extension connected. Moodle sync isn't available yet.";
  return "Extension not connected.";
}
