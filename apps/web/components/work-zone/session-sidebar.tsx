"use client";

import { WorkZoneSidebar } from "./sidebar/work-zone-sidebar";

/**
 * The Work Zone sidebar entry point. Its body is `WorkZoneSidebar` since Phase 07.10 (sections by department, D-01);
 * the export name stays so the shell's import does not change. The pure helpers moved to `sidebar/model.ts` and the
 * pre-07.10 rows to `sidebar/session-rows.tsx`; both stay importable from here.
 */
export function SessionSidebar() {
  return <WorkZoneSidebar />;
}

export {
  elapsedLabel,
  isActiveSession,
  orderActiveSessions,
  projectInitials,
  rowProject,
  shortAgo,
} from "./sidebar/model";
export { ActiveRow, ProjectBadge, SettledRow } from "./sidebar/session-rows";
