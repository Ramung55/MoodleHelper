import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AssessmentRow } from "@/components/mh/AssessmentRow";
import { AssessmentSheet } from "@/components/mh/AssessmentSheet";
import { DateInput } from "@/components/mh/DateInput";
import { EmptyState, PageHeader, TYPE_LABEL } from "@/components/mh/bits";
import type { AssessmentView } from "@/domain/assessments";
import { dayGroup, matchStatus, STATUS_FILTERS, weekGroup, type Group } from "@/domain/deadline-display";
import type { AssessmentType, DateValue } from "@/domain/types";
import { useApp } from "@/lib/app-store";
import { personalDateError } from "@/domain/personal-event";

type Search = { course?: string; type?: string; status?: string; id?: string; group?: string; week?: number };

export function parseDeadlineSearch(s: Record<string, unknown>): Search {
  const week = typeof s.week === "number" || typeof s.week === "string" ? Number(s.week) : NaN;
  return {
    course: typeof s.course === "string" && s.course ? s.course : undefined,
    type: typeof s.type === "string" && Object.hasOwn(TYPE_LABEL, s.type) ? s.type : undefined,
    status: typeof s.status === "string" && (STATUS_FILTERS as readonly string[]).includes(s.status) ? s.status : undefined,
    id: typeof s.id === "string" && s.id ? s.id : undefined,
    group: s.group === "day" ? "day" : undefined,
    week: Number.isInteger(week) && week > 0 && week < 100 ? week : undefined,
  };
}

