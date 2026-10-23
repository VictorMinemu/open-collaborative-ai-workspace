"use client";

import type { WorkProjectDetail } from "@ocw/contracts";
import { useId } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useUpdateWorkProject } from "@/lib/work-project-queries";

export const DEFAULT_SWITCH_COPY = {
  label: "Visible to everyone in the project",
  description: "When off, new sessions start as Only me. Existing sessions don't change.",
  ariaLabel: "New sessions are visible to everyone in the project",
  on: (project: string) => `New sessions in ${project} start visible to everyone`,
  off: (project: string) => `New sessions in ${project} start as Only me`,
} as const;

type SwitchProject = Pick<WorkProjectDetail, "id" | "name" | "defaultVisibility" | "viewerCan">;

/**
 * The project's one setting (D-03, U-6): new sessions start visible to everyone in the project (on, the default) or
 * as Only me (off). Saves on toggle, optimistic, back with a toast on failure. Only `viewerCan.manage` (the API's
 * `work_project.manage`) toggles it; everyone else sees its state, disabled.
 */
export function ProjectDefaultSwitch({ project }: { project: SwitchProject }) {
  const update = useUpdateWorkProject(project.id);
  return (
    <ProjectDefaultSwitchRow
      project={project}
      onChange={(on) =>
        update.mutate(on ? "project" : "owner", {
          onSuccess: (p) =>
            toast.success(on ? DEFAULT_SWITCH_COPY.on(p.name) : DEFAULT_SWITCH_COPY.off(p.name)),
          onError: (err) => toast.error(errorMessage(err)),
        })
      }
    />
  );
}

/** The row over its inputs, so the editable and read-only states render in a unit test. */
export function ProjectDefaultSwitchRow({
  project,
  onChange,
}: {
  project: SwitchProject;
  onChange: (on: boolean) => void;
}) {
  const descriptionId = useId();
  const on = project.defaultVisibility === "project";
  return (
    <div
      data-testid="project-default"
      className="flex items-start justify-between gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs"
    >
      <span className="min-w-0 text-sm">
        <span className="block font-semibold">{DEFAULT_SWITCH_COPY.label}</span>
        <span id={descriptionId} className="block text-muted-foreground text-xs">
          {DEFAULT_SWITCH_COPY.description}
        </span>
      </span>
      <Switch
        checked={on}
        disabled={!project.viewerCan.manage}
        onCheckedChange={onChange}
        aria-label={DEFAULT_SWITCH_COPY.ariaLabel}
        aria-describedby={descriptionId}
        data-testid="project-default-switch"
        // A 44 px hit area below 768 around the 20 px switch (touch rule), without moving it.
        className="mt-0.5 max-md:after:absolute max-md:after:-inset-3 max-md:after:content-['']"
      />
    </div>
  );
}
