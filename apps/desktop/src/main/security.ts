// Electron hardening shared by every window: no webviews, no new windows, navigation pinned to
// the configured web origin, external links only via the OS browser after the http(s) allowlist,
// and a deny-by-default permission policy.

import { type IpcMainInvokeEvent, session, shell, type WebContents, type WebPreferences } from "electron";
import { isAllowedNavigation, isSafeExternalUrl } from "../shared/urls";

export function hardenedPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: true,
    safeDialogs: true,
  };
}

function openExternalSafely(url: string): void {
  if (isSafeExternalUrl(url)) void shell.openExternal(url);
}

/**
 * Pin a window's navigation. `allowedOrigin()` is read on every event so a server change applies
 * immediately; `null` means "no remote navigation at all" (local onboarding page).
 */
export function restrictNavigation(contents: WebContents, allowedOrigin: () => string | null): void {
  const guard = (event: { preventDefault: () => void }, url: string) => {
    const origin = allowedOrigin();
    if (origin && isAllowedNavigation(url, origin)) return;
    event.preventDefault();
    openExternalSafely(url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return; // covered by will-navigate
    const origin = allowedOrigin();
    if (origin && isAllowedNavigation(event.url, origin)) return;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
}

/** Global guards for any web contents the app ever creates. */
export function installGlobalGuards(app: Electron.App, webOrigin: () => string | null): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafely(url);
      return { action: "deny" };
    });
  });

  const allowedForWeb = new Set(["clipboard-sanitized-write", "fullscreen", "notifications"]);
  const isWebOrigin = (url: string | undefined) => {
    const origin = webOrigin();
    return !!url && !!origin && isAllowedNavigation(url, origin);
  };
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowedForWeb.has(permission) && isWebOrigin(details.requestingUrl ?? contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return allowedForWeb.has(permission) && isWebOrigin(requestingOrigin);
  });
  // Device APIs (USB/HID/serial/bluetooth) are never granted.
  session.defaultSession.setDevicePermissionHandler(() => false);
}

/** True if an IPC call comes from the top frame of `expected` at an allowed URL. */
export function isTrustedSender(
  event: IpcMainInvokeEvent,
  expected: WebContents | null | undefined,
  urlOk: (url: string) => boolean,
): boolean {
  if (!expected || event.sender !== expected) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return urlOk(frame.url);
}
