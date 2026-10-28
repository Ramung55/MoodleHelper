/** Decode a deliberately restricted xref stream; reject unsupported filters and object streams. */
export async function readXrefStream(bytes: Uint8Array, text: string, offset: number, end: number, signal: AbortSignal): Promise<{ trailer: string; entries: { object: number; generation: number; inUse: boolean; position: number }[] }> {
  const fail = (): never => { throw new Error("Unsupported or corrupt PDF cross-reference stream."); };
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
  let data = bytes.slice(start, finish);
  if (filter) {
    if (typeof DecompressionStream === 'undefined') return fail();
    const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const chunks: Uint8Array[] = []; let n = 0;
    try {
      while (true) { if (signal.aborted) throw new DOMException('Cancelled','AbortError'); const r = await reader.read(); if (r.done) break; n += r.value.length; if (n > expected) { await reader.cancel(); return fail(); } chunks.push(r.value); }
    } catch (error) { if (signal.aborted) throw new DOMException('Cancelled','AbortError'); return fail(); }
    data = new Uint8Array(n); let at=0; for (const chunk of chunks) { data.set(chunk,at); at+=chunk.length; }
  }
  if (data.length !== expected) return fail();
  let cursor = 0;
  const read = (width: number): number => { let value=0; for (let n=0;n<width;n++) value=value*256+data[cursor++]!; return value; };
  const entries = objectNumbers.map((object) => {
    const type = widths[0] === 0 ? 1 : read(widths[0]!); const position = read(widths[1]!), generation = read(widths[2]!);
    if (type !== 0 && type !== 1) return fail();
    if (type === 1 && (position > offset || !text.slice(position).startsWith(`${object} ${generation} obj`))) return fail();
    return { object, generation, inUse:type === 1, position };
  });
  return { trailer: dictionary, entries };
}
