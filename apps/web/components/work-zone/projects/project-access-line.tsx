"use client";

import { WORK_PROJECT_LIMITS, type WorkProjectDetail } from "@ocw/contracts";
import { UserAvatar } from "@/components/ui/avatar";
import { accessTitle } from "./project-labels";

export const ACCESS_COPY = {
  line: "Its members, people in its teams, and admins.",
} as const;

/**
 * Who can open the project (UI-SPEC § 4.3 "Access line", N3): up to five faces, the API's count and one line. The
 * project-level twin of the visibility panel's footer; the count is the API's (members ∪ team members, never admins).
 */
export function ProjectAccessLine({ project }: { project: Pick<WorkProjectDetail, "access"> }) {
  const { count, people } = project.access;
  const faces = people.slice(0, WORK_PROJECT_LIMITS.accessPeople);
  return (
    <section
      data-testid="project-access"
      data-count={count}
      aria-label="Access"
      className="flex min-h-14 items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs"
    >
      {faces.length > 0 ? (
        <div aria-hidden className="flex shrink-0 items-center -space-x-1.5">
          {faces.map((p, i) => (
            // The first face sits on top, so each one keeps its initials readable (as in the visibility footer).
            <span key={p.userId} className="relative inline-flex" style={{ zIndex: faces.length - i }}>
              <UserAvatar
                name={p.name}
                src={p.avatarUrl}
                seed={p.userId}
                className="size-7 text-[10px] ring-2 ring-card"
              />
            </span>
          ))}
        </div>
      ) : null}
      <div className="min-w-0">
        <p className="font-semibold text-sm">{accessTitle(count)}</p>
        <p className="text-muted-foreground text-xs">{ACCESS_COPY.line}</p>
      </div>
    </section>
  );
}
