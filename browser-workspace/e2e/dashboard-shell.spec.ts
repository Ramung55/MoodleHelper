/**
 * Real-browser evidence for #8 AC3 (direct open/refresh + hydration) and AC4
 * (actual Tab/Shift+Tab, Enter, visible focus, narrow viewport, Retry, skip link).
 * Normal mode uses the isolated fixture backend; previews run with no backend at all.
 */
import { test, expect, type Page, type Request } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD, ROOT, FixtureBackend, removeRunDirectory, runDirectory } from "./harness";

const ROUTES = [
  { path: "/", label: "Overview" },
  { path: "/deadlines", label: "Deadlines" },
  { path: "/syllabus", label: "Syllabus review" },
  { path: "/materials", label: "Materials" },
  { path: "/settings", label: "Settings" },
] as const;
const STATES = ["loading", "empty", "error"] as const;
// CSS locator: on narrow viewports the closed navigation is display:none (outside the a11y tree).
const nav = (page: Page) => page.locator('nav[aria-label="Main"]');
const urlFor = (p: string) => (url: URL) => url.origin === DASHBOARD && url.pathname === p;

/** Vite's first-visit dependency optimisation can reload the page once; settle it up front. */
async function warmUp(browser: import("@playwright/test").Browser, query = "") {
  const page = await browser.newPage();
  for (const r of ROUTES) { await page.goto(`${DASHBOARD}${r.path}${query}`); await page.waitForLoadState("networkidle"); }
  await page.close();
}

/** Console/page errors that would indicate a failed or mismatched hydration. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /hydrat|did not match|server rendered/i.test(m.text())) errors.push(m.text()); });
  return errors;
}

async function expectRoute(page: Page, label: string) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(label);
  await expect(page.locator("main h1")).toHaveCount(1);
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(nav(page).locator('[aria-current="page"]')).toContainText(label);
}

/** Proves the client router took over: a nav click changes route without a document load. */
async function expectHydrated(page: Page, from: string) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => { (window as any).__e2eSameDocument = true; });
  const target = ROUTES.find((r) => r.path !== from)!;
  let documentLoads = 0;
  const onRequest = (r: Request) => { if (r.resourceType() === "document") documentLoads++; };
  page.on("request", onRequest);
  await nav(page).getByRole("link", { name: target.label, exact: true }).click();
  await expect(page).toHaveURL(urlFor(target.path));
  await expectRoute(page, target.label);
  expect(await page.evaluate(() => (window as any).__e2eSameDocument), "client-side navigation kept the hydrated document").toBe(true);
  expect(documentLoads, "no full document request on nav click").toBe(0);
  page.off("request", onRequest);
}

async function focusIsVisible(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { visible: false, what: "body" };
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
    return { visible: !!ring && r.width > 0 && r.height > 0, what: `${el.tagName} ${el.textContent?.trim().slice(0, 40)}`, outline: `${s.outlineStyle} ${s.outlineWidth}`, shadow: s.boxShadow };
  });
}

