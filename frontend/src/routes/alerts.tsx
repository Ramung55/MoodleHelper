import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/mh/bits";
import { useApp } from "@/lib/app-store";
import { resolveAssessmentId } from "@/domain/assessments";
import { alertDestination, deliveryLabel, describeAssertion, DELIVERY_DISABLED_TEXT } from "@/domain/alerts";
import type { Alert } from "@/domain/types";

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

function AlertLink({ a, resolve }: { a: Alert; resolve: (id: string) => string }) {
  const d = alertDestination(a, resolve);
  if (d.to === "/deadlines") return <Link to="/deadlines" search={{ id: d.id }} className="text-sm text-primary underline">Open</Link>;
  if (d.to === "/planner") return <Link to="/planner" className="text-sm text-primary underline">Open planner</Link>;
  return null;
}

function Alerts() {
  const { snap, run } = useApp();
  const s = snap!;
  const unread = s.alerts.filter((a) => !a.read).map((a) => a.id);
  const markRead = (ids: string[]) => run((a) => a.updateAlerts(ids, "read"));
  const denied = s.alerts.some((a) => a.delivery?.state === "denied");
  const resolve = (id: string) => resolveAssessmentId(s, id);
  return (
    <>
      <PageHeader
        title="Alerts"
        sub="Every alert is kept here. Browser notifications come from the Chrome extension and only while Chrome is open. Week-only events never get exact-time reminders."
        actions={<Button variant="outline" disabled={!unread.length} onClick={() => markRead(unread)}>Mark all read</Button>}
      />
      {denied && <p role="status" className="mb-4 rounded-lg border bg-card p-3 text-sm">{DELIVERY_DISABLED_TEXT} Allow notifications for Moodle Helper in Chrome or your system settings, then reconnect.</p>}
      {s.alerts.length === 0 ? <EmptyState title="No alerts yet" /> : (
        <ul className="divide-y rounded-lg border bg-card">
          {s.alerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{KIND[a.kind]}{!a.read && <span className="ml-2 rounded bg-primary px-1.5 text-primary-foreground">new</span>}</p>
                <p className="text-sm">{a.message}</p>
                {a.context?.change && (
                  <p className="text-xs text-muted-foreground">Previous: {describeAssertion(a.context.change.from)} · New: {describeAssertion(a.context.change.to)}{a.context.reason === "source_change_hidden" ? " · hidden item, no new reminder" : ""}</p>
                )}
                {deliveryLabel(a) && <p className="text-xs text-muted-foreground">{deliveryLabel(a)}</p>}
              </div>
              <div className="flex items-center gap-3">
                <AlertLink a={a} resolve={resolve} />
                {!a.read && <Button variant="ghost" size="sm" onClick={() => markRead([a.id])}>Mark read</Button>}
                <Button variant="ghost" size="sm" aria-label={`Delete alert: ${a.message}`} onClick={() => run((ad) => ad.updateAlerts([a.id], "delete"))}>Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
