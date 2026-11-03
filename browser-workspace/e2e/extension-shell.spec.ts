/**
 * Real-browser evidence for #7: the unpacked production build from extension/dist
 * loads in bundled Chromium, its worker runs/wakes, the popup page opens without
 * errors, content scripts appear only where declared, and reload adds no grant.
 *
 * Boundaries (recorded, not hidden): the SDU login page is a LOCAL FIXTURE served
 * for https://moodle.sdu.edu.kz/login/index.php by request interception (no network);
 * the popup is opened as an extension page tab, not the toolbar popup UI; site access
 * is read from chrome.permissions in the worker, not from the chrome://extensions UI.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  DASHBOARD, EXTENSION_DIST, FixtureBackend, launchWithExtension, removeRunDirectory, runDirectory,
  watchExtensionWorker, assertNoUnexpectedTraffic, type ExtensionSession,
} from "./harness";

const SDU_LOGIN = "https://moodle.sdu.edu.kz/login/index.php";
const SDU_FIXTURE = "<!doctype html><html><head><title>SDU login (local fixture)</title></head><body><h1>Synthetic SDU login fixture</h1></body></html>";

let dir: string, backend: FixtureBackend, session: ExtensionSession, unrelated: http.Server, unrelatedUrl: string;

test.beforeAll(async () => {
  dir = runDirectory("extension");
  backend = new FixtureBackend(dir);
  await backend.start();
  unrelated = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Unrelated site</title><h1>Unrelated local site</h1>"); });
  await new Promise<void>((r) => unrelated.listen(0, "127.0.0.1", r));
  unrelatedUrl = `http://127.0.0.1:${(unrelated.address() as AddressInfo).port}/`;
  session = await launchWithExtension(dir, { fixtureRoutes: { [SDU_LOGIN]: SDU_FIXTURE } });
});
test.afterAll(async () => {
  await session?.close().catch(() => {});
  await new Promise((r) => unrelated?.close(r));
  await backend?.stop();
  if (dir) removeRunDirectory(dir);
});

/** Extension isolated-world execution contexts created in a page, via DevTools Runtime events. */
async function extensionContextsOn(page: Page, url: string) {
  const cdp = await session.context.newCDPSession(page);
  const contexts: { origin: string; name: string; type: string }[] = [];
  cdp.on("Runtime.executionContextCreated", ({ context }: any) => contexts.push({ origin: context.origin, name: context.name, type: context.auxData?.type }));
  await cdp.send("Runtime.enable");
  await page.goto(url);
  await page.waitForLoadState("load");
  await page.waitForTimeout(500); // document_idle injection settles after load (bounded, single wait)
  await cdp.detach();
  return contexts.filter((c) => c.type === "isolated" && c.origin === `chrome-extension://${session.extensionId}`);
}

test("AC1 unpacked build loads, worker runs, popup page opens without errors, worker wakes after stop", async ({}, testInfo) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIST, "manifest.json"), "utf8"));
  const loaded = await session.worker().evaluate(() => (globalThis as any).chrome.runtime.getManifest());
  expect(loaded.manifest_version).toBe(3);
  expect(loaded.name).toBe(manifest.name);
  expect(session.worker().url()).toBe(`chrome-extension://${session.extensionId}/index.js`);
  const page = await session.context.newPage();
  testInfo.annotations.push({ type: "browser", description: `Chromium ${await page.evaluate(() => navigator.userAgent)}` });
  testInfo.annotations.push({ type: "extension-id", description: session.extensionId });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`chrome-extension://${session.extensionId}/popup.html`);
  await expect(page).toHaveTitle("Moodle Helper");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mock scan progress");
  await expect(page.locator("#status")).not.toHaveText("Connecting…");
  await testInfo.attach("popup-page", { body: await page.screenshot(), contentType: "image/png" });
  expect(errors, "popup page errors").toEqual([]);

  const watcher = await watchExtensionWorker(session.context, page, session.extensionId);
  await watcher.stop();
  // Wake through the declared path: the dashboard relay messages the worker on reconnect.
  const dashboard = await session.context.newPage();
  await dashboard.goto(`${DASHBOARD}/settings`);
  await dashboard.getByRole("button", { name: "Check / reconnect extension" }).click();
  await expect.poll(() => watcher.statuses.at(-1)?.split(":")[1], { message: "worker running again after wake" }).toBe("running");
  testInfo.annotations.push({ type: "worker-status", description: watcher.statuses.join(" → ") });
  await watcher.detach();
  await dashboard.close();
  await page.reload(); // reopen the popup page
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mock scan progress");
  expect(errors).toEqual([]);
  await page.close();
});

