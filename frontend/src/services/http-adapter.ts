import type { RawCourseObservation } from "@/domain/types";
import { z } from "zod";
import { ConnectionState, ReminderPlan, Snapshot, TeachingCalendar, LocalReviewContext, LocalSyllabusDate, SyllabusRevisionPreview, LocalSyllabusInput, LocalSyllabusResult, type SyllabusRevisionDecision, type Snapshot as SnapshotValue } from "@/domain/types";
import { RestoreOutcomeUnknown, EraseOutcomeUnknown, type EraseRequest, type MoodleHelperAdapter, type OverlayPatch, type PersonalEventInput, type ReviewDecision, type RestoreRequest } from "./adapter";

const connectionSchema = z.object({ state: ConnectionState, message: z.string(), extensionDetected: z.boolean() });
const importSchema = z.object({ snapshot: Snapshot, result: z.union([
  z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), reason: z.string() }),
]) });
const downloadSchema = z.object({ snapshot: Snapshot, supported: z.boolean(), message: z.string() });
const cleanupState = z.enum(["pending", "complete", "failed"]);
const cleanupSchema = z.object({ backend: z.literal("complete"), dashboard: cleanupState, extension: cleanupState }).strict();
const dataContextSchema = z.object({ datasetId: z.string(), epoch: z.number().int().min(0), revision: z.number().int().min(0),
  lifecycle: z.enum(["active", "cleanup_pending", "complete"]), erasure: z.object({ eraseId: z.string(), cleanup: cleanupSchema }).strict().optional() }).strict();
const eraseStatusSchema = z.object({ eraseId: z.string(), datasetId: z.string(), epoch: z.number().int().min(0), current: z.boolean(), cleanup: cleanupSchema }).strict();
const aiSchema = z.union([
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({ available: z.literal(true), provider: z.string(), retention: z.string() }),
]);

/** The backend answered definitively (any HTTP status); network loss or an unreadable body stays uncertain. */
export class BackendResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "BackendResponseError"; }
}

/** HTTP transport for the local fictional-data backend. No fallback to fixtures. */
export class HttpAdapter implements MoodleHelperAdapter {
  readonly kind = "demo" as const;
  readonly storage = "backend" as const;

  /** #56 data-lifecycle epoch captured with the authoritative load; attached to every write. */
  private epoch: number | undefined;

