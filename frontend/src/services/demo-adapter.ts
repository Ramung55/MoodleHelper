import type { RawCourseObservation } from "@/domain/types";
import { effectiveSources, reconciledSourceDate } from "@/domain/assessments";
import { candidateToAssessment, checkFormat } from "@/domain/extraction";
import { Snapshot as SnapshotSchema, type Snapshot } from "@/domain/types";
import type { MoodleHelperAdapter, PersonalEventInput, ReviewDecision } from "./adapter";
import { buildDemoSnapshot } from "./fixtures";

export const DEMO_STORAGE_KEY = "moodle-helper:demo:v1";

export interface KV {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

const memoryKV = (): KV => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
};

export const browserKV = (): KV =>
  typeof window === "undefined"
    ? memoryKV()
    : {
        get: (k) => window.localStorage.getItem(k),
        set: (k, v) => window.localStorage.setItem(k, v),
        remove: (k) => window.localStorage.removeItem(k),
      };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function emptySnapshot(base: Snapshot): Snapshot {
  const { collection: _collection, reconciliation: _reconciliation, deadlineStreams: _deadlineStreams, syllabusRevisions: _syllabusRevisions, ...retained } = base;
  return { ...retained, courses: [], assessments: [], overlays: [], materials: [], documents: [], candidates: [], sync: [], changes: [], alerts: [], settings: { ...base.settings, trackedCourseIds: [] } };
}

/** Demo implementation of the services layer. Persists interactions locally. Never contacts Moodle. */
export class DemoAdapter implements MoodleHelperAdapter {
  readonly kind = "demo" as const;
  constructor(
    private kv: KV = browserKV(),
    private delay = 250,
    private now: () => number = Date.now,
  ) {}

