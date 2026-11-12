const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(__dirname, '../frontend/.playwright-browsers');
const { chromium, expect } = createRequire(path.resolve(__dirname, '../frontend/package.json'))('@playwright/test');

const root = path.resolve(__dirname, '..');
const project = `moodlehelper-e2e-${randomUUID().replaceAll('-', '')}`;
let env;
function compose(...args) {
  return execFileSync('docker', ['compose', '-f', path.join(root, 'docker-compose.yaml'), '-p', project, ...args],
    { cwd: root, env, stdio: 'inherit', timeout: 600000 });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function ready(base) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/snapshot`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('App did not become ready');
}
(async () => {
  const port = await freePort();
  env = { ...process.env, APP_PORT: String(port), POSTGRES_USER: 'sdip',
    POSTGRES_PASSWORD: 'test_only_password', POSTGRES_DB: 'sdip',
    MOODLE_HELPER_DATABASE_URL: 'postgresql://sdip:test_only_password@postgres:5432/sdip' };
  const base = `http://127.0.0.1:${port}`;
  let browser;
  let page;
  try {
    compose('up', '-d', '--build', '--wait');
    await ready(base);
    browser = await chromium.launch({ channel: 'chromium' });
    let context = await browser.newContext();
    page = await context.newPage();
    await page.goto(base);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
    // Navigate the actual dashboard and validate an invalid and a successful form.
    await page.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Deadlines', exact: true }).click();
    await page.getByRole('button', { name: 'Personal event', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Add event' }).click();
    await expect(dialog.getByText('Enter a title.')).toBeVisible();
    await dialog.getByLabel('Title').fill('Compose browser study event');
    const createResponse = page.waitForResponse(r => r.url().endsWith('/api/personal-events') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Add event' }).click();
    const created = await createResponse;
    expect(created.status()).toBe(200);
    const snapshot = await created.json();
    const event = snapshot.assessments.find(item => item.title === 'Compose browser study event');
    expect(event).toBeTruthy();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('button').filter({ hasText: 'Compose browser study event' });
    await expect(row).toBeVisible();
    await row.click();
    const check = page.getByRole('checkbox', { name: "I've finished this (personal check)" });
    const completedResponse = page.waitForResponse(r => r.url().includes('/overlay') && r.request().method() === 'PATCH');
    await check.click();
    expect((await completedResponse).status()).toBe(200);
    await expect(check).toBeChecked();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: "I've finished this (personal check)" })).toBeChecked();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    // Confirm the frontend's event and completion actually reached PostgreSQL.
    const sql = "SELECT count(*) FROM snapshots s, jsonb_array_elements(s.snapshot::jsonb->'assessments') a, jsonb_array_elements(s.snapshot::jsonb->'overlays') o WHERE a->>'title'='Compose browser study event' AND o->>'assessmentId'=a->>'id' AND o->>'completed'='true'";
    const count = execFileSync('docker', ['compose', '-f', path.join(root, 'docker-compose.yaml'), '-p', project, 'exec', '-T', 'postgres', 'psql', '-U', 'sdip', '-d', 'sdip', '-Atc', sql], { cwd: root, env, encoding: 'utf8' });
    expect(Number(count.trim())).toBe(1);
    // The process binding is a write guard, not an application login.
    const denied = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ semesterWeeks: 10 }) });
    expect(denied.status).toBe(409);
    const stale = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Moodle-Helper-Bridge-Binding': 'stale' }, body: JSON.stringify({ semesterWeeks: 10 }) });
    expect(stale.status).toBe(409);
    const preflight = await fetch(`${base}/api/settings`, { method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'X-Moodle-Helper-Bridge-Binding' } });
    expect(preflight.status).toBe(400);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const badHost = await new Promise((resolve, reject) => {
      http.get(`${base}/api/snapshot`, { headers: { Host: 'attacker.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(badHost).toBe(400);
    await page.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await page.getByText('Legacy settings', { exact: true }).click();
    const weeks = page.locator('#sw');
    const saved = (await weeks.inputValue()) === '9' ? '10' : '9';
    const response = page.waitForResponse(r => r.url().includes('/api/settings') && r.request().method() === 'PATCH');
    await weeks.fill(saved);
    if (!(await response).ok()) throw new Error('Settings save failed');
    await page.reload();
    await page.getByText('Legacy settings', { exact: true }).click();
    await expect(weeks).toHaveValue(saved);
    await context.close();
    compose('down');
    compose('up', '-d', '--wait');
    await ready(base);
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(`${base}/settings`);
    await page.getByText('Legacy settings', { exact: true }).click();
    await expect(page.locator('#sw')).toHaveValue(saved);
    console.log('Compose browser workflow and persistence tests passed');
  } catch (error) {
    const artifacts = path.join(root, 'e2e', 'artifacts', project);
    fs.mkdirSync(artifacts, { recursive: true });
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    try {
      const logs = execFileSync('docker', ['compose', '-f', path.join(root, 'docker-compose.yaml'), '-p', project, 'logs', '--no-color'], { cwd: root, env, encoding: 'utf8' });
      fs.writeFileSync(path.join(artifacts, 'compose.log'), logs);
    } catch (logError) { fs.writeFileSync(path.join(artifacts, 'compose.log'), String(logError)); }
    fs.writeFileSync(path.join(artifacts, 'failure.log'), String(error.stack || error));
    console.error(`Failure artifacts: ${artifacts}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    compose('down', '--volumes', '--remove-orphans');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
