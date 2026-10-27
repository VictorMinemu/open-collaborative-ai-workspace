"use client";

import { createContext, useContext } from "react";

export interface WorkZoneContextValue {
  /** Open the "New session" dialog, optionally preselecting a project. */
  openNewSession(projectId?: string): void;
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
