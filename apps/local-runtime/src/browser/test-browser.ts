// The pinned headless shell for the Work Zone browser's tests (07.13-09, P5): the same verified Chrome for Testing build
// the device installs, kept in a test cache (`OCW_TEST_BROWSERS_DIR`, default `~/.cache/ocw-test-browsers`), never
// Playwright's shared browser cache and never a system Chrome. Test-only (imported by *.test.ts files).
//
// Locally the cache is pre-seeded once, outside the tests (`OCW_BROWSERS_DIR=~/.cache/ocw-test-browsers ocw-runtime
// browser install`): a test never downloads, and the real-Chromium suites skip when the cache is empty. In CI (`CI`
// set) a missing build is installed through `installBrowser` (download + sha256), once per cache: Woodpecker keeps it
// on the shared cache volume, GitHub Actions in `actions/cache` keyed on `pins.ts`.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { inContainer, resolveChromiumSandbox } from "./agent/sandbox.js";
import { installBrowser, installedBrowser } from "./install.js";

export function testBrowsersDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.OCW_TEST_BROWSERS_DIR?.trim();
  if (dir && isAbsolute(dir)) return dir;
  return join(homedir(), ".cache", "ocw-test-browsers");
}

/** Printed by a suite that skips because the cache is empty (the path is the developer's own). */
export const TEST_BROWSER_HINT =
  "real-Chromium tests skipped: run `OCW_BROWSERS_DIR=~/.cache/ocw-test-browsers ocw-runtime browser install` once";

let pending: Promise<string | null> | null = null;

/**
 * The pinned headless shell's executable, or null when it is not in the test cache outside CI. In CI a missing build is
 * installed (and a failed install throws, so CI never skips these tests).
 */
export function testBrowser(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  pending ??= (async () => {
    const root = testBrowsersDir(env);
    const found = await installedBrowser(root);
    if (found) return found.executable;
    if (!env.CI) return null;
    return (await installBrowser({ root })).executable;
  })();
  return pending;
}

/** Chromium's sandbox for the tests, by the production rule (PD-18): off only inside a container. */
export function testSandbox(): boolean {
  const container = inContainer();
  return resolveChromiumSandbox({ configured: container ? "container" : "on", inContainer: container });
}
