import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
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
  const { snap, run, setSnap, adapter } = useApp();
  const s = snap!;
  const fileRef = useRef<HTMLInputElement>(null);
  const [course, setCourse] = useState(s.settings.trackedCourseIds[0] ?? "");
  const [importing, setImporting] = useState(false);
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
    setImporting(true);
    try {
      const bytes = await f.arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const { result, snapshot } = await adapter.importDocument(course, f.name, setSnap, digest);
      setSnap(snapshot);
      if (!result.ok) toast.error(result.reason);
      else toast.success("Imported. Review the extracted items below.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed. Your saved data was not changed.");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <PageHeader title="Syllabus review" sub="Extraction here is mocked in demo mode. Nothing is read from your file's contents yet." />
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
                  {!isDismissed && <Button size="sm" variant="outline" disabled={!s.courses.some((c) => c.id === item.courseId)} onClick={() => { setCourse(item.courseId); setSelected({ id: item.id, title: item.title }); }}>Choose local file for this course</Button>}
                  <Button size="sm" variant="ghost" disabled={saving} onClick={() => void changeDismissal(item.id, !isDismissed)}>{isDismissed ? "Restore" : "Dismiss"}</Button>
                </div>
              </li>)}</ul></div>;
          })}
        </section>
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-2 text-lg font-semibold">Import a file</h2>
          <p className="mb-3 text-sm text-muted-foreground">Moodle file retrieval and real file validation/import are not yet available. Choosing a local file uses the existing mock import.</p>
          {selected && <p className="mb-3 text-sm">Selected resource: {selected.title}. Choose a local file below or cancel. <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Cancel</Button></p>}
          <div className="flex flex-wrap gap-2">
            <select aria-label="Course for import" className="h-9 rounded-md border bg-card px-2 text-sm" value={course} onChange={(e) => { setCourse(e.target.value); setSelected(null); }}>
              {s.courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            </select>
            <input ref={fileRef} type="file" aria-label="Syllabus file" aria-busy={importing} disabled={importing} className="text-sm" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
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
