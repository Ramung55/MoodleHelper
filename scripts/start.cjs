const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const identity = ['MOODLE_HELPER_DATASET', 'MOODLE_HELPER_MOODLE_ORIGIN', 'MOODLE_HELPER_PROFILE_LABEL', 'MOODLE_HELPER_STABLE_USER_ID'];
const origin = 'https://moodle.sdu.edu.kz';
const WHERE = 'Open your profile in SDU Moodle (click your name, then Profile); the user id is the number after id= in the address bar.';

async function selectIdentity(env, input = process.stdin, output = process.stdout) {
  const present = identity.filter(key => env[key] !== undefined && env[key] !== '');
  if (present.length && present.length !== identity.length) throw new Error('Incomplete Moodle identity. Set all four MOODLE_HELPER identity variables, or unset all four to enter them interactively.');
  if (!present.length) {
    if (!input.isTTY) throw new Error('Moodle identity is required. Set the four MOODLE_HELPER identity variables or run interactively.');
    const rl = createInterface({ input, output });
    try {
      output.write('Enter the same profile label and stable Moodle user ID you used previously to open the same data. No password is needed.\n');
      output.write(`The Moodle user ID is a number. ${WHERE}\n`);
      const profile = await rl.question('Profile label: ');
      const user = await rl.question('Stable Moodle user ID (numeric): ');
      Object.assign(env, { MOODLE_HELPER_DATASET: 'moodle', MOODLE_HELPER_MOODLE_ORIGIN: origin, MOODLE_HELPER_PROFILE_LABEL: profile, MOODLE_HELPER_STABLE_USER_ID: user });
    } finally { rl.close(); }
  }
  if (env.MOODLE_HELPER_DATASET !== 'moodle' || env.MOODLE_HELPER_MOODLE_ORIGIN !== origin || !env.MOODLE_HELPER_PROFILE_LABEL?.trim() || !env.MOODLE_HELPER_STABLE_USER_ID?.trim()) throw new Error('A complete Moodle identity with the canonical SDU origin is required; existing settings were not changed.');
  // #93: only the numeric Moodle user id can match the account signed in to Moodle.
  if (!/^[1-9][0-9]{0,18}$/.test(env.MOODLE_HELPER_STABLE_USER_ID)) throw new Error(`The stable Moodle user ID must be your numeric Moodle user id (digits only). ${WHERE} Existing settings were not changed.`);
  return env;
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is unavailable. Stop the application using it and try again.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

function request(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 1000 }, response => { response.resume(); resolve(response.statusCode >= 200 && response.statusCode < 400); });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
  });
}

async function main(options = {}) {
  const env = await selectIdentity({ ...process.env, ...options.env });
  const backendPort = options.backendPort ?? 8000, frontendPort = options.frontendPort ?? 5173;
  await Promise.all([checkPort(backendPort), checkPort(frontendPort)]);
  const children = [];
  let stopping = false, failure;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }
  };
  const start = (command, args, cwd) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32', detached: process.platform !== 'win32', windowsHide: true });
    children.push(child);
    child.on('error', err => { if (!stopping) { failure = err; stop(); } });
    child.on('exit', (code, signal) => { if (!stopping) { const hint = command === 'uv' ? ' Check the Python environment and run uv sync; see the startup instructions in README.md.' : command === 'bun' ? ' Check Bun and the frontend dependencies; run make install and see README.md.' : ''; failure = new Error(`${command} stopped unexpectedly (${signal || code}).${hint}`); stop(); } });
    return child;
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const backend = options.backend ?? ['uv', ['run', 'uvicorn', 'backend.main:app', '--app-dir', '.', '--host', '127.0.0.1', '--port', '8000'], root];
    const frontend = options.frontend ?? ['bun', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], path.join(root, 'frontend')];
    start(...backend);
    start(...frontend);
    const deadline = Date.now() + 60000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      if ((await request(`http://127.0.0.1:${backendPort}/api/connection`)) && (await request(`http://127.0.0.1:${frontendPort}/`))) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready && !stopping) { failure = new Error('The application did not become ready within 60 seconds. Check the startup messages above.'); stop(); }
    if (ready) {
      console.log(`Moodle Helper is ready at http://127.0.0.1:${frontendPort}/ . Press Ctrl+C to stop.`);
      console.log('For live sync, enable the Moodle Helper browser extension and sign in to SDU Moodle in Chrome.');
      options.onReady?.();
    }
    while (!stopping) await new Promise(resolve => setTimeout(resolve, 250));
  } finally { stop(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  if (failure) throw failure;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { selectIdentity, checkPort, main };
