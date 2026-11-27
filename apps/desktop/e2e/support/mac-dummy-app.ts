// A dummy `OCW.app`, signed ad hoc like the real build, for the macOS update tests (07.13.1, D-12): the unit tests of
// src/main/mac-update.ts and plan 07's e2e. It is a minimal bundle (Info.plist, `Contents/MacOS/OCW` copied from
// /usr/bin/true, a stand-in daemon entry and one symlink), built only inside the temp folder the caller gives; it never
// touches /Applications or the installed OCW. Every tool runs from its absolute path with an argv array. macOS only.

import { execFile } from "node:child_process";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

function darwinOnly(): void {
  if (process.platform !== "darwin") throw new Error("the dummy macOS app is built only on macOS");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function infoPlist(bundleId: string, version: string): string {
  const entries: [string, string][] = [
    ["CFBundleIdentifier", bundleId],
    ["CFBundleName", "OCW"],
    ["CFBundleExecutable", "OCW"],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([k, v]) => `  <key>${k}</key>\n  <string>${xml(v)}</string>`).join("\n")}
</dict>
</plist>
`;
}

/**
 * Builds `<dir>/OCW.app` with the given version (and `bundleId`, default `dev.ocw.desktop`), signs it with
 * `codesign --force --deep -s -` and returns its path. `tamperAfterSign` changes the daemon entry after signing, so
 * the seal no longer verifies.
 */
export async function buildDummyMacApp(opts: {
  dir: string;
  version: string;
  bundleId?: string;
  tamperAfterSign?: boolean;
}): Promise<string> {
  darwinOnly();
  const app = join(opts.dir, "OCW.app");
  const contents = join(app, "Contents");
  const daemonBin = join(contents, "Resources", "daemon", "bin");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(daemonBin, { recursive: true });
  await writeFile(join(contents, "Info.plist"), infoPlist(opts.bundleId ?? "dev.ocw.desktop", opts.version));
  await copyFile("/usr/bin/true", join(contents, "MacOS", "OCW"));
  await writeFile(join(daemonBin, "ocw-runtime"), "#!/usr/bin/env node\n// dummy Local Runtime entry\n", {
    mode: 0o755,
  });
  // A relative symlink inside the bundle, like a framework's `Versions/Current`: the zip must keep it a symlink.
  await symlink("daemon", join(contents, "Resources", "current"));
  await run("/usr/bin/codesign", ["--force", "--deep", "-s", "-", app]);
  if (opts.tamperAfterSign) {
    await writeFile(join(daemonBin, "ocw-runtime"), "#!/usr/bin/env node\n// changed after signing\n");
  }
  return app;
}

/** Zips the app the way the release does (`ditto -c -k --keepParent`, so `OCW.app` is at the zip's root). */
export async function zipDummyMacApp(app: string, zip: string): Promise<void> {
  darwinOnly();
  await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
}
