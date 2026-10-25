import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CourseTag, EmptyState, PageHeader } from "@/components/mh/bits";
import { useApp } from "@/lib/app-store";

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

function Materials() {
  const { snap, adapter, setSnap } = useApp();
  const s = snap!;
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const needle = q.trim().toLocaleLowerCase();
  const list = s.materials.filter((m) => s.settings.trackedCourseIds.includes(m.courseId) && (!type || m.fileType === type) && (!needle || m.title.toLocaleLowerCase().includes(needle)));
  const byCourse = s.courses.map((c) => ({ c, items: list.filter((m) => m.courseId === c.id) })).filter((g) => g.items.length);

  return (
    <>
      <PageHeader title="Materials" sub="Links are indexed only. Files are downloaded only when you ask. Moodle resources may require you to be logged in." />
      <div className="mb-6 flex flex-wrap gap-2">
        <Input aria-label="Search titles" placeholder="Search titles (English or Russian)…" className="max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="File type" className="h-9 rounded-md border bg-card px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {["pdf", "docx", "pptx", "link", "video", "other"].map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
        </select>
      </div>
      {byCourse.length === 0 ? <EmptyState title="No materials match" /> : (
        <div className="space-y-6">
          {byCourse.map(({ c, items }) => (
            <section key={c.id} className="rounded-lg border bg-card p-4">
              <CourseTag course={c} className="text-sm" />
              {[...new Set(items.map((i) => i.section))].map((sec) => (
                <div key={sec} className="mt-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">{sec}</h3>
                  <ul className="mt-1 divide-y">
                    {items.filter((i) => i.section === sec).map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div>
                          <span className="font-medium">{m.title}</span>
                          <span className="ml-2 rounded bg-muted px-1.5 text-xs">{m.fileType.toUpperCase()}</span>
                          {!m.accessible && <span className="ml-2 text-xs text-destructive">Not accessible — log in to Moodle</span>}
                          {m.stale && <span className="ml-2 text-xs text-warning-foreground">Stale: last checked {new Date(m.lastCheckedAt).toLocaleDateString("en-GB")}</span>}
                          {m.downloadedAt && <span className="ml-2 text-xs text-muted-foreground">Downloaded once on {new Date(m.downloadedAt).toLocaleDateString("en-GB")} (file may no longer exist)</span>}
                        </div>
                        <div className="flex gap-2">
                          <Button asChild size="sm" variant="outline"><a href={m.url} target="_blank" rel="noreferrer">Open in Moodle</a></Button>
                          {m.fileType !== "link" && (
                            <Button size="sm" variant="ghost" onClick={async () => {
                              try {
                                const r = await adapter.downloadMaterial(m.id);
                                setSnap(r.snapshot);
                                toast.info(r.message);
                              } catch (e) {
                                toast.error(e instanceof Error ? e.message : "Download request failed.");
                              }
                            }}>Download</Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
