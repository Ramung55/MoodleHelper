import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { PageHeader, TYPE_LABEL } from "@/components/mh/bits";
import { formatDate } from "@/domain/dates";
import { mapTeachingWeek } from "@/domain/teaching-weeks";
import { weightOf } from "@/domain/workload";
import { busyReasons, contributionReason, precisionLabel, unallocatedReason } from "@/domain/weekly-overview";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/planner")({
  head: () => ({
    meta: [
      { title: "Weekly planner — Moodle Helper" },
      { name: "description", content: "Assessment count and estimated weighted workload for each SDU teaching week, with overload warnings." },
      { property: "og:title", content: "Weekly planner — Moodle Helper" },
      { property: "og:description", content: "See busy weeks coming before they arrive." },
    ],
  }),
  component: Planner,
});

function Planner() {
  const { snap, weeks, unallocated, unallocatedSummary, workloadError, currentWeek } = useApp();
  const s = snap!.settings;
  const calendarMissing = !s.teachingCalendar;
  const resolvedWeeks = weeks.filter((w) => mapTeachingWeek(w.week, s.teachingCalendar).resolved);
  return (
    <>
      <PageHeader
        title="Weekly planner"
        sub={`Weights: exam ${s.weights.exam}, assignment ${s.weights.assignment}, quiz ${s.weights.quiz}, other ${s.weights.other}. Warning above ${s.thresholds.maxOutstanding} outstanding or weighted estimate ${s.thresholds.maxWeighted}. Weighted scores are estimates, not study hours.`}
      />
      {workloadError && <p role="alert" className="mb-4 text-destructive">{workloadError} <Link to="/settings" className="underline">Review workload weights</Link></p>}
      {!workloadError && calendarMissing && <p role="status" className="mb-4 rounded-lg border bg-card p-4 text-sm">Teaching calendar not configured. No teaching weeks can be resolved, so every assessment is listed as unallocated. <Link to="/settings" className="underline">Configure the teaching calendar in Settings</Link></p>}
      {!workloadError && !calendarMissing && resolvedWeeks.length === 0 && <p role="status" className="mb-4 rounded-lg border bg-card p-4 text-sm">Teaching calendar unresolved: no teaching weeks could be mapped. <Link to="/settings" className="underline">Review the teaching calendar in Settings</Link></p>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {resolvedWeeks.map((w) => {
          const r = mapTeachingWeek(w.week, s.teachingCalendar);
          if (!r.resolved) return null;
          const reasons = busyReasons(w, s.thresholds);
          return (
            <section key={w.week} aria-labelledby={`week-${w.week}-h`} className={cn("rounded-lg border bg-card p-4", reasons.length > 0 && "border-warning ring-1 ring-warning", w.week === currentWeek && "outline outline-2 outline-primary")}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <h2 id={`week-${w.week}-h`} className="font-display text-lg font-semibold">
                  <Link to="/deadlines" search={{ week: w.week }} className="hover:underline">Week {w.week}{w.week === currentWeek && " · now"}</Link>
                </h2>
                <span className="text-xs text-muted-foreground">{r.start} – {r.end}</span>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><dt className="text-xs text-muted-foreground">Total</dt><dd className="font-mono text-lg">{w.total}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Outstanding</dt><dd className="font-mono text-lg">{w.outstanding}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Weighted estimate</dt><dd className="font-mono text-lg">{w.weighted}</dd></div>
              </dl>
              {reasons.length > 0 && (
                <p className="mt-2 flex items-start gap-1 text-sm font-medium text-warning-foreground"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Busy week warning: {reasons.join("; ")}.</p>
              )}
              {w.items.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No assessments this week.</p> : (
                <ul className="mt-2 space-y-1 text-sm" aria-label={`Week ${w.week} contributors`}>
                  {w.items.map((v) => (
                    <li key={v.a.id} className={cn(!v.outstanding && "text-muted-foreground")}>
                      <div className="flex justify-between gap-2">
                        <Link to="/deadlines" search={{ id: v.a.id }} className={cn("break-words hover:underline", !v.outstanding && "line-through")}>{v.title}</Link>
                        <span className="shrink-0 text-xs">{TYPE_LABEL[v.a.type]} · {v.outstanding ? `+${weightOf(v, s)} est.` : "done"}</span>
                      </div>
                      <span className="block text-xs text-muted-foreground">{contributionReason(v)} Date: {precisionLabel(v)}.</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <section className="mt-8" aria-labelledby="unallocated-h">
        <h2 id="unallocated-h" className="mb-2 text-xl font-semibold">Unallocated</h2>
        {unallocatedSummary && <p className="mb-2 text-sm">{unallocatedSummary.total} total · {unallocatedSummary.outstanding} outstanding · weighted estimate {unallocatedSummary.weighted}</p>}
        <p className="mb-2 text-sm text-muted-foreground">Missing or unresolved teaching calendar, undated events, breaks and dates outside the semester are not counted in a teaching week.</p>
        <ul className="divide-y rounded-lg border bg-card">
          {unallocated.length === 0 && <li className="p-4 text-sm text-muted-foreground">{workloadError ? "Totals unavailable until the workload error is resolved." : "Nothing unallocated."}</li>}
          {unallocated.map((v) => (
            <li key={v.a.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm">
              <span><Link to="/deadlines" search={{ id: v.a.id }} className="font-medium break-words hover:underline">{v.title}</Link>
                <span className="block text-xs text-muted-foreground">{TYPE_LABEL[v.a.type]} · {v.outstanding ? `outstanding, +${weightOf(v, s)} est.` : "not outstanding"}</span></span>
              <span className="text-muted-foreground">{v.date.kind === "unknown" ? "Date unknown" : formatDate(v.date, s.timezone)} <span className="block text-xs">Precision: {precisionLabel(v)} · Reason: {unallocatedReason(v)}</span></span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
