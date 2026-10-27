"use client";

import { createContext, useContext } from "react";

/**
 * What the new-session dialog preselects (07.10-05, R5): a repository id (every caller before 07.10), or a team project,
 * for which the dialog picks that project's first online repository the viewer can start on.
 */
export type NewSessionPreselect = string | { teamProjectId: string };

export interface WorkZoneContextValue {
  /** Open the "New session" dialog, optionally preselecting a repository or a team project. */
  openNewSession(target?: NewSessionPreselect): void;
  /** Open "New project", optionally preselecting the unit it sits under (07.10-05, R6; ignored when not allowed). */
  openNewProject(defaultParentId?: string): void;
}

export const WorkZoneContext = createContext<WorkZoneContextValue>({
  openNewSession: () => {},
  openNewProject: () => {},
});

export function useWorkZone(): WorkZoneContextValue {
  return useContext(WorkZoneContext);
}
