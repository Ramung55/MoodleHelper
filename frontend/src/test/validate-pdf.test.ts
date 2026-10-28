import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { DecompressionStream as NodeDecompressionStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => ({ getDocument, GlobalWorkerOptions: {}, VerbosityLevel: { ERRORS: 0 } }));
import { validatePdf } from "@/services/validate-pdf";
const fixture = readFileSync("src/test/fixtures/local-valid.pdf");
const copy = () => Uint8Array.from(fixture);
const validate = (bytes: Uint8Array) => validatePdf(bytes.buffer, new AbortController().signal);
beforeEach(() => { getDocument.mockReset(); getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue({ getOperatorList: vi.fn(), cleanup: vi.fn() }) }), destroy: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());
describe("PDF structural gate", () => {
  it("passes local bytes to PDF.js with network-related facilities disabled", async () => {
    await expect(validate(copy())).resolves.toBeUndefined();
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(Uint8Array), stopAtErrors: true, useWorkerFetch: false, useSystemFonts: false, useWasm: false }));
  });
  it.each(['local-version2.pdf', 'local-incremental.pdf'])("accepts a synthetic valid %s structure", async (name) => {
    await expect(validate(Uint8Array.from(readFileSync(`src/test/fixtures/${name}`)))).resolves.toBeUndefined();
  });
  it('accepts a bounded compressed xref stream and rejects corruption', async () => {
    vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('DecompressionStream', NodeDecompressionStream);
    const bytes = Uint8Array.from(readFileSync('src/test/fixtures/local-xref-stream.pdf'));
    await expect(validate(bytes)).resolves.toBeUndefined();
    getDocument.mockClear();
    const position = Buffer.from(bytes).indexOf(Buffer.from('stream\n')) + 7;
    bytes[position + 3] ^= 1;
    await expect(validate(bytes)).rejects.toThrow(/corrupt/);
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('fails closed on invalid xref-stream widths, ranges, lengths and filters', async () => {
    const original = readFileSync('src/test/fixtures/local-xref-stream.pdf', 'latin1');
    for (const modified of [
      original.replace('/W [1 4 2]', '/W [1 9 2]'),
      original.replace('/W [1 4 2]', '/W [1 4 2] /Index [0 100001]'),
      original.replace(/\/Length \d+/, '/Length 99999999'),
      original.replace('/FlateDecode', '/Unsupported'),
    ]) {
      await expect(validate(Uint8Array.from(Buffer.from(modified, 'latin1')))).rejects.toThrow(/corrupt/);
    }
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('rejects cyclic, forward and missing incremental cross-reference targets', async () => {
    const original = readFileSync('src/test/fixtures/local-incremental.pdf', 'latin1');
    const matches = [...original.matchAll(/startxref\s+(\d+)/g)];
    const latest = matches.at(-1)![1]!;
    for (const target of [latest, String(Number(latest) + 1), '1']) {
      const modified = original.replace(/\/Prev\s+\d+/, `/Prev ${target}`);
      await expect(validate(Uint8Array.from(Buffer.from(modified, 'latin1')))).rejects.toThrow(/corrupt/);
    }
    expect(getDocument).not.toHaveBeenCalled();
  });
  it("rejects truncation and invalid xref offsets before invoking PDF.js", async () => {
    await expect(validate(copy().slice(0, -15))).rejects.toThrow(/corrupt/);
    const invalid = copy(); const source = new TextDecoder().decode(invalid); const pos = source.indexOf('0000000009'); invalid[pos + 9] = 50;
    await expect(validate(invalid)).rejects.toThrow(/corrupt/); expect(getDocument).not.toHaveBeenCalled();
  });
  it("rejects an encrypted trailer before parsing", async () => {
    const text = new TextDecoder().decode(copy()).replace('/Size 4', '/Encrypt /Size 4');
    await expect(validate(new TextEncoder().encode(text))).rejects.toThrow(/Password-protected/); expect(getDocument).not.toHaveBeenCalled();
  });
  it("rejects a genuinely encrypted synthetic PDF", async () => {
    const encrypted = Uint8Array.from(readFileSync("src/test/fixtures/local-encrypted.pdf"));
    await expect(validate(encrypted)).rejects.toThrow(/Password-protected/);
    expect(getDocument).not.toHaveBeenCalled();
  });
  it("rejects parser failures", async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error('bad')), destroy: vi.fn() });
    await expect(validate(copy())).rejects.toThrow(/corrupt/);
  });
});
