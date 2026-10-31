import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import { viewAll, viewAssessment, type AssessmentView } from "@/domain/assessments";
import { dayGroup, displayDate, dueState, matchStatus, redactUnsafeLinks, safeSourceHref, sourceFreshness, weekGroup } from "@/domain/deadline-display";
import { DeadlineList, parseDeadlineSearch } from "@/routes/deadlines";
import { AssessmentSheet } from "@/components/mh/AssessmentSheet";
import type { Assessment, DateValue, Overlay, Snapshot } from "@/domain/types";

const state = vi.hoisted(() => ({ app: {} as any }));
vi.mock("@/lib/app-store", () => ({ useApp: () => state.app }));
afterEach(cleanup);

const calendar = { startDate: "2026-09-07", endDate: "2026-12-20", timezone: "UTC", excludedWeekStarts: [] };

function mk(date: DateValue, extra: Partial<Assessment> = {}): Assessment {
  return { id: "a1", courseId: "c-csc", title: "Essay", type: "assignment", sources: [{ source: "moodle", date, observedAt: "2026-09-01T00:00:00Z" }], personal: false, firstObservedAt: "2026-09-01T00:00:00Z", lastObservedAt: "2026-09-01T00:00:00Z", ...extra };
}

function setup(mutate?: (s: Snapshot) => void, ok = true) {
  const snap = buildDemoSnapshot();
  mutate?.(snap);
  const api = { updateOverlay: vi.fn(async (id: string, patch: Partial<Overlay>) => {
    const o = snap.overlays.find((x) => x.assessmentId === id);
    if (o) Object.assign(o, patch); else snap.overlays.push({ assessmentId: id, hidden: false, completed: false, ...patch } as Overlay);
  }) };
  const views = () => viewAll(snap.assessments, snap.overlays, snap.settings, snap);
  state.app = { snap, api, views: views(), run: vi.fn(async (fn) => { if (!ok) return false; await fn(api); state.app.views = views(); return true; }) };
  return { snap, api };
}

describe("safe source links (#35)", () => {
  it("accepts only stable HTTPS SDU activity/course routes", () => {
    expect(safeSourceHref("https://moodle.sdu.edu.kz/mod/assign/view.php?id=12")).toBe("https://moodle.sdu.edu.kz/mod/assign/view.php?id=12");
    expect(safeSourceHref("https://moodle.sdu.edu.kz/course/view.php?id=3")).toBeTruthy();
    for (const bad of [
      "javascript:alert(1)", "http://moodle.sdu.edu.kz/mod/assign/view.php?id=12", "https://user:pw@moodle.sdu.edu.kz/mod/assign/view.php?id=12",
      "https://moodle.sdu.edu.kz:8443/mod/assign/view.php?id=12", "https://evil.example/mod/assign/view.php?id=12",
      "https://moodle.sdu.edu.kz/mod/assign/view.php?id=12&sesskey=abc", "https://moodle.sdu.edu.kz/login/token.php?id=1",
      "https://moodle.sdu.edu.kz/mod/assign/view.php?id=12#x", "data:text/html,hi", "//moodle.sdu.edu.kz/mod/assign/view.php?id=1",
    ]) expect(safeSourceHref(bad), bad).toBeNull();
    expect(JSON.stringify({ u: "https://x.example/?token=SECRET", ok: "https://moodle.sdu.edu.kz/mod/quiz/view.php?id=4" }, redactUnsafeLinks)).not.toContain("SECRET");
  });

  it("renders unsafe primary and history links as unavailable without echoing them", () => {
    const { snap } = setup((s) => {
      const a = s.assessments.find((x) => !x.personal)!;
      a.sources = [{ ...a.sources[0], url: "https://moodle.sdu.edu.kz/mod/assign/view.php?id=9&token=SECRET1" }];
      s.changes.push({ id: "ch", assessmentId: a.id, from: { kind: "week", week: 1 }, to: { kind: "week", week: 2 }, detectedAt: "2026-09-02T00:00:00Z", sourceUrl: "javascript:SECRET2" });
    });
    const a = snap.assessments.find((x) => !x.personal)!;
    const { container } = render(<AssessmentSheet id={a.id} onClose={vi.fn()} />);
    expect(screen.getAllByText("Source link unavailable").length).toBeGreaterThanOrEqual(2);
    expect(document.body.innerHTML).not.toMatch(/SECRET/);
    expect(container.ownerDocument.querySelectorAll("a[href*='javascript']")).toHaveLength(0);
  });

  it("keeps safe links clickable with noopener/noreferrer", () => {
    const { snap } = setup((s) => { const a = s.assessments.find((x) => !x.personal)!; a.sources = [{ ...a.sources[0], url: "https://moodle.sdu.edu.kz/mod/assign/view.php?id=9" }]; });
    render(<AssessmentSheet id={snap.assessments.find((x) => !x.personal)!.id} onClose={vi.fn()} />);
    const link = screen.getByRole("link", { name: "Open source in Moodle" });
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });
});

