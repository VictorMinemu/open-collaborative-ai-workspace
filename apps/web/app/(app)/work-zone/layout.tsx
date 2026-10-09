import type { ReactNode } from "react";
import { ModuleGate } from "@/components/shell/module-gate";
import { WorkZoneShell } from "@/components/work-zone/work-zone-shell";

/** A member whose Work Zone is turned off (07.3) sees the in-place off state on every Work Zone URL, live. */
export default function WorkZoneLayout({ children }: { children: ReactNode }) {
  return (
    <ModuleGate module="work_zone">
      <WorkZoneShell>{children}</WorkZoneShell>
    </ModuleGate>
  );
}
