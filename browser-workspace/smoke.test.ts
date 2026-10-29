import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { catalog } from "../shared/src/bridge";

describe("emitted browser modules", () => {
  for (const name of ["shared"]) {
    it(`loads the actual ${name} ESM build without Chrome APIs`, async () => {
      expect("chrome" in globalThis).toBe(false);
      const artifact = new URL(`../${name}/dist/index.js`, import.meta.url);
      await access(fileURLToPath(artifact));
      const module = await import(/* @vite-ignore */ artifact.href);
      expect(module.catalog).toBeDefined();
      expect(Object.keys(module.catalog).sort()).toEqual(Object.keys(catalog).sort());
    });
  }
});
