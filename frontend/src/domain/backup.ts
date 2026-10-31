import { z } from "zod";
import { Snapshot } from "./types";

export const BACKUP_VERSION = 1;

/** Additive, optional v1 metadata (#45). Historical v1 files without it stay readable; #55 decides legacy identity. */
export const BackupCount = z.object({ label: z.string(), count: z.number().int().min(0) }).strict();
export const BackupSummary = z.object({
  counts: z.array(BackupCount),
  exclusions: z.array(z.string()),
  redactions: z.number().int().min(0),
}).strict();
export type BackupSummary = z.infer<typeof BackupSummary>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const Backup = z.object({
  app: z.literal("moodle-helper"),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string(),
  note: z.string(),
  datasetId: z.string().regex(UUID).optional(),
  summary: BackupSummary.optional(),
  data: Snapshot,
});
export type Backup = z.infer<typeof Backup>;

export const BACKUP_NOTE = "Structured records, settings and personal changes only. Original document files and downloaded files are not included.";
export const BACKUP_EXCLUSIONS = [
  "Original PDF/DOCX file bytes",
  "Session-local extracted or OCR text kept outside the structured records",
  "Material files downloaded to your disk",
  "Credentials, provider keys, bridge tokens and Moodle account identifiers",
];

export function makeBackup(data: Snapshot, now = new Date()): Backup {
  return { app: "moodle-helper", version: BACKUP_VERSION, exportedAt: now.toISOString(), note: BACKUP_NOTE, data };
}

export function backupCounts(d: Snapshot): { label: string; count: number }[] {
  return [
    { label: "Courses", count: d.courses.length },
    { label: "Assessments", count: d.assessments.length },
    { label: "Personal changes", count: d.overlays.length },
    { label: "Materials", count: d.materials.length },
    { label: "Imported document records", count: d.documents.length },
    { label: "Review candidates", count: d.candidates.length },
    { label: "Deadline changes", count: d.changes.length },
    { label: "Alerts", count: d.alerts.length },
    { label: "Collected source records", count: d.collection?.records.length ?? 0 },
    { label: "Page refresh receipts", count: d.collection?.refreshes.length ?? 0 },
  ];
}

const SAFE_SCHEMES = new Set(["http:", "https:"]);
const LINK_SCHEMES = /^(javascript|data|file|blob|vbscript|ftp|ws|wss|chrome-extension|moz-extension):$/i;
const SECRET_QUERY = /^(token|wstoken|sesskey|session|sessionid|sid|moodlesession|sig|signature|auth|authorization|access_token|id_token|refresh_token|api_key|apikey|key|password|passwd|secret|credential|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|se|sp|sv)$/i;
const SECRET_QUERY_PREFIX = /^(x-amz-|x-goog-)/i;
const AUTH_ROUTE = /\/(login|logout|auth|oauth2?|sso|saml)(\/|$)|\/token\.php$/i;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;
const SECRET_TEXT = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /MoodleSession[A-Za-z]*=/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[?&](?:wstoken|sesskey|token|X-Amz-Signature)=/i,
];

