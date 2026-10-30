import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CourseTag, EmptyState, PageHeader } from "@/components/mh/bits";
import { useApp } from "@/lib/app-store";
import { LIBRARY_TYPES, TYPE_LABEL, attemptReasons, buildMaterialLibrary, filterLibrary, latestMaterialAttempts, type LibraryItem, type LibraryType } from "@/domain/material-library";

export const Route = createFileRoute("/materials")({
  head: () => ({
    meta: [
      { title: "Materials — Moodle Helper" },
      { name: "description", content: "SDU Moodle course resources organised by course and section, with search and file-type filters." },
      { property: "og:title", content: "Materials — Moodle Helper" },
      { property: "og:description", content: "Find lecture slides, readings and files across your courses." },
    ],
  }),
  component: Materials,
});

const fmt = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
};

function folderListing(i: LibraryItem): string {
  const l = i.listing ?? {};
  if (l.scope === "reference_only" || l.coverage === "none" || (!l.scope && !l.coverage)) return "Folder contents not inspected — this is not a complete inventory";
  if (l.coverage === "partial") return "Folder listing incomplete — some contents may be missing";
  return "Listed contents as observed (only supplied entries)";
}

export function Materials() {
  const { snap, adapter, setSnap, error, retryLoad } = useApp();
  const s = snap!;
  const [q, setQ] = useState("");
  const [type, setType] = useState<"" | LibraryType>("");
  const all = useMemo(() => buildMaterialLibrary(s), [s]);
  const attempts = useMemo(() => latestMaterialAttempts(s), [s]);
  const list = filterLibrary(all, { q, type });
  const byKey = new Map(all.map((i) => [i.key, i]));
  const tracked = s.courses.filter((c) => s.settings.trackedCourseIds.includes(c.id));
  const byCourse = tracked.map((c) => ({ c, items: list.filter((m) => m.courseId === c.id) })).filter((g) => g.items.length);
  const receipts = (s.collection?.refreshes ?? []).filter((r) => r.collector === "material");
  const synthetic = receipts.some((r) => r.evidenceMode === "synthetic");
  const incomplete = [...attempts.values()].filter((r) => r.outcome !== "ok");
  const filtered = !!q.trim() || !!type;

  return (
    <>
      <PageHeader title="Materials" sub="Links are indexed only. Files are downloaded only when you ask. Moodle resources may require you to be logged in." />
      {error && <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">Couldn't refresh materials: {error}. Showing previously loaded data, which may be stale. <Button size="sm" variant="outline" className="ml-2" onClick={retryLoad}>Retry</Button></p>}
      {synthetic && <p className="mb-4 rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">Some materials come from labeled synthetic collection fixtures — compatibility with live SDU Moodle is not verified.</p>}
      {incomplete.length > 0 && <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">The latest material collection for {incomplete.length} course{incomplete.length > 1 ? "s" : ""} did not complete. Previously indexed resources are kept and may be incomplete.</p>}
      <p className="mb-2 text-xs text-muted-foreground">Opening a resource takes you to Moodle (or the linked site) in a new tab. You may need to log in to Moodle there; your login is never sent to this dashboard.</p>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Input aria-label="Search titles" placeholder="Search titles (English or Russian)…" className="max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="File type" className="h-9 rounded-md border bg-card px-2 text-sm" value={type} onChange={(e) => setType(e.target.value as "" | LibraryType)}>
          <option value="">All types</option>
          {LIBRARY_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <span className="text-xs text-muted-foreground" aria-live="polite">Showing {list.length} of {all.length}</span>
        {filtered && <Button size="sm" variant="ghost" onClick={() => { setQ(""); setType(""); }}>Reset filters</Button>}
      </div>
      {tracked.length === 0 ? <EmptyState title="No courses selected">Choose courses in Settings to see their materials.</EmptyState>
        : all.length === 0 ? <EmptyState title="No materials indexed yet">No course resources have been collected for your selected courses.</EmptyState>
        : byCourse.length === 0 ? <EmptyState title="No materials match">Try a different search or type, or reset the filters.</EmptyState> : (
        <div className="space-y-6">
          {byCourse.map(({ c, items }) => {
            const sections = [...new Set(items.map((i) => i.section))].sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
            return (
            <section key={c.id} className="rounded-lg border bg-card p-4">
              <CourseTag course={c} className="text-sm" />
              {sections.map((sec) => (
                <div key={sec ?? "\u0000unknown"} className="mt-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">{sec ?? "Section unknown"}</h3>
                  <ul className="mt-1 divide-y">
                    {items.filter((i) => i.section === sec).map((m) => {
                      const attempt = m.sourceCourseId ? attempts.get(m.sourceCourseId) : undefined;
                      const failed = attempt && attempt.outcome !== "ok" ? attempt : undefined;
                      const children = m.children.map((k) => byKey.get(k)).filter((x): x is LibraryItem => !!x);
                      const seen = fmt(m.lastObservedAt);
                      return (
                      <li key={m.key} data-testid="material-row" className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div className="min-w-0">
                          {m.breadcrumb.length > 0 && <div className="text-xs text-muted-foreground">In folder: {m.breadcrumb.join(" › ")}</div>}
                          <span className={m.titleKnown ? "font-medium" : "font-medium italic text-muted-foreground"}>{m.title}</span>
                          <span className="ml-2 rounded bg-muted px-1.5 text-xs">{TYPE_LABEL[m.type]}</span>
                          {m.mimeType && <span className="ml-2 text-xs text-muted-foreground">{m.mimeType}</span>}
                          {m.provenance === "legacy" && <span className="ml-2 text-xs text-muted-foreground">Legacy index entry</span>}
                          {m.access === "not_verified" && <span className="ml-2 text-xs text-muted-foreground">Access not verified; Moodle login may be required</span>}
                          {m.access === "legacy_inaccessible" && <span className="ml-2 text-xs text-destructive">Not accessible at last check — Moodle login may be required</span>}
                          {m.stale ? <span className="ml-2 text-xs text-warning-foreground">Stale: last checked {seen ?? "at an unknown time"}</span>
                            : <span className="ml-2 text-xs text-muted-foreground">{seen ? `Last observed ${seen}` : "Freshness unknown"}</span>}
                          {failed && <span className="ml-2 text-xs text-warning-foreground">Latest refresh attempt {fmt(failed.observedAt)} did not complete{attemptReasons(failed).length ? ` (${attemptReasons(failed).join(", ")})` : ""}</span>}
                          {m.warnings.map((w) => <span key={w} className="ml-2 text-xs text-warning-foreground">{w}</span>)}
                          {m.downloadedAt && <span className="ml-2 text-xs text-muted-foreground">Downloaded once on {new Date(m.downloadedAt).toLocaleDateString("en-GB")} (file may no longer exist)</span>}
                          {m.kind === "folder" && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              <div>{folderListing(m)}</div>
                              {children.length > 0 && <ul aria-label={`Contents of ${m.title}`} className="ml-4 list-disc">{children.map((ch) => <li key={ch.key}>{ch.title}</li>)}</ul>}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {m.source.href ? <Button asChild size="sm" variant="outline"><a href={m.source.href} target="_blank" rel="noopener noreferrer">Open in Moodle</a></Button>
                            : m.source.reason ? <Button size="sm" variant="outline" disabled title={m.source.reason}>Moodle link unavailable</Button> : null}
                          {m.destination && (m.destination.href ? <Button asChild size="sm" variant="ghost"><a href={m.destination.href} target="_blank" rel="noopener noreferrer">{m.destination.external ? "Open external link" : m.kind === "folder" ? "Open folder" : "Open file"}</a></Button>
                            : <Button size="sm" variant="ghost" disabled title={m.destination.reason}>Destination unavailable</Button>)}
                          {m.provenance === "legacy" && m.kind === "file" && (
                            <Button size="sm" variant="ghost" onClick={async () => {
                              try {
                                const r = await adapter.downloadMaterial(m.recordId);
                                setSnap(r.snapshot);
                                toast.info(r.message);
                              } catch (e) {
                                toast.error(e instanceof Error ? e.message : "Download request failed.");
                              }
                            }}>Download</Button>
                          )}
                        </div>
                      </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
            );
          })}
        </div>
      )}
    </>
  );
}
