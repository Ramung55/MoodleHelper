import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Details, PageHeader } from "@/components/mh/bits";
import { formatDate, friendlyInstant } from "@/domain/dates";
import { dueState } from "@/domain/deadline-display";
import { useApp } from "@/lib/app-store";
import { lastFullSyncAt, syncButtonLabel, syncSummaryLine } from "@/domain/live-sync";
import { cn } from "@/lib/utils";
import { MockProgress } from "@/components/mh/MockProgress";
import { syncFreshness, type FullSyncAttestation } from "../../../shared/src/full-sync";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — Moodle Helper" },
      {
        name: "description",
        content:
          "Upcoming SDU assessments, this week's outstanding work, workload warnings and sync status.",
      },
      { property: "og:title", content: "Overview — Moodle Helper" },
      {
        property: "og:description",
        content: "Your SDU deadlines, workload and syllabus review queue in one place.",
      },
    ],
  }),
  component: Overview,
});

const CARD = "block rounded-lg border bg-card p-5";

function Card({
  to,
  search,
  hash,
  title,
  value,
  tone,
  children,
}: {
  to: string;
  search?: Record<string, string>;
  hash?: string;
  title: string;
  value: string | number;
  tone?: "warn" | "bad" | undefined;
  children?: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      search={search as never}
      {...(hash ? { hash } : {})}
      className={cn(
        CARD,
        "transition-shadow hover:shadow-md",
        tone === "warn" && "border-warning",
        tone === "bad" && "border-destructive",
      )}
    >
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 font-display text-4xl font-semibold text-foreground">{value}</p>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </Link>
  );
}

const SET_CALENDAR = "Set your teaching calendar to count weeks.";

