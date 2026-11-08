/**
 * Real-browser evidence for #24 local document import: PDF/DOCX validated in the
 * browser (PDF.js), stored in IndexedDB, associated with the chosen course; same-course
 * duplicate and confirmed cross-course association; visible queued/parsing/complete/
 * failed/cancelled states with Retry (incl. a test-injected QuotaExceededError on
 * IndexedDB writes); persistence across a real browser restart of the same
 * persistent profile; and a context-wide network capture showing no document upload.
 * Fixtures are the committed synthetic files under frontend/src/test/fixtures.
 */
import { test, expect, type Page } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD, ROOT, FixtureBackend, launchWithExtension, removeRunDirectory, runDirectory, assertNoUnexpectedTraffic, type ExtensionSession } from "./harness";

const FIX = path.join(ROOT, "frontend", "src", "test", "fixtures");
const PDF = path.join(FIX, "local-valid.pdf"), DOCX = path.join(FIX, "local-valid.docx"), BROKEN_PDF = path.join(FIX, "local-truncated.pdf");
const FRESH_DOCX = path.join(FIX, "extraction-bilingual.docx");
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

let dir: string, backend: FixtureBackend, session: ExtensionSession, page: Page;
const uploads: string[] = [], requests: string[] = [], workers: string[] = [];
const fileHeads = [PDF, DOCX, BROKEN_PDF, FRESH_DOCX].map((f) => fs.readFileSync(f).subarray(0, 64));
const smallest = Math.min(...[PDF, DOCX].map((f) => fs.statSync(f).size));

async function open(s: ExtensionSession) {
  s.context.on("request", (r) => {
    requests.push(`${r.method()} ${r.url()}`);
    const body = r.postDataBuffer();
    if (body && (body.length >= smallest || fileHeads.some((h) => body.includes(h)) || /multipart\/form-data/i.test(r.headers()["content-type"] ?? ""))) uploads.push(`${r.method()} ${r.url()} (${body.length} bytes)`);
  });
  const p = await s.context.newPage();
  p.on("worker", (w) => workers.push(w.url()));
  await p.addInitScript(() => {
    const seen: string[] = [];
    (window as any).__e2eStatuses = seen;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[role="status"]')) { const t = el.textContent?.trim() ?? ""; if (t && seen.at(-1) !== t) seen.push(t); }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    // TEST-ONLY fault injection: while armed, IndexedDB writes throw the browser's
    // QuotaExceededError (DevTools Storage.overrideQuotaForOrigin was not enforced for
    // IndexedDB writes in this headless build, so the failure is simulated here).
    (window as any).__e2eQuotaFull = false;
    for (const method of ["put", "add"] as const) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: any[]) {
        if ((window as any).__e2eQuotaFull) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return (original as any).apply(this, args);
      } as any;
    }
  });
  return p;
}
const statuses = () => page.evaluate(() => [...(window as any).__e2eStatuses] as string[]);
const status = () => page.getByRole("status").filter({ hasText: /Queued|Parsing|Complete|Failed|Cancelled|Already associated/ });
async function importFile(course: string, file: string) {
  await expect(page.getByLabel("Syllabus file")).toBeEnabled();
  await page.getByLabel("Course for import").selectOption({ label: course });
  await page.getByLabel("Syllabus file").setInputFiles(file);
}
const rows = (name: string) => page.locator("li").filter({ hasText: new RegExp(`^${name.replace(".", "\\.")} · `) });

test.beforeAll(async () => {
  dir = runDirectory("import");
  backend = new FixtureBackend(dir);
  await backend.start();
  session = await launchWithExtension(dir);
  page = await open(session);
});
test.afterAll(async () => {
  await session?.close().catch(() => {});
  await backend?.stop();
  if (dir) removeRunDirectory(dir);
});

