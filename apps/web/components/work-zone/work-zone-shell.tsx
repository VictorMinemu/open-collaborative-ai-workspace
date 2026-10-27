"use client";

import { type ReactNode, useMemo, useState } from "react";
import { useWorkZoneOrgSync } from "@/lib/workzone-queries";
import { NewSessionDialog } from "./new-session-dialog";
import { NewProjectDialog } from "./projects/new-project-dialog";
import { SessionSidebar } from "./session-sidebar";
import { type NewSessionPreselect, WorkZoneContext } from "./work-zone-context";

/**
 * Work Zone chrome: session sidebar + content, the shared "New session" and "New project" dialogs (the sidebar's "+"
 * buttons open them, 07.10-05) and live org sync.
 */
export function WorkZoneShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<NewSessionPreselect | undefined>();
  const [projectOpen, setProjectOpen] = useState(false);
  const [defaultParentId, setDefaultParentId] = useState<string | undefined>();
  useWorkZoneOrgSync();
  const ctx = useMemo(
    () => ({
      openNewSession(next?: NewSessionPreselect) {
        setTarget(next);
        setOpen(true);
      },
      openNewProject(parentId?: string) {
        setDefaultParentId(parentId);
        setProjectOpen(true);
      },
    }),
    [],
  );
  return (
    <WorkZoneContext.Provider value={ctx}>
      <SessionSidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <NewSessionDialog open={open} onOpenChange={setOpen} initialTarget={target} />
      <NewProjectDialog open={projectOpen} onOpenChange={setProjectOpen} defaultParentId={defaultParentId} />
    </WorkZoneContext.Provider>
  );
}