  constructor(private baseUrl = "", private fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private epochHeader(): Record<string, string> {
    return this.epoch === undefined ? {} : { "X-Moodle-Helper-Data-Epoch": String(this.epoch) };
  }

  private async request<S extends z.ZodTypeAny>(method: string, path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/api${path}`, {
        method, credentials: "omit",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : this.epochHeader()) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("Could not reach the local backend. Check that FastAPI and the frontend API proxy are running, then try again.");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(response.ok ? "The backend returned an invalid JSON response." : `Backend request failed (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const error = z.object({ message: z.string() }).safeParse(payload);
      throw new BackendResponseError(error.success ? error.data.message : `Backend request failed (HTTP ${response.status}).`, response.status);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error(`The backend returned an invalid response (${parsed.error.issues[0]?.path.join(".") || "response"}).`);
    return parsed.data;
  }

  connection() { return this.request("GET", "/connection", connectionSchema); }
  /** Epoch is read BEFORE the Snapshot: an erase in between leaves a stale epoch, so writes 409 and reload. */
  async load() {
    try { this.epoch = (await this.dataContext()).epoch; } catch { this.epoch = undefined; }
    return this.request("GET", "/snapshot", Snapshot);
  }
  dataContext() { return this.request("GET", "/data-context", dataContextSchema); }
  private async binding(message: string) {
    const base = this.baseUrl.replace(/\/$/, "");
    const context = await this.fetcher(`${base}/api/bridge-context`, { credentials: "omit", cache: "no-store" }).catch(() => null);
    if (!context?.ok) throw new Error(message);
    return z.object({ version: z.literal("1"), binding: z.string().min(1) }).strict().parse(await context.json()).binding;
  }
  /** Browser-to-localhost only; bounded control request with stale-state preconditions (#56). */
  async eraseLocalData(body: EraseRequest) {
    const base = this.baseUrl.replace(/\/$/, "");
    const binding = await this.binding("Could not verify the local process. Reconnect and confirm again. Nothing was deleted.");
    let response: Response;
    try {
      response = await this.fetcher(`${base}/api/local-data/erase`, { method: "POST", credentials: "omit", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Moodle-Helper-Bridge-Binding": binding }, body: JSON.stringify(body) });
    } catch { throw new EraseOutcomeUnknown(); }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new EraseOutcomeUnknown(); }
    if (!response.ok) throw new BackendResponseError(z.object({ message: z.string() }).safeParse(payload).data?.message ?? `Deletion failed (HTTP ${response.status}).`, response.status);
    const result = z.object({ eraseId: z.string(), datasetId: z.string(), epoch: z.number().int().min(0), revision: z.number().int().min(0), snapshot: Snapshot, cleanup: cleanupSchema }).strict().parse(payload);
    this.epoch = result.epoch;
    return result;
  }
  eraseStatus(eraseId: string) { return this.request("GET", `/local-data/erasures/${encodeURIComponent(eraseId)}`, eraseStatusSchema); }
  async acknowledgeErase(eraseId: string, component: "dashboard", state: "complete" | "failed") {
    const base = this.baseUrl.replace(/\/$/, "");
    const binding = await this.binding("Could not verify the local process. Retry cleanup.");
    const response = await this.fetcher(`${base}/api/local-data/erasures/${encodeURIComponent(eraseId)}/ack`, { method: "POST", credentials: "omit", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Moodle-Helper-Bridge-Binding": binding }, body: JSON.stringify({ component, state }) });
    const payload: unknown = await response.json();
    if (!response.ok) throw new BackendResponseError(z.object({ message: z.string() }).safeParse(payload).data?.message ?? `Cleanup acknowledgement failed (HTTP ${response.status}).`, response.status);
    return eraseStatusSchema.parse(payload);
  }
  /** Browser-to-localhost only; deliberately absent from the Chrome adapter catalog. */
  async routeLocalSyllabus(input: LocalSyllabusInput, signal?: AbortSignal): Promise<LocalSyllabusResult> {
    const body = LocalSyllabusInput.parse(input), base = this.baseUrl.replace(/\/$/, "");
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).length > 1024 * 1024) throw new Error("Local routing metadata exceeds the 1 MiB request limit. Route fewer proposals.");
    const context = await this.fetcher(`${base}/api/bridge-context`, { credentials: "omit", cache: "no-store", signal });
    if (!context.ok) throw new Error("Could not verify the local process. Reconnect before routing.");
    const binding = z.object({ version: z.literal("1"), binding: z.string().min(1) }).strict().parse(await context.json());
    signal?.throwIfAborted();
    const response = await this.fetcher(`${base}/api/local-syllabus/route`, { method: "POST", credentials: "omit", cache: "no-store", signal, headers: { Accept: "application/json", "Content-Type": "application/json", "X-Moodle-Helper-Bridge-Binding": binding.binding, ...this.epochHeader() }, body: encoded });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(z.object({ message: z.string() }).safeParse(result).data?.message ?? "Local routing failed. Retry the same stored proposal to reconcile its outcome.");
    return LocalSyllabusResult.parse(result);
  }
  restoreContext() { return this.request("GET", "/backups/restore-context", z.object({ datasetId: z.string(), epoch: z.number().int().min(0), revision: z.number().int().min(0) }).strict()); }
  /** Browser-to-localhost only; sends the exact prepared backup with stale-write preconditions (#55). */
  async restoreBackup(body: RestoreRequest) {
    const base = this.baseUrl.replace(/\/$/, "");
    const context = await this.fetcher(`${base}/api/bridge-context`, { credentials: "omit", cache: "no-store" }).catch(() => null);
    if (!context?.ok) throw new Error("Could not verify the local process. Reconnect and refresh the restore preview. Nothing was changed.");
    const binding = z.object({ version: z.literal("1"), binding: z.string().min(1) }).strict().parse(await context.json());
    let response: Response;
    try {
      response = await this.fetcher(`${base}/api/backups/restore`, { method: "POST", credentials: "omit", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Moodle-Helper-Bridge-Binding": binding.binding }, body: JSON.stringify(body) });
    } catch { throw new RestoreOutcomeUnknown(); }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new RestoreOutcomeUnknown(); }
    if (!response.ok) {
      const message = z.object({ message: z.string() }).safeParse(payload).data?.message ?? `Restore failed (HTTP ${response.status}).`;
      throw new BackendResponseError(message, response.status);
    }
    const restored = z.object({ snapshot: Snapshot, datasetId: z.string(), epoch: z.number(), revision: z.number(), restoreId: z.string(), remindersRebuilt: z.boolean(), reminderGeneration: z.string(), replayed: z.boolean() }).strict().parse(payload);
    if (this.epoch !== undefined) this.epoch = restored.epoch;
    return restored;
  }
  replaceAll(snapshot: SnapshotValue) { return this.request("PUT", "/snapshot", Snapshot, snapshot); }
  ingestCourseDiscovery(observations: RawCourseObservation[]) { return this.request("POST", "/courses/discovery", Snapshot, { observations }); }
  setTrackedCourses(ids: string[]) { return this.request("PUT", "/tracked-courses", Snapshot, ids); }
  updateOverlay(id: string, patch: OverlayPatch) {
    const wire = { ...patch };
    for (const key of ["titleOverride", "dateOverride", "overrideBase"] as const) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === undefined) wire[key] = null;
    }
    return this.request("PATCH", `/assessments/${encodeURIComponent(id)}/overlay`, Snapshot, wire);
  }
  addPersonalEvent(input: PersonalEventInput) { return this.request("POST", "/personal-events", Snapshot, input); }
  deletePersonalEvent(id: string) { return this.request("DELETE", `/personal-events/${encodeURIComponent(id)}`, Snapshot); }
  async syncAll(onProgress: (snapshot: SnapshotValue) => void) {
    const result = await this.request("POST", "/sync", Snapshot);
    onProgress(result);
    return result;
  }
  async importDocument(courseId: string, fileName: string, onProgress: (snapshot: SnapshotValue) => void, contentDigest?: string) {
    const result = await this.request("POST", "/documents/import", importSchema, { courseId, fileName, ...(contentDigest ? { contentDigest } : {}) });
    onProgress(result.snapshot);
    return result;
  }
  review(id: string, decision: ReviewDecision) {
    if (!decision.localReview) return this.request("POST", `/candidates/${encodeURIComponent(id)}/review`, Snapshot, decision);
    return this.reviewLocal(id, decision);
  }
  /** Registered local candidate: strict metadata-only body plus the current process binding (#32). */
  private async reviewLocal(id: string, decision: ReviewDecision) {
    LocalReviewContext.parse(decision.localReview);
    const body = decision.kind === "correct" ? { kind: decision.kind, title: decision.title, type: decision.type, date: LocalSyllabusDate.parse(decision.date), localReview: decision.localReview } : { kind: decision.kind, localReview: decision.localReview };
    const base = this.baseUrl.replace(/\/$/, "");
    let context: Response;
    try { context = await this.fetcher(`${base}/api/bridge-context`, { credentials: "omit", cache: "no-store" }); }
    catch { throw new BackendResponseError("Could not verify the local process. Nothing was saved; reconnect and retry.", 0); }
    const binding = context.ok ? z.object({ version: z.literal("1"), binding: z.string().min(1) }).strict().safeParse(await context.json().catch(() => null)) : undefined;
    if (!binding?.success) throw new BackendResponseError("Could not verify the local process. Nothing was saved; reconnect and retry.", context.status || 0);
    let response: Response;
    try {
      response = await this.fetcher(`${base}/api/candidates/${encodeURIComponent(id)}/review`, { method: "POST", credentials: "omit", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Moodle-Helper-Bridge-Binding": binding.data.binding, ...this.epochHeader() }, body: JSON.stringify(body) });
    } catch { throw new Error("The review result is unknown: the local backend did not answer. Retry to reconcile the same decision."); }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw response.ok ? new Error("The review result is unknown: the backend response was unreadable. Retry to reconcile the same decision.") : new BackendResponseError(`Review failed (HTTP ${response.status}).`, response.status); }
    if (!response.ok) throw new BackendResponseError(z.object({ message: z.string() }).safeParse(payload).data?.message ?? `Review failed (HTTP ${response.status}).`, response.status);
    const parsed = Snapshot.safeParse(payload);
    if (!parsed.success) throw new Error("The review result is unknown: the backend response was invalid. Retry to reconcile the same decision.");
    return parsed.data;
  }
  proposeReconciliation(left: string, right: string) { return this.request("POST", "/reconciliation/pairs", Snapshot, { left, right }); }
  previewSyllabusRevision(sourceId: string, candidateId: string) { return this.request("POST", "/syllabus-revisions/preview", SyllabusRevisionPreview, {sourceId, candidateId}); }
  confirmSyllabusRevision(decision: SyllabusRevisionDecision) { return this.request("POST", "/syllabus-revisions/confirm", Snapshot, decision); }
  decideReconciliation(pairId: string, fingerprint: string, reviewRevision: string, kind: "confirm" | "reject", choices: Record<string, string>) {
    return this.request("POST", "/reconciliation/decisions", Snapshot, { pairId, fingerprint, reviewRevision, kind, choices });
  }
  downloadMaterial(id: string) { return this.request("POST", `/materials/${encodeURIComponent(id)}/download`, downloadSchema); }
  saveAlerts(alerts: SnapshotValue["alerts"]) { return this.request("PUT", "/alerts", Snapshot, alerts); }
  updateAlerts(ids: string[], action: "read" | "delete") { return this.request("POST", "/alerts/update", Snapshot, { ids, action }); }
  setSyllabusSuggestionDismissal(recordId: string, dismissed: boolean) { return this.request("POST", "/syllabus-suggestions/dismissal", Snapshot, { recordId, dismissed }); }
  async updateSettings(patch: Partial<SnapshotValue["settings"]>) { if (Object.hasOwn(patch, "teachingCalendar")) TeachingCalendar.parse(patch.teachingCalendar); return this.request("PATCH", "/settings", Snapshot, patch); }
  deleteLocalData() { return this.request("DELETE", "/local-data", Snapshot); }
  resetDemo() { return this.request("POST", "/demo/reset", Snapshot); }
  aiAvailability() { return this.request("GET", "/ai/availability", aiSchema); }
  reminderPlan() { return this.request("GET", "/reminders/plan", ReminderPlan); }
}
