import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, BookOpen, CalendarDays, FileSearch, FolderOpen, LayoutDashboard, Menu, PlugZap, Settings, Bell } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { EmptyState, PageHeader } from "./bits";
import type { ShellState } from "@/lib/shell-preview";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/deadlines", label: "Deadlines", icon: CalendarDays },
  { to: "/planner", label: "Weekly planner", icon: BookOpen },
  { to: "/syllabus", label: "Syllabus review", icon: FileSearch },
  { to: "/materials", label: "Materials", icon: FolderOpen },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

/** Preview never mounts the provider, an adapter, or real route controls. */
export function AppShell({ preview }: { preview?: ShellState }) {
  return preview ? <PreviewShell state={preview} /> : <ConnectedShell />;
}

function PreviewShell({ state }: { state: ShellState }) {
  const { pathname } = useLocation();
  const from = NAV.find((item) => item.to === pathname)?.to ?? "/";
  const navigate = useNavigate({ from });
  return <ShellFrame state={state} preview notice="Development preview. No student data is loaded or saved."
    connection="Preview — no connections" storage="Preview uses no saved data."
    retry={() => void navigate({ search: () => ({ shellState: "empty" as const }), replace: true })}
    exit={() => void navigate({ search: () => ({}), replace: true })} />;
}

function ConnectedShell() {
  const { snap, conn, error, adapter, retryLoad } = useApp();
  return <ShellFrame state={error ? "error" : !snap ? "loading" : undefined}
    error={error ?? undefined} retry={retryLoad}
    notice={conn?.message ?? "Connecting to local backend…"}
    connection={conn?.extensionDetected ? "Extension detected" : "Extension not connected"}
    storage={adapter.storage === "backend" ? "Data stays in your local backend." : "Data stays in this browser."}
    unread={snap?.alerts.filter((a) => !a.read).length}
    pending={snap?.candidates.filter((c) => c.status === "pending").length}>
    <Outlet />
  </ShellFrame>;
}

function ShellFrame({ state, preview, notice, connection, storage, retry, exit, error, unread = 0, pending = 0, children }: {
  state?: ShellState | undefined; preview?: boolean; notice: string; connection: string; storage: string;
  retry: () => void; exit?: () => void; error?: string | undefined; unread?: number | undefined; pending?: number | undefined; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const page = NAV.find((item) => item.to === pathname);
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      setOpen(false);
      main.current?.focus();
      previousPath.current = pathname;
    }
  }, [pathname]);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <a href="#main" onClick={() => main.current?.focus()} className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-card focus:p-2">
        Skip to content
      </a>
      <aside id="main-navigation" className={cn("bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:block md:h-screen", open ? "block" : "hidden")}>
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
                search={(previous) => preview ? previous : {}}
                onClick={() => { setOpen(false); main.current?.focus(); }}
                activeOptions={{ exact: true, includeSearch: false }}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent"
                activeProps={{ "aria-current": "page", className: "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" }}
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
              {connection}
            </p>
            <p className="mt-1 opacity-75">{storage}</p>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <div className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-demo-foreground/20 bg-demo px-4 py-2 text-sm text-demo-foreground">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open} aria-controls="main-navigation">
            <Menu className="h-4 w-4" />
          </Button>
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <p role="status">{notice}</p>
          {preview && <Button variant="outline" size="sm" onClick={exit}>Exit preview</Button>}
        </div>
        <main id="main" ref={main} tabIndex={-1} aria-label={page?.label ?? "Page content"} className="mx-auto max-w-6xl p-4 md:p-8">
          {page && state && <PageHeader title={page.label} />}
          {page && state === "error" ? (
            <div role="alert" className="rounded-lg border border-destructive bg-card p-6">
              <p className="font-semibold text-destructive">{preview ? "Preview data could not be loaded" : "Local data could not be loaded"}</p>
              <p className="mb-4 text-sm text-muted-foreground">{error ?? "This is a simulated error. Retry to view the empty preview."}</p>
              <Button onClick={retry}>Retry</Button>
            </div>
          ) : page && state === "empty" ? <EmptyState title={`No ${page.label.toLowerCase()} data yet`}>No data is present in this preview. Exit preview to load your local backend data.</EmptyState> : page && state === "loading" ? (
            <div role="status" className="space-y-3" aria-busy="true" aria-label={`Loading ${page.label}`}>
              <p className="sr-only">Loading {page.label}…</p>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : (
            children ?? <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
