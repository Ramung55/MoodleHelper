// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

// Real installed parser and its Node worker shim; this is not browser-worker evidence.
describe("hybrid PDF fixtures with real PDF.js", () => {
  it.each(["local-hybrid.pdf", "local-hybrid-incremental.pdf"])("reads the catalog and page operators in %s", async (name) => {
    const task = getDocument({
      data: Uint8Array.from(readFileSync(`src/test/fixtures/${name}`)),
      stopAtErrors: true, verbosity: VerbosityLevel.ERRORS,
      useWorkerFetch: false, useSystemFonts: false, useWasm: false,
      disableFontFace: true, disableAutoFetch: true, disableStream: true, disableRange: true,
    });
    try {
      const pdf = await task.promise;
      expect(pdf.numPages).toBe(1);
      const page = await pdf.getPage(1);
      expect(page.view).toEqual([0, 0, 200, 200]);
      await expect(page.getOperatorList()).resolves.toMatchObject({ fnArray: [], argsArray: [] });
      page.cleanup();
    } finally { await task.destroy(); }
  });
});
