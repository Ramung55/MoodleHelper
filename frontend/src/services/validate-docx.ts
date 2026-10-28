/** Strict bounded DOCX container checks; no extraction and no network access. */
const MAX_UNCOMPRESSED = 40 * 1024 * 1024;
const fail = (reason: string): never => { throw new Error(reason); };
const invalid = () => fail("The DOCX archive is corrupt or uses an unsupported ZIP feature. Export a new DOCX and retry.");
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
async function inflate(bytes: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") fail("This browser cannot validate compressed DOCX files. Try a current browser.");
  let stream: ReadableStream<Uint8Array>;
  try { stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat)); }
  catch { return fail("This browser cannot validate compressed DOCX files. Try a current browser."); }
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > expected || size > MAX_UNCOMPRESSED) { await reader.cancel(); return invalid(); }
      chunks.push(value);
    }
  } catch { return invalid(); }
  if (size !== expected) return invalid();
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function validateDocx(buffer: ArrayBuffer, signal: AbortSignal): Promise<void> {
  const b = new Uint8Array(buffer), v = new DataView(buffer);
  const u16 = (at: number) => { if (at < 0 || at + 2 > b.length) return invalid(); return v.getUint16(at, true); };
  const u32 = (at: number) => { if (at < 0 || at + 4 > b.length) return invalid(); return v.getUint32(at, true); };
  const check = () => { if (signal.aborted) throw new DOMException("Cancelled", "AbortError"); };
  check();
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === b.length) { end = i; break; }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) return invalid();
  const count = u16(end + 10), centralSize = u32(end + 12), central = u32(end + 16);
  if (count === 0xffff || central + centralSize !== end || count > 4096) return invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true }); const names = new Set<string>();
  const parts = new Map<string, Uint8Array>(); let cursor = central, total = 0;
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    check(); if (u32(cursor) !== 0x02014b50 || cursor + 46 > end) return invalid();
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const compressed = u32(cursor + 20), size = u32(cursor + 24), nameLen = u16(cursor + 28), extraLen = u16(cursor + 30), commentLen = u16(cursor + 32), local = u32(cursor + 42);
    if ((flags & ~0x0808) !== 0 || (method !== 0 && method !== 8) || u16(cursor + 34) !== 0 || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return invalid();
    if (cursor + 46 + nameLen + extraLen + commentLen > end || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) return invalid();
    const localCrc = u32(local + 14), localCompressed = u32(local + 18), localSize = u32(local + 22);
    if (flags & 8) {
      if ((localCrc !== 0 && localCrc !== crc) || (localCompressed !== 0 && localCompressed !== compressed) || (localSize !== 0 && localSize !== size)) return invalid();
    } else if (localCrc !== crc || localCompressed !== compressed || localSize !== size) return invalid();
    let name: string; try { name = decoder.decode(b.subarray(cursor + 46, cursor + 46 + nameLen)); } catch { return invalid(); }
    const localNameLen = u16(local + 26), localExtraLen = u16(local + 28);
    if (localNameLen !== nameLen || local + 30 + localNameLen + localExtraLen > central || decoder.decode(b.subarray(local + 30, local + 30 + localNameLen)) !== name || names.has(name)) return invalid();
    names.add(name);
    const start = local + 30 + localNameLen + localExtraLen, finish = start + compressed;
    if (finish > central) return invalid();
    let rangeEnd = finish;
    if (flags & 8) {
      let descriptor = finish;
      if (u32(descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > central || u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) return invalid();
      rangeEnd = descriptor + 12;
    }
    if (ranges.some(([a, z]) => local < z && rangeEnd > a)) return invalid();
    ranges.push([local, rangeEnd]); total += size; if (total > MAX_UNCOMPRESSED || size > MAX_UNCOMPRESSED) return invalid();
    const data = method === 0 ? b.slice(start, finish) : await inflate(b.slice(start, finish), size);
    check(); if (data.length !== size || crc32(data) !== crc) return invalid();
    if (name === "[Content_Types].xml" || name === "word/document.xml") parts.set(name, data);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (cursor !== end || parts.size !== 2) return invalid();
  for (const [name, bytes] of parts) {
    let xml: Document;
    try {
      const text = decoder.decode(bytes);
      if (/<!DOCTYPE/i.test(text)) return invalid();
      xml = new DOMParser().parseFromString(text, "application/xml");
    } catch { return invalid(); }
    if (xml.getElementsByTagName("parsererror").length || !xml.documentElement || xml.doctype) return invalid();
    const root = xml.documentElement;
    if (name === "[Content_Types].xml" && (root.localName !== "Types" || root.namespaceURI !== "http://schemas.openxmlformats.org/package/2006/content-types")) return invalid();
    if (name === "word/document.xml" && (root.localName !== "document" || !["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"].includes(root.namespaceURI ?? ""))) return invalid();
  }
}
