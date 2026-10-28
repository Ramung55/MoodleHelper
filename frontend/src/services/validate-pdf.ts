import { getDocument, GlobalWorkerOptions, VerbosityLevel } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Restricted classic-xref PDFs only. Reject features that require repair or a password. */
export async function validatePdf(buffer: ArrayBuffer, signal: AbortSignal): Promise<void> {
  const fail = (reason: string): never => { throw new Error(reason); };
  const bad = () => fail("The PDF is corrupt or uses an unsupported structure. Export a new unencrypted PDF and retry.");
  const check = () => { if (signal.aborted) throw new DOMException("Cancelled", "AbortError"); };
  check();
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder("latin1").decode(bytes);
  if (!/^%PDF-1\.[0-7](?:\r\n|\r|\n)/.test(text)) return bad();
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!tail) return bad();
  const offset = Number(tail[1]);
  if (!Number.isSafeInteger(offset) || offset >= text.length || text.slice(offset, offset + 4) !== "xref") return bad();
  const xref = text.slice(offset, tail.index);
  const trailerIndex = xref.indexOf("trailer");
  if (trailerIndex < 0) return bad();
  const trailer = xref.slice(trailerIndex + 7);
  if (/\/Encrypt\b/.test(trailer)) return fail("Password-protected PDFs are unsupported. Export an unencrypted copy and retry.");
  if (!/^\s*<<[\s\S]*>>\s*$/.test(trailer) || /\/(?:Prev|XRefStm)\b/.test(trailer)) return bad();
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(trailer);
  if (!root) return bad();
  const lines = xref.slice(4, trailerIndex).trim().split(/\r\n|\r|\n/); let i = 0; let rootFound = false;
  while (i < lines.length) {
    const section = /^(\d+)\s+(\d+)\s*$/.exec(lines[i++] ?? "");
    if (!section) return bad();
    const first = Number(section[1]), count = Number(section[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count > 100000 || i + count > lines.length) return bad();
    for (let j = 0; j < count; j++) {
      const entry = /^(\d{10})\s+(\d{5})\s+([nf])\s*$/.exec(lines[i++] ?? "");
      if (!entry) return bad();
      if (entry[3] === "n") {
        const position = Number(entry[1]), generation = Number(entry[2]), object = first + j;
        if (position >= offset || !text.slice(position).startsWith(`${object} ${generation} obj`)) return bad();
        if (object === Number(root[1]) && generation === Number(root[2])) rootFound = true;
      }
    }
  }
  if (!rootFound) return bad();
  check(); GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({ data: bytes, stopAtErrors: true, verbosity: VerbosityLevel.ERRORS,
    useWorkerFetch: false, useSystemFonts: false, useWasm: false, disableFontFace: true,
    disableAutoFetch: true, disableStream: true, disableRange: true });
  const abort = () => { void task.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await task.promise; check();
    if (pdf.numPages < 1 || pdf.numPages > 10000) return bad();
    for (let page = 1; page <= pdf.numPages; page++) {
      check();
      const current = await pdf.getPage(page);
      await current.getOperatorList();
      current.cleanup();
    }
    check();
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof Error && error.name === "PasswordException") return fail("Password-protected PDFs are unsupported. Export an unencrypted copy and retry.");
    return bad();
  } finally { signal.removeEventListener("abort", abort); await task.destroy(); }
}
