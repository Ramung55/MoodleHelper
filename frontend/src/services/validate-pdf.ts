import { getDocument, GlobalWorkerOptions, VerbosityLevel } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readXrefStream } from "./pdf-xref-stream";

/** Classic xref tables, including bounded incremental revisions. */
export async function validatePdf(buffer: ArrayBuffer, signal: AbortSignal): Promise<void> {
  const fail = (reason: string): never => { throw new Error(reason); };
  const bad = () => fail("The PDF is corrupt or uses an unsupported structure. Export a new unencrypted PDF and retry.");
  const check = () => { if (signal.aborted) throw new DOMException("Cancelled", "AbortError"); };
  check();
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder("latin1").decode(bytes);
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(text)) return bad();
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!tail) return bad();
  let offset = Number(tail[1]);
  let root: [number, number] | undefined;
  const entries = new Map<number, { generation: number; inUse: boolean }>();
  const seen = new Set<number>();
  if (Number.isSafeInteger(offset) && offset >= 0 && offset < tail.index && text.slice(offset, offset + 4) !== "xref") {
    let stream: Awaited<ReturnType<typeof readXrefStream>>;
    try { stream = await readXrefStream(bytes, text, offset, tail.index, signal); }
    catch { if (signal.aborted) throw new DOMException("Cancelled", "AbortError"); return bad(); }
    if (/\/Prev\b/.test(stream.trailer)) return bad();
    const roots = [...stream.trailer.matchAll(/\/Root\s+(\d+)\s+(\d+)\s+R\b/g)];
    if (roots.length !== 1) return bad();
    root = [Number(roots[0]![1]), Number(roots[0]![2])];
    for (const entry of stream.entries) entries.set(entry.object, entry);
  } else {
  while (true) {
    check();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= tail.index || seen.has(offset) || seen.size >= 128 || text.slice(offset, offset + 4) !== "xref") return bad();
    seen.add(offset);
    const trailerIndex = text.indexOf("trailer", offset + 4);
    if (trailerIndex < 0 || trailerIndex >= tail.index) return bad();
    const match = /^\s*<<((?:(?!<<|>>)[\s\S])*)>>/.exec(text.slice(trailerIndex + 7, tail.index));
    if (!match) return bad();
    const endOfTrailer = trailerIndex + 7 + match[0].length;
    const footer = /^\s*startxref\s+(\d+)\s+%%EOF(?:\s|$)/.exec(text.slice(endOfTrailer));
    if (!footer || Number(footer[1]) !== offset) return bad();
    const trailer = match[1]!;
    if (/\/Encrypt\b/.test(trailer)) return fail("Password-protected PDFs are unsupported. Export an unencrypted copy and retry.");
    if (/\/XRefStm\b/.test(trailer)) return bad();
    const rootMatches = [...trailer.matchAll(/\/Root\s+(\d+)\s+(\d+)\s+R\b/g)];
    const prevMatches = [...trailer.matchAll(/\/Prev\s+(\d+)\b/g)];
    if (rootMatches.length > 1 || prevMatches.length > 1 || (/\/Prev\b/.test(trailer) && !prevMatches.length)) return bad();
    if (!root && rootMatches.length) root = [Number(rootMatches[0]![1]), Number(rootMatches[0]![2])];
    const lines = text.slice(offset + 4, trailerIndex).trim().split(/\r\n|\r|\n/); let i = 0;
    const local = new Set<number>();
    while (i < lines.length) {
      const section = /^(\d+)\s+(\d+)\s*$/.exec(lines[i++] ?? "");
      if (!section) return bad();
      const first = Number(section[1]), count = Number(section[2]);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count > 100000 || i + count > lines.length) return bad();
      for (let j = 0; j < count; j++) {
        const entry = /^(\d{10})\s+(\d{5})\s+([nf])\s*$/.exec(lines[i++] ?? "");
        if (!entry) return bad();
        const position = Number(entry[1]), generation = Number(entry[2]), object = first + j;
        if (local.has(object)) return bad();
        local.add(object);
        if (entry[3] === "n" && (position >= offset || !text.slice(position).startsWith(`${object} ${generation} obj`))) return bad();
        if (!entries.has(object)) entries.set(object, { generation, inUse: entry[3] === "n" });
      }
    }
    if (!prevMatches.length) break;
    const prev = Number(prevMatches[0]![1]);
    if (!Number.isSafeInteger(prev) || prev >= offset) return bad();
    offset = prev;
  }
  }
  if (!root || !entries.get(root[0])?.inUse || entries.get(root[0])?.generation !== root[1]) return bad();
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