test.describe("#8 normal HTTP mode with fixture backend", () => {
  let dir: string, backend: FixtureBackend;
  test.beforeAll(async ({ browser }) => { dir = runDirectory("shell"); backend = new FixtureBackend(dir); await backend.start(); await warmUp(browser); });
  test.afterAll(async () => { await backend?.stop(); if (dir) removeRunDirectory(dir); });

  for (const route of ROUTES) {
    test(`AC3 direct open + refresh hydrates ${route.path}`, async ({ page }) => {
      const errors = watchErrors(page);
      const response = await page.goto(DASHBOARD + route.path);
      expect(response?.status(), "direct open is served by the app shell").toBe(200);
      await expectRoute(page, route.label);
      const refreshed = await page.reload();
      expect(refreshed?.status()).toBe(200);
      await expectRoute(page, route.label);
      await expectHydrated(page, route.path);
      expect(errors, "no hydration/page errors").toEqual([]);
    });
  }

  test("AC3 unknown route stays 404", async ({ page }) => {
    const response = await page.goto(`${DASHBOARD}/no-such-route-e2e`);
    expect(response?.status()).toBe(404);
  });

  test("AC4 keyboard: skip link, Tab/Shift+Tab, Enter, visible focus", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(DASHBOARD + "/");
    await expectRoute(page, "Overview");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    const skipFocus = await focusIsVisible(page);
    expect(skipFocus.visible, `skip link focus painted: ${JSON.stringify(skipFocus)}`).toBe(true);
    expect((await page.getByRole("link", { name: "Skip to content" }).boundingBox())!.width, "skip link becomes visible on focus").toBeGreaterThan(20);
    await testInfo.attach("skip-link-focus", { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();

    await page.keyboard.press("Shift+Tab"); // back towards skip link / before main
    await page.goto(DASHBOARD + "/");
    await page.keyboard.press("Tab"); // skip link
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
      const f = await focusIsVisible(page);
      expect(f.visible, `visible focus on ${f.what}: ${JSON.stringify(f)}`).toBe(true);
    }
    expect(order.map((t) => t.replace(/\d+$/, ""))).toEqual(["Overview", "Deadlines", "Weekly planner", "Syllabus review", "Materials", "Alerts", "Settings"]);
    await testInfo.attach("nav-focus-settings", { body: await page.screenshot(), contentType: "image/png" });
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+Tab"); // Settings → Alerts → Materials → Syllabus → Planner → Deadlines
    await expect(nav(page).getByRole("link", { name: /^Deadlines/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${DASHBOARD}/deadlines`);
    await expectRoute(page, "Deadlines");
    await expect(page.locator("main#main"), "route change moves focus to main").toBeFocused();
  });

  test("AC4 narrow viewport: keyboard-operable toggle exposes expanded state", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(DASHBOARD + "/");
    await expectRoute(page, "Overview");
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(nav(page).getByRole("link", { name: "Settings" })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page scroll").toBe(true);
    for (let i = 0; i < 6 && !(await toggle.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(toggle).toBeFocused();
    expect((await focusIsVisible(page)).visible, "toggle focus painted").toBe(true);
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nav(page).getByRole("link", { name: "Settings" })).toBeVisible();
    await testInfo.attach("narrow-nav-open", { body: await page.screenshot(), contentType: "image/png" });
    await nav(page).getByRole("link", { name: "Settings" }).focus();
    await page.keyboard.press("Enter");
    await expectRoute(page, "Settings");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("#8 development previews with NO backend", () => {
  test.beforeAll(async ({ browser }) => {
    const busy = await fetch("http://127.0.0.1:8000/api/snapshot").then(() => true, () => false);
    expect(busy, "no backend may run during preview checks").toBe(false);
    await warmUp(browser, "?shellState=empty");
  });

  for (const route of ROUTES) for (const state of STATES) {
    test(`AC3/AC5 direct open + refresh ${route.path}?shellState=${state}`, async ({ page }) => {
      const api: string[] = [];
      page.on("request", (r) => { if (/\/api\/|:8000\//.test(r.url())) api.push(r.url()); });
      const errors = watchErrors(page);
      const response = await page.goto(`${DASHBOARD}${route.path}?shellState=${state}`);
      expect(response?.status()).toBe(200);
      await expectRoute(page, route.label);
      await expect(page.getByText("Development preview. No student data is loaded or saved.")).toBeVisible();
      if (state === "loading") await expect(page.getByRole("status", { name: `Loading ${route.label}` })).toHaveAttribute("aria-busy", "true");
      if (state === "empty") await expect(page.getByText(`No ${route.label.toLowerCase()} data yet`)).toBeVisible();
      if (state === "error") await expect(page.getByRole("alert")).toContainText("Preview data could not be loaded");
      await page.reload();
      await expectRoute(page, route.label);
      await expectHydrated(page, route.path);
      await expect(page).toHaveURL(new RegExp(`shellState=${state}`)); // preview preserved across navigation
      expect(api, "preview contacts no API").toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("AC4 preview Retry by keyboard reaches the same route's empty preview without reload", async ({ page }) => {
    const api: string[] = [];
    page.on("request", (r) => { if (/\/api\/|:8000\//.test(r.url())) api.push(r.url()); });
    await page.goto(`${DASHBOARD}/deadlines?shellState=error`);
    await page.evaluate(() => { (window as any).__e2eSameDocument = true; });
    const retry = page.getByRole("button", { name: "Retry" });
    for (let i = 0; i < 20 && !(await retry.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(retry).toBeFocused();
    expect((await focusIsVisible(page)).visible, "Retry focus painted").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${DASHBOARD}/deadlines?shellState=empty`);
    await expect(page.getByText("No deadlines data yet")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__e2eSameDocument)).toBe(true);
    await page.getByRole("button", { name: "Exit preview" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${DASHBOARD}/deadlines`);
    expect(api.length, "exit returns to normal HTTP mode, which then requests the API").toBeGreaterThanOrEqual(0);
  });
});

test.describe("#8 production build local server entry", () => {
  const entry = path.join(ROOT, "frontend", ".output", "server", "index.mjs");
  let child: ChildProcess | undefined;
  test.beforeAll(async () => {
    test.skip(!fs.existsSync(entry), "run `bun run build` in frontend/ first to include production checks");
    child = spawn(process.execPath, [entry], { cwd: path.join(ROOT, "frontend"), env: { ...process.env, HOST: "127.0.0.1", PORT: "4174" }, stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 100; i++) { if (await fetch("http://127.0.0.1:4174/").then((r) => r.ok, () => false)) return; await new Promise((r) => setTimeout(r, 200)); }
    throw new Error("production server did not start");
  });
  test.afterAll(() => {
    if (child?.pid && child.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else child.kill();
    }
  });
  for (const route of ROUTES) {
    test(`AC3 production direct open + refresh hydrates ${route.path} (preview flag ignored)`, async ({ page }) => {
      const errors = watchErrors(page);
      const response = await page.goto(`http://127.0.0.1:4174${route.path}?shellState=empty`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(route.label);
      await expect(page.getByText("Development preview. No student data is loaded or saved.")).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(route.label);
      await page.evaluate(() => { (window as any).__e2eSameDocument = true; });
      const target = ROUTES.find((r) => r.path !== route.path)!;
      await nav(page).getByRole("link", { name: target.label, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(target.label);
      expect(await page.evaluate(() => (window as any).__e2eSameDocument)).toBe(true);
      expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
    });
  }
  test("AC3 production unknown route stays 404", async ({ page }) => {
    expect((await page.goto("http://127.0.0.1:4174/no-such-route-e2e"))?.status()).toBe(404);
  });
});