  private read(): Snapshot {
    const raw = this.kv.get(DEMO_STORAGE_KEY);
    if (raw) {
      const parsed = SnapshotSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
    const fresh = buildDemoSnapshot(this.now());
    this.write(fresh);
    return fresh;
  }
  private write(s: Snapshot): Snapshot {
    this.kv.set(DEMO_STORAGE_KEY, JSON.stringify(s));
    return s;
  }
  private mutate(fn: (s: Snapshot) => Snapshot): Snapshot {
    return this.write(fn(structuredClone(this.read())));
  }
  private stamp() {
    return new Date(this.now()).toISOString();
  }

  async ingestCourseDiscovery(_observations: RawCourseObservation[]): Promise<Snapshot> {
    throw new Error("Course discovery persistence requires the local backend. Use the default HTTP adapter.");
  }

  async connection() {
    return {
      state: "demo" as const,
      extensionDetected: false,
      message: "Chrome extension not connected. Showing fictional demo data — nothing here comes from Moodle.",
    };
  }
  async load() {
    return this.read();
  }
  async setTrackedCourses(ids: string[]) {
    return this.mutate((s) => ({ ...s, settings: { ...s.settings, trackedCourseIds: ids } }));
  }
  async updateOverlay(id: string, patch: Parameters<MoodleHelperAdapter["updateOverlay"]>[1]) {
    return this.mutate((s) => {
      const cur = s.overlays.find((o) => o.assessmentId === id) ?? { assessmentId: id, hidden: false, completed: false };
      if ("dateOverride" in patch && patch.dateOverride == null && patch.overrideBase != null) {
        throw new Error("Clearing dateOverride cannot set a nonnull overrideBase");
      }
      const next = { ...cur };
      for (const [key, value] of Object.entries(patch)) {
        if (["titleOverride", "dateOverride", "overrideBase"].includes(key) && value == null) delete next[key as keyof typeof next];
        else Object.assign(next, { [key]: value });
      }
      // remember which source date the override was set against
      if ("dateOverride" in patch) {
        const a = s.assessments.find((x) => x.id === id);
        const sources = a ? effectiveSources(s, a) : [];
        next.overrideBase = patch.dateOverride && a ? (sources.length ? reconciledSourceDate(sources) : {kind:"unknown"}) : undefined;
      }
      return { ...s, overlays: [...s.overlays.filter((o) => o.assessmentId !== id), next] };
    });
  }
  async addPersonalEvent(input: PersonalEventInput) {
    const t = this.stamp();
    return this.mutate((s) => ({
      ...s,
      assessments: [
        ...s.assessments,
        { id: `p-${this.now().toString(36)}`, courseId: input.courseId, title: input.title, type: input.type, personal: true, sources: [{ source: "personal", date: input.date, observedAt: t }], firstObservedAt: t, lastObservedAt: t },
      ],
    }));
  }
  async deletePersonalEvent(id: string) {
    return this.mutate((s) => ({
      ...s,
      assessments: s.assessments.filter((a) => !(a.id === id && a.personal)),
      overlays: s.overlays.filter((o) => o.assessmentId !== id),
    }));
  }

  /** Simulated sync: one course fails; previously saved data is preserved. */
  async syncAll(onProgress: (s: Snapshot) => void) {
    const ids = this.read().settings.trackedCourseIds;
    let s = this.mutate((x) => ({ ...x, sync: x.sync.map((c) => (ids.includes(c.courseId) ? { ...c, status: "syncing" as const, progress: 0 } : c)) }));
    onProgress(s);
    for (const id of ids) {
      for (const p of [40, 100]) {
        await wait(this.delay);
        const failing = id === "c-phy";
        s = this.mutate((x) => ({
          ...x,
          sync: x.sync.map((c) =>
            c.courseId !== id
              ? c
              : p < 100
                ? { ...c, progress: p }
                : failing
                  ? { ...c, status: "failed" as const, progress: 100, error: "Moodle returned an error for 2 of 9 activities. Earlier data kept." }
                  : { ...c, status: "ok" as const, coverage: "full" as const, progress: 100, error: undefined, lastSuccessAt: this.stamp() },
          ),
        }));
        onProgress(s);
      }
    }
    return s;
  }

  async importDocument(courseId: string, fileName: string, onProgress: (s: Snapshot) => void, contentDigest?: string) {
    const fmt = checkFormat(fileName);
    if (!fmt.ok) return { snapshot: this.read(), result: fmt };
    const id = contentDigest ? `d-mock-${JSON.stringify([courseId, contentDigest])}` : `d-${this.now().toString(36)}`;
    const previous = this.read();
    if (contentDigest && previous.documents.some((d) => d.id === id)) {
      if (previous.documents.filter((d) => d.id === id && d.courseId === courseId && d.mocked).length !== 1 ||
          previous.candidates.filter((c) => c.id === `k-${id}` && c.documentId === id && c.courseId === courseId).length !== 1) {
        throw new Error("Mock document identity collision; import was not saved.");
      }
      return { snapshot: previous, result: { ok: true as const } };
    }
    if (previous.candidates.some((c) => c.id === `k-${id}`)) throw new Error("Mock candidate identity collision; import was not saved.");
    let s = this.mutate((x) => ({ ...x, documents: [...x.documents, { id, courseId, name: fileName, format: fmt.format, status: "extracting", progress: 0, importedAt: this.stamp(), mocked: true }] }));
    onProgress(s);
    for (const p of [35, 70, 100]) {
      await wait(this.delay);
      s = this.mutate((x) => ({ ...x, documents: x.documents.map((d) => (d.id === id ? { ...d, progress: p, status: p === 100 ? ("done" as const) : d.status } : d)) }));
      onProgress(s);
    }
    // Mocked extraction: one uncertain candidate that must be reviewed
    s = this.mutate((x) => ({
      ...x,
      candidates: [
        ...x.candidates,
        { id: `k-${id}`, documentId: id, courseId, title: "Assignment (from imported syllabus)", type: "assignment", date: { kind: "week", week: 8 }, rawDateText: "Week 8", language: "en", confidence: 0.6, excerpt: "Assignment due in week 8 (mock extraction)", location: `${fileName}, page 2`, status: "pending", reason: "Mock extraction — verify against the document" },
      ],
    }));
    return { snapshot: s, result: { ok: true as const } };
  }

  async review(candidateId: string, d: ReviewDecision) {
    const t = this.stamp();
    return this.mutate((s) => {
      const c = s.candidates.find((x) => x.id === candidateId);
      if (!c) return s;
      if (d.kind === "reject") return { ...s, candidates: s.candidates.map((x) => (x.id === c.id ? { ...x, status: "rejected" as const } : x)) };
      const fixed = d.kind === "correct" ? { ...c, title: d.title, date: d.date, type: d.type } : c;
      let assessments = s.assessments;
      if (c.matchAssessmentId && assessments.some((a) => a.id === c.matchAssessmentId)) {
        // confirmed match → attach syllabus evidence; Moodle date keeps priority
        assessments = assessments.map((a) =>
          a.id === c.matchAssessmentId ? { ...a, sources: [...a.sources, { source: "syllabus" as const, date: fixed.date, excerpt: fixed.excerpt, location: fixed.location, observedAt: t }] } : a,
        );
      } else {
        assessments = [...assessments, candidateToAssessment(fixed, t)];
      }
      return {
        ...s,
        assessments,
        candidates: s.candidates.map((x) => (x.id === c.id ? { ...fixed, status: d.kind === "correct" ? ("corrected" as const) : ("confirmed" as const) } : x)),
      };
    });
  }
  async proposeReconciliation(_left: string, _right: string): Promise<Snapshot> {
    throw new Error("Match review requires the local backend. Demo data stays unchanged.");
  }
  async previewSyllabusRevision(_sourceId: string, _candidateId: string): Promise<never> { throw new Error("Syllabus revision review requires the local backend."); }
  async confirmSyllabusRevision(_decision: import("@/domain/types").SyllabusRevisionDecision): Promise<Snapshot> { throw new Error("Syllabus revision review requires the local backend."); }
  async decideReconciliation(_pairId: string, _fingerprint: string, _reviewRevision: string, _kind: "confirm" | "reject", _choices: Record<string, string>): Promise<Snapshot> {
    throw new Error("Match review requires the local backend. Demo data stays unchanged.");
  }

  async downloadMaterial(id: string) {
    const m = this.read().materials.find((x) => x.id === id);
    if (!m?.accessible) return { snapshot: this.read(), supported: false, message: "This resource is not accessible. Log in to Moodle and try again." };
    return { snapshot: this.read(), supported: false, message: "Downloads need the Chrome extension. In demo mode nothing is downloaded." };
  }
  async saveAlerts(alerts: Snapshot["alerts"]) {
    return this.mutate((s) => ({ ...s, alerts }));
  }
  async setSyllabusSuggestionDismissal(recordId: string, dismissed: boolean) {
    return this.mutate((s) => {
      if (!s.collection?.records.some((r) => r.kind === "material" && r.id === recordId && r.observations.some((o) => o.kind !== "folder"))) throw new Error("Suggestion is no longer available. Refresh and try again.");
      const ids = new Set(s.dismissedSyllabusSuggestions ?? []);
      if (dismissed) ids.add(recordId); else ids.delete(recordId);
      return { ...s, dismissedSyllabusSuggestions: [...ids].sort() };
    });
  }
  async updateSettings(patch: Partial<Snapshot["settings"]>) {
    return this.mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  }
  async replaceAll(next: Snapshot) {
    const parsed = SnapshotSchema.parse(next); // throws before writing anything
    return this.write(parsed);
  }
  async deleteLocalData() {
    return this.write(emptySnapshot(this.read()));
  }
  async resetDemo() {
    return this.write(buildDemoSnapshot(this.now()));
  }
  async aiAvailability() {
    return { available: false as const, reason: "No AI gateway or provider policy is configured. External AI is unavailable; all local features keep working." };
  }
}
