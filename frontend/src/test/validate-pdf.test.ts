import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { DecompressionStream as NodeDecompressionStream } from "node:stream/web";
import { deflateSync, inflateSync } from "node:zlib";
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
  it.each(['local-classic-to-stream.pdf','local-stream-to-classic.pdf','local-stream-to-stream.pdf'])("validates mixed revision chain %s and rejects invalid Prev", async (name) => {
    vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('DecompressionStream', NodeDecompressionStream);
    const source = readFileSync(`src/test/fixtures/${name}`), text = source.toString('latin1');
    await expect(validate(Uint8Array.from(source))).resolves.toBeUndefined();
    getDocument.mockClear();
    const latest = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1)![1]!;
    for (const target of [latest, String(Number(latest)+1), '1']) {
      const modified = text.replace(/\/Prev\s+\d+/, `/Prev ${target}`);
      await expect(validate(Uint8Array.from(Buffer.from(modified,'latin1')))).rejects.toThrow(/corrupt/);
    }
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('resolves compressed objects from an earlier revision and honors a later free entry', async () => {
    vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('DecompressionStream', NodeDecompressionStream);
    const source = readFileSync('src/test/fixtures/local-object-incremental.pdf');
    await expect(validate(Uint8Array.from(source))).resolves.toBeUndefined();
    getDocument.mockClear();
    const text = readFileSync('src/test/fixtures/local-stream-to-classic.pdf','latin1');
    const invalid = text.replace(/(xref\s+1\s+1\s+\d{10}\s+00000\s+)n/, '$1f');
    expect(invalid).not.toBe(text);
    await expect(validate(Uint8Array.from(Buffer.from(invalid,'latin1')))).rejects.toThrow(/corrupt/);
    expect(getDocument).not.toHaveBeenCalled();
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
  it('accepts a compressed catalog object and rejects corrupted streams and indexes', async () => {
    vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('DecompressionStream', NodeDecompressionStream);
    const bytes = Uint8Array.from(readFileSync('src/test/fixtures/local-object-stream.pdf'));
    await expect(validate(bytes)).resolves.toBeUndefined();
    getDocument.mockClear();
    const text = Buffer.from(bytes).toString('latin1');
    const objectData = text.indexOf('stream\n') + 7;
    const broken = Uint8Array.from(bytes); broken[objectData + 3] ^= 1;
    await expect(validate(broken)).rejects.toThrow(/corrupt/);
    for (const modified of [text.replace('/N 1', '/N 2'), text.replace('/First 4', '/First 9')]) {
      await expect(validate(Uint8Array.from(Buffer.from(modified, 'latin1')))).rejects.toThrow(/corrupt/);
    }
    const lastStream = text.lastIndexOf('stream\n', text.lastIndexOf('endstream'));
    const xrefHeaderStart = text.lastIndexOf('5 0 obj', lastStream);
    const header = text.slice(xrefHeaderStart, lastStream + 7);
    const length = Number(/\/Length (\d+)/.exec(header)![1]);
    const start = lastStream + 7;
    const payload = inflateSync(Buffer.from(bytes).subarray(start, start + length));
    payload[13] = 1; // compressed object's index points past the only object
    const compressed = deflateSync(payload);
    const rebuilt = Buffer.concat([Buffer.from(bytes).subarray(0, xrefHeaderStart), Buffer.from(header.replace(/\/Length \d+/, `/Length ${compressed.length}`), 'latin1'), compressed, Buffer.from(bytes).subarray(start + length)]);
    await expect(validate(Uint8Array.from(rebuilt))).rejects.toThrow(/corrupt/);
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('accepts PNG-predictor xref rows and rejects invalid filters and row sizes', async () => {
    vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('DecompressionStream', NodeDecompressionStream);
    const source = readFileSync('src/test/fixtures/local-predictor.pdf');
    await expect(validate(Uint8Array.from(source))).resolves.toBeUndefined();
    getDocument.mockClear();
    const text = source.toString('latin1'), headerStart = text.indexOf('4 0 obj');
    const start = text.indexOf('stream\n', headerStart) + 7;
    const header = text.slice(headerStart, start), length = Number(/\/Length (\d+)/.exec(header)![1]);
    const raw = inflateSync(source.subarray(start, start + length)); raw[0] = 5;
    const corrupted = deflateSync(raw);
    const rebuilt = Buffer.concat([source.subarray(0,headerStart), Buffer.from(header.replace(/\/Length \d+/, `/Length ${corrupted.length}`),'latin1'), corrupted, source.subarray(start+length)]);
    await expect(validate(Uint8Array.from(rebuilt))).rejects.toThrow(/corrupt/);
    await expect(validate(Uint8Array.from(Buffer.from(text.replace('/Columns 7','/Columns 8'),'latin1')))).rejects.toThrow(/corrupt/);
    expect(getDocument).not.toHaveBeenCalled();
  });
  it.each([0,1,2,3,4])('reconstructs PNG predictor row filter %i', async (mode) => {
    vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('DecompressionStream', NodeDecompressionStream);
    const source=readFileSync('src/test/fixtures/local-predictor.pdf'), text=source.toString('latin1');
    const headerStart=text.indexOf('4 0 obj'), start=text.indexOf('stream\n',headerStart)+7;
    const header=text.slice(headerStart,start), length=Number(/\/Length (\d+)/.exec(header)![1]);
    const previousEncoding=inflateSync(source.subarray(start,start+length));
    const plain=Buffer.alloc(35);
    for(let row=0;row<5;row++) for(let col=0;col<7;col++) plain[row*7+col]=(previousEncoding[row*8+col+1]!+(row?plain[(row-1)*7+col]!:0))&255;
    const encoded=Buffer.alloc(40);
    for(let row=0;row<5;row++) {
      encoded[row*8]=mode;
      for(let col=0;col<7;col++) {
        const i=row*7+col,left=col?plain[i-1]!:0,above=row?plain[i-7]!:0,upperLeft=row&&col?plain[i-8]!:0;
        let prediction=0;
        if(mode===1) prediction=left; else if(mode===2) prediction=above; else if(mode===3) prediction=Math.floor((left+above)/2);
        else if(mode===4){const p=left+above-upperLeft,a=Math.abs(p-left),b=Math.abs(p-above),c=Math.abs(p-upperLeft);prediction=a<=b&&a<=c?left:b<=c?above:upperLeft;}
        encoded[row*8+col+1]=(plain[i]!-prediction)&255;
      }
    }
    const packed=deflateSync(encoded);
    const rebuilt=Buffer.concat([source.subarray(0,headerStart),Buffer.from(header.replace(/\/Length \d+/,`/Length ${packed.length}`),'latin1'),packed,source.subarray(start+length)]);
    await expect(validate(Uint8Array.from(rebuilt))).resolves.toBeUndefined();
  });
  it('rejects a compressed object stream exceeding the bounded expanded size', async () => {
    vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('DecompressionStream', NodeDecompressionStream);
    const bytes = Uint8Array.from(readFileSync('src/test/fixtures/local-object-bomb.pdf'));
    await expect(validate(bytes)).rejects.toThrow(/corrupt/);
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('rejects a cancelled PDF before parser or network activity', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(validatePdf(copy().buffer, controller.signal)).rejects.toMatchObject({name:'AbortError'});
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
