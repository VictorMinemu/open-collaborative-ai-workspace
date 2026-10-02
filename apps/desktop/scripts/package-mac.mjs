// `pnpm --filter @ocw/desktop package:mac`: build app + bundled daemon, then electron-builder
// (unsigned, ad-hoc signed arm64 .app + .dmg in apps/desktop/release/).
//
// Both `pnpm deploy` and electron-builder's dependency collector spawn `pnpm`. Some installs put a
// non-executable placeholder named `pnpm` first on PATH (spawn → ENOEXEC), so we prepend a shim
// that points at the pnpm binary running this script (npm_execpath).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const shimDir = mkdtempSync(join(tmpdir(), "ocw-pnpm-"));
const pnpmBin = process.env.npm_execpath;
if (pnpmBin && !/\.(c|m)?js$/.test(pnpmBin)) {
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
    [cli, "--config", "electron-builder.yml", "--mac", "--arm64", "--publish", "never"],
    { cwd: root, env, stdio: "inherit" },
  );
} finally {
  rmSync(shimDir, { recursive: true, force: true });
}
