import {
  approved,
  APPROVED_ORIGINS,
  BridgeError,
  idValid,
  requestError,
  validReply,
  type DiscoveryResult,
  type SignInResult,
  type LocalOperation,
  type Request,
  type Operation,
} from "../../../shared/src/bridge";
import type { RawCourseObservation, Snapshot, Settings, ReminderPlan } from "@/domain/types";
import type {
  MoodleHelperAdapter,
  OverlayPatch,
  PersonalEventInput,
  ReviewDecision,
  ConnectionInfo,
  AiAvailability,
  ImportResult,
} from "./adapter";
import type { MaterialDownloads } from "@/domain/material-transfer";
import type { Current, MockRun } from "../../../shared/src/mock-progress";
export { APPROVED_ORIGINS };
export const isApprovedOrigin = approved;
/** #82: a run reads up to 5 Moodle requests, each paced, retried and limited to 30 s. */
export const DISCOVERY_DEADLINE_MS = 300_000;
/** #46: one paced GET that may wait behind a running scan and be retried twice. */
export const SIGN_IN_DEADLINE_MS = 300_000;

type Pending = {
  request: Request;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class BridgeClient implements MoodleHelperAdapter {
  readonly kind = "extension" as const;
  readonly storage = "backend" as const;
  readonly clientId: string;
  private sessionId: string | null = null;
  private pending = new Map<string, Pending>();
  private window: Window | undefined;
  private listener: (e: MessageEvent) => void;
  constructor(
    win: Window | undefined = typeof window === "undefined" ? undefined : window,
    private deadlines: { hello: number; operation: number; discovery?: number; signIn?: number } = {
      hello: 800,
      operation: 10000,
    },
  ) {
    this.window = win;
    this.clientId = crypto.randomUUID();
    this.listener = (e) => {
      if (
        !win ||
        win.top !== win ||
        e.source !== win ||
        e.origin !== win.location.origin ||
        !approved(e.origin)
      )
        return;
      const value = e.data;
      if (
        !value ||
        value.source !== "moodle-helper-extension" ||
        value.clientId !== this.clientId ||
        !idValid(value.requestId)
      )
        return;
      const item = this.pending.get(value.requestId);
      if (!item) return;
      // Wrong correlations and late responses are ignored. A matching malformed reply fails closed.
      if (!validReply(value, item.request)) {
        this.finish(value.requestId, new BridgeError("INVALID_RESPONSE"));
        return;
      }
      if (!value.ok) {
        const error = new BridgeError(value.error!.code);
        this.finish(value.requestId, error);
        if (["RECONNECT_REQUIRED", "PERMISSION_DENIED"].includes(value.error!.code))
          this.invalidate();
      } else this.finish(value.requestId, null, value.result);
    };
    win?.addEventListener("message", this.listener);
  }
  private finish(id: string, error: Error | null, result?: unknown) {
    const item = this.pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(id);
    if (error) item.reject(error);
    else item.resolve(result);
  }
  private invalidate() {
    this.sessionId = null;
    for (const id of this.pending.keys()) this.finish(id, new BridgeError("RECONNECT_REQUIRED"));
  }
  dispose() {
    this.invalidate();
    this.window?.removeEventListener("message", this.listener);
  }
  async connect() {
    this.invalidate();
    const result = await this.send<{
      sessionId: string;
      version: "1";
      workerGeneration: string;
      backend: "ready" | "unavailable";
      localRepository: "ready" | "unavailable";
      moodleCollection: "unavailable";
    }>("hello", {});
    this.sessionId = result.sessionId;
    return result as {
      version: "1";
      workerGeneration: string;
      sessionId: string;
      backend: "ready" | "unavailable";
      localRepository: "ready" | "unavailable";
      moodleCollection: "unavailable";
    };
  }
  private send<T>(operation: Operation | "hello" | LocalOperation, payload: unknown): Promise<T> {
    const win = this.window;
    if (!win || win.top !== win || !approved(win.location.origin))
      return Promise.reject(new BridgeError("PERMISSION_DENIED"));
    if (operation !== "hello" && !this.sessionId)
      return Promise.reject(new BridgeError("RECONNECT_REQUIRED"));
    if (this.pending.size >= 32) return Promise.reject(new BridgeError("BUSY"));
    const request: Request = {
      source: "moodle-helper-web",
      type: "request",
      version: "1",
      clientId: this.clientId,
      requestId: crypto.randomUUID(),
      operation,
      payload,
      ...(operation === "hello" ? {} : { sessionId: this.sessionId! }),
    };
    const invalid = requestError(request);
    if (invalid) return Promise.reject(new BridgeError(invalid));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.finish(
            request.requestId,
            new BridgeError(operation === "hello" ? "MISSING_EXTENSION" : "TIMEOUT"),
          );
          this.invalidate();
        },
        operation === "hello"
          ? this.deadlines.hello
          : operation === "discoverCourses"
            ? (this.deadlines.discovery ?? DISCOVERY_DEADLINE_MS)
            : operation === "checkMoodleSignIn"
              ? (this.deadlines.signIn ?? SIGN_IN_DEADLINE_MS)
              : this.deadlines.operation,
      );
      this.pending.set(request.requestId, {
        request,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        win.postMessage(request, win.location.origin);
      } catch {
        this.finish(request.requestId, new BridgeError("RECONNECT_REQUIRED"));
        this.invalidate();
      }
    });
  }
  connection(): Promise<ConnectionInfo> {
    return this.send("connection", {});
  }
  load(): Promise<Snapshot> {
    return this.send("load", {});
  }
  currentMockRun(): Promise<Current> {
    return this.send("currentMockRun", {});
  }
  startMockRun(idempotencyKey: string): Promise<MockRun> {
    return this.send("startMockRun", { idempotencyKey });
  }
  cancelMockRun(id: string): Promise<MockRun> {
    return this.send("cancelMockRun", { id });
  }
  replaceAll(snapshot: Snapshot): Promise<Snapshot> {
    return this.send("replaceAll", snapshot);
  }
  /** #82 worker-local "Find my SDU courses" run; the reply is closed and never holds the sesskey. */
  discoverCourses(): Promise<DiscoveryResult> {
    return this.send("discoverCourses", {});
  }
  /** #46 worker-local read-only sign-in probe; the closed reply is {signal, checkedAt}. */
  checkMoodleSignIn(): Promise<SignInResult> {
    return this.send("checkMoodleSignIn", {});
  }
  ingestCourseDiscovery(observations: RawCourseObservation[]): Promise<Snapshot> {
    return this.send("ingestCourseDiscovery", { observations });
  }
  setTrackedCourses(ids: string[]): Promise<Snapshot> {
    return this.send("setTrackedCourses", ids);
  }
  updateOverlay(id: string, patch: OverlayPatch): Promise<Snapshot> {
    const body = { ...patch };
    for (const k of ["titleOverride", "dateOverride", "overrideBase"] as const)
      if (Object.hasOwn(patch, k) && patch[k] === undefined) body[k] = null;
    return this.send("updateOverlay", { id, body });
  }
  addPersonalEvent(input: PersonalEventInput): Promise<Snapshot> {
    return this.send("addPersonalEvent", input);
  }
  deletePersonalEvent(id: string): Promise<Snapshot> {
    return this.send("deletePersonalEvent", { id });
  }
  async syncAll(onProgress: (s: Snapshot) => void) {
    const s: Snapshot = await this.send("syncAll", {});
    onProgress(s);
    return s;
  }
  async importDocument(
    courseId: string,
    fileName: string,
    onProgress: (s: Snapshot) => void,
    contentDigest?: string,
  ) {
    const r: { snapshot: Snapshot; result: ImportResult } = await this.send("importDocument", {
      courseId,
      fileName,
      ...(contentDigest ? { contentDigest } : {}),
    });
    onProgress(r.snapshot);
    return r;
  }
  review(id: string, body: ReviewDecision): Promise<Snapshot> {
    return this.send("review", { id, body });
  }
  async proposeReconciliation(left: string, right: string): Promise<Snapshot> {
    return this.send("proposeReconciliationPair", { left, right });
  }
  async previewSyllabusRevision(
    sourceId: string,
    candidateId: string,
  ): Promise<import("@/domain/types").SyllabusRevisionPreview> {
    return this.send("previewSyllabusRevision", { sourceId, candidateId });
  }
  async confirmSyllabusRevision(
    decision: import("@/domain/types").SyllabusRevisionDecision,
  ): Promise<Snapshot> {
    return this.send("confirmSyllabusRevision", decision);
  }
  async decideReconciliation(
    pairId: string,
    fingerprint: string,
    reviewRevision: string,
    kind: "confirm" | "reject",
    choices: Record<string, string>,
  ): Promise<Snapshot> {
    return this.send("decideReconciliationPair", {
      pairId,
      fingerprint,
      reviewRevision,
      kind,
      choices,
    });
  }
  downloadMaterial(
    id: string,
  ): Promise<{ snapshot: Snapshot; supported: boolean; message: string }> {
    return this.send("downloadMaterial", { id });
  }
  /** #41 explicit single-file transfer metadata; the extension opens its own transfer tab. */
  startMaterialDownload(
    datasetId: string,
    materialId: string,
    idempotencyKey: string,
  ): Promise<import("@/domain/material-transfer").MaterialDownloadStartResult> {
    return this.send("startMaterialDownload", { datasetId, materialId, idempotencyKey });
  }
  listMaterialDownloads(): Promise<{
    transfers: import("@/domain/material-transfer").MaterialTransfer[];
  }> {
    return this.send("listMaterialDownloads", {});
  }
  materialDownload(
    transferId: string,
  ): Promise<import("@/domain/material-transfer").MaterialTransfer> {
    return this.send("materialDownload", { id: transferId });
  }
  cancelMaterialDownload(
    transferId: string,
  ): Promise<import("@/domain/material-transfer").MaterialTransfer> {
    return this.send("cancelMaterialDownload", { id: transferId });
  }
  saveAlerts(alerts: Snapshot["alerts"]): Promise<Snapshot> {
    return this.send("saveAlerts", alerts);
  }
  updateAlerts(ids: string[], action: "read" | "delete"): Promise<Snapshot> {
    return this.send("updateAlerts", { ids, action });
  }
  setSyllabusSuggestionDismissal(recordId: string, dismissed: boolean): Promise<Snapshot> {
    return this.send("setSyllabusSuggestionDismissal", { recordId, dismissed });
  }
  updateSettings(patch: Partial<Settings>): Promise<Snapshot> {
    return this.send("updateSettings", patch);
  }
  deleteLocalData(): Promise<Snapshot> {
    return this.send("deleteLocalData", {});
  }
  resetDemo(): Promise<Snapshot> {
    return this.send("resetDemo", {});
  }
  aiAvailability(): Promise<AiAvailability> {
    return this.send("aiAvailability", {});
  }
  reminderPlan(): Promise<ReminderPlan> {
    return this.send("reminderPlan", {});
  }
}
export class ExtensionAdapter extends BridgeClient {}
/** #82: one explicit discovery through a fresh bridge session, beside the default HTTP adapter. */
export async function discoverSduCourses(): Promise<DiscoveryResult> {
  const client = new BridgeClient();
  try {
    await client.connect();
    return await client.discoverCourses();
  } finally {
    client.dispose();
  }
}
/** #46: one sign-in probe through a fresh bridge session, beside the default HTTP adapter. */
export async function checkSduSignIn(): Promise<SignInResult> {
  const client = new BridgeClient();
  try {
    await client.connect();
    return await client.checkMoodleSignIn();
  } finally {
    client.dispose();
  }
}
/**
 * #41 owner live check: the default HTTP adapter has no transfer operations, and only the
 * extension worker opens the transfer tab for a queued transfer. When live sync is available the
 * Materials page sends each transfer operation through a fresh bridge session, as Sync all does.
 */
