import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { LocalExtraction as Extraction } from "@/domain/local-extraction";
import { currentDataset, readLocalDocument, type LocalAssociation } from "@/services/local-documents";

/** Result and preview URLs live only for this visible, dataset-bound row. */
export function LocalExtraction({ document: association }: { document: LocalAssociation }) {
  const [result, setResult] = useState<Extraction>();
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<{ url: string; page: number }>();
  const controller = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const previewUrl = useRef<string | undefined>(undefined);
  const revoke = () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = undefined; };
  useEffect(() => {
    controller.current = undefined; setResult(undefined); setStatus(""); setPending(false); setPreview(undefined);
    return () => { generation.current++; controller.current?.abort(); revoke(); };
  }, [association.datasetId, association.courseId, association.digest]);
  const extract = async () => {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    const attempt = ++generation.current;
    const valid = () => attempt === generation.current && !abort.signal.aborted;
    setResult(undefined); setPending(true); setProgress(0); setStatus("Reading validated local document…");
    try {
      const file = await readLocalDocument(association, abort.signal);
      if (!valid()) return;
      const identity = { datasetId: association.datasetId, courseId: association.courseId, digest: association.digest, complete: true as const };
      let extracted: Extraction;
      if (/\.docx$/i.test(association.name)) {
        const { extractDocx } = await import("@/services/extract-docx"); if (!valid()) return;
        const blocks = await extractDocx(file, abort.signal, (block, total) => {
          if (valid()) { setProgress(total ? Math.round(block / total * 100) : 0); setStatus(`Extracting body block ${block} of ${total} locally…`); }
        });
        extracted = { ...identity, format: "docx", blocks };
      } else {
        const { extractPdf } = await import("@/services/extract-pdf"); if (!valid()) return;
        const pages = await extractPdf(file, abort.signal, (page, total) => {
          if (valid()) { setProgress(Math.round(page / total * 100)); setStatus(`Extracting page ${page} of ${total} locally…`); }
        });
        extracted = { ...identity, format: "pdf", pages };
      }
      if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reconnect before extracting.");
      if (!valid()) return;
      setResult(extracted);
      setStatus(extracted.format === "pdf" && extracted.pages.some((page) => page.status === "ocr_needed") ? "Local extraction finished. Image-only pages need OCR; no OCR has been performed." : "Local extraction complete. No assessments have been created.");
    } catch (error) {
      if (attempt === generation.current) { setResult(undefined); setStatus(abort.signal.aborted ? "Extraction cancelled. No complete result was saved." : `Extraction failed: ${error instanceof Error ? error.message : "Retry with a supported PDF."}`); }
    } finally { if (attempt === generation.current) { controller.current = undefined; setPending(false); } }
  };
  const inspect = async (page: number) => {
    const attempt = generation.current;
    try {
      const file = await readLocalDocument(association, new AbortController().signal);
      if (attempt !== generation.current) return;
      revoke(); const url = URL.createObjectURL(new Blob([file], { type: "application/pdf" }));
      previewUrl.current = url; setPreview({ url, page });
    } catch (error) { if (attempt === generation.current) setStatus(error instanceof Error ? error.message : "The original local document is unavailable."); }
  };
  return <div className="mt-2 space-y-2 break-normal">
    <Button size="sm" variant="outline" disabled={pending} onClick={() => void extract()}>Extract text</Button>
    {pending && <><Button size="sm" variant="ghost" onClick={() => { controller.current?.abort(); setResult(undefined); setStatus("Extraction cancelled. No complete result was saved."); }}>Cancel extraction</Button><Progress value={progress} aria-label={`Extracting text from ${association.name}`} /></>}
    {status && <p role="status">{status}</p>}
    {result && <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Session-local evidence · SHA-256 {result.digest}. Reopening requires extraction again.</p>
      {result.format === "docx" && <p className="text-xs text-muted-foreground">Original body paragraphs and table cells only; headers, footers and page layout are not extracted.</p>}
      {result.format === "pdf" ? result.pages.map((page) => <section key={page.page} className="rounded border p-2">
        <h3 className="font-semibold">Page {page.page} · {page.status === "ocr_needed" ? "OCR needed (image-only)" : page.status === "blank" ? "Blank page" : "Extracted text"}</h3>
        <Button size="sm" variant="ghost" onClick={() => void inspect(page.page)}>Inspect original page {page.page}</Button>
        {page.rows.map((row, index) => <details key={index}><summary className="cursor-pointer whitespace-pre-wrap">{row.text}</summary>
          <p className="text-xs">{association.name} · page {page.page} · SHA-256 {association.digest}</p>
          {row.items.map((item, i) => <p key={i} className="text-xs whitespace-pre-wrap">{item.text} · transform [{item.transform.join(", ")}] · width {item.width}, height {item.height}</p>)}
        </details>)}
      </section>) : result.blocks.map((block) => <section key={block.kind === "paragraph" ? block.paragraph.id : block.id} className="rounded border p-2">
        {block.kind === "paragraph" ? <details><summary className="cursor-pointer whitespace-pre-wrap">{block.paragraph.text || "Empty paragraph"}</summary>
          <p className="text-xs">{association.name} · {block.paragraph.id} · SHA-256 {association.digest}</p>
          <p className="whitespace-pre-wrap">{block.paragraph.text}</p>
        </details> : <><h3 className="font-semibold">Table {block.table} · body block {block.bodyBlock}</h3>
          {block.rows.map((row) => <div key={row.row} className="mt-2 rounded border p-2"><h4 className="text-xs font-semibold">Row {row.row}</h4>
            {row.cells.map((cell) => <div key={cell.cell}><p className="text-xs">Cell {cell.cell}</p>
              {cell.paragraphs.map((paragraph) => <details key={paragraph.id}><summary className="cursor-pointer whitespace-pre-wrap">{paragraph.text || "Empty paragraph"}</summary>
                <p className="text-xs">{association.name} · {paragraph.id} · SHA-256 {association.digest}</p><p className="whitespace-pre-wrap">{paragraph.text}</p>
              </details>)}
            </div>)}
          </div>)}
        </>}
      </section>)}
    </div>}
    <Dialog open={!!preview} onOpenChange={(open) => { if (!open) { revoke(); setPreview(undefined); } }}>
      <DialogContent className="h-[85vh] max-w-4xl"><DialogHeader><DialogTitle>{association.name} · original page {preview?.page}</DialogTitle></DialogHeader>
        {preview && <iframe className="h-full min-h-96 w-full" title={`Original ${association.name}, page ${preview.page}`} src={`${preview.url}#page=${preview.page}`} />}
      </DialogContent>
    </Dialog>
  </div>;
}
