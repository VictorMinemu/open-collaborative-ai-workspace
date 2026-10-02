"use client";

import { createContext, useContext } from "react";

export interface WorkZoneContextValue {
  /** Open the "New session" dialog, optionally preselecting a project. */
  openNewSession(projectId?: string): void;
}

export const WorkZoneContext = createContext<WorkZoneContextValue>({ openNewSession: () => {} });

export function useWorkZone(): WorkZoneContextValue {
  return useContext(WorkZoneContext);
}
