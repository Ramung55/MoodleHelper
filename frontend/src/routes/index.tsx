import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/mh/bits";
import { formatDate } from "@/domain/dates";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { MockProgress } from "@/components/mh/MockProgress";
import { fullSyncFreshness, type FullSyncAttestation } from "../../../shared/src/full-sync";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — Moodle Helper" },
      { name: "description", content: "Upcoming SDU assessments, this week's outstanding work, workload warnings and sync status." },
      { property: "og:title", content: "Overview — Moodle Helper" },
      { property: "og:description", content: "Your SDU deadlines, workload and syllabus review queue in one place." },
    ],
  }),
  component: Overview,
});

function Card({ to, search, title, value, tone, children }: { to: string; search?: Record<string, string>; title: string; value: string | number; tone?: "warn" | "bad"; children?: React.ReactNode }) {
  return (
    <Link
      to={to}
      search={search as never}
      className={cn("block rounded-lg border bg-card p-5 transition-shadow hover:shadow-md", tone === "warn" && "border-warning", tone === "bad" && "border-destructive")}
    >
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 font-display text-4xl font-semibold text-foreground">{value}</p>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </Link>
  );
}

export function Overview({fullSyncAttestation}:{fullSyncAttestation?:FullSyncAttestation} = {}) {
  const { snap, views, weeks, currentWeek, syncAll, syncing } = useApp();
  const s = snap!;
  const tz = s.settings.timezone;
  const now = Date.now();
  const visible = views.filter((v) => !v.hidden);
  const upcoming = visible.filter((v) => v.outstanding && v.sort >= now && v.sort < now + 14 * 86_400_000).slice(0, 5);
  const thisWeek = weeks.find((w) => w.week === currentWeek);
  const overloaded = weeks.filter((w) => w.overloaded && (currentWeek == null || w.week >= currentWeek));
  const review = s.candidates.filter((c) => c.status === "pending").length;
  const attention = visible.filter((v) => v.needsAttention);

  return (
    <>
      <PageHeader
        title="Overview"
        sub={currentWeek ? `Teaching week ${currentWeek} of ${weeks.length}` : s.settings.teachingCalendar ? "Today is outside a configured teaching week" : "Teaching calendar is not configured"}
        actions={
          <Button onClick={syncAll} disabled={syncing}>
            <RefreshCw className={cn("mr-2 h-4 w-4", syncing && "animate-spin")} aria-hidden />
            {syncing ? "Syncing…" : "Sync all courses (demo)"}
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card to="/deadlines" search={{ status: "outstanding" }} title="Outstanding this week" value={thisWeek?.outstanding ?? 0}>
          {thisWeek ? `${thisWeek.total} total · weighted ${thisWeek.weighted}` : "—"}
        </Card>
        <Card to="/planner" title="Busy weeks ahead" value={overloaded.length} tone={overloaded.length ? "warn" : undefined}>
          {overloaded.length ? overloaded.map((w) => `Week ${w.week}`).join(", ") : "No overload warnings"}
        </Card>
        <Card to="/syllabus" title="Needs syllabus review" value={review} tone={review ? "warn" : undefined}>
          Uncertain dates are never confirmed automatically
        </Card>
        <Card to="/deadlines" search={{ status: "attention" }} title="Drafts & resubmissions" value={attention.length} tone={attention.length ? "bad" : undefined}>
          {attention.map((a) => a.title).join(" · ") || "Nothing pending in Moodle"}
        </Card>
        <Card to="/settings" title="Successful full sync" value={fullSyncFreshness(s.settings.trackedCourseIds,fullSyncAttestation,s.settings.timezone).startsWith('Synthetic example') ? 'Example' : 'Never'}>
          {fullSyncFreshness(s.settings.trackedCourseIds,fullSyncAttestation,s.settings.timezone)}
        </Card>
        <Card to="/alerts" title="Unread alerts" value={s.alerts.filter((a) => !a.read).length} />
      </div>

      <MockProgress snapshot={s} fullSyncAttestation={fullSyncAttestation} />

      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Next two weeks</h2>
          <Link to="/deadlines" className="text-sm text-primary underline">All deadlines</Link>
        </div>
        <ul className="divide-y rounded-lg border bg-card">
          {upcoming.length === 0 && <li className="p-4 text-sm text-muted-foreground">Nothing outstanding in the next two weeks.</li>}
          {upcoming.map((v) => (
            <li key={v.a.id}>
              <Link to="/deadlines" search={{ id: v.a.id } as never} className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50">
                <span className="font-medium">{v.title}</span>
                <span className="font-mono text-sm">{formatDate(v.date, tz)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
