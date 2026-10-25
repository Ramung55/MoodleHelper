import { z } from "zod";
import { Snapshot } from "./types";

export const BACKUP_VERSION = 1;

export const Backup = z.object({
  app: z.literal("moodle-helper"),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string(),
  note: z.string(),
  data: Snapshot,
});
export type Backup = z.infer<typeof Backup>;

export function makeBackup(data: Snapshot, now = new Date()): Backup {
  return {
    app: "moodle-helper",
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    note: "Structured records, settings and personal changes only. Original document files and downloaded files are not included.",
    data,
  };
}

export type RestorePreview =
  | { ok: true; backup: Backup; diff: { label: string; current: number; incoming: number }[] }
  | { ok: false; error: string };

/** Validate fully before anything is written, so a restore is all-or-nothing. */
export function previewRestore(raw: string, current: Snapshot): RestorePreview {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This file is not valid JSON." };
  }
  const parsed = Backup.safeParse(json);
  if (!parsed.success) {
    const v = (json as { version?: unknown })?.version;
    if (v !== undefined && v !== BACKUP_VERSION) return { ok: false, error: `Unsupported backup version: ${String(v)}.` };
    return { ok: false, error: "This file is not a valid Moodle Helper backup." };
  }
  const d = parsed.data.data;
  return {
    ok: true,
    backup: parsed.data,
    diff: [
      { label: "Courses", current: current.courses.length, incoming: d.courses.length },
      { label: "Assessments", current: current.assessments.length, incoming: d.assessments.length },
      { label: "Personal changes", current: current.overlays.length, incoming: d.overlays.length },
      { label: "Materials", current: current.materials.length, incoming: d.materials.length },
      { label: "Review candidates", current: current.candidates.length, incoming: d.candidates.length },
    ],
  };
}
