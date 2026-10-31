import { AlertCircle, CheckCircle2, Clock, EyeOff, GitCompare, History, Pencil, User } from "lucide-react";
import type { AssessmentView } from "@/domain/assessments";
import { displayDate, dueState, sourceFreshness } from "@/domain/deadline-display";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { COURSE_BORDER, CourseTag, SubmissionBadge, TYPE_LABEL } from "./bits";

export function AssessmentRow({ v, onOpen, now = new Date() }: { v: AssessmentView; onOpen: (id: string) => void; now?: Date }) {
  const { snap } = useApp();
  const course = snap?.courses.find((c) => c.id === v.a.courseId);
  const tz = snap!.settings.timezone;
  const due = dueState(v, tz, now);
  const fresh = snap ? sourceFreshness(v, snap, tz) : null;
  return (
    <button
      type="button"
      data-assessment-row={v.a.id}
      onClick={() => onOpen(v.a.id)}
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border border-l-4 bg-card p-4 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:flex-row sm:items-center",
        COURSE_BORDER[course?.color ?? 1],
        v.hidden && "opacity-60",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-semibold text-foreground [overflow-wrap:anywhere]">{v.title}</span>
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{TYPE_LABEL[v.a.type]}</span>
        </div>
        <CourseTag course={course} />
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {v.a.personal && (
            <span className="inline-flex items-center gap-1"><User className="h-3 w-3" aria-hidden />Personal event</span>
          )}
          {v.overlay?.dateOverride && (
            <span className="inline-flex items-center gap-1"><Pencil className="h-3 w-3" aria-hidden />Your date</span>
          )}
          {v.conflict && (
            <span className="inline-flex items-center gap-1 text-destructive"><GitCompare className="h-3 w-3" aria-hidden />Moodle and syllabus disagree</span>
          )}
          {v.overrideDisagreement && (
            <span className="inline-flex items-center gap-1 text-destructive"><AlertCircle className="h-3 w-3" aria-hidden />Source changed under your edit</span>
          )}
          {v.hidden && <span className="inline-flex items-center gap-1"><EyeOff className="h-3 w-3" aria-hidden />Hidden</span>}
          {due && <span className={cn("inline-flex items-center gap-1", due.kind === "overdue" && "font-semibold text-destructive")}><Clock className="h-3 w-3" aria-hidden />{due.label}</span>}
          {fresh?.stale && <span className="inline-flex items-center gap-1 text-warning"><History className="h-3 w-3" aria-hidden />Stale source</span>}
          {v.completed && <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="h-3 w-3" aria-hidden />You marked done</span>}
        </div>
      </div>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <span className="font-mono text-sm font-semibold text-foreground">{displayDate(v.date, tz)}</span>
        {v.date.kind === "week" && <span className="text-xs text-muted-foreground">{v.teachingMapping.resolved ? `${v.teachingMapping.start} – ${v.teachingMapping.end} · ${v.teachingMapping.timezone}` : v.teachingMapping.reason}</span>}
        {!v.a.personal && <SubmissionBadge status={v.a.submission?.status} />}
      </div>
    </button>
  );
}
