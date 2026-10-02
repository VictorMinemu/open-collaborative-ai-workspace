"use client";

import { type ReactNode, useMemo, useState } from "react";
import { useWorkZoneOrgSync } from "@/lib/workzone-queries";
import { NewSessionDialog } from "./new-session-dialog";
import { SessionSidebar } from "./session-sidebar";
import { WorkZoneContext } from "./work-zone-context";

/** Work Zone chrome: session sidebar + content, the shared "New session" dialog and live org sync. */
export function WorkZoneShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>();
  useWorkZoneOrgSync();
  const ctx = useMemo(
    () => ({
      openNewSession(id?: string) {
        setProjectId(id);
        setOpen(true);
      },
    }),
    [],
  );
  return (
    <WorkZoneContext.Provider value={ctx}>
      <SessionSidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <NewSessionDialog open={open} onOpenChange={setOpen} initialProjectId={projectId} />
    </WorkZoneContext.Provider>
  );
}
