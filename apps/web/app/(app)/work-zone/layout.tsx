import type { ReactNode } from "react";
import { WorkZoneShell } from "@/components/work-zone/work-zone-shell";

export default function WorkZoneLayout({ children }: { children: ReactNode }) {
  return <WorkZoneShell>{children}</WorkZoneShell>;
}
