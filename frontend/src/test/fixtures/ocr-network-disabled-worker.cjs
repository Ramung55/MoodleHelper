// Actual Node Tesseract worker with all external network transports denied.
const deny = () => { throw new Error('External network disabled for local OCR verification'); };
globalThis.fetch = deny;
for (const transport of ['node:http', 'node:https']) { const module = require(transport); module.request = deny; module.get = deny; }
require('tesseract.js/src/worker-script/node/index.js');
