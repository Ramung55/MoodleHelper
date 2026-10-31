/**
 * #47 end-to-end student journey (FIXTURE MODE). Synthetic demo dataset in a fresh
 * TEMP SQLite file, the real dashboard on 127.0.0.1:5173 and the real built unpacked
 * extension. No account, provider key, private material or AI call is involved.
 *
 * Deliberate failure: MH_E2E_BROKEN=1 swaps one expected badge for a wrong one so the
 * "Deadlines: reopened submission badge" step fails with screenshot/trace/report.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import {
  DASHBOARD, BACKEND, ROOT, FixtureBackend, launchWithExtension, observeBridge, removeRunDirectory,
  runDirectory, stopExtensionWorker, workerGenerations, assertNoUnexpectedTraffic, type ExtensionSession,
} from "./harness";

const BROKEN = process.env.MH_E2E_BROKEN === "1";
const DOCX = path.join(ROOT, "frontend", "src", "test", "fixtures", "extraction-bilingual.docx");
const WEEKS_DOCX = path.join(ROOT, "frontend", "src", "test", "fixtures", "teaching-weeks.docx");
const COURSE_NAMES: Record<string, string> = { "c-csc": "Data Structures", "c-math": "Calculus II", "c-phy": "General Physics" };
const TZ = "Asia/Almaty";

type Totals = { total: number; outstanding: number; weighted: number };

const api = async (p: string) => { const r = await fetch(BACKEND + p); expect(r.ok, `GET ${p}`).toBe(true); return r.json(); };
const localDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const addDays = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const weekOf = (start: string, date: string) => {
  const week = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 / 7) + 1;
  return week >= 1 && week <= 15 ? week : null;
};

async function weekTotals(page: Page, week: number | null): Promise<Totals> {
  if (week === null) {
    const text = await page.locator('section[aria-labelledby="unallocated-h"]').innerText();
    const m = /(\d+) total · (\d+) outstanding · weighted estimate (\d+)/.exec(text);
    if (!m) return { total: NaN, outstanding: NaN, weighted: NaN };
    return { total: +m![1]!, outstanding: +m![2]!, weighted: +m![3]! };
  }
  const values = await page.locator(`section[aria-labelledby="week-${week}-h"] dd`).allInnerTexts();
  return { total: +values[0]!, outstanding: +values[1]!, weighted: +values[2]! };
}

let dir: string, backend: FixtureBackend, session: ExtensionSession, page: Page;

test.beforeAll(async () => {
  dir = runDirectory("journey");
  backend = new FixtureBackend(dir);
  await backend.start();
  session = await launchWithExtension(dir);
  page = await session.context.newPage();
  await observeBridge(page);
});

test.afterAll(async () => {
  await session?.close().catch(() => {});
  await backend?.stop().catch(() => {});
  if (dir) removeRunDirectory(dir);
});

test("fixture student journey: selection, sync, review, conflict, completion, restart, interrupted sync", async ({}, testInfo) => {
  testInfo.annotations.push({ type: "mode", description: "FIXTURE — synthetic demo dataset, mock queue executor; not a live Moodle full sync." });
  testInfo.annotations.push({ type: "browser", description: `Chromium ${session.context.browser()?.version() ?? "(persistent context)"}; extension ${session.extensionId}` });
  const initial = await api("/api/snapshot");
  const semesterStart: string = initial.settings.semesterStart;
  const moodleDate = localDate(initial.assessments.find((a: any) => a.id === "a1").sources[0].date.iso);

  await test.step("Settings: tracked course selection saves and survives reopening", async () => {
    await page.goto(`${DASHBOARD}/settings`);
    const math = page.getByRole("checkbox", { name: "Track Calculus II" });
    await expect(math).toBeChecked();
    await math.click(); // controlled input: state follows the confirmed save
    await expect(math).not.toBeChecked();
    await expect(page.getByText("Saving course selection…")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Track Calculus II" })).not.toBeChecked();
    expect((await api("/api/snapshot")).settings.trackedCourseIds).toEqual(["c-csc", "c-phy"]);
    await page.getByRole("checkbox", { name: "Track Calculus II" }).click();
    await expect(page.getByRole("checkbox", { name: "Track Calculus II" })).toBeChecked();
    await expect(page.getByText("Saving course selection…")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Track Calculus II" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Track Introduction to Programming (previous year)" })).not.toBeChecked();
  });

  await test.step("Settings: explicit teaching calendar for the fixture semester", async () => {
    await page.getByLabel("Inclusive calendar start").fill(semesterStart);
    await page.getByLabel("Inclusive calendar end").fill(addDays(semesterStart, 15 * 7 - 1));
    await page.getByLabel("Calendar timezone").selectOption(TZ);
    await page.getByRole("button", { name: "Save teaching calendar" }).click();
    await expect.poll(async () => (await api("/api/snapshot")).settings.teachingCalendar?.timezone).toBe(TZ);
  });

  await test.step("Syllabus: real local DOCX extraction retains evidence and routes explicit dates", async () => {
    await page.goto(`${DASHBOARD}/syllabus`);
    await page.getByLabel("Course for import").selectOption({ label: "PHY 201" });
    await page.getByLabel("Syllabus file").setInputFiles(DOCX);
    await expect(page.getByText("Complete: validated and stored locally.")).toBeVisible();
    await page.getByRole("button", { name: "Extract text" }).click();
    await page.getByRole("button", { name: "Find assessments" }).click();
    await expect(page.getByText("2 possible assessments found.")).toBeVisible();
    await page.getByRole("button", { name: "Interpret explicit dates" }).click();
    await page.getByRole("button", { name: "Retain evidence and route proposals" }).click();
    await expect(page.getByText("2 stored proposals routed.")).toBeVisible();
    await expect(page.getByText("Added Automatically (Clear Evidence)")).toHaveCount(2);
    const local = (await api("/api/snapshot")).candidates.filter((c: any) => c.localEvidence);
    expect(local.map((c: any) => c.title).sort()).toEqual(["Assignment 1", "Экзамен"]);
    // Files, excerpts and raw wording stay in the browser; the backend holds only derived facts.
    for (const c of local) { expect(c.excerpt).toBe(""); expect(c.rawDateText).toBe(""); }
  });

  await test.step("Syllabus: genuinely uncertain week-only proposal from a real local DOCX routes to review; manual confirm creates one event", async () => {
    // Committed #30 synthetic fixture: "Exam Week 6", "Экзамен неделя 6", "Assignment Week 31", "Quiz Week 2–3".
    await page.getByLabel("Course for import").selectOption({ label: "PHY 201" });
    await page.getByLabel("Syllabus file").setInputFiles(WEEKS_DOCX);
    await expect(page.getByRole("status").filter({ hasText: "Complete: validated and stored locally." })).toBeVisible();
    const doc = page.locator("li").filter({ hasText: "teaching-weeks.docx" }).first();
    await doc.getByRole("button", { name: "Extract text" }).click();
    await doc.getByRole("button", { name: "Find assessments" }).click();
    await doc.getByRole("button", { name: "Interpret explicit dates" }).click();
    await doc.getByRole("button", { name: "Retain evidence and route proposals" }).click();
    await expect(page.getByText("4 stored proposals routed.")).toBeVisible();
    const card = page.locator("div,article,li").filter({ hasText: "Original date wording: Exam Week 6" }).filter({ has: page.getByRole("button", { name: "Confirm" }) }).last();
    await expect(card).toContainText("Deterministic policy · review required");
    await expect(card).toContainText("Why review: Date is not explicit; Only a teaching week is given");
    await expect(card).toContainText("Original document is available locally.");
    const pendingBefore = (await api("/api/snapshot")).candidates.filter((c: any) => c.localEvidence && c.status === "pending").length;
    expect(pendingBefore, "all four week-only/unresolved proposals wait for review").toBe(4);
    await card.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(async () => (await api("/api/snapshot")).assessments.filter((a: any) => a.title === "Exam" && a.courseId === "c-phy").length, { message: "exactly one reviewed event" }).toBe(1);
    const after = await api("/api/snapshot");
    expect(after.candidates.filter((c: any) => c.localEvidence && c.status === "pending")).toHaveLength(3);
    expect(after.assessments.find((a: any) => a.title === "Exam" && a.courseId === "c-phy").sources[0].date).toEqual({ kind: "week", week: 6 });
  });

  await test.step("Deadlines: draft submission and personal completion stay independent", async () => {
    await page.goto(`${DASHBOARD}/deadlines`);
    const lab = page.getByRole("button").filter({ hasText: "Lab 5: Hash tables" });
    await expect(lab).toContainText("Moodle: Draft — not submitted");
    await expect(lab).toContainText("You marked done");
  });

  await test.step("Deadlines: reopened submission badge", async () => {
    const ps = page.getByRole("button").filter({ hasText: "Problem set 4" });
    await expect(ps, "Problem set 4 row badge").toContainText(BROKEN ? "Moodle: Submitted" : "Moodle: Reopened — resubmit");
    await expect(ps).toContainText("Moodle and syllabus disagree");
  });

  await test.step("Deadline detail: Moodle/syllabus conflict shows both precise dates", async () => {
    await page.getByRole("button").filter({ hasText: "Problem set 4" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(/Moodle: \w{3} \d{1,2} \w{3}, \d{2}:\d{2}/);
    await expect(sheet).toContainText(/Syllabus: \w{3} \d{1,2} \w{3} \(no time\)/);
    await expect(sheet).toContainText("Moodle: Reopened — resubmit");
    await expect(sheet).toContainText("Independent of your personal check.");
    await page.keyboard.press("Escape");
  });

  await test.step("Deadline detail: separate personal completion check on a personal event", async () => {
    await page.getByRole("button").filter({ hasText: "Study group" }).click();
    const sheet = page.getByRole("dialog");
    const done = sheet.getByRole("checkbox", { name: "I've finished this (personal check)" });
    await expect(done).not.toBeChecked();
    await done.click(); // controlled input: state follows the confirmed save
    await expect(done).toBeChecked();
    await expect.poll(async () => (await api("/api/snapshot")).overlays.find((o: any) => o.assessmentId === "p1")?.completed).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button").filter({ hasText: "Study group" })).toContainText("You marked done");
  });

  // Fixed fixture: per-week expectations derived from the seeded records, not from the page.
  const expected = () => {
    const rows: { date: string | null; week?: number; weight: number; outstanding: boolean }[] = [
      { date: moodleDate, weight: 2, outstanding: true },            // Lab 5: draft beats personal completion
      { date: moodleDate, weight: 2, outstanding: true },            // Problem set 4: reopened (Moodle date used)
      { date: moodleDate, weight: 0, outstanding: false },           // Study group: personally completed
      { date: null, week: 9, weight: 3, outstanding: true },         // Midterm exam: week only
      { date: null, week: 6, weight: 3, outstanding: true },         // Reviewed local "Exam Week 6"
      { date: "2026-10-29", weight: 2, outstanding: true },          // Local DOCX Assignment 1
      { date: "2026-11-05", weight: 3, outstanding: true },          // Local DOCX exam
      { date: "unknown", weight: 2, outstanding: true },             // Final lab report: unknown date
    ];
    const buckets = new Map<number | null, Totals>();
    for (const r of rows) {
      const w = r.week ?? (r.date && r.date !== "unknown" ? weekOf(semesterStart, r.date) : null);
      const t = buckets.get(w) ?? { total: 0, outstanding: 0, weighted: 0 };
      t.total++; if (r.outstanding) { t.outstanding++; t.weighted += r.weight; }
      buckets.set(w, t);
    }
    return buckets;
  };

  await test.step("Weekly planner: mapped weekly counts and weighted estimates match the fixture", async () => {
    await page.goto(`${DASHBOARD}/planner`);
    await expect(page.getByRole("heading", { name: "Weekly planner", level: 1 })).toBeVisible();
    for (const [week, totals] of expected()) await expect.poll(() => weekTotals(page, week), { message: `week ${week ?? "unallocated"} totals` }).toEqual(totals);
  });

  let firstGeneration = "";
  await test.step("Sync: start one mock run from the dashboard and see per-course progress", async () => {
    await page.goto(`${DASHBOARD}/`);
    const panel = page.getByRole("region", { name: "Mock scan progress" });
    await expect(panel).toContainText("Demonstration only");
    await panel.getByRole("button", { name: "Start mock run" }).click();
    await expect(panel).toContainText(/Mock run: (pending|running|completed) · \d\/3 completed/);
    for (const course of ["Data Structures", "Calculus II", "General Physics"]) await expect(panel).toContainText(new RegExp(`${course}: (pending|running|completed)`));
    const run = (await api("/api/queue/current")).run;
    expect(run.courseIds).toEqual(["c-csc", "c-math", "c-phy"]);
    const generations = await workerGenerations(page);
    expect(generations.length, "bridge handshake reported a worker generation").toBeGreaterThan(0);
    firstGeneration = generations.at(-1)!;
  });

  await test.step("Extension worker restart: genuine MV3 stop, new generation, queue continues from SQLite", async () => {
    const before = (await api("/api/queue/current")).run;
    const stopped = await stopExtensionWorker(session.context, page, session.extensionId);
    const panel = page.getByRole("region", { name: "Mock scan progress" });
    // The page's old bridge session died with the worker; reconnect wakes a fresh worker.
    await expect(panel.getByRole("alert")).toContainText("Saved data remains visible", { timeout: 20_000 });
    await panel.getByRole("button", { name: "Reconnect" }).click();
    await expect.poll(async () => (await workerGenerations(page)).at(-1), { message: "new worker generation after restart" }).not.toBe(firstGeneration);
    await expect(panel).toContainText("Mock run: completed · 3/3 completed", { timeout: 30_000 });
    const after = (await api("/api/queue/current")).run;
    expect(after.id, "same durable run continued").toBe(before.id);
    expect(after.progress).toMatchObject({ total: 3, completed: 3, failed: 0 });
    testInfo.annotations.push({ type: "worker-status", description: stopped.statuses.join(" → ") });
    await stopped.detach();
  });

  await test.step("Partial failed sync: one course fails while the others complete; saved data and freshness preserved", async () => {
    const before = await api("/api/snapshot");
    const panel = page.getByRole("region", { name: "Mock scan progress" });
    const timestamps = await panel.getByText(/Saved course timestamp/).allInnerTexts();
    await panel.getByRole("button", { name: "Retry mock run" }).click();
    await expect(panel).toContainText(/Mock run: (pending|running) · 0\/3 completed/);
    // TEST-ONLY fixture hook: the harness acts as a second queue worker over the real
    // HTTP queue contract (current bridge binding) and fails exactly one course job.
    // No product code or route is changed; the extension worker completes the rest.
    const binding = (await api("/api/bridge-context")).binding;
    const post = async (p: string, body: unknown) => {
      const r = await fetch(BACKEND + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Moodle-Helper-Bridge-Binding": binding }, body: JSON.stringify(body) });
      expect(r.ok, `POST ${p}`).toBe(true); return r.json();
    };
    const { claim } = await post("/api/queue/claim", {});
    expect(claim, "a pending course job was available to fail").toBeTruthy();
    await post("/api/queue/finish", { jobId: claim.job.id, generation: claim.generation, token: claim.token, outcome: "failed", errorCode: "mock_failure" });
    const failedName = COURSE_NAMES[claim.job.courseId]!;
    testInfo.annotations.push({ type: "partial-failure", description: `failed course ${claim.job.courseId} via test-only queue hook` });
    const stopped = await stopExtensionWorker(session.context, page, session.extensionId); // wake a fresh worker for the rest
    await stopped.detach();
    await expect(panel.getByRole("alert")).toContainText("Saved data remains visible", { timeout: 20_000 });
    await panel.getByRole("button", { name: "Reconnect" }).click();
    await expect(panel).toContainText("Mock run: failed · 2/3 completed", { timeout: 30_000 });
    await expect(panel).toContainText(`${failedName}: failed`);
    for (const [id, name] of Object.entries(COURSE_NAMES)) if (id !== claim.job.courseId) await expect(panel).toContainText(`${name}: completed`);
    await expect(panel).toContainText("Last failed mock attempt started");
    await expect(panel).toContainText("No successful full sync yet.");
    expect(await panel.getByText(/Saved course timestamp/).allInnerTexts(), "per-course saved timestamps unchanged").toEqual(timestamps);
    const run = (await api("/api/queue/current")).run;
    expect(run.progress).toMatchObject({ total: 3, completed: 2, failed: 1 });
    const after = await api("/api/snapshot");
    for (const key of ["assessments", "overlays", "candidates", "documents", "sync"]) expect(after[key], `${key} preserved after partial failure`).toEqual(before[key]);
  });

  await test.step("Interrupted sync: backend outage mid-run preserves saved data and freshness", async () => {
    const before = await api("/api/snapshot");
    const panel = page.getByRole("region", { name: "Mock scan progress" });
    const timestamps = await panel.getByText(/Saved course timestamp/).allInnerTexts();
    await panel.getByRole("button", { name: "Retry mock run" }).click();
    await expect(panel).toContainText(/Mock run: (pending|running) · [0-2]\/3 completed/);
    const interrupted = (await api("/api/queue/current")).run;
    await backend.stop();
    await expect(panel.getByRole("alert")).toContainText("Progress is unavailable or the outcome is unknown. Saved data remains visible.", { timeout: 20_000 });
    // Saved records are still shown while the backend is unavailable.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Deadlines" }).click();
    await expect(page.getByRole("button").filter({ hasText: "Lab 5: Hash tables" })).toBeVisible();
    await backend.start(); // same TEMP SQLite file
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" }).click();
    const reopened = page.getByRole("region", { name: "Mock scan progress" });
    await expect(reopened).toContainText(/Mock run: (pending|running|completed)/);
    const resumed = (await api("/api/queue/current")).run;
    expect(resumed.id, "interrupted run is retained, not replaced").toBe(interrupted.id);
    if (resumed.status !== "completed") {
      const stopped = await stopExtensionWorker(session.context, page, session.extensionId);
      await stopped.detach();
      const alert = reopened.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 20_000 });
      await reopened.getByRole("button", { name: "Reconnect" }).click();
    }
    await expect(reopened).toContainText("Mock run: completed · 3/3 completed", { timeout: 30_000 });
    // Mock runs never claim a full sync or rewrite saved course timestamps.
    await expect(reopened).toContainText("No successful full sync yet.");
    expect(await reopened.getByText(/Saved course timestamp/).allInnerTexts()).toEqual(timestamps);
    const after = await api("/api/snapshot");
    for (const key of ["assessments", "overlays", "candidates", "documents", "sync"]) expect(after[key], `${key} preserved`).toEqual(before[key]);
  });

  await test.step("After restarts: planner still matches the fixture", async () => {
    await page.goto(`${DASHBOARD}/planner`);
    for (const [week, totals] of expected()) await expect.poll(() => weekTotals(page, week), { message: `week ${week ?? "unallocated"} totals after restarts` }).toEqual(totals);
  });

  await test.step("No non-local network traffic", async () => {
    testInfo.annotations.push({ type: "blocked-design-fonts", description: `${session.blockedDesignAssets.length} Google Fonts request(s) aborted locally` });
    assertNoUnexpectedTraffic(session);
  });
});
