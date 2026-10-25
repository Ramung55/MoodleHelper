import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AssessmentRow } from "@/components/mh/AssessmentRow";
import { AssessmentSheet } from "@/components/mh/AssessmentSheet";
import { DateInput } from "@/components/mh/DateInput";
import { EmptyState, PageHeader, TYPE_LABEL } from "@/components/mh/bits";
import type { AssessmentView } from "@/domain/assessments";
import { weekRange } from "@/domain/dates";
import type { AssessmentType, DateValue } from "@/domain/types";
import { useApp } from "@/lib/app-store";

type Search = { course?: string; type?: string; status?: string; id?: string; group?: string; week?: number };

export const Route = createFileRoute("/deadlines")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    course: typeof s.course === "string" ? s.course : undefined,
    type: typeof s.type === "string" ? s.type : undefined,
    status: typeof s.status === "string" ? s.status : undefined,
    id: typeof s.id === "string" ? s.id : undefined,
    group: typeof s.group === "string" ? s.group : undefined,
    week: s.week != null && !Number.isNaN(Number(s.week)) ? Number(s.week) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Deadlines — Moodle Helper" },
      { name: "description", content: "Every SDU assessment grouped by day or teaching week, with sources, submission status and your personal changes." },
      { property: "og:title", content: "Deadlines — Moodle Helper" },
      { property: "og:description", content: "Filter deadlines by course, type and action status." },
    ],
  }),
  component: Deadlines,
});

function matchStatus(v: AssessmentView, st?: string) {
  switch (st) {
    case "outstanding": return v.outstanding;
    case "attention": return v.needsAttention;
    case "done": return v.completed || v.a.submission?.status === "submitted";
    case "hidden": return v.hidden;
    default: return !v.hidden;
  }
}

function Deadlines() {
  const search = Route.useSearch();
  const nav = useNavigate({ from: "/deadlines" });
  const { snap, views } = useApp();
  const [adding, setAdding] = useState(false);
  const s = snap!;
  const set = (p: Partial<Search>) => nav({ search: (old) => ({ ...old, ...p }) });

  const list = views.filter(
    (v) => (!search.course || v.a.courseId === search.course) && (!search.type || v.a.type === search.type) && matchStatus(v, search.status) && (search.week == null || v.week === search.week),
  );
  const byWeek = search.group !== "day";
  const groups = new Map<string, AssessmentView[]>();
  for (const v of list) {
    let key: string;
    if (byWeek) key = v.week ? `Week ${v.week}` : "Unallocated";
    else key = v.date.kind === "exact" ? new Date(v.date.iso).toLocaleDateString("en-GB", { timeZone: s.settings.timezone, weekday: "long", day: "numeric", month: "long" }) : v.date.kind === "date" ? v.date.date : v.week ? `Week ${v.week} (no exact day)` : "Unallocated";
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }

  const sel = "h-9 rounded-md border bg-card px-2 text-sm";
  return (
    <>
      <PageHeader title="Deadlines" sub={`${list.length} shown`} actions={<Button onClick={() => setAdding(true)}><Plus className="mr-2 h-4 w-4" aria-hidden />Personal event</Button>} />
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filters">
        <select aria-label="Course" className={sel} value={search.course ?? ""} onChange={(e) => set({ course: e.target.value || undefined })}>
          <option value="">All courses</option>
          {s.courses.filter((c) => s.settings.trackedCourseIds.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
        <select aria-label="Type" className={sel} value={search.type ?? ""} onChange={(e) => set({ type: e.target.value || undefined })}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select aria-label="Status" className={sel} value={search.status ?? ""} onChange={(e) => set({ status: e.target.value || undefined })}>
          <option value="">All visible</option>
          <option value="outstanding">Outstanding</option>
          <option value="attention">Draft / resubmit</option>
          <option value="done">Done</option>
          <option value="hidden">Hidden</option>
        </select>
        <select aria-label="Group by" className={sel} value={byWeek ? "week" : "day"} onChange={(e) => set({ group: e.target.value })}>
          <option value="week">Group by week</option>
          <option value="day">Group by day</option>
        </select>
        {search.week != null && <Button variant="outline" size="sm" onClick={() => set({ week: undefined })}>Week {search.week} ✕</Button>}
      </div>

      {list.length === 0 ? (
        <EmptyState title="No assessments match these filters" />
      ) : (
        <div className="space-y-8">
          {[...groups].map(([k, items]) => {
            const wk = byWeek && k.startsWith("Week") ? weekRange(Number(k.slice(5)), s.settings.semesterStart) : null;
            return (
              <section key={k}>
                <h2 className="mb-2 text-lg font-semibold">{k}{wk && <span className="ml-2 text-sm font-normal text-muted-foreground">{wk.start} – {wk.end}</span>}</h2>
                <div className="space-y-2">{items.map((v) => <AssessmentRow key={v.a.id} v={v} onOpen={(id) => set({ id })} />)}</div>
              </section>
            );
          })}
        </div>
      )}
      <AssessmentSheet id={search.id ?? null} onClose={() => set({ id: undefined })} />
      <AddEvent open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddEvent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snap, run } = useApp();
  const [title, setTitle] = useState("");
  const [courseId, setCourse] = useState(snap!.settings.trackedCourseIds[0] ?? "");
  const [type, setType] = useState<AssessmentType>("other");
  const [date, setDate] = useState<DateValue | undefined>({ kind: "date", date: new Date().toISOString().slice(0, 10) });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New personal event</DialogTitle></DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim() || !date) return;
            const ok = await run((a) => a.addPersonalEvent({ title: title.trim(), courseId, type, date }));
            if (ok) {
              setTitle("");
              onClose();
            }
          }}
        >
          <div className="space-y-1"><Label htmlFor="pe-t">Title</Label><Input id="pe-t" required value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label htmlFor="pe-c">Course</Label>
              <select id="pe-c" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={courseId} onChange={(e) => setCourse(e.target.value)}>
                {snap!.courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
              </select>
            </div>
            <div className="space-y-1"><Label htmlFor="pe-y">Type</Label>
              <select id="pe-y" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={type} onChange={(e) => setType(e.target.value as AssessmentType)}>
                {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1"><Label>Date</Label><DateInput value={date} onChange={setDate} /></div>
          <DialogFooter><Button type="submit">Add event</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
