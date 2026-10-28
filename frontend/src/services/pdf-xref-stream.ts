/** Decode bounded xref and object streams; unsupported PDF features fail closed. */
const fail = (): never => { throw new Error("Unsupported or corrupt PDF cross-reference stream."); };
async function decode(data: Uint8Array, compressed: boolean, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!compressed) { if (data.length > limit) return fail(); return data; }
  if (typeof DecompressionStream === 'undefined') return fail();
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > limit) { await reader.cancel(); return fail(); }
      chunks.push(part.value);
    }
  } catch { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); return fail(); }
  const result = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}

export async function readXrefStream(bytes: Uint8Array, text: string, offset: number, end: number, signal: AbortSignal): Promise<{ trailer: string; entries: { object: number; generation: number; inUse: boolean; position: number }[] }> {
  const header = /^(\d+)\s+(\d+)\s+obj\s*<<((?:(?!<<|>>)[\s\S])*)>>\s*stream(?:\r\n|\r|\n)/.exec(text.slice(offset, end));
  if (!header) return fail();
  const dictionary = header[3]!;
  const single = (pattern: RegExp): RegExpMatchArray | null => {
    const matches = [...dictionary.matchAll(pattern)];
    if (matches.length > 1) return fail();
    return matches[0] ?? null;
  };
  if (!/\/Type\s*\/XRef\b/.test(dictionary) || /\/(?:DecodeParms|DP|XRefStm|Encrypt)\b/.test(dictionary)) return fail();
  const sizeMatch = single(/\/Size\s+(\d+)\b/g), lengthMatch = single(/\/Length\s+(\d+)\b/g), widthsMatch = single(/\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/g);
  if (!sizeMatch || !lengthMatch || !widthsMatch) return fail();
  if (/\/(?:Length|Size)\s+\d+\s+\d+\s+R\b/.test(dictionary)) return fail();
  const size = Number(sizeMatch[1]), length = Number(lengthMatch[1]), widths = widthsMatch.slice(1).map(Number);
  if (!Number.isSafeInteger(size) || size < 1 || size > 100000 || !Number.isSafeInteger(length) || length < 1 || widths.some((n) => n > 6) || widths.reduce((a,b) => a+b,0) < 1) return fail();
  const filter = single(/\/Filter\s*\/([A-Za-z0-9]+)\b/g);
  if ((/\/Filter\b/.test(dictionary) && !filter) || (filter && filter[1] !== 'FlateDecode')) return fail();
  const indexMatch = single(/\/Index\s*\[([^\]]*)\]/g);
  if (/\/Index\b/.test(dictionary) && !indexMatch) return fail();
  const indexText = indexMatch?.[1]?.trim();
  if (indexMatch && !indexText) return fail();
  if (indexText && !/^\d+(?:\s+\d+)*$/.test(indexText)) return fail();
  const index = indexText ? indexText.split(/\s+/).map(Number) : [0,size];
  if (index.length % 2 || !index.length) return fail();
  let count = 0; const objectNumbers: number[] = [];
  for (let i = 0; i < index.length; i += 2) {
    const start = index[i]!, n = index[i+1]!;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(n) || n < 1 || start + n > size || count+n > 100000) return fail();
    for (let j=0;j<n;j++) objectNumbers.push(start+j);
    count += n;
  }
  if (new Set(objectNumbers).size !== objectNumbers.length) return fail();
  const expected = count * widths.reduce((a,b)=>a+b,0), start = offset + header[0].length, finish = start + length;
  const footer = /^(?:\r\n|\r|\n)endstream\s*endobj\s*startxref\s+(\d+)\s+%%EOF(?:\s|$)/.exec(text.slice(finish));
  if (expected > 2_000_000 || finish > end || !footer || Number(footer[1]) !== offset) return fail();
  const data = await decode(bytes.slice(start, finish), !!filter, expected, signal);
  if (data.length !== expected) return fail();
  let cursor = 0;
  const read = (width: number): number => { let value=0; for (let n=0;n<width;n++) value=value*256+data[cursor++]!; return value; };
  const entries = objectNumbers.map((object) => {
    const type = widths[0] === 0 ? 1 : read(widths[0]!); const position = read(widths[1]!), generation = read(widths[2]!);
    if (type !== 0 && type !== 1 && type !== 2) return fail();
    if (type === 1 && (position > offset || !text.slice(position).startsWith(`${object} ${generation} obj`))) return fail();
    return { object, generation:type === 2 ? 0 : generation, inUse:type !== 0, position, type, index:type === 2 ? generation : 0 };
  });
  const byObject = new Map(entries.map((entry) => [entry.object, entry]));
  const streams = new Map<number, { ids: number[]; offsets: number[]; length: number }>();
  let totalDecoded = 0;
  for (const entry of entries) {
    if (entry.type !== 2) continue;
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    let objectStream = streams.get(entry.position);
    if (!objectStream) {
      const container = byObject.get(entry.position);
      if (!container || container.type !== 1 || container.generation !== 0 || container.position >= offset) return fail();
      const objHeader = /^(\d+)\s+0\s+obj\s*<<((?:(?!<<|>>)[\s\S])*)>>\s*stream(?:\r\n|\r|\n)/.exec(text.slice(container.position, offset));
      if (!objHeader || Number(objHeader[1]) !== entry.position) return fail();
      const dict = objHeader[2]!;
      if (!/\/Type\s*\/ObjStm\b/.test(dict) || /\/(?:DecodeParms|DP|Encrypt)\b/.test(dict)) return fail();
      const only = (pattern: RegExp) => { const values = [...dict.matchAll(pattern)]; if (values.length !== 1) return fail(); return Number(values[0]![1]); };
      const n = only(/\/N\s+(\d+)\b/g), first = only(/\/First\s+(\d+)\b/g), size = only(/\/Length\s+(\d+)\b/g);
      if (/\/(?:N|First|Length)\s+\d+\s+\d+\s+R\b/.test(dict) || !Number.isSafeInteger(n) || n < 1 || n > 100000 || !Number.isSafeInteger(first) || !Number.isSafeInteger(size) || size < 1) return fail();
      const filters = [...dict.matchAll(/\/Filter\s*\/([A-Za-z0-9]+)\b/g)];
      if (filters.length > 1 || (/\/Filter\b/.test(dict) && !filters.length) || (filters.length && filters[0]![1] !== 'FlateDecode')) return fail();
      const from = container.position + objHeader[0].length, to = from + size;
      if (to > offset || !/^(?:\r\n|\r|\n)endstream\s*endobj\b/.test(text.slice(to, offset))) return fail();
      const data = await decode(bytes.slice(from, to), filters.length > 0, 40 * 1024 * 1024 - totalDecoded, signal);
      totalDecoded += data.length;
      if (first > data.length) return fail();
      const indexText = new TextDecoder('latin1').decode(data.subarray(0, first)).trim();
      if (!/^\d+(?:\s+\d+)*$/.test(indexText)) return fail();
      const index = indexText.split(/\s+/).map(Number);
      if (index.length !== n * 2 || index.some((value) => !Number.isSafeInteger(value))) return fail();
      const ids: number[] = [], offsets: number[] = [];
      for (let i = 0; i < index.length; i += 2) { ids.push(index[i]!); offsets.push(index[i+1]!); }
      if (new Set(ids).size !== ids.length || offsets.some((value, i) => value >= data.length-first || (i > 0 && value <= offsets[i-1]!))) return fail();
      objectStream = { ids, offsets, length: data.length-first }; streams.set(entry.position, objectStream);
    }
    if (entry.index >= objectStream.ids.length || objectStream.ids[entry.index] !== entry.object) return fail();
  }
  return { trailer: dictionary, entries };
}
