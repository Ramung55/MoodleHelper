import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'public/ocr/7.0.0');
const assets = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function copy(packageName, source, target, expectedVersion) {
  const packageRoot = path.join(root, 'node_modules', packageName);
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.version !== expectedVersion) throw new Error(`OCR setup requires ${packageName}@${expectedVersion}`);
  const bytes = await readFile(path.join(packageRoot, source));
  const output = path.join(destination, target);
  if (!output.startsWith(destination + path.sep)) throw new Error('Invalid OCR asset destination');
  await mkdir(path.dirname(output), { recursive: true });
  let current; try { current = await readFile(output); } catch { /* first setup */ }
  if (!current || hash(current) !== hash(bytes)) await copyFile(path.join(packageRoot, source), output);
  assets.push({ file: target.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes), package: packageName, version: metadata.version, source, packageLicense: metadata.license });
}
await mkdir(destination, { recursive: true });
await copy('tesseract.js', 'dist/worker.min.js', 'worker.min.js', '7.0.0');
await copy('tesseract.js', 'LICENSE.md', 'notices/tesseract-LICENSE', '7.0.0');
for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) for (const extension of ['wasm.js', 'wasm']) await copy('tesseract.js-core', `tesseract-core-${variant}.${extension}`, `core/tesseract-core-${variant}.${extension}`, '7.0.0');
await copy('tesseract.js-core', 'LICENSE', 'notices/core-LICENSE', '7.0.0');
for (const language of ['eng', 'rus']) {
  await copy(`@tesseract.js-data/${language}`, `4.0.0_best_int/${language}.traineddata.gz`, `lang/${language}.traineddata.gz`, '1.0.0');
  for (const file of ['package.json', 'README.md']) await copy(`@tesseract.js-data/${language}`, file, `notices/${language}-${file}`, '1.0.0');
}
const bootstrap = `/* Version-pinned local OCR worker; no remote fallback or content network transfer. */
const base = new URL('./', self.location.href);
const checked = (input) => { const url = new URL(typeof input === 'string' ? input : input.url, base); if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Only installed local OCR assets are allowed'); return url.href; };
const localFetch = self.fetch.bind(self); self.fetch = (input, options = {}) => { if ((options.method && options.method !== 'GET') || options.body || (typeof Request !== 'undefined' && input instanceof Request && input.method !== 'GET')) return Promise.reject(new Error('OCR network writes are disabled')); return localFetch(checked(input), { ...options, credentials: 'omit' }); };
const localImport = self.importScripts.bind(self); self.importScripts = (...urls) => localImport(...urls.map(checked));
self.XMLHttpRequest = undefined;
for (const name of ['log', 'info', 'warn', 'error', 'debug']) self.console[name] = () => {};
self.importScripts(new URL('worker.min.js', base).href);
`;
await writeFile(path.join(destination, 'local-worker.js'), bootstrap);
assets.push({ file: 'local-worker.js', bytes: Buffer.byteLength(bootstrap), sha256: hash(bootstrap), source: 'scripts/prepare-ocr-assets.mjs' });
const notice = 'Language npm package metadata declares MIT. The upstream traineddata repository declares Apache-2.0: https://github.com/naptha/tessdata/blob/gh-pages/LICENSE . Retain both package metadata and upstream data attribution; notices/core-LICENSE contains the Apache-2.0 license text. Models: 4.0.0_best_int eng/rus only. No other traineddata is bundled.\n';
await writeFile(path.join(destination, 'notices/DATA-NOTICE.txt'), notice);
assets.push({ file: 'notices/DATA-NOTICE.txt', bytes: Buffer.byteLength(notice), sha256: hash(notice), source: 'scripts/prepare-ocr-assets.mjs' });
const inventory = { engine: '7.0.0', core: '7.0.0', data: '1.0.0', mode: 'LSTM only', totalAssetBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0), assets };
await writeFile(path.join(destination, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(`Local OCR assets prepared: ${inventory.totalAssetBytes} bytes`);
