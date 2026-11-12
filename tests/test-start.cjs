const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { selectIdentity, checkPort } = require('../scripts/start.cjs');
const complete = { MOODLE_HELPER_DATASET: 'moodle', MOODLE_HELPER_MOODLE_ORIGIN: 'https://moodle.sdu.edu.kz', MOODLE_HELPER_PROFILE_LABEL: 'existing', MOODLE_HELPER_STABLE_USER_ID: '42', MOODLE_HELPER_DATABASE_URL: 'sqlite:///existing.db' };
test('preserves an explicitly configured identity and database', async () => {
  const env = { ...complete };
  assert.deepEqual(await selectIdentity(env), complete);
});
test('rejects incomplete or demo identity and noninteractive missing identity', async () => {
  await assert.rejects(selectIdentity({ MOODLE_HELPER_DATASET: 'moodle' }), /Incomplete/);
  await assert.rejects(selectIdentity({ ...complete, MOODLE_HELPER_DATASET: 'demo' }), /complete Moodle identity/);
  await assert.rejects(selectIdentity({}, { isTTY: false }), /required/);
});
test('prompts for both identity values without changing the database selection', async () => {
  const input = new PassThrough(); input.isTTY = true;
  const output = new PassThrough(); output.resume();
  const env = { MOODLE_HELPER_DATABASE_URL: 'sqlite:///existing.db' };
  const result = selectIdentity(env, input, output);
  setImmediate(() => { input.write('profile\n'); setImmediate(() => input.write('stable-user\n')); });
  assert.deepEqual(await result, { MOODLE_HELPER_DATABASE_URL: 'sqlite:///existing.db', MOODLE_HELPER_DATASET: 'moodle', MOODLE_HELPER_MOODLE_ORIGIN: 'https://moodle.sdu.edu.kz', MOODLE_HELPER_PROFILE_LABEL: 'profile', MOODLE_HELPER_STABLE_USER_ID: 'stable-user' });
  input.destroy(); output.destroy();
});
test('detects an occupied port without disturbing its owner', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(checkPort(server.address().port), /unavailable/); assert.equal(server.listening, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('starts two services, waits for HTTP, and stops only its own processes', async () => {
  const { main } = require('../scripts/start.cjs');
  const path = require('node:path');
  async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  }
  const first = await freePort(), second = await freePort();
  const script = path.resolve(__dirname, 'start-fake-server.cjs');
  let ready = false;
  await main({ env: complete, backendPort: first, frontendPort: second,
    backend: ['node', [script, String(first)], process.cwd()],
    frontend: ['node', [script, String(second)], process.cwd()],
    onReady: () => { ready = true; process.emit('SIGINT'); } });
  assert.equal(ready, true);
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await checkPort(first); await checkPort(second); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.fail('owned services did not stop');
});

test('reports a failed service and stops the other service', async () => {
  const { main } = require('../scripts/start.cjs');
  const path = require('node:path');
  const pick = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
  const first = await pick(), second = await pick();
  const script = path.resolve(__dirname, 'start-fake-server.cjs');
  await assert.rejects(main({ env: complete, backendPort: first, frontendPort: second,
    backend: ['node', ['-e', 'process.exit(1)'], process.cwd()],
    frontend: ['node', [script, String(second)], process.cwd()] }), /stopped unexpectedly/);
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await checkPort(first); await checkPort(second); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.fail('remaining service did not stop');
});
