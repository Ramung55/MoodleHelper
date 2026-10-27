import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { DateInput } from "@/components/mh/DateInput";
import { ReconciliationReview } from "@/components/mh/ReconciliationReview";
import { CourseTag, EmptyState, PageHeader, TYPE_LABEL } from "@/components/mh/bits";
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

function Syllabus() {
  const { snap, run, setSnap, adapter } = useApp();
  const s = snap!;
  const fileRef = useRef<HTMLInputElement>(null);
  const [course, setCourse] = useState(s.settings.trackedCourseIds[0] ?? "");
  const [importing, setImporting] = useState(false);
  const pending = s.candidates.filter((c) => c.status === "pending");
  const decided = s.candidates.filter((c) => c.status !== "pending");
  const suggestions = s.materials.filter((m) => m.syllabusSuggestion);

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
          <ul className="space-y-2 text-sm">
            {suggestions.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span><span className="font-medium">{m.title}</span> <CourseTag course={s.courses.find((c) => c.id === m.courseId)} className="ml-1" /></span>
                <Button size="sm" variant="outline" onClick={() => toast.info("Fetching Moodle files requires the Chrome extension.")}>Import</Button>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-2 text-lg font-semibold">Import a file</h2>
          <p className="mb-3 text-sm text-muted-foreground">Text-based PDF or DOCX, English or Russian. Scanned pages need local OCR (not available yet).</p>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Course for import" className="h-9 rounded-md border bg-card px-2 text-sm" value={course} onChange={(e) => setCourse(e.target.value)}>
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
