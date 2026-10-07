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
  /** Dock/taskbar badge = unread mentions (0 clears). Whole numbers only; the main process validates again. */
  setBadgeCount: (count: unknown): Promise<void> =>
    Number.isInteger(count) ? ipcRenderer.invoke(Channels.setBadgeCount, count) : Promise.resolve(),
  /** ChatGPT sign-in without pasting (05-07): a one-shot 127.0.0.1 listener in the main process. */
  chatgptLoopbackPrepare: (): Promise<unknown> => ipcRenderer.invoke(Channels.chatgptLoopbackPrepare),
  /** Opens the authorize page in the system browser; resolves with the loopback URL (or why it did not). */
  chatgptLoopbackAwait: (flowToken: unknown, authorizeUrl: unknown): Promise<unknown> =>
    typeof flowToken === "string" && typeof authorizeUrl === "string"
      ? ipcRenderer.invoke(Channels.chatgptLoopbackAwait, { flowToken, authorizeUrl })
      : Promise.reject(new TypeError("chatgptLoopbackAwait expects two strings")),
  chatgptLoopbackCancel: (flowToken: unknown): Promise<void> =>
    typeof flowToken === "string"
      ? ipcRenderer.invoke(Channels.chatgptLoopbackCancel, { flowToken })
      : Promise.resolve(),
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
