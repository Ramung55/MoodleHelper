import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { DateInput } from "@/components/mh/DateInput";
import { ReconciliationReview } from "@/components/mh/ReconciliationReview";
import { SyllabusRevisionReview } from "@/components/mh/SyllabusRevisionReview";
import { CourseTag, EmptyState, PageHeader, TYPE_LABEL } from "@/components/mh/bits";
import { rankSyllabusSuggestions } from "@/domain/syllabus-suggestions";
import { formatDate } from "@/domain/dates";
import type { DateValue, ExtractionCandidate } from "@/domain/types";
import { useApp } from "@/lib/app-store";
import { currentDataset, listLocalDocuments, saveLocalDocument, type LocalAssociation } from "@/services/local-documents";
import { validateDocx } from "@/services/validate-docx";

const LOCAL_FILE_LIMIT = 20 * 1024 * 1024;

export const Route = createFileRoute("/syllabus")({
  head: () => ({
    meta: [
      { title: "Syllabus review — Moodle Helper" },
      { name: "description", content: "Import SDU syllabi (PDF/DOCX), see extraction evidence and confirm, correct or reject uncertain dates." },
      { property: "og:title", content: "Syllabus review — Moodle Helper" },
      { property: "og:description", content: "Uncertain syllabus dates never become deadlines without your review." },
    ],
  }),
  component: Syllabus,
});

