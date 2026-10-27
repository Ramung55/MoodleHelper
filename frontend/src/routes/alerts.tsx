import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/mh/bits";
import { useApp } from "@/lib/app-store";
import { resolveAssessmentId } from "@/domain/assessments";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — Moodle Helper" },
      { name: "description", content: "History of deadline reminders, busy-week warnings and deadline changes." },
      { property: "og:title", content: "Alerts — Moodle Helper" },
      { property: "og:description", content: "Every reminder and deadline change, in one history." },
    ],
  }),
  component: Alerts,
});

const KIND = { deadline: "Deadline", busy_week: "Busy week", change: "Deadline changed", sync: "Sync" } as const;

function Alerts() {
  const { snap, run } = useApp();
  const s = snap!;
  return (
    <>
      <PageHeader
        title="Alerts"
        sub="Browser notifications will come from the Chrome extension and only while Chrome is open. Week-only events never get exact-time reminders."
        actions={<Button variant="outline" disabled={!s.alerts.some((a) => !a.read)} onClick={() => run((a) => a.saveAlerts(s.alerts.map((x) => ({ ...x, read: true }))))}>Mark all read</Button>}
      />
      {s.alerts.length === 0 ? <EmptyState title="No alerts yet" /> : (
        <ul className="divide-y rounded-lg border bg-card">
          {s.alerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{KIND[a.kind]}{!a.read && <span className="ml-2 rounded bg-primary px-1.5 text-primary-foreground">new</span>}</p>
                <p className="text-sm">{a.message}</p>
              </div>
              {a.assessmentId && <Link to="/deadlines" search={{ id: resolveAssessmentId(s, a.assessmentId) }} className="text-sm text-primary underline">Open</Link>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
