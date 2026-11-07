// `pnpm --filter @ocw/desktop package` builds the app and the bundled daemon, then runs electron-builder for
// this machine's platform (or `--mac` / `--win` / `--linux`), into apps/desktop/release/:
//   macOS   arm64 .app + .dmg (ad-hoc signed; no Developer ID, no notarization)
//   Windows x64 NSIS installer (unsigned)
//   Linux   x64 AppImage + .deb
// Build each platform on that platform: the daemon's dependencies carry native binaries (esbuild, used by tsx).
//
// Both `pnpm deploy` and electron-builder's dependency collector spawn `pnpm`. Some installs put a
// non-executable placeholder named `pnpm` first on PATH (spawn → ENOEXEC), so on macOS and Linux we
// prepend a shim that points at the pnpm binary running this script (npm_execpath).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = {
  "--mac": ["--mac", "--arm64"],
  "--win": ["--win", "--x64"],
  "--linux": ["--linux", "--x64"],
};
const HOST = { darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform];
const flag = process.argv.slice(2).find((a) => a in TARGETS) ?? HOST;
if (!flag) throw new Error(`no desktop build for ${process.platform}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const shimDir = mkdtempSync(join(tmpdir(), "ocw-pnpm-"));
const pnpmBin = process.env.npm_execpath;
if (process.platform !== "win32" && pnpmBin && !/\.(c|m)?js$/.test(pnpmBin)) {
  symlinkSync(pnpmBin, join(shimDir, "pnpm"));
  env.PATH = `${shimDir}${delimiter}${env.PATH ?? ""}`;
}

try {
  execFileSync(process.execPath, [join(root, "scripts", "build.mjs"), "--daemon"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
  execFileSync(
    process.execPath,
    [cli, "--config", "electron-builder.yml", ...TARGETS[flag], "--publish", "never"],
    { cwd: root, env, stdio: "inherit" },
  );
} finally {
  rmSync(shimDir, { recursive: true, force: true });
}
