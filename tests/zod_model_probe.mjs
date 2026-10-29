// Focused runnable probe against the actual Zod definitions, no duplicate schema.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../frontend/src/domain/types.ts", import.meta.url));
const ts = require("typescript");
const source = fs.readFileSync(new URL("../frontend/src/domain/types.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
new Function("require", "module", "exports", compiled)(require, module, module.exports);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const schema = module.exports[input.model];
const result = schema.safeParse(input.value);
process.stdout.write(JSON.stringify(result.success ? { success: true, value: result.data } : { success: false, errors: result.error.issues }));