describe("precision-aware overdue (#35 AC3)", () => {
  const S = { ...buildDemoSnapshot().settings, timezone: "Asia/Almaty", teachingCalendar: calendar } as any;
  const view = (d: DateValue, o?: Partial<Overlay>) => viewAssessment(mk(d), o ? { assessmentId: "a1", hidden: false, completed: false, ...o } : undefined, S);
  it("exact is overdue only after its instant", () => {
    const v = view({ kind: "exact", iso: "2026-10-01T10:00:00Z", tz: "UTC" });
    expect(dueState(v, "Asia/Almaty", new Date("2026-10-01T09:59:59Z"))).toBeNull();
    expect(dueState(v, "Asia/Almaty", new Date("2026-10-01T10:00:01Z"))?.label).toBe("Overdue");
    expect(dueState(view({ kind: "exact", iso: "2026-10-01T10:00:00Z", tz: "UTC" }, { completed: true }), "UTC", new Date("2026-12-01T00:00:00Z"))).toBeNull();
  });
  it("date-only passes only after the literal day in the display zone, without invented time", () => {
    const v = view({ kind: "date", date: "2026-10-01" });
    expect(dueState(v, "Asia/Almaty", new Date("2026-10-01T20:00:00Z"))?.label).toBe("Date passed; time unspecified"); // already Oct 2 in Almaty
    expect(dueState(v, "UTC", new Date("2026-10-01T18:00:00Z"))).toBeNull();
  });
  it("week-only never gets an exact overdue badge; resolved map gives past-week label", () => {
    expect(dueState(view({ kind: "week", week: 1 }), "UTC", new Date("2026-10-01T00:00:00Z"))).toEqual({ kind: "week_passed", label: "Past teaching week 1" });
    const unresolved = viewAssessment(mk({ kind: "week", week: 1 }), undefined, { ...S, teachingCalendar: undefined });
    expect(dueState(unresolved, "UTC", new Date("2030-01-01T00:00:00Z"))).toBeNull();
    expect(dueState(view({ kind: "unknown" }), "UTC", new Date("2030-01-01T00:00:00Z"))).toBeNull();
  });
  it("invalid legacy dates show as unavailable instead of crashing", () => {
    const v = view({ kind: "exact", iso: "not-a-date", tz: "UTC" });
    expect(dueState(v, "UTC", new Date())?.kind).toBe("invalid");
    expect(displayDate(v.date, "UTC")).toBe("Invalid date (unavailable)");
    expect(displayDate({ kind: "exact", iso: "2026-10-01T10:00:00Z", tz: "Bad/Zone" }, "UTC")).toBe("Invalid date (unavailable)");
    expect(displayDate({ kind: "date", date: "2027-02-29" }, "UTC")).toBe("Invalid date (unavailable)");
  });
});