export function Overview({
  fullSyncAttestation,
}: { fullSyncAttestation?: FullSyncAttestation } = {}) {
  const { snap, conn, views, weeks, workloadError, currentWeek, syncAll, syncing, detecting } =
    useApp();
  const s = snap!;
  // Only the real (non-demo) dataset can show a real full sync; an unknown connection counts as demo.
  const realData = !!conn && conn.state !== "demo";
  const freshness = syncFreshness(s, realData, fullSyncAttestation);
  const tz = s.settings.timezone;
  const now = Date.now();
  const nowDate = new Date(now);
  const visible = views.filter((v) => !v.hidden);
  const upcoming = visible
    .filter((v) => v.outstanding && v.sort >= now && v.sort < now + 14 * 86_400_000)
    .slice(0, 5);
  const overdue = visible.filter((v) => {
    const d = dueState(v, tz, nowDate);
    return !!d && d.kind !== "invalid";
  }).length;
  const thisWeek = weeks.find((w) => w.week === currentWeek);
  const overloaded = weeks.filter(
    (w) => w.overloaded && (currentWeek == null || w.week >= currentWeek),
  );
  const review = s.candidates.filter((c) => c.status === "pending").length;
  const attention = visible.filter((v) => v.needsAttention);
  const calendarMissing = !s.settings.teachingCalendar;
  const submissionsObserved = views.some((v) => !!v.a.submission);
  const setupDone = !!s.settings.trackedCourseIds.length && !calendarMissing;
  const fullAt =
    freshness.value === "Never" || freshness.value === "Example"
      ? undefined
      : lastFullSyncAt(s.settings.trackedCourseIds, s.sync);
  const syncValue =
    fullAt === undefined
      ? freshness.value === "Example"
        ? "Example"
        : "Never"
      : friendlyInstant(fullAt, tz);
  // Busy weeks need a resolved calendar; without one the counters show a dash, never a misleading 0 (#87 O2).
  const weeksUnknown = calendarMissing && !workloadError;

  return (
    <>
      <PageHeader
        title="Overview"
        sub={
          calendarMissing ? (
            <>
              Teaching calendar not set ·{" "}
              <Link to="/settings" hash="teaching-calendar" className="text-primary underline">
                Set calendar
              </Link>
            </>
          ) : currentWeek ? (
            `Teaching week ${currentWeek}`
          ) : (
            "Today is outside the teaching weeks"
          )
        }
        actions={
          <Button onClick={syncAll} disabled={syncing || detecting}>
            <RefreshCw className={cn("mr-2 h-4 w-4", syncing && "animate-spin")} aria-hidden />
            {syncButtonLabel(conn, syncing, detecting)}
          </Button>
        }
      />
      {!setupDone && (
        <p className="mb-4 text-sm text-muted-foreground">
          Finish setup to choose your courses and semester calendar.{" "}
          <Link to="/setup" className="text-primary underline">
            Open setup checklist
          </Link>
        </p>
      )}
      {workloadError && (
        <p role="alert" className="mb-4 text-destructive">
          {workloadError}{" "}
          <Link to="/settings" className="underline">
            Review workload weights
          </Link>
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {overdue > 0 && (
          <Card
            to="/deadlines"
            search={{ status: "outstanding" }}
            title="Overdue"
            value={overdue}
            tone="bad"
          >
            Past their due date and still outstanding.
          </Card>
        )}
        {weeksUnknown ? (
          <>
            <Card to="/settings" hash="teaching-calendar" title="Outstanding this week" value="—">
              {SET_CALENDAR}
            </Card>
            <Card to="/settings" hash="teaching-calendar" title="Busy weeks ahead" value="—">
              {SET_CALENDAR}
            </Card>
          </>
        ) : (
          <>
            <Card
              to="/deadlines"
              search={{ status: "outstanding" }}
              title="Outstanding this week"
              value={workloadError ? "Unavailable" : (thisWeek?.outstanding ?? 0)}
            >
              {thisWeek
                ? `${thisWeek.total} due this week · estimate ${thisWeek.weighted} (not study hours)`
                : "Today is outside the teaching weeks."}
            </Card>
            <Card
              to="/planner"
              title="Busy weeks ahead"
              value={workloadError ? "Unavailable" : overloaded.length}
              tone={overloaded.length ? "warn" : undefined}
            >
              {workloadError
                ? "Workload weights need attention."
                : overloaded.length
                  ? overloaded.map((w) => `Week ${w.week}`).join(", ")
                  : "No busy weeks ahead."}
            </Card>
          </>
        )}
        <Card
          to="/syllabus"
          title="Needs syllabus review"
          value={review}
          tone={review ? "warn" : undefined}
        >
          {review ? "Confirm the dates found in your syllabus." : "Nothing to review."}
        </Card>
        <Card
          to="/deadlines"
          search={{ status: "attention" }}
          title="Needs submission"
          value={submissionsObserved ? attention.length : "—"}
          tone={attention.length ? "bad" : undefined}
        >
          {!submissionsObserved
            ? "Moodle submission status isn't collected yet."
            : attention.map((a) => a.title).join(" · ") || "Nothing left to submit."}
        </Card>
        <section aria-label="Last full sync" className={CARD}>
          <p className="text-sm text-muted-foreground">Last full sync</p>
          <p className="mt-1 font-display text-4xl font-semibold text-foreground">{syncValue}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {syncSummaryLine(s.settings.trackedCourseIds, s.sync)}
          </p>
          <Details>
            <p>{freshness.fullSync}</p>
            <p>{freshness.pageRefresh}</p>
            {freshness.courses.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>
              <Link to="/settings" className="text-primary underline">
                Sync settings
              </Link>
            </p>
          </Details>
        </section>
        <Card to="/alerts" title="Unread alerts" value={s.alerts.filter((a) => !a.read).length} />
      </div>

      {/* #87 O4: demo dataset only; the real dataset reaches it under Settings → Connection & sync → Details. */}
      {!realData && (
        <MockProgress snapshot={s} realData={realData} fullSyncAttestation={fullSyncAttestation} />
      )}

      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Next two weeks</h2>
          <Link to="/deadlines" className="text-sm text-primary underline">
            All deadlines
          </Link>
        </div>
        <ul className="divide-y rounded-lg border bg-card">
          {upcoming.length === 0 && (
            <li className="p-4 text-sm text-muted-foreground">
              Nothing due in the next two weeks.
            </li>
          )}
          {upcoming.map((v) => (
            <li key={v.a.id}>
              <Link
                to="/deadlines"
                search={{ id: v.a.id } as never}
                className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50"
              >
                <span className="min-w-0 break-words font-medium">{v.title}</span>
                <span className="shrink-0 text-sm">{formatDate(v.date, tz)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