/** Returns a reason (never the value) when a URL-shaped string is unsafe to export. */
export function unsafeUrlReason(value: string): string | null {
  const v = value.trim();
  if (!URL_LIKE.test(v) || /^[a-z]:[\\/]/i.test(v)) return null;
  let u: URL;
  try { u = new URL(v); } catch { return v.includes("://") ? "unparseable link" : null; }
  if (!SAFE_SCHEMES.has(u.protocol)) return LINK_SCHEMES.test(u.protocol) || v.includes("://") ? "unexpected link scheme" : null;
  if (u.username || u.password) return "link contains embedded credentials";
  for (const k of u.searchParams.keys()) if (SECRET_QUERY.test(k) || SECRET_QUERY_PREFIX.test(k)) return "link contains a session, token or signature parameter";
  if (/(^|[&#])(access_token|id_token|token)=/i.test(u.hash.slice(1))) return "link contains a token fragment";
  if (AUTH_ROUTE.test(u.pathname)) return "link points to a login or session route";
  return null;
}

export class BackupSanitizeError extends Error {
  constructor(public readonly problems: { path: string; reason: string }[]) {
    super(`Export stopped: ${problems.length} field${problems.length === 1 ? "" : "s"} contain credential-bearing or unsafe content (${problems.slice(0, 3).map((p) => p.path).join(", ")}${problems.length > 3 ? ", …" : ""}). Remove or refresh those records and retry.`);
    this.name = "BackupSanitizeError";
  }
}

function scan(value: unknown, path: string, out: { path: string; reason: string }[]) {
  if (typeof value === "string") {
    const r = unsafeUrlReason(value);
    if (r) out.push({ path, reason: r });
    else if (SECRET_TEXT.some((re) => re.test(value))) out.push({ path, reason: "text contains a credential marker" });
  } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) {
    if (SECRET_TEXT.some((re) => re.test(k))) out.push({ path: `${path}.<key>`, reason: "key contains a credential marker" });
    scan(v, `${path}.${k}`, out);
  }
}

/**
 * Validated projection: zod parses an independent clone, dropping unknown keys on known models (and failing
 * on strict ones), then every remaining string (nested URLs, evidence, history, free text) is checked.
 * Unsafe content fails the export with field paths only; values are never echoed.
 */
export function sanitizeSnapshot(raw: unknown): Snapshot {
  let cloned: unknown;
  try { cloned = structuredClone(raw); } catch { throw new Error("Export stopped: the loaded data could not be copied safely."); }
  const parsed = Snapshot.safeParse(cloned);
  if (!parsed.success) throw new Error("Export stopped: the loaded data did not pass validation. Sync or reload, then retry.");
  const problems: { path: string; reason: string }[] = [];
  scan(parsed.data, "data", problems);
  if (problems.length) throw new BackupSanitizeError(problems);
  return parsed.data;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}

export type PreparedBackup = { backup: Backup; json: string; bytes: number; filename: string };

/** Build the frozen export object and its serialized text once; preview counts come from the same object. */
export function buildBackup(raw: unknown, datasetId: string, now = new Date()): PreparedBackup {
  if (!UUID.test(datasetId)) throw new Error("The current dataset identity is invalid. Reconnect and retry.");
  const data = sanitizeSnapshot(raw);
  const backup: Backup = {
    ...makeBackup(data, now),
    datasetId,
    summary: { counts: backupCounts(data), exclusions: [...BACKUP_EXCLUSIONS], redactions: 0 },
  };
  let json: string;
  try { json = JSON.stringify(backup, null, 2); } catch { throw new Error("Export stopped: the backup could not be serialized."); }
  if (!Backup.safeParse(JSON.parse(json)).success) throw new Error("Export stopped: the prepared backup failed validation.");
  return { backup: deepFreeze(backup), json, bytes: new TextEncoder().encode(json).length, filename: `moodle-helper-backup-${backup.exportedAt.slice(0, 10)}.json` };
}

/**
 * One atomic Snapshot read bracketed by two identity reads. Detects a changed or unavailable dataset; it is not
 * a coordinated identity session and cannot detect an unsignalled switch-and-switch-back between the reads.
 */
export async function prepareBackup(load: () => Promise<unknown>, context: () => Promise<string>, now = () => new Date()): Promise<PreparedBackup> {
  const before = await context();
  let raw: unknown;
  try { raw = await load(); } catch (e) { throw new Error(`Could not read local data: ${e instanceof Error ? e.message : "unknown error"}`); }
  const after = await context();
  if (before !== after) throw new Error("The dataset changed while preparing the backup. Reconnect and prepare again.");
  return buildBackup(raw, before, now());
}

export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

/** Size check before any read; strict UTF-8 decode so malformed bytes are not silently replaced (#55). */
export async function readBackupFile(file: Blob): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (file.size > MAX_BACKUP_BYTES) return { ok: false, error: "This backup is larger than the 20 MiB restore limit. Nothing was read or changed." };
  let buffer: ArrayBuffer;
  try { buffer = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as ArrayBuffer); r.onerror = () => reject(r.error); r.readAsArrayBuffer(file); }); } catch { return { ok: false, error: "The backup file could not be read. Nothing was changed." }; }
  try { return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) }; }
  catch { return { ok: false, error: "This file is not valid UTF-8 text. Nothing was changed." }; }
}

export type RestoreIdentity = "match" | "unavailable";
export type RestorePreview =
  | {
      ok: true; backup: Backup; raw: unknown; bytes: number;
      diff: { label: string; current: number; incoming: number }[];
      identity: RestoreIdentity; restorable: boolean; reason?: string;
      exclusions: string[]; settingsReplaced: boolean; overlaysReplaced: boolean;
    }
  | { ok: false; error: string };

