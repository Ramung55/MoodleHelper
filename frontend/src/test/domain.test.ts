import { describe, expect, it } from "vitest";
import { isOutstanding, reconciledSourceDate, viewAssessment } from "@/domain/assessments";
import { eligibleAlerts } from "@/domain/alerts";
import { makeBackup, previewRestore } from "@/domain/backup";
import { instantMicros, weekOfYmd } from "@/domain/dates";
import { canAutoAccept, checkFormat, proposeMatches } from "@/domain/extraction";
import { weeklyLoad } from "@/domain/workload";
import type { Assessment, ExtractionCandidate } from "@/domain/types";
import { buildDemoSnapshot } from "@/services/fixtures";
import { DemoAdapter, type KV } from "@/services/demo-adapter";

const snap = buildDemoSnapshot(Date.UTC(2026, 9, 24, 9));
const S = snap.settings;
const t = "2026-10-01T00:00:00Z";
const mk = (x: Partial<Assessment>): Assessment => ({
  id: "x", courseId: "c-csc", title: "T", type: "assignment", personal: false,
  sources: [{ source: "moodle", date: { kind: "date", date: S.semesterStart }, observedAt: t }],
  firstObservedAt: t, lastObservedAt: t, ...x,
});
const memKV = (): KV => { const m = new Map<string, string>(); return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) }; };

describe("dates", () => {
  it("orders Python-compatible legacy instants across the supported year range", () => {
    expect(instantMicros("0001-01-01T00:00:00Z")).toBe(-62135596800000000n);
    expect(instantMicros("9999-12-31T23:59:59.999999Z")).toBe(253402300799999999n);
    expect(instantMicros("99991231 235959.999999+0100")).toBe(instantMicros("9999-12-31T22:59:59.999999Z"));
    expect(instantMicros("2026-W01-1T12:30.5+05:30.5")).toBe(instantMicros("2025-12-29T07:00:00Z"));
    expect(instantMicros("0001-01-01T00:00:00+01:00")).toBeNull();
  });
  it("maps days to teaching weeks", () => {
    expect(weekOfYmd("2026-09-01", "2026-09-01")).toBe(1);
    expect(weekOfYmd("2026-09-08", "2026-09-01")).toBe(2);
    expect(weekOfYmd("2026-08-31", "2026-09-01")).toBeNull();
  });
});

describe("reconciliation", () => {
  it("keeps a known syllabus date when the newest Moodle date is unknown", () => {
    const a = mk({ sources: [
      { source: "moodle", date: { kind: "date", date: "2026-10-01" }, observedAt: t },
      { source: "moodle", date: { kind: "unknown" }, observedAt: "2026-10-02T00:00:00Z" },
      { source: "syllabus", date: { kind: "week", week: 8 }, observedAt: t },
    ] });
    expect(reconciledSourceDate(a.sources)).toEqual({ kind: "week", week: 8 });
    expect(viewAssessment(a, undefined, S).conflict).toBeUndefined();
  });
  it("recognizes equivalent exact instants across offsets", () => {
    const a = mk({ sources: [
      { source: "moodle", date: { kind: "exact", iso: "2026-10-01T10:00:00Z", tz: "UTC" }, observedAt: t },
      { source: "syllabus", date: { kind: "exact", iso: "2026-10-01T15:00:00+05:00", tz: "Asia/Almaty" }, observedAt: t },
    ] });
    expect(viewAssessment(a, undefined, S).conflict).toBeUndefined();
    const different = mk({ sources: [
      { source: "moodle", date: { kind: "exact", iso: "2026-10-01T10:00:00.000001Z", tz: "UTC" }, observedAt: t },
      { source: "syllabus", date: { kind: "exact", iso: "2026-10-01T15:00:00.000002+05:00", tz: "Asia/Almaty" }, observedAt: t },
    ] });
    expect(viewAssessment(different, undefined, S).conflict?.comparison).toBe("different");
  });
  it("Moodle date wins over syllabus and the conflict is shown", () => {
    const a = mk({ sources: [
      { source: "syllabus", date: { kind: "date", date: "2026-10-01" }, observedAt: t },
      { source: "moodle", date: { kind: "date", date: "2026-10-03" }, observedAt: t },
    ] });
    expect(reconciledSourceDate(a.sources)).toEqual({ kind: "date", date: "2026-10-03" });
    expect(viewAssessment(a, undefined, S).conflict).toBeDefined();
  });
  it("shows disagreement when the source moved under a personal override", () => {
    const a = mk({});
    const v = viewAssessment(a, { assessmentId: "x", hidden: false, completed: false, dateOverride: { kind: "week", week: 3 }, overrideBase: { kind: "date", date: "2020-01-01" } }, S);
    expect(v.date).toEqual({ kind: "week", week: 3 });
    expect(v.overrideDisagreement?.now).toEqual(a.sources[0].date);
  });
});

