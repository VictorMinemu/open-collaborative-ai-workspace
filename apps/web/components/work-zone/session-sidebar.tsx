"use client";

import { WorkZoneSidebar } from "./sidebar/work-zone-sidebar";

/**
 * The Work Zone sidebar entry point. Its body is `WorkZoneSidebar` since Phase 07.10 (sections by department, D-01);
 * the export name stays so the shell's import does not change. The pure helpers moved to `sidebar/model.ts` and the
 * kept rows (`SettledRow`, `ProjectBadge`) to `sidebar/session-rows.tsx`; both stay importable from here. The old
 * three-line active row was retired in 07.10-04.
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
export { ProjectBadge, SettledRow } from "./sidebar/session-rows";
