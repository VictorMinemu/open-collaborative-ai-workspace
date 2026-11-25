// Chromium's sandbox on the device (07.13 PD-18): always on, except the owner's `container` mode, which counts only when
// this process itself runs in a container. Never an automatic fallback: a launch that finds no usable sandbox fails
// with `no_usable_sandbox` and doctor says why (the AppArmor line, Pitfall 4).

import { existsSync } from "node:fs";
import type { BrowserSandboxMode } from "../../config.js";

/** Whether this process runs in a container (`/.dockerenv` or `/run/.containerenv`, as doctor reads it). */
export function inContainer(exists: (path: string) => boolean = existsSync): boolean {
  return exists("/.dockerenv") || exists("/run/.containerenv");
}

/** True = launch Chromium with its sandbox. False only for `container` mode inside a container. */
export function resolveChromiumSandbox(opts: {
  configured: BrowserSandboxMode;
  inContainer: boolean;
}): boolean {
  return !(opts.configured === "container" && opts.inContainer);
}