describe("submission & completion", () => {
  it("draft stays outstanding even when personally completed", () => {
    expect(isOutstanding(mk({ submission: { status: "draft", observedAt: t } }), { assessmentId: "x", hidden: false, completed: true })).toBe(true);
  });
  it("personal completion clears a not-submitted item", () => {
    expect(isOutstanding(mk({ submission: { status: "not_submitted", observedAt: t } }), { assessmentId: "x", hidden: false, completed: true })).toBe(false);
  });
  it("hidden items are never outstanding", () => {
    expect(isOutstanding(mk({}), { assessmentId: "x", hidden: true, completed: false })).toBe(false);
  });
});

describe("workload", () => {
  it("uses weights exam 3 / assignment 2 / quiz 1 and warns above 10 weighted", () => {
    const d = (type: Assessment["type"], i: number) => mk({ id: `i${i}`, type });
    const vs = [d("exam", 1), d("exam", 2), d("assignment", 3), d("assignment", 4), d("quiz", 5)].map((a) => viewAssessment(a, undefined, S));
    const w1 = weeklyLoad(vs, S).weeks[0];
    expect(w1.weighted).toBe(11);
    expect(w1.outstanding).toBe(5);
    expect(w1.overloaded).toBe(true);
  });
  it("warns at more than 5 outstanding but not at exactly 5", () => {
    const vs = (n: number) => Array.from({ length: n }, (_, i) => viewAssessment(mk({ id: `q${i}`, type: "quiz" }), undefined, S));
    expect(weeklyLoad(vs(5), S).weeks[0].overloaded).toBe(false);
    expect(weeklyLoad(vs(6), S).weeks[0].overloaded).toBe(true);
  });
  it("puts unknown dates in Unallocated", () => {
    const v = viewAssessment(mk({ sources: [{ source: "syllabus", date: { kind: "unknown" }, observedAt: t }] }), undefined, S);
    expect(weeklyLoad([v], S).unallocated).toHaveLength(1);
  });
});

describe("extraction", () => {
  const c: ExtractionCandidate = { id: "k", documentId: "d", courseId: "c-csc", title: "Quiz", type: "assignment", date: { kind: "week", week: 1 }, rawDateText: "Week 1", language: "en", confidence: 0.95, excerpt: "x", location: "p1", status: "pending" };
  it("rejects unsupported formats", () => {
    expect(checkFormat("a.pdf").ok).toBe(true);
    expect(checkFormat("a.docx").ok).toBe(true);
    expect(checkFormat("a.png").ok).toBe(false);
  });
  it("low confidence never auto-accepts", () => {
    expect(canAutoAccept({ ...c, confidence: 0.5 }, [])).toBe(false);
    expect(canAutoAccept(c, [])).toBe(true);
  });
  it("does not match recurring items in different weeks", () => {
    expect(proposeMatches({ ...c, date: { kind: "week", week: 2 } }, [mk({})], S)).toHaveLength(0);
    expect(proposeMatches(c, [mk({})], S)).toHaveLength(1);
  });
});

describe("alerts", () => {
  it("never sends exact-deadline reminders for week-only events, and dedupes", () => {
    const now = Date.parse(`${S.semesterStart}T00:00:00Z`);
    const week = viewAssessment(mk({ id: "w", sources: [{ source: "syllabus", date: { kind: "week", week: 1 }, observedAt: t }] }), undefined, S);
    const day = viewAssessment(mk({ id: "d" }), undefined, S);
    const first = eligibleAlerts([week, day], [], [], S, now, []);
    expect(first.map((a) => a.assessmentId)).toEqual(["d"]);
    expect(eligibleAlerts([week, day], [], [], S, now, first)).toHaveLength(0);
  });
});

describe("backup", () => {
  it("round-trips and rejects junk", () => {
    expect(previewRestore(JSON.stringify(makeBackup(snap)), snap).ok).toBe(true);
    expect(previewRestore("{}", snap).ok).toBe(false);
    expect(previewRestore("nope", snap).ok).toBe(false);
  });
});

describe("demo adapter", () => {
  it("sync keeps personal changes and preserves data for a failed course", async () => {
    const ad = new DemoAdapter(memKV(), 0);
    await ad.updateOverlay("a2", { completed: true });
    const before = (await ad.load()).assessments.filter((a) => a.courseId === "c-phy").length;
    const after = await ad.syncAll(() => {});
    expect(after.overlays.find((o) => o.assessmentId === "a2")?.completed).toBe(true);
    expect(after.sync.find((c) => c.courseId === "c-phy")?.status).toBe("failed");
    expect(after.assessments.filter((a) => a.courseId === "c-phy")).toHaveLength(before);
  });
  it("covers the reopened and draft fixtures", async () => {
    const s = await new DemoAdapter(memKV(), 0).load();
    const st = s.assessments.map((a) => a.submission?.status);
    expect(st).toContain("reopened");
    expect(st).toContain("draft");
  });
});
