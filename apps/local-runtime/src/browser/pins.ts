// The Chrome for Testing headless shell the Work Zone browser runs (07.13 D-05, PD-19): one build, one sha256 and size
// per desktop platform. The pins live in the runtime's source only: the server never sends a version, a URL or a hash,
// so a compromised or misconfigured server cannot make a device run another binary. The two Linux rows equal the bots'
// brw image (`infra/sandbox/browser/Dockerfile`, `ADD --checksum`), asserted by pins.test.ts, so both cannot drift.
// Bump all five rows together with the image and playwright-core's milestone (RESEARCH § Standard Stack).

/** The Chrome for Testing build (stable, milestone 156). */
export const CFT_VERSION = "156.0.8078.47";

export const CFT_PLATFORMS = ["linux64", "linux-arm64", "mac-arm64", "mac-x64", "win64"] as const;
/** Chrome for Testing's platform keys for the desktop builds (no 32-bit Windows build is pinned). */
export type CftPlatform = (typeof CFT_PLATFORMS)[number];

export interface CftPin {
  /** sha256 of the whole zip, lowercase hex. */
  sha256: string;
  /** The zip's exact size in bytes; a download is cut off past it. */
  bytes: number;
}

/** Verified against Google's storage (RESEARCH § Standard Stack, 2026-11-25) and, for Linux, the brw Dockerfile. */
export const CFT_PINS: Readonly<Record<CftPlatform, CftPin>> = Object.freeze({
  linux64: { sha256: "0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa", bytes: 125_799_226 },
  "linux-arm64": {
    sha256: "955059fa7020d7be85eb503e21339fd4d718f51f5996d3b60633fbf908bda132",
    bytes: 125_696_256,
  },
  "mac-arm64": {
    sha256: "2fd1c09a3e1ebde9e69e6aba92f1dd3f21ad247b55d9bf66e39213ff4205436d",
    bytes: 103_927_850,
  },
  "mac-x64": {
    sha256: "5e230044c6ac989597f4a4e301a0a710d257e07d6f7754754da2bf62ea3d272c",
    bytes: 109_256_749,
  },
  win64: { sha256: "e0af9b23f8051cca4f37ca49cd425e8055701bfc0383c198d67f8d5cc5884249", bytes: 126_051_683 },
});

/** This machine's CfT platform from Node's `process.platform` and `process.arch`; null when there is no pinned build. */
export function cftPlatformOf(platform: NodeJS.Platform | string, arch: string): CftPlatform | null {
  if (platform === "linux") return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : null;
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
  if (platform === "win32") return arch === "x64" ? "win64" : null;
  return null;
}

/** The fixed storage URL of the pinned zip for `p`. */
export function cftZipUrl(p: CftPlatform): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${CFT_VERSION}/${p}/chrome-headless-shell-${p}.zip`;
}

/** The executable inside the extracted root (`extractZip` strips the zip's `chrome-headless-shell-<p>/` directory). */
export function headlessShellRelativePath(p: CftPlatform): string {
  return p === "win64" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
}