export function Syllabus() {
  const { snap, run } = useApp();
  const s = snap!;
  const fileRef = useRef<HTMLInputElement>(null);
  const [course, setCourse] = useState("");
  const [importing, setImporting] = useState(false);
  const [localDocuments, setLocalDocuments] = useState<LocalAssociation[]>([]);
  const [localStatus, setLocalStatus] = useState("");
  const [retryFile, setRetryFile] = useState<File>();
  const cancellation = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      setLocalDocuments([]);
      void currentDataset().then(listLocalDocuments).then((rows) => { if (active) setLocalDocuments(rows); }).catch(() => { if (active) setLocalStatus("Local files are unavailable. Check the backend and browser storage, then retry."); });
    };
    refresh(); window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); cancellation.current?.abort(); };
  }, []);
  const pending = s.candidates.filter((c) => c.status === "pending");
  const decided = s.candidates.filter((c) => c.status !== "pending");
  const suggestions = rankSyllabusSuggestions(s);
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const dismissed = new Set(s.dismissedSyllabusSuggestions ?? []);
  const changeDismissal = async (id: string, value: boolean) => {
    setSaving(true);
    try { await run((a) => a.setSyllabusSuggestionDismissal(id, value)); }
    finally { setSaving(false); }
  };

  const onFile = async (f?: File) => {
    if (!f) return;
    const controller = new AbortController(); cancellation.current = controller;
    setRetryFile(f);
    setImporting(true);
    setLocalStatus("Queued for local validation.");
    try {
      if (!s.courses.some((c) => c.id === course)) throw new Error("Choose an existing course first.");
      if (f.size > LOCAL_FILE_LIMIT) throw new Error("The file exceeds the 20 MiB limit. Choose a smaller file.");
      if (/\.doc$/i.test(f.name)) throw new Error("Legacy .doc is unsupported. Export it as DOCX.");
      if (/\.(gdoc|gsheet|gslides)$/i.test(f.name)) throw new Error("Export the Google document as PDF or DOCX and select the exported file.");
      if (/\.pdf$/i.test(f.name)) throw new Error("PDF validation is not yet available. Select a DOCX file instead.");
      if (!/\.docx$/i.test(f.name)) throw new Error("Choose a DOCX file. Google Docs must first be exported.");
      const datasetId = await currentDataset();
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      setLocalStatus("Parsing: validating and hashing locally; no extraction is performed.");
      const bytes = await f.arrayBuffer();
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      await validateDocx(bytes, controller.signal);
      if (!globalThis.crypto?.subtle) throw new Error("Secure hashing is unavailable in this browser. Use a secure local origin and retry.");
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      let rows = await listLocalDocuments(datasetId);
      const others = rows.filter((row) => row.digest === digest && row.courseId !== course).map((row) => row.courseId);
      const confirmed = others;
      if (others.length && !rows.some((row) => row.digest === digest && row.courseId === course)) {
        const labels = others.map((id) => s.courses.find((c) => c.id === id)?.code ?? id).join(", ");
        if (!window.confirm(`This document is already associated with ${labels}. Also associate it with ${s.courses.find((c) => c.id === course)?.code}?`)) throw new DOMException("Cancelled", "AbortError");
      }
      const result = await saveLocalDocument({ datasetId, courseId: course, digest, name: f.name, size: f.size, source: selected?.title ?? "Local selection", createdAt: new Date().toISOString() }, f, confirmed, controller.signal);
      if (result === "confirmation-required") throw new Error("Another course association was added. Retry to review it.");
      cancellation.current = null;
      setLocalStatus(result === "duplicate" ? "Already associated with this course." : "Complete: validated and stored locally. Extraction has not been performed.");
      setRetryFile(undefined);
      try { rows = await listLocalDocuments(datasetId); setLocalDocuments(rows); }
      catch { setLocalDocuments([]); setLocalStatus("Saved locally, but the dataset changed or is unavailable. Reconnect to view it."); }
    } catch (e) {
      setLocalStatus(e instanceof DOMException && e.name === "AbortError" ? "Cancelled. No association was added." : `Failed: ${e instanceof Error ? e.message : "Local import failed. Retry."}`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <PageHeader title="Syllabus review" sub="Local documents stay in this browser. Extraction is not yet available; existing demo candidates are mocked." />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-2 text-lg font-semibold">Suggested from Moodle</h2>
          {suggestions.length === 0 && <p className="text-sm">No collected file suggestions yet.</p>}
          {[false, true].map((isDismissed) => {
            const rows = suggestions.filter((item) => dismissed.has(item.id) === isDismissed);
            return <div key={String(isDismissed)}>{isDismissed && <h3 className="mt-4 font-semibold">Dismissed suggestions</h3>}
              {isDismissed && rows.length === 0 && <p className="text-sm">No dismissed suggestions.</p>}
              <ul className="space-y-2 text-sm">{rows.map((item) => <li key={item.id} className="rounded border p-2">
                <p className="font-medium">{item.title} {s.courses.find((c) => c.id === item.courseId)?.code ?? "Unknown course"}</p>
                <p>{item.type === "unknown" ? "Unknown type" : item.type} · {item.reason}{item.uncertain && " · Uncertain"}</p>
                {item.link ? <a href={item.link} target="_blank" rel="noreferrer" className="underline">Original link</a> : <span>Link unavailable</span>}
                <div className="mt-2 flex gap-2">
                  {!isDismissed && <Button size="sm" variant="outline" disabled={importing || !s.courses.some((c) => c.id === item.courseId)} onClick={() => { setCourse(item.courseId); setSelected({ id: item.id, title: item.title }); }}>Choose local file for this course</Button>}
                  <Button size="sm" variant="ghost" disabled={saving} onClick={() => void changeDismissal(item.id, !isDismissed)}>{isDismissed ? "Restore" : "Dismiss"}</Button>
                </div>
              </li>)}</ul></div>;
          })}
        </section>
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-2 text-lg font-semibold">Import a file</h2>
          <p className="mb-3 text-sm text-muted-foreground">Select a local DOCX up to 20 MiB. PDF validation is not yet available. Files stay in this browser profile and origin; clearing browser storage removes them.</p>
          {selected && <p className="mb-3 text-sm">Selected resource: {selected.title}. Choose a local file below or cancel. <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Cancel</Button></p>}
          <div className="flex flex-wrap gap-2">
            <select aria-label="Course for import" disabled={importing} className="h-9 rounded-md border bg-card px-2 text-sm" value={course} onChange={(e) => { setCourse(e.target.value); setSelected(null); }}>
              <option value="">Choose a course</option>
              {s.courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            </select>
            <input ref={fileRef} type="file" aria-label="Syllabus file" aria-busy={importing} disabled={importing} className="text-sm" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          {localStatus && <p role="status" className="mt-2 text-sm">{localStatus}</p>}
          {importing && <Button size="sm" variant="outline" onClick={() => cancellation.current?.abort()}>Cancel import</Button>}
          {!importing && retryFile && <Button size="sm" variant="outline" onClick={() => void onFile(retryFile)}>Retry selected file</Button>}
          <ul className="mt-3 space-y-2">{localDocuments.map((d) => <li key={`${d.courseId}:${d.digest}`} className="text-sm break-all">{d.name} · {s.courses.find((c) => c.id === d.courseId)?.code ?? d.courseId} · {d.source} · {d.size} bytes · SHA-256 {d.digest} · Complete (local validation only)</li>)}</ul>
          <ul className="mt-4 space-y-2">
            {s.documents.map((d) => (
              <li key={d.id} className="text-sm">
                <div className="flex justify-between"><span className="font-medium">{d.name}</span><span className="text-xs text-muted-foreground">{d.status.replace("_", " ")}{d.mocked && " · mock"}</span></div>
                {d.status === "extracting" && <Progress value={d.progress} aria-label={`Extracting ${d.name}`} />}
                {d.error && <p className="text-xs text-destructive">{d.error}</p>}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <ReconciliationReview />
      <SyllabusRevisionReview />
      <section className="mt-8">
        <h2 className="mb-3 text-xl font-semibold">Needs review ({pending.length})</h2>
        {pending.length === 0 ? <EmptyState title="Review queue is empty" /> : (
          <div className="space-y-3">{pending.map((c) => <CandidateCard key={c.id} c={c} onDecide={(d) => run((a) => a.review(c.id, d))} />)}</div>
        )}
      </section>
      {decided.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Decided</h2>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {decided.map((c) => (
              <li key={c.id} className="flex justify-between p-3"><span>{c.title} — {formatDate(c.date, s.settings.timezone)}</span><span className="capitalize text-muted-foreground">{c.status === "auto" ? "added automatically (clear evidence)" : c.status}</span></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function CandidateCard({ c, onDecide }: { c: ExtractionCandidate; onDecide: (d: Parameters<ReturnType<typeof useApp>["adapter"]["review"]>[1]) => void }) {
  const { snap, views } = useApp();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [date, setDate] = useState<DateValue | undefined>(c.date);
  const match = views.find((v) => v.a.id === c.matchAssessmentId);
  return (
    <article className="rounded-lg border border-warning bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{c.title} <span className="text-xs uppercase text-muted-foreground">{TYPE_LABEL[c.type]} · {c.language.toUpperCase()}</span></p>
          <CourseTag course={snap!.courses.find((x) => x.id === c.courseId)} />
        </div>
        <span className="rounded bg-warning px-2 py-0.5 text-xs text-warning-foreground">Confidence {Math.round(c.confidence * 100)}%</span>
      </div>
      <blockquote className="mt-3 border-l-2 pl-3 text-sm italic">“{c.excerpt}”</blockquote>
      <p className="text-xs text-muted-foreground">{c.location}</p>
      <p className="mt-2 text-sm">Proposed: <strong>{formatDate(c.date, snap!.settings.timezone)}</strong> from “{c.rawDateText}”</p>
      {c.reason && <p className="text-sm text-muted-foreground">Why review: {c.reason}</p>}
      {match && <p className="text-sm">Possible related item: <strong>{match.title}</strong>. Moodle and syllabus matches are reviewed separately.</p>}
      {editing && (
        <div className="mt-3 space-y-2">
          <input aria-label="Corrected title" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} />
          <DateInput value={date} onChange={setDate} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <Button size="sm" onClick={() => date && onDecide({ kind: "correct", title, date, type: c.type })}>Save correction</Button>
        ) : (
          <>
            <Button size="sm" onClick={() => onDecide({ kind: "confirm" })}>Confirm</Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Correct</Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => onDecide({ kind: "reject" })}>Reject</Button>
      </div>
    </article>
  );
}