test("#24 local import lifecycle, associations, quota failure, restart persistence, no upload", async ({}, testInfo) => {
  await page.goto(`${DASHBOARD}/syllabus`);

  await test.step("valid PDF → chosen course through queued/parsing/complete with identity", async () => {
    await importFile("PHY 201", PDF);
    await expect(status()).toHaveText("Complete: validated and stored locally. Extraction has not been performed.");
    const seen = await statuses();
    expect(seen).toEqual(expect.arrayContaining(["Queued for local validation.", "Parsing: validating and hashing locally; no extraction is performed."]));
    expect(seen.indexOf("Queued for local validation.")).toBeLessThan(seen.indexOf("Parsing: validating and hashing locally; no extraction is performed."));
    await expect(rows("local-valid.pdf")).toHaveCount(1);
    await expect(rows("local-valid.pdf")).toContainText(`local-valid.pdf · PHY 201 · Local selection · ${fs.statSync(PDF).size} bytes · SHA-256 ${sha(PDF)}`);
    expect(workers.some((w) => /pdf\.worker/.test(w)), "validation ran through the real PDF.js browser worker").toBe(true);
    testInfo.annotations.push({ type: "browser-workers", description: workers.join(", ") || "(none observed)" });
  });

  await test.step("valid DOCX → another chosen course", async () => {
    await importFile("CSS 215", DOCX);
    await expect(status()).toHaveText(/^Complete: validated and stored locally/);
    await expect(rows("local-valid.docx")).toContainText(`CSS 215 · Local selection · ${fs.statSync(DOCX).size} bytes · SHA-256 ${sha(DOCX)}`);
  });

  await test.step("same-course duplicate is not stored twice", async () => {
    await importFile("PHY 201", PDF);
    await expect(status()).toHaveText("Already associated with this course.");
    await expect(rows("local-valid.pdf")).toHaveCount(1);
  });

  await test.step("cross-course association: declining the confirmation cancels; accepting preserves both", async () => {
    page.once("dialog", (d) => { expect(d.message()).toContain("already associated with PHY 201"); void d.dismiss(); });
    await importFile("MAT 102", PDF);
    await expect(status()).toHaveText("Cancelled. No association was added.");
    await expect(rows("local-valid.pdf")).toHaveCount(1);
    page.once("dialog", (d) => void d.accept());
    await importFile("MAT 102", PDF);
    await expect(status()).toHaveText(/^Complete: validated and stored locally/);
    await expect(rows("local-valid.pdf")).toHaveCount(2);
    await expect(rows("local-valid.pdf").filter({ hasText: "PHY 201" })).toHaveCount(1);
    await expect(rows("local-valid.pdf").filter({ hasText: "MAT 102" })).toHaveCount(1);
  });

  await test.step("failed validation shows a specific failure and Retry", async () => {
    await importFile("PHY 201", BROKEN_PDF);
    await expect(status()).toHaveText(/^Failed: /);
    await expect(page.getByRole("button", { name: "Retry selected file" })).toBeVisible();
    await page.getByRole("button", { name: "Retry selected file" }).click();
    await expect(status()).toHaveText(/^Failed: /);
    await expect(rows("local-truncated.pdf")).toHaveCount(0);
  });

  await test.step("simulated storage-quota failure, then Retry succeeds after quota is restored", async () => {
    await page.evaluate(() => { (window as any).__e2eQuotaFull = true; });
    await importFile("MAT 102", FRESH_DOCX); // bytes not stored yet, so the IndexedDB write must allocate
    await expect(status(), "quota exhaustion surfaces as a failed import").toHaveText(/^Failed: /);
    testInfo.annotations.push({ type: "quota-failure-message", description: (await status().innerText()) });
    await expect(rows("extraction-bilingual.docx")).toHaveCount(0);
    await page.evaluate(() => { (window as any).__e2eQuotaFull = false; });
    await page.getByRole("button", { name: "Retry selected file" }).click();
    await expect(status()).toHaveText(/^Complete: validated and stored locally/);
    await expect(rows("extraction-bilingual.docx").filter({ hasText: "MAT 102" })).toHaveCount(1);
  });

  await test.step("real browser restart of the same persistent profile keeps IndexedDB records", async () => {
    const before = (await page.locator("li").filter({ hasText: / · SHA-256 / }).allInnerTexts()).map((t) => t.split(" · Complete")[0]).sort();
    await session.close();
    session = await launchWithExtension(dir);
    page = await open(session);
    await page.goto(`${DASHBOARD}/syllabus`);
    await expect(rows("local-valid.pdf")).toHaveCount(2);
    const after = (await page.locator("li").filter({ hasText: / · SHA-256 / }).allInnerTexts()).map((t) => t.split(" · Complete")[0]).sort();
    expect(after).toEqual(before);
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    testInfo.annotations.push({ type: "indexeddb", description: JSON.stringify(dbs) });
    expect(dbs.length).toBeGreaterThan(0);
  });

  await test.step("network capture: no document bytes leave the browser", async () => {
    testInfo.annotations.push({ type: "requests", description: `${requests.length} requests captured` });
    expect(uploads, "no request carried document bytes or multipart content").toEqual([]);
    expect(requests.filter((r) => /documents|upload/i.test(r) && r.startsWith("POST")), "legacy filename/digest document endpoint not called").toEqual([]);
    assertNoUnexpectedTraffic(session);
  });
});
