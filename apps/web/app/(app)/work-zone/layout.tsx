"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ModuleGate } from "@/components/shell/module-gate";
import { WorkZoneShell } from "@/components/work-zone/work-zone-shell";
import { isSessionPath } from "@/lib/work-zone-routes";

/**
 * A member whose Work Zone is turned off (07.3) sees the in-place off state on every Work Zone URL, live. A session
 * that was open when it went off explains the lost access itself (RT-01: the realtime revoke shows "You no longer have
 * access to this session", for a role change as for a turned-off module), so it stays until the member leaves it.
 * The project pages (`/work-zone/projects…`) are not sessions: they show the off state at once (UI-SPEC R8).
 */
export default function WorkZoneLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <ModuleGate module="work_zone" keepOpen={isSessionPath(pathname) ? pathname : null}>
      <WorkZoneShell>{children}</WorkZoneShell>
    </ModuleGate>
  );
}
