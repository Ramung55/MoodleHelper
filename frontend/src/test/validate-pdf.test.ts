import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const getDocument = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => ({ getDocument, GlobalWorkerOptions: {}, VerbosityLevel: { ERRORS: 0 } }));
import { validatePdf } from "@/services/validate-pdf";
const fixture = readFileSync("src/test/fixtures/local-valid.pdf");
const copy = () => Uint8Array.from(fixture);
const validate = (bytes: Uint8Array) => validatePdf(bytes.buffer, new AbortController().signal);
beforeEach(() => { getDocument.mockReset(); getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue({ getOperatorList: vi.fn(), cleanup: vi.fn() }) }), destroy: vi.fn() }); });
describe("PDF structural gate", () => {
  it("passes local bytes to PDF.js with network-related facilities disabled", async () => {
    await expect(validate(copy())).resolves.toBeUndefined();
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(Uint8Array), stopAtErrors: true, useWorkerFetch: false, useSystemFonts: false, useWasm: false }));
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