export const Route = createFileRoute("/deadlines")({
  validateSearch: parseDeadlineSearch,
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

const STATUS_LABEL: Record<string, string> = { outstanding: "Outstanding", attention: "Not submitted / draft / resubmit", done: "Done", hidden: "Hidden" };

function Deadlines() {
  const search = Route.useSearch();
  const nav = useNavigate({ from: "/deadlines" });
  const set = (p: Partial<Search>) => nav({ search: (old) => ({ ...old, ...p }) });
  return <DeadlineList search={search} set={set} />;
}

export function DeadlineList({ search, set }: { search: Search; set: (p: Partial<Search>) => void }) {
  const { snap, views } = useApp();
  const [adding, setAdding] = useState(false);
  const s = snap!;
  const tz = s.settings.timezone;

  // Course choices: tracked courses plus any course with a visible item (e.g. personal events on untracked courses).
  const courseIds = new Set([...s.settings.trackedCourseIds, ...views.map((v) => v.a.courseId)]);
  const courseChoices = s.courses.filter((c) => courseIds.has(c.id));
  const unknownCourse = !!search.course && !courseChoices.some((c) => c.id === search.course);
  const list = unknownCourse ? [] : views.filter(
    (v) => (!search.course || v.a.courseId === search.course) && (!search.type || v.a.type === search.type) && matchStatus(v, search.status) && (search.week == null || v.week === search.week),
  );
  const byWeek = search.group !== "day";
  const groups = new Map<string, { g: Group; items: AssessmentView[] }>();
  for (const v of list) {
    const g = byWeek ? weekGroup(v) : dayGroup(v, tz);
    const entry = groups.get(g.key) ?? { g, items: [] };
    entry.items.push(v);
    groups.set(g.key, entry);
  }
  const ordered = [...groups.values()].sort((a, b) => a.g.order - b.g.order);
  const filtered = !!(search.course || search.type || search.status || search.week != null);
  const visibleTotal = views.filter((v) => !v.hidden).length;
  const filterText = [
    search.course && (s.courses.find((c) => c.id === search.course)?.code ?? "Unavailable course"),
    search.type && TYPE_LABEL[search.type as keyof typeof TYPE_LABEL],
    search.status ? STATUS_LABEL[search.status] : "All visible",
    search.week != null && `Week ${search.week}`,
  ].filter(Boolean).join(" · ");
  const reset = () => set({ course: undefined, type: undefined, status: undefined, week: undefined });
  const now = new Date();

  const sel = "h-9 rounded-md border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <>
      <PageHeader title="Deadlines" sub={<span role="status">{list.length} shown · {filterText}</span>} actions={<Button onClick={() => setAdding(true)}><Plus className="mr-2 h-4 w-4" aria-hidden />Personal event</Button>} />
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filters">
        <select aria-label="Course" className={sel} value={unknownCourse ? "__unknown" : search.course ?? ""} onChange={(e) => set({ course: e.target.value || undefined })}>
          <option value="">All courses</option>
          {unknownCourse && <option value="__unknown" disabled>Unavailable course</option>}
          {courseChoices.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
        <select aria-label="Type" className={sel} value={search.type ?? ""} onChange={(e) => set({ type: e.target.value || undefined })}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select aria-label="Status" className={sel} value={search.status ?? ""} onChange={(e) => set({ status: e.target.value || undefined })}>
          <option value="">All visible</option>
          {STATUS_FILTERS.map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
        </select>
        <select aria-label="Group by" className={sel} value={byWeek ? "week" : "day"} onChange={(e) => set({ group: e.target.value === "day" ? "day" : undefined })}>
          <option value="week">Group by week</option>
          <option value="day">Group by day</option>
        </select>
        {search.week != null && <Button variant="outline" size="sm" aria-label={`Clear week ${search.week} filter`} onClick={() => set({ week: undefined })}>Week {search.week} ✕</Button>}
        {filtered && <Button variant="ghost" size="sm" onClick={reset}>Reset filters</Button>}
      </div>

      {list.length === 0 ? (
        unknownCourse ? (
          <EmptyState title="This course filter is not available">The course in the link is not tracked or no longer exists. <Button variant="link" className="h-auto p-0" onClick={reset}>Reset filters</Button></EmptyState>
        ) : !filtered && visibleTotal === 0 ? (
          <EmptyState title="No deadlines yet">Sync Moodle, import a syllabus or add a personal event.</EmptyState>
        ) : (
          <EmptyState title="No assessments match these filters"><Button variant="link" className="h-auto p-0" onClick={reset}>Reset filters</Button></EmptyState>
        )
      ) : (
        <div className="space-y-8">
          {ordered.map(({ g, items }) => (
            <section key={g.key} aria-label={`${g.label} (${items.length})`}>
              <h2 className="mb-2 text-lg font-semibold">{g.label}{g.detail && <span className="ml-2 text-sm font-normal text-muted-foreground">{g.detail}</span>}</h2>
              <div className="space-y-2">{items.map((v) => <AssessmentRow key={v.a.id} v={v} now={now} onOpen={(id) => set({ id })} />)}</div>
            </section>
          ))}
        </div>
      )}
      <AssessmentSheet id={search.id ?? null} onClose={() => set({ id: undefined })} />
      <AddEvent open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

export function AddEvent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snap, run } = useApp();
  const [title, setTitle] = useState("");
  const [courseId, setCourse] = useState(snap!.settings.trackedCourseIds[0] ?? "");
  const [type, setType] = useState<AssessmentType>("other");
  const [date, setDate] = useState<DateValue | undefined>({ kind: "date", date: new Date().toISOString().slice(0, 10) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy.current && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New personal event</DialogTitle></DialogHeader>
        <form
          noValidate
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy.current) return;
            const invalid: Record<string, string> = {};
            if (!title.trim()) invalid.title = "Enter a title.";
            if (!snap!.courses.some((c) => c.id === courseId)) invalid.course = "Choose an available course.";
            if (!Object.hasOwn(TYPE_LABEL, type)) invalid.type = "Choose an assessment type.";
            const dateError = personalDateError(date);
            if (dateError) invalid.date = dateError;
            setErrors(invalid);
            if (Object.keys(invalid).length || !date) return;
            busy.current = true; setPending(true);
            const ok = await run((a) => a.addPersonalEvent({ title: title.trim(), courseId, type, date }));
            busy.current = false; setPending(false);
            if (ok) {
              setTitle("");
              onClose();
            } else setErrors({ save: "The event was not saved. Your entries are retained; check the backend and retry." });
          }}
        >
          <fieldset disabled={pending} className="space-y-3">
          <div className="space-y-1"><Label htmlFor="pe-t">Title</Label><Input id="pe-t" required aria-invalid={!!errors.title} aria-describedby="pe-title-error" value={title} onChange={(e) => setTitle(e.target.value)} />{errors.title && <p id="pe-title-error" role="alert" className="text-sm text-destructive">{errors.title}</p>}</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label htmlFor="pe-c">Course</Label>
              <select id="pe-c" aria-invalid={!!errors.course} aria-describedby="pe-course-error" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={courseId} onChange={(e) => setCourse(e.target.value)}>
                <option value="">Choose a course</option>
                {snap!.courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
              </select>
              {errors.course && <p id="pe-course-error" role="alert" className="text-sm text-destructive">{errors.course}</p>}
            </div>
            <div className="space-y-1"><Label htmlFor="pe-y">Type</Label>
              <select id="pe-y" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={type} onChange={(e) => setType(e.target.value as AssessmentType)}>
                {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {errors.type && <p role="alert" className="text-sm text-destructive">{errors.type}</p>}
            </div>
          </div>
          <div className="space-y-1"><Label>Date ({snap!.settings.timezone})</Label><DateInput value={date} onChange={setDate} personalTimezone={snap!.settings.timezone} errorId="pe-date-error" />{errors.date && <p id="pe-date-error" role="alert" className="text-sm text-destructive">{errors.date}</p>}</div>
          {errors.save && <p role="alert" className="text-sm text-destructive">{errors.save}</p>}
          <DialogFooter><Button type="submit">{pending ? "Saving…" : "Add event"}</Button></DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
