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
  /** `notice`: a short note to show (e.g. the folder has no git repository). Absent in older desktop builds. */
  | { ok: true; project: DesktopProject; notice?: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string };

export interface DesktopStatus {
  state: "online" | "connecting" | "offline" | "needs_pairing" | "paused";
  label: string;
  paired: boolean;
  deviceName: string | null;
  projects: number;
}

/** "Sign in with ChatGPT" without pasting (05-07): the desktop main process's one-shot 127.0.0.1 listener. */
export interface DesktopChatgptLoopbackPrepared {
  flowToken: string;
  port: number;
}

export type DesktopChatgptLoopbackResult =
  | { ok: true; redirectUrl: string }
  | { ok: false; reason: "timeout" | "cancelled" | "invalid_url" };

export interface OcwDesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  status(): Promise<DesktopStatus>;
  addProject(options?: { name?: string }): Promise<DesktopAddProjectResult>;
  listProjects(): Promise<DesktopProject[]>;
  onStatus(callback: (status: DesktopStatus) => void): () => void;
  /** Dock/taskbar badge = unread mentions (0 clears). Optional: desktop builds before 04-11 lack it. */
  setBadgeCount?(count: number): Promise<void>;
  /** ChatGPT sign-in without pasting. Optional: desktop builds before 05-07 lack them (the web falls back to paste). */
  chatgptLoopbackPrepare?(): Promise<DesktopChatgptLoopbackPrepared>;
  chatgptLoopbackAwait?(flowToken: string, authorizeUrl: string): Promise<DesktopChatgptLoopbackResult>;
  chatgptLoopbackCancel?(flowToken: string): Promise<void>;
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

/** The desktop's ChatGPT loopback bridge when all three functions exist, else null (browser, older desktop builds). */
export function desktopChatgptLoopback(api: OcwDesktopApi | null): {
  prepare(): Promise<DesktopChatgptLoopbackPrepared>;
  await(flowToken: string, authorizeUrl: string): Promise<DesktopChatgptLoopbackResult>;
  cancel(flowToken: string): Promise<void>;
} | null {
  const prepare = api?.chatgptLoopbackPrepare;
  const wait = api?.chatgptLoopbackAwait;
  const cancel = api?.chatgptLoopbackCancel;
  if (!prepare || !wait || !cancel) return null;
  return {
    prepare: () => prepare(),
    await: (flowToken, authorizeUrl) => wait(flowToken, authorizeUrl),
    cancel: (flowToken) => cancel(flowToken),
  };
}
