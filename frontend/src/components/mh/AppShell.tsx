import { Link, Outlet } from "@tanstack/react-router";
import { AlertTriangle, BookOpen, CalendarDays, FileSearch, FolderOpen, LayoutDashboard, Menu, PlugZap, Settings, Bell } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/deadlines", label: "Deadlines", icon: CalendarDays },
  { to: "/planner", label: "Weekly planner", icon: BookOpen },
  { to: "/syllabus", label: "Syllabus review", icon: FileSearch },
  { to: "/materials", label: "Materials", icon: FolderOpen },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell() {
  const { snap, conn, error, adapter } = useApp();
  const [open, setOpen] = useState(false);
  const unread = snap?.alerts.filter((a) => !a.read).length ?? 0;
  const pending = snap?.candidates.filter((c) => c.status === "pending").length ?? 0;

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-card focus:p-2">
        Skip to content
      </a>
      <aside className={cn("bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:block md:h-screen", open ? "block" : "hidden")}>
        <div className="flex h-full flex-col p-4">
          <div className="mb-6 px-2">
            <p className="font-display text-xl font-semibold">Moodle Helper</p>
            <p className="text-xs opacity-70">SDU University · planning</p>
          </div>
          <nav aria-label="Main" className="flex flex-col gap-1">
            {NAV.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                onClick={() => setOpen(false)}
                activeOptions={{ exact: to === "/" }}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent"
                activeProps={{ className: "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" }}
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span className="flex-1">{label}</span>
                {to === "/alerts" && unread > 0 && <span className="rounded-full bg-sidebar-primary px-2 text-xs text-sidebar-primary-foreground">{unread}</span>}
                {to === "/syllabus" && pending > 0 && <span className="rounded-full bg-sidebar-primary px-2 text-xs text-sidebar-primary-foreground">{pending}</span>}
              </Link>
            ))}
          </nav>
          <div className="mt-auto rounded-md border border-sidebar-border p-3 text-xs">
            <p className="flex items-center gap-2 font-semibold">
              <PlugZap className="h-3.5 w-3.5" aria-hidden />
              {conn?.extensionDetected ? "Extension detected" : "Extension not connected"}
            </p>
            <p className="mt-1 opacity-75">{adapter.storage === "backend" ? "Data stays in your local backend." : "Data stays in this browser."}</p>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <div role="status" className="sticky top-0 z-30 flex items-center gap-3 border-b border-demo-foreground/20 bg-demo px-4 py-2 text-sm text-demo-foreground">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation">
            <Menu className="h-4 w-4" />
          </Button>
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <p>
            <strong>Demo data.</strong> {conn?.message ?? "Loading…"}
          </p>
        </div>
        <main id="main" className="mx-auto max-w-6xl p-4 md:p-8">
          {error ? (
            <div role="alert" className="rounded-lg border border-destructive bg-card p-6">
              <p className="font-semibold text-destructive">Local data could not be loaded</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          ) : !snap ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
