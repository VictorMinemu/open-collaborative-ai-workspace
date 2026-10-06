"use client";

import { useEffect, useState } from "react";

/**
 * Feature detection of the Electron desktop shell (`window.ocwDesktop`, exposed by its preload). Mirrors
 * the subset of apps/desktop/src/shared/desktop-api.d.ts the web uses; absolute paths never cross it.
 */
export interface DesktopProject {
  localId: string;
  name: string;
  gitRemote: string | null;
  defaultBranch: string | null;
  addedAt: string;
}

export type DesktopAddProjectResult =
  | { ok: true; project: DesktopProject }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string };

export interface DesktopStatus {
  state: "online" | "connecting" | "offline" | "needs_pairing" | "paused";
  label: string;
  paired: boolean;
  deviceName: string | null;
  projects: number;
}

export interface OcwDesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  status(): Promise<DesktopStatus>;
  addProject(options?: { name?: string }): Promise<DesktopAddProjectResult>;
  listProjects(): Promise<DesktopProject[]>;
  onStatus(callback: (status: DesktopStatus) => void): () => void;
  /** Dock/taskbar badge = unread mentions (0 clears). Optional: desktop builds before 04-11 lack it. */
  setBadgeCount?(count: number): Promise<void>;
}

declare global {
  interface Window {
    ocwDesktop?: OcwDesktopApi;
  }
}

/** The desktop bridge when running inside the desktop app, else null (always null during SSR). */
export function useDesktop(): OcwDesktopApi | null {
  const [api, setApi] = useState<OcwDesktopApi | null>(null);
  useEffect(() => {
    setApi(window.ocwDesktop?.isDesktop ? window.ocwDesktop : null);
  }, []);
  return api;
}
