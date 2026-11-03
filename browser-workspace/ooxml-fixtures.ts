/**
 * #85 SYNTHETIC ZIP/OOXML fixtures, assembled byte by byte in test code (stored, method 0).
 * No binary Office file is committed and none of this is live SDU evidence. The options
 * break one ZIP rule at a time so the container check can be exercised step by step.
 */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type ZipOptions = {
  /** Bytes placed before the first local header. */
  prefix?: Uint8Array;
  /** Entry names that get general-purpose bit 0 (encrypted) in their central and local headers. */
  encrypt?: string[];
  /** Entry names whose central local-header offset points at junk instead of their local header. */
  junkLocal?: string[];
  /** Entry names whose local header carries another name than the central one. */
  renameLocal?: Record<string, string>;
  /** EOCD field overrides. */
  eocd?: Partial<{ disk: number; cdDisk: number; onDisk: number; total: number; cdSize: number; cdOffset: number }>;
  /** EOCD comment (counted by the EOCD comment length). */
  comment?: Uint8Array;
  /** Bytes appended after the EOCD (so it no longer ends the body). */
  trailing?: Uint8Array;
};

const enc = new TextEncoder();
const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** A stored ZIP with the given entry names, each holding a few bytes of text. */
export function zip(names: string[], o: ZipOptions = {}): Uint8Array {
  const out: number[] = [...(o.prefix ?? [])];
  const central: number[] = [];
  for (const name of names) {
    const nameBytes = enc.encode(name);
    const localName = enc.encode(o.renameLocal?.[name] ?? name);
    const data = enc.encode(`<x>${name}</x>`);
    const flags = o.encrypt?.includes(name) ? 1 : 0;
    const local = out.length;
    out.push(...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(data.length), ...u32(data.length), ...u16(localName.length), ...u16(0), ...localName, ...data);
    const pointer = o.junkLocal?.includes(name) ? local + 8 : local;
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(pointer), ...nameBytes);
  }
  const cdOffset = out.length;
  out.push(...central);
  const e = { disk: 0, cdDisk: 0, onDisk: names.length, total: names.length, cdSize: central.length, cdOffset, ...o.eocd };
  const comment = o.comment ?? new Uint8Array();
  out.push(...u32(0x06054b50), ...u16(e.disk), ...u16(e.cdDisk), ...u16(e.onDisk), ...u16(e.total), ...u32(e.cdSize), ...u32(e.cdOffset),
    ...u16(comment.length), ...comment, ...(o.trailing ?? []));
  return new Uint8Array(out);
}

export const DOCX_NAMES = ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "docProps/core.xml"];
export const PPTX_NAMES = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/slides/slide1.xml"];
export const docx = (o: ZipOptions = {}) => zip(DOCX_NAMES, o);
export const pptx = (o: ZipOptions = {}) => zip(PPTX_NAMES, o);
/** An EPUB-shaped ZIP: a `mimetype` entry and no `[Content_Types].xml`. */
export const epub = () => zip(["mimetype", "META-INF/container.xml", "OEBPS/content.opf"]);
