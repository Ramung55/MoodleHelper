import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Course, SubmissionStatus } from "@/domain/types";

export const COURSE_DOT = ["", "bg-course-1", "bg-course-2", "bg-course-3", "bg-course-4", "bg-course-5", "bg-course-6"];
export const COURSE_BORDER = ["", "border-l-course-1", "border-l-course-2", "border-l-course-3", "border-l-course-4", "border-l-course-5", "border-l-course-6"];

export function CourseTag({ course, className }: { course?: Course; className?: string }) {
  if (!course) return <span className="text-xs text-muted-foreground">Unknown course</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground", className)}>
      <span aria-hidden className={cn("h-2.5 w-2.5 rounded-full", COURSE_DOT[course.color])} />
      {course.code} · {course.name}
    </span>
  );
}

const SUB: Record<SubmissionStatus, { label: string; cls: string }> = {
  submitted: { label: "Submitted", cls: "bg-success text-success-foreground" },
  draft: { label: "Draft — not submitted", cls: "bg-warning text-warning-foreground" },
  not_submitted: { label: "Not submitted", cls: "bg-secondary text-secondary-foreground" },
  reopened: { label: "Reopened — resubmit", cls: "bg-destructive text-destructive-foreground" },
  unknown: { label: "Status unknown", cls: "bg-muted text-muted-foreground border border-dashed border-border" },
};

export function SubmissionBadge({ status }: { status?: SubmissionStatus }) {
  if (!status) return <Badge variant="outline">No Moodle status</Badge>;
  const s = SUB[status];
  return <Badge className={cn("border-transparent", s.cls)}>Moodle: {s.label}</Badge>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed bg-card p-8 text-center">
      <p className="font-medium text-foreground">{title}</p>
      {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export const TYPE_LABEL = { assignment: "Assignment", quiz: "Quiz", exam: "Exam", other: "Other" } as const;
