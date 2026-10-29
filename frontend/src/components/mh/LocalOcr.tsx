import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { currentDataset, readLocalDocument, type LocalAssociation } from "@/services/local-documents";
import { DEFAULT_OCR_LIMITS, type OcrJob, type OcrProgress } from "@/services/ocr-pdf";

export function LocalOcr({ document: association, onInspect }: { document: LocalAssociation; onInspect: (page: number) => Promise<void> }) {
  const [selection, setSelection] = useState(""); const [language, setLanguage] = useState<OcrJob["language"]>("eng+rus");
  const [limits, setLimits] = useState({ ...DEFAULT_OCR_LIMITS });
  const [pending, setPending] = useState(false); const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<OcrProgress>(); const [result, setResult] = useState<OcrJob>();
  const generation = useRef(0), controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => { controller.current = undefined; setProgress(undefined); setResult(undefined); setPending(false); setMessage(""); return () => { generation.current++; controller.current?.abort(); }; }, [association.datasetId, association.courseId, association.digest]);
  const start = async () => {
    if (controller.current) return;
    if (!/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(selection)) { setMessage("Enter selected original page numbers separated by commas, such as 1, 3."); return; }
    const pages = selection.split(",").map((value) => Number(value.trim()));
    const abort = new AbortController(); controller.current = abort; const attempt = ++generation.current;
    const current = () => attempt === generation.current;
    setPending(true); setMessage("Opening selected local pages for OCR…"); setProgress(undefined); setResult(undefined);
    try {
      const file = await readLocalDocument(association, abort.signal);
      if (!current() || abort.signal.aborted) return;
      const { runOcr } = await import("@/services/ocr-pdf");
      if (!current() || abort.signal.aborted) return;
      const job = await runOcr(file, pages, language, limits, abort.signal, (state) => { if (current() && !abort.signal.aborted) setProgress(state); });
      if (await currentDataset() !== association.datasetId) throw new Error("The dataset changed. Reload before OCR.");
      if (!current()) return;
      setResult(job); setMessage(job.status === "complete" ? "Selected-page OCR finished. Text remains unconfirmed; inspect the original before using dates." : job.status === "cancelled" ? "OCR cancelled. Partial results are incomplete." : "OCR is incomplete. Review failed pages and retry them explicitly.");
    } catch (error) { if (current()) { setResult(undefined); setProgress(undefined); setMessage(abort.signal.aborted ? "OCR cancelled. No complete result was saved." : `OCR could not start. ${error instanceof Error ? error.message : "Check installed local assets and retry."}`); } }
    finally { if (current()) { controller.current = undefined; setPending(false); } }
  };
  const rows = result?.pages ?? progress?.pages ?? [];
  return <details className="rounded border p-2"><summary className="cursor-pointer font-medium">OCR selected scanned PDF pages</summary>
    <p className="my-2 text-xs">Explicit local OCR only. Defaults: 20 selected pages/job, 120 DPI, 60 seconds/page (including rendering), 8 million pixels/page and 100,000 characters/page. A loaded locally running application needs no AI/internet; local assets must be installed first. Cold-start offline caching is not provided.</p>
    <fieldset disabled={pending} className="space-y-2">
      <label className="block text-xs">Original pages (comma-separated)<Input aria-label="OCR original pages" value={selection} onChange={(event) => setSelection(event.target.value)} placeholder="1, 3" /></label>
      <label className="block text-xs">OCR language<select aria-label="OCR language" value={language} onChange={(event) => setLanguage(event.target.value as OcrJob["language"])} className="ml-2 rounded border bg-card p-1"><option value="eng">English</option><option value="rus">Russian</option><option value="eng+rus">English and Russian</option></select></label>
      <div className="flex flex-wrap gap-2">{([['maxPages','Pages/job',1,50],['dpi','Render DPI',72,180],['millisecondsPerPage','Milliseconds/page',1000,120000],['maxPixels','Pixels/page',1,8000000]] as const).map(([key,label,min,max]) => <label key={key} className="text-xs">{label}<Input type="number" aria-label={`OCR ${label}`} min={min} max={max} value={limits[key]} onChange={(event) => setLimits((value) => ({ ...value, [key]: Number(event.target.value) }))} /></label>)}</div>
      <Button size="sm" variant="outline" onClick={() => void start()}>Start selected-page OCR</Button>
    </fieldset>
    {pending && <Button size="sm" variant="ghost" onClick={() => { controller.current?.abort(); setMessage("OCR cancelled. Any partial results remain incomplete."); }}>Cancel OCR</Button>}
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
    {progress && <div className="mt-2 text-xs"><p>Selected {progress.total} · completed {progress.completed} · failed {progress.failed} · remaining {progress.remaining}{progress.currentPage && ` · original page ${progress.currentPage}`}</p><Progress aria-label="OCR current page progress" value={Math.round(progress.currentProgress * 100)} /></div>}
    {rows.map((page) => <section key={page.page} className="mt-2 rounded border p-2 text-xs"><p className="font-semibold">{association.name} · original page {page.page} · {page.status === "review_needed" ? "Low quality/no reliable text — review needed" : page.status}{result?.complete !== true && " · incomplete job"}</p><p>Local Tesseract.js 7.0.0 OCR · SHA-256 {association.digest} · {result?.dpi ?? limits.dpi} DPI · confidence {Math.round(page.confidence)} (not date confidence)</p><Button size="sm" variant="ghost" onClick={() => void onInspect(page.page)}>Inspect OCR original page {page.page}</Button>{page.error && <p>{page.error}</p>}<pre className="whitespace-pre-wrap">{page.text}</pre>{page.regions.map((region,index) => <p key={index} className="whitespace-pre-wrap">{region.text} · pixel region [{region.bounds.join(", ")}]</p>)}</section>)}
  </details>;
}