describe("grouping and filters (#35 AC1)", () => {
  const S = { ...buildDemoSnapshot().settings, timezone: "UTC", teachingCalendar: calendar } as any;
  it("day grouping keeps exact, date-only, week-only and unknown separate", () => {
    const g = (d: DateValue) => dayGroup(viewAssessment(mk(d), undefined, S), "UTC");
    expect(g({ kind: "exact", iso: "2026-09-08T10:00:00Z", tz: "UTC" }).key).not.toBe(g({ kind: "date", date: "2026-09-08" }).key);
    expect(g({ kind: "date", date: "2026-09-08" }).label).toMatch(/no time/);
    expect(g({ kind: "week", week: 1 }).label).toBe("Week 1 · no exact day");
    expect(g({ kind: "week", week: 1 }).detail).toBe("2026-09-07 – 2026-09-13");
    expect(g({ kind: "unknown" }).label).toBe("Date unknown");
  });
  it("week grouping uses resolved intervals and an unresolved category", () => {
    expect(weekGroup(viewAssessment(mk({ kind: "date", date: "2026-09-15" }), undefined, S)).label).toBe("Week 2");
    expect(weekGroup(viewAssessment(mk({ kind: "week", week: 1 }), undefined, { ...S, teachingCalendar: undefined })).label).toBe("Unresolved week");
    expect(weekGroup(viewAssessment(mk({ kind: "unknown" }), undefined, S)).label).toBe("No date");
  });
  it("validates URL state", () => {
    expect(parseDeadlineSearch({ type: "bogus", status: "nope", week: "-2", group: "x" })).toEqual({ course: undefined, type: undefined, status: undefined, id: undefined, group: undefined, week: undefined });
    expect(parseDeadlineSearch({ type: "quiz", status: "hidden", week: "3", group: "day" })).toMatchObject({ type: "quiz", status: "hidden", week: 3, group: "day" });
    expect(parseDeadlineSearch({ week: "2.5" }).week).toBeUndefined();
  });
  it("hidden items appear only under the explicit Hidden filter", () => {
    const v = { hidden: true, completed: true, outstanding: false, needsAttention: false, a: { submission: { status: "submitted" } } } as unknown as AssessmentView;
    expect(["", "outstanding", "attention", "done"].some((s) => matchStatus(v, s || undefined))).toBe(false);
    expect(matchStatus(v, "hidden")).toBe(true);
  });

  it("unknown course shows a no-match reset path instead of everything", () => {
    setup();
    const set = vi.fn();
    render(<DeadlineList search={{ course: "c-deleted" }} set={set} />);
    expect(screen.getByText("This course filter is not available")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("0 shown · Unavailable course");
    fireEvent.click(screen.getAllByRole("button", { name: "Reset filters" }).at(-1)!);
    expect(set).toHaveBeenCalledWith({ course: undefined, type: undefined, status: undefined, week: undefined });
  });

  it("filters combine, headings report filters, and empty matches differ from empty data", () => {
    setup();
    render(<DeadlineList search={{ course: "c-csc", type: "exam" }} set={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/shown · .+ · Exam · All visible/);
    cleanup();
    setup((s) => { s.assessments = []; });
    render(<DeadlineList search={{}} set={vi.fn()} />);
    expect(screen.getByText("No deadlines yet")).toBeVisible();
  });
});

describe("freshness (#35 AC4)", () => {
  it("marks saved data stale after a failed sync and unknown for invalid observedAt", () => {
    const snap = buildDemoSnapshot();
    const phy = snap.assessments.find((a) => a.courseId === "c-phy" && !a.personal)!;
    const v = viewAssessment(phy, undefined, snap.settings, snap);
    const f = sourceFreshness(v, snap, "UTC")!;
    expect(f.stale).toBe(true);
    expect(f.label).toMatch(/latest sync failed, last successful sync/);
    const bad = viewAssessment({ ...phy, sources: phy.sources.map((s) => ({ ...s, observedAt: "garbage" })) }, undefined, snap.settings, snap);
    expect(sourceFreshness(bad, snap, "UTC")!.label).toMatch(/Freshness unknown/);
    snap.sync = [];
    expect(sourceFreshness(viewAssessment(phy, undefined, snap.settings, snap), snap, "UTC")!.label).toMatch(/freshness unknown/);
  });
});

describe("details and restore (#35 AC2/AC5)", () => {
  it("explains a missing deep-linked item with a back action", () => {
    setup();
    const onClose = vi.fn();
    render(<AssessmentSheet id="does-not-exist" onClose={onClose} />);
    expect(screen.getByText("Assessment not available")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to deadlines" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows unknown Moodle status as its own fact", () => {
    const { snap } = setup((s) => { const a = s.assessments.find((x) => !x.personal)!; delete a.submission; });
    render(<AssessmentSheet id={snap.assessments.find((x) => !x.personal)!.id} onClose={vi.fn()} />);
    expect(screen.getByText(/Moodle submission status unknown/)).toBeVisible();
  });

  it("Hidden filter makes Restore reachable; failure keeps hidden status visible", async () => {
    let target = "";
    const { api } = setup((s) => { target = s.assessments.find((x) => !x.personal)!.id; s.overlays = s.overlays.filter((o) => o.assessmentId !== target); s.overlays.push({ assessmentId: target, hidden: true, completed: false }); });
    render(<DeadlineList search={{ status: "hidden" }} set={vi.fn()} />);
    const row = document.querySelector<HTMLElement>(`[data-assessment-row="${target}"]`)!;
    expect(within(row).getByText("Hidden")).toBeVisible();
    expect(row.querySelector("button, a, input")).toBeNull();
    cleanup();
    render(<AssessmentSheet id={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore item" }));
    await waitFor(() => expect(api.updateOverlay).toHaveBeenCalledWith(target, { hidden: false }));
    cleanup();
    setup((s) => { s.overlays = s.overlays.filter((o) => o.assessmentId !== target); s.overlays.push({ assessmentId: target, hidden: true, completed: false }); }, false);
    render(<AssessmentSheet id={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore item" }));
    expect(await screen.findByText(/was not restored/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Restore item" })).toBeVisible();
  });
});