export function bridgeMaterialDownloads(
  open: () => BridgeClient = () => new BridgeClient(),
): MaterialDownloads {
  const through = async <T>(call: (client: BridgeClient) => Promise<T>): Promise<T> => {
    const client = open();
    try {
      await client.connect();
      return await call(client);
    } finally {
      client.dispose();
    }
  };
  return {
    startMaterialDownload: (datasetId, materialId, idempotencyKey) =>
      through((c) => c.startMaterialDownload(datasetId, materialId, idempotencyKey)),
    listMaterialDownloads: () => through((c) => c.listMaterialDownloads()),
    materialDownload: (transferId) => through((c) => c.materialDownload(transferId)),
    cancelMaterialDownload: (transferId) => through((c) => c.cancelMaterialDownload(transferId)),
  };
}
/** #20/#46: Sync all through a fresh bridge session, so the worker starts the queued scan at once. */
export async function syncAllThroughExtension(
  onProgress: (s: Snapshot) => void,
): Promise<Snapshot> {
  const client = new BridgeClient();
  try {
    await client.connect();
    return await client.syncAll(onProgress);
  } finally {
    client.dispose();
  }
}
/** Detection is explanatory only; the default HTTP adapter and its saved Snapshot stay in use. */
export async function detectExtension(timeoutMs = 800): Promise<boolean> {
  const client = new BridgeClient(undefined, { hello: timeoutMs, operation: 10000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    client.dispose();
  }
}
