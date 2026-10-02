// Preload for the bundled onboarding page (local file, no remote content).

import { contextBridge, ipcRenderer } from "electron";
import { Channels } from "../shared/channels";

contextBridge.exposeInMainWorld(
  "ocwOnboarding",
  Object.freeze({
    defaults: (): Promise<unknown> => ipcRenderer.invoke(Channels.onboardingDefaults),
    status: (): Promise<unknown> => ipcRenderer.invoke(Channels.onboardingStatus),
    checkServer: (input: { webUrl: string; apiUrl?: string }): Promise<unknown> =>
      ipcRenderer.invoke(Channels.onboardingCheckServer, {
        webUrl: String(input.webUrl),
        ...(input.apiUrl ? { apiUrl: String(input.apiUrl) } : {}),
      }),
    enroll: (input: { webUrl: string; apiUrl: string; code: string; deviceName: string }): Promise<unknown> =>
      ipcRenderer.invoke(Channels.onboardingEnroll, {
        webUrl: String(input.webUrl),
        apiUrl: String(input.apiUrl),
        code: String(input.code),
        deviceName: String(input.deviceName),
      }),
    finish: (skipPairing: boolean): Promise<unknown> =>
      ipcRenderer.invoke(Channels.onboardingFinish, { skipPairing: skipPairing === true }),
    onStatus: (callback: (status: unknown) => void): void => {
      ipcRenderer.on(Channels.statusChanged, (_e, s: unknown) => callback(s));
    },
  }),
);
