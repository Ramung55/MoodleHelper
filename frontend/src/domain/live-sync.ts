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
export function connectionWithExtension(c: ConnectionInfo, detected: boolean, mode?: string): ConnectionInfo {
  if (!detected) return c;
  if (c.state === "demo") return { ...c, extensionDetected: true, message: EXTENSION_MESSAGES.demo };
  return mode === "verified" ? { ...c, extensionDetected: true, liveSync: true, message: EXTENSION_MESSAGES.live } : { ...c, extensionDetected: true };
}

/** "(demo)" marks the demo dataset only; an unknown connection counts as demo. */
export const syncAllLabel = (conn: ConnectionInfo | null) => (!conn || conn.state === "demo" ? "Sync all courses (demo)" : "Sync all courses");
