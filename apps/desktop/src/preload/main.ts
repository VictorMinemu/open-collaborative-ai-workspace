// Preload for the main window (the web app, a remote origin). Exposes ONLY the narrow
// `window.ocwDesktop` API; no generic IPC passthrough. The main process re-validates the sender
// and every argument.

import { contextBridge, ipcRenderer } from "electron";
import { Channels } from "../shared/channels";

type Listener = (status: unknown) => void;

const api = Object.freeze({
  isDesktop: true as const,
  platform: process.platform,
  /** Current runtime status (state, label, device name, project count, detected runtimes). */
  status: (): Promise<unknown> => ipcRenderer.invoke(Channels.status),
  /** Native folder picker → validated git repo → registered with the local runtime. */
  addProject: (options?: { name?: string }): Promise<unknown> =>
    ipcRenderer.invoke(
      Channels.addProject,
      options && typeof options.name === "string" ? { name: options.name } : undefined,
    ),
  /** Projects registered on this computer (names and ids only, never paths). */
  listProjects: (): Promise<unknown> => ipcRenderer.invoke(Channels.listProjects),
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus: (callback: Listener): (() => void) => {
    if (typeof callback !== "function") throw new TypeError("onStatus expects a function");
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on(Channels.statusChanged, listener);
    return () => {
      ipcRenderer.removeListener(Channels.statusChanged, listener);
    };
  },
});

contextBridge.exposeInMainWorld("ocwDesktop", api);
