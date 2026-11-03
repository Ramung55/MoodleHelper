import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/domain/dates";
import type { SyllabusRevisionPreview } from "@/domain/types";
import { useApp } from "@/lib/app-store";
import { toast } from "sonner";

export function SyllabusRevisionReview() {
  const { snap, adapter, run } = useApp();
  const [candidateId, setCandidate] = useState("");
  const [sourceId, setSource] = useState("");
  const [preview, setPreview] = useState<SyllabusRevisionPreview>();
  if (!snap) return null;
  const members = new Set((snap.syllabusRevisions ?? []).flatMap((s) => s.links.map((l) => l.candidateId)));
  const candidates = snap.candidates.filter((c) => ["confirmed", "corrected", "auto"].includes(c.status) && c.date.kind !== "unknown" && !members.has(c.id));
  const candidate = candidates.find((c) => c.id === candidateId);
  const sources = (snap.reconciliation?.sources ?? []).filter((s) => s.kind === "syllabus" && s.courseId === candidate?.courseId && s.candidateId !== candidateId && !members.has(s.candidateId ?? ""));
  async function inspect() {
    try { setPreview(await adapter.previewSyllabusRevision(sourceId, candidateId)); }
    catch (error) { setPreview(undefined); toast.error(error instanceof Error ? error.message : "Could not review this revision."); }
  }
  return <section className="mt-8 rounded-lg border bg-card p-4 space-y-3">
    <h2 className="text-lg font-semibold">Link a reviewed syllabus revision</h2>
    <p className="text-sm text-muted-foreground">Extraction is mocked. Your confirmation records an association between these documents.</p>
    <label className="block text-sm">Reviewed candidate
      <select aria-label="Reviewed candidate for revision" value={candidateId} onChange={(e) => {setCandidate(e.target.value);setSource("");setPreview(undefined);}} className="ml-2 rounded border bg-card p-1">
        <option value="">Choose candidate</option>{candidates.map((c) => <option key={c.id} value={c.id}>{c.title} — {snap.documents.find((d) => d.id === c.documentId)?.name}</option>)}
      </select>
    </label>
    <label className="block text-sm">Existing syllabus source
      <select aria-label="Existing syllabus source" value={sourceId} onChange={(e) => {setSource(e.target.value);setPreview(undefined);}} className="ml-2 rounded border bg-card p-1">
        <option value="">Choose source</option>{sources.map((s) => <option key={s.id} value={s.id}>{snap.candidates.find((c) => c.id === s.candidateId)?.title} — {snap.documents.find((d) => d.id === s.documentId)?.name}</option>)}
      </select>
    </label>
    <Button size="sm" disabled={!sourceId || !candidateId} onClick={() => void inspect()}>Review revision</Button>
    {preview && <div className="space-y-3">
      {([['Current source',preview.target],['Reviewed revision',preview.incoming]] as const).map(([label,e]) => <article key={label} className="rounded border p-3 text-sm">
        <p className="font-semibold">{label}: {e.title}</p><p>{e.documentName}{e.mocked && ' · mock extraction'}</p>
        <p>{formatDate(e.date,snap.settings.timezone)}{e.date.kind === 'exact' && ` (${e.date.iso}, ${e.date.tz})`}</p>
        <blockquote>“{e.excerpt}”</blockquote><p>{e.location} · Reviewed {e.observedAt}</p>
      </article>)}
      <Button size="sm" onClick={() => void run((a) => a.confirmSyllabusRevision({sourceId:preview.sourceId,candidateId:preview.candidateId,revision:preview.revision,fingerprint:preview.fingerprint})).then((ok) => {if(ok)setPreview(undefined);})}>Confirm revision link</Button>
    </div>}
  </section>;
}
