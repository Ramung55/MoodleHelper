import type { DocxBlock, DocxLocation, DocxParagraph } from "@/domain/local-extraction";
import { readValidatedDocx } from "./validate-docx";

const unsupported = (): never => { throw new Error("This DOCX contains unsupported body structure (such as nested tables, tracked changes, fields or embedded objects). Export a simple DOCX with paragraphs and tables."); };
const MAX_ITEMS = 100_000, MAX_CHARACTERS = 1_000_000;

/** Native bounded XML extraction; visible link text only, no relationship resolution. */
export async function extractDocx(blob: Blob, signal: AbortSignal, progress: (block: number, total: number) => void): Promise<DocxBlock[]> {
  const check = () => { if (signal.aborted) throw new DOMException("Extraction cancelled", "AbortError"); };
  check(); if (blob.size > 20 * 1024 * 1024) throw new Error("DOCX extraction supports files up to 20 MiB.");
  const bytes = await blob.arrayBuffer(); check();
  const xml = await readValidatedDocx(bytes, signal); check();
  const namespace = xml.documentElement.namespaceURI!;
  const bodies = xml.getElementsByTagNameNS(namespace, "body");
  if (bodies.length !== 1) return unsupported();
  const body = bodies[0]!;
  // Structures with text outside ordinary body paragraphs need their own semantics.
  const forbidden = ["altChunk", "txbxContent", "drawing", "object", "ins", "del", "moveFrom", "moveTo", "instrText", "fldSimple", "footnoteReference", "endnoteReference", "sdt", "subDoc"];
  if (forbidden.some((name) => body.getElementsByTagNameNS(namespace, name).length)) return unsupported();
  let items = 0, characters = 0;
  const budget = async () => {
    if (++items > MAX_ITEMS) throw new Error("The DOCX exceeds the 100,000-item extraction limit. Split it and retry.");
    if (items % 128 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    check();
  };
  const paragraph = async (element: Element, location: DocxLocation): Promise<DocxParagraph> => {
    let text = "";
    const visit = async (node: Element): Promise<void> => {
      await budget();
      if (node.namespaceURI !== namespace) return unsupported();
      if (node.localName === "t") text += node.textContent ?? "";
      else if (node.localName === "tab") text += "\t";
      else if (node.localName === "br" || node.localName === "cr") text += "\n";
      else if (["p", "r", "hyperlink", "smartTag"].includes(node.localName)) { for (const child of Array.from(node.children)) await visit(child); }
      else if (!["pPr", "rPr", "bookmarkStart", "bookmarkEnd", "proofErr", "lastRenderedPageBreak"].includes(node.localName)) return unsupported();
      if (text.length + characters > MAX_CHARACTERS) throw new Error("The DOCX exceeds the one-million-character extraction limit. Split it and retry.");
    };
    await visit(element); characters += text.length;
    const key = location.table ? `table${location.table}/row${location.row}/cell${location.cell}/p${location.paragraph}` : `p${location.paragraph}`;
    return { id: `word/document.xml/body${location.bodyBlock}/${key}`, text, location };
  };
  const blocks: DocxBlock[] = []; const children = Array.from(body.children);
  if (children.length > MAX_ITEMS) throw new Error("The DOCX has too many body blocks. Split it and retry.");
  let bodyBlock = 0, paragraphIndex = 0, tableIndex = 0;
  progress(0, children.length);
  for (let index = 0; index < children.length; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0)); check(); const child = children[index]!;
    if (child.namespaceURI !== namespace) return unsupported();
    if (child.localName === "sectPr") { progress(index + 1, children.length); continue; }
    bodyBlock++;
    if (child.localName === "p") blocks.push({ kind: "paragraph", paragraph: await paragraph(child, { part: "word/document.xml", bodyBlock, paragraph: ++paragraphIndex }) });
    else if (child.localName === "tbl") {
      const table = ++tableIndex; const rows: Extract<DocxBlock, { kind: "table" }>["rows"] = [];
      for (const row of Array.from(child.children)) {
        await budget();
        if (["tblPr", "tblGrid"].includes(row.localName)) continue;
        if (row.namespaceURI !== namespace || row.localName !== "tr") return unsupported();
        const cells: typeof rows[number]["cells"] = [];
        for (const cell of Array.from(row.children)) {
          await budget(); if (cell.localName === "trPr") continue;
          if (cell.namespaceURI !== namespace || cell.localName !== "tc") return unsupported();
          const paragraphs: DocxParagraph[] = [];
          for (const part of Array.from(cell.children)) {
            if (part.localName === "tcPr") continue;
            if (part.namespaceURI !== namespace || part.localName !== "p") return unsupported();
            paragraphs.push(await paragraph(part, { part: "word/document.xml", bodyBlock, table, row: rows.length + 1, cell: cells.length + 1, paragraph: paragraphs.length + 1 }));
          }
          cells.push({ cell: cells.length + 1, paragraphs });
        }
        rows.push({ row: rows.length + 1, cells });
      }
      blocks.push({ kind: "table", id: `word/document.xml/body${bodyBlock}/table${table}`, table, bodyBlock, rows });
    } else return unsupported();
    progress(index + 1, children.length); check();
  }
  if (!blocks.some((block) => block.kind === "paragraph" ? block.paragraph.text.trim() : block.rows.some((row) => row.cells.some((cell) => cell.paragraphs.some((p) => p.text.trim()))))) throw new Error("This DOCX has no supported body text. Export a text-based DOCX with paragraphs or tables.");
  return blocks;
}