test("AC2 manifest scope and content script context on the (fixture) SDU login page", async ({}, testInfo) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIST, "manifest.json"), "utf8"));
  expect(manifest.background).toEqual({ service_worker: "index.js", type: "module" });
  expect(manifest.action.default_popup).toBe("popup.html");
  const content = manifest.content_scripts.find((c: any) => c.js.includes("content.js"));
  expect(content.matches).toEqual(["https://moodle.sdu.edu.kz/*"]);
  testInfo.annotations.push({ type: "manifest-current", description: `permissions=${JSON.stringify(manifest.permissions ?? [])} host_permissions=${JSON.stringify(manifest.host_permissions ?? [])} content_scripts=${JSON.stringify(manifest.content_scripts.map((c: any) => [c.js, c.matches]))}` });
  const page = await session.context.newPage();
  const contexts = await extensionContextsOn(page, SDU_LOGIN);
  expect(contexts.length, "this extension's isolated world exists on the SDU page").toBeGreaterThan(0);
  testInfo.annotations.push({ type: "sdu-contexts", description: JSON.stringify(contexts) });
  await page.close();
});

test("AC3 no injection or site access on an unrelated site", async ({}, testInfo) => {
  const page = await session.context.newPage();
  const contexts = await extensionContextsOn(page, unrelatedUrl);
  expect(contexts, `no extension context on ${unrelatedUrl}`).toEqual([]);
  // Control: the declared dashboard relay is injected on the dashboard origin only.
  const dashboard = await extensionContextsOn(page, `${DASHBOARD}/?shellState=empty`);
  expect(dashboard.length, "declared dashboard relay context present on 127.0.0.1:5173").toBeGreaterThan(0);
  await page.goto(`chrome-extension://${session.extensionId}/popup.html`);
  const granted = await page.evaluate(() => (globalThis as any).chrome.permissions.getAll());
  testInfo.annotations.push({ type: "granted", description: JSON.stringify(granted) });
  // Chrome reports declared host permissions plus static content-script matches; nothing else.
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIST, "manifest.json"), "utf8"));
  const declared = [...new Set([...(manifest.host_permissions ?? []), ...manifest.content_scripts.flatMap((c: any) => c.matches)])].sort();
  expect(granted.origins.sort()).toEqual(declared);
  expect(granted.origins.some((o: string) => o.includes(new URL(unrelatedUrl).host) || o === "<all_urls>")).toBe(false);
  await page.close();
});

test("AC4 reload restarts the shell without new grants or non-local traffic", async ({}, testInfo) => {
  const host = await session.context.newPage();
  await host.goto(`chrome-extension://${session.extensionId}/popup.html`);
  const before = await host.evaluate(() => (globalThis as any).chrome.permissions.getAll());
  const watcher = await watchExtensionWorker(session.context, host, session.extensionId);
  const versionsBefore = new Set(watcher.versions.keys());
  // Reload through chrome://extensions as a developer would (isolated test profile only).
  const manager = await session.context.newPage();
  await manager.goto("chrome://extensions/");
  const devMode = manager.locator("#devMode");
  if ((await devMode.getAttribute("aria-pressed")) !== "true") await devMode.click();
  await manager.goto(`chrome://extensions/?id=${session.extensionId}`);
  await testInfo.attach("extension-details", { body: await manager.screenshot({ fullPage: true }), contentType: "image/png" });
  const siteAccess = await manager.locator("extensions-detail-view").innerText().catch(() => "");
  testInfo.annotations.push({ type: "details-view", description: siteAccess.replace(/\s+/g, " ").slice(0, 600) });
  await manager.locator("extensions-detail-view #dev-reload-button").click();
  await testInfo.attach("extension-details-after-reload", { body: await manager.screenshot({ fullPage: true }), contentType: "image/png" });
  const after = await session.context.newPage();
  await expect.poll(async () => { try { await after.goto(`chrome-extension://${session.extensionId}/popup.html`); return await after.title(); } catch { return ""; } }, { message: "same extension id serves its popup after reload" }).toBe("Moodle Helper");
  expect(await after.evaluate(() => (globalThis as any).chrome.permissions.getAll()), "reload adds no grant").toEqual(before);
  testInfo.annotations.push({ type: "worker-versions", description: `before=${[...versionsBefore].join(",")} statuses=${watcher.statuses.join(" → ")}` });
  await watcher.detach().catch(() => {});
  await after.close();
  const page = await session.context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${session.extensionId}/popup.html`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mock scan progress");
  expect(errors).toEqual([]);
  testInfo.annotations.push({ type: "fonts-blocked", description: String(session.blockedDesignAssets.length) });
  assertNoUnexpectedTraffic(session);
  await page.close();
});
