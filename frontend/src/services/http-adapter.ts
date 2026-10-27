import type { RawCourseObservation } from "@/domain/types";
import { z } from "zod";
import { ConnectionState, Snapshot, type Snapshot as SnapshotValue } from "@/domain/types";
import type { MoodleHelperAdapter, OverlayPatch, PersonalEventInput, ReviewDecision } from "./adapter";

const connectionSchema = z.object({ state: ConnectionState, message: z.string(), extensionDetected: z.boolean() });
const importSchema = z.object({ snapshot: Snapshot, result: z.union([
  z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), reason: z.string() }),
]) });
const downloadSchema = z.object({ snapshot: Snapshot, supported: z.boolean(), message: z.string() });
const aiSchema = z.union([
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({ available: z.literal(true), provider: z.string(), retention: z.string() }),
]);

/** HTTP transport for the local fictional-data backend. No fallback to fixtures. */
export class HttpAdapter implements MoodleHelperAdapter {
  readonly kind = "demo" as const;
  readonly storage = "backend" as const;

  constructor(private baseUrl = "", private fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async request<S extends z.ZodTypeAny>(method: string, path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/api${path}`, {
        method, credentials: "omit",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
      throw new Error(error.success ? error.data.message : `Backend request failed (HTTP ${response.status}).`);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error(`The backend returned an invalid response (${parsed.error.issues[0]?.path.join(".") || "response"}).`);
    return parsed.data;
  }

  connection() { return this.request("GET", "/connection", connectionSchema); }
  load() { return this.request("GET", "/snapshot", Snapshot); }
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
  review(id: string, decision: ReviewDecision) { return this.request("POST", `/candidates/${encodeURIComponent(id)}/review`, Snapshot, decision); }
  proposeReconciliation(left: string, right: string) { return this.request("POST", "/reconciliation/pairs", Snapshot, { left, right }); }
  decideReconciliation(pairId: string, fingerprint: string, reviewRevision: string, kind: "confirm" | "reject", choices: Record<string, string>) {
    return this.request("POST", "/reconciliation/decisions", Snapshot, { pairId, fingerprint, reviewRevision, kind, choices });
  }
  downloadMaterial(id: string) { return this.request("POST", `/materials/${encodeURIComponent(id)}/download`, downloadSchema); }
  saveAlerts(alerts: SnapshotValue["alerts"]) { return this.request("PUT", "/alerts", Snapshot, alerts); }
  updateSettings(patch: Partial<SnapshotValue["settings"]>) { return this.request("PATCH", "/settings", Snapshot, patch); }
  deleteLocalData() { return this.request("DELETE", "/local-data", Snapshot); }
  resetDemo() { return this.request("POST", "/demo/reset", Snapshot); }
  aiAvailability() { return this.request("GET", "/ai/availability", aiSchema); }
}
