import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { PageHeader, TYPE_LABEL } from "@/components/mh/bits";
import { formatDate } from "@/domain/dates";
import { mapTeachingWeek } from "@/domain/teaching-weeks";
import { weightOf } from "@/domain/workload";
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
  const { snap, weeks, unallocated, currentWeek } = useApp();
  const s = snap!.settings;
  return (
    <>
      <PageHeader
        title="Weekly planner"
        sub={`Weights: exam ${s.weights.exam}, assignment ${s.weights.assignment}, quiz ${s.weights.quiz}. Warning above ${s.thresholds.maxOutstanding} outstanding or weighted ${s.thresholds.maxWeighted}. Scores are estimates, not study hours.`}
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {weeks.map((w) => {
          const r = mapTeachingWeek(w.week, s.teachingCalendar);
          if (!r.resolved) return null;
          return (
            <section key={w.week} aria-label={`Week ${w.week}`} className={cn("rounded-lg border bg-card p-4", w.overloaded && "border-warning ring-1 ring-warning", w.week === currentWeek && "outline outline-2 outline-primary")}>
              <div className="flex items-baseline justify-between">
                <Link to="/deadlines" search={{ week: w.week }} className="font-display text-lg font-semibold hover:underline">
                  Week {w.week}{w.week === currentWeek && " · now"}
                </Link>
                <span className="text-xs text-muted-foreground">{r.start.slice(5)} – {r.end.slice(5)}</span>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><dt className="text-xs text-muted-foreground">Total</dt><dd className="font-mono text-lg">{w.total}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Outstanding</dt><dd className="font-mono text-lg">{w.outstanding}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Weighted</dt><dd className="font-mono text-lg">{w.weighted}</dd></div>
              </dl>
              {w.overloaded && (
                <p className="mt-2 flex items-center gap-1 text-sm font-medium text-warning-foreground"><AlertTriangle className="h-4 w-4" aria-hidden />Overload warning</p>
              )}
              {w.items.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {w.items.map((v) => (
                    <li key={v.a.id} className={cn("flex justify-between gap-2", !v.outstanding && "text-muted-foreground line-through")}>
                      <span className="truncate">{v.title}</span>
                      <span className="shrink-0 text-xs">{TYPE_LABEL[v.a.type]} · {v.outstanding ? `+${weightOf(v, snap!.settings)}` : "done"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <section className="mt-8">
        <h2 className="mb-2 text-xl font-semibold">Unallocated</h2>
        <p className="mb-2 text-sm text-muted-foreground">Events without a resolvable date or outside the semester. They are not counted in any week.</p>
        <ul className="divide-y rounded-lg border bg-card">
          {unallocated.length === 0 && <li className="p-4 text-sm text-muted-foreground">Nothing unallocated.</li>}
          {unallocated.map((v) => (
            <li key={v.a.id} className="flex justify-between p-3 text-sm">
              <Link to="/deadlines" search={{ id: v.a.id }} className="font-medium hover:underline">{v.title}</Link>
              <span className="text-muted-foreground">{formatDate(v.date, s.timezone)}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