function depthOk(v: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (Array.isArray(v)) return v.every((x) => depthOk(x, depth + 1));
  if (v && typeof v === "object") return Object.values(v).every((x) => depthOk(x, depth + 1));
  return true;
}

/**
 * Validate fully before anything is written. `datasetId` is the current authoritative identity; without it, or for an
 * identity-less historical v1 file, counts are shown but the backup is not restorable. Links are never fetched.
 */
export function previewRestore(raw: string, current: Snapshot, datasetId?: string): RestorePreview {
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > MAX_BACKUP_BYTES) return { ok: false, error: "This backup is larger than the 20 MiB restore limit. Nothing was changed." };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This file is not valid JSON." };
  }
  if (!depthOk(json)) return { ok: false, error: "This backup is too deeply nested to restore safely." };
  const v = (json as { version?: unknown })?.version;
  if (typeof v === "number" && v > BACKUP_VERSION) return { ok: false, error: `Backup format version ${v} is newer than this app supports. Update Moodle Helper and retry.` };
  const parsed = Backup.safeParse(json);
  if (!parsed.success) {
    if (v !== undefined && v !== BACKUP_VERSION) return { ok: false, error: `Unsupported backup version: ${String(v)}.` };
    return { ok: false, error: "This file is not a valid Moodle Helper backup." };
  }
  if (Number.isNaN(Date.parse(parsed.data.exportedAt)) || !/^\d{4}-\d{2}-\d{2}T/.test(parsed.data.exportedAt)) return { ok: false, error: "Backup export timestamp is invalid." };
  if (parsed.data.datasetId && datasetId && parsed.data.datasetId !== datasetId) {
    return { ok: false, error: "Wrong identity: this backup belongs to a different local dataset and cannot be restored here." };
  }
  const problems: { path: string; reason: string }[] = [];
  scan(parsed.data.data, "data", problems);
  const expiring = (x: unknown, path: string): void => {
    if (typeof x === "string") { if (/[?&](expires|expiry|exp|x-amz-expires)=/i.test(x) && URL_LIKE.test(x.trim())) problems.push({ path, reason: "expiring link" }); }
    else if (Array.isArray(x)) x.forEach((y, i) => expiring(y, `${path}[${i}]`));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) expiring(y, `${path}.${k}`);
  };
  expiring(parsed.data.data, "data");
  if (problems.length) {
    const paths = [...new Set(problems.map((p) => p.path))];
    return { ok: false, error: `Backup rejected: ${paths.length} field${paths.length === 1 ? "" : "s"} contain credential-bearing, expiring or unsafe links (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}). Nothing was changed.` };
  }
  const d = parsed.data.data;
  const now = backupCounts(current), next = backupCounts(d);
  const identity: RestoreIdentity = parsed.data.datasetId && datasetId ? "match" : "unavailable";
  const reason = !parsed.data.datasetId
    ? "Identity unavailable: this older backup has no dataset identity and cannot be restored here."
    : !datasetId ? "Identity unavailable: the current dataset could not be verified. Reconnect to the local backend and retry." : undefined;
  return {
    ok: true, backup: parsed.data, raw: json, bytes,
    diff: next.map((n, i) => ({ label: n.label, current: now[i].count, incoming: n.count })),
    identity, restorable: identity === "match", ...(reason ? { reason } : {}),
    exclusions: parsed.data.summary?.exclusions.length ? parsed.data.summary.exclusions : [...BACKUP_EXCLUSIONS],
    settingsReplaced: true, overlaysReplaced: true,
  };
}

/** Dispatch an anchor download. There is no disk-completion signal; callers must not claim "saved". */
export function dispatchDownload(prepared: PreparedBackup, doc: Document = document, revokeAfterMs = 60_000): () => void {
  const blob = new Blob([prepared.json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  let revoked = false;
  const revoke = () => { if (!revoked) { revoked = true; URL.revokeObjectURL(url); } };
  try {
    const a = doc.createElement("a");
    a.href = url; a.download = prepared.filename; a.rel = "noopener"; a.style.display = "none";
    doc.body.appendChild(a); a.click(); a.remove();
  } catch (e) { revoke(); throw e; }
  const t = setTimeout(revoke, revokeAfterMs);
  return () => { clearTimeout(t); revoke(); };
}
