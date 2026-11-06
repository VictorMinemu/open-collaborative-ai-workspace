// After `package`: runs the packaged app's bundled daemon the way the app starts it (the app's own
// Electron binary as plain Node) and checks that it loads and prints its version. This proves the
// daemon, its TypeScript loader and that loader's native binary work on this platform.
//   node scripts/check-package.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const release = join(dirname(fileURLToPath(import.meta.url)), "..", "release");
const layouts = {
  darwin: { exe: "mac-arm64/OCW.app/Contents/MacOS/OCW", resources: "mac-arm64/OCW.app/Contents/Resources" },
  win32: { exe: "win-unpacked/OCW.exe", resources: "win-unpacked/resources" },
  linux: { exe: "linux-unpacked/ocw", resources: "linux-unpacked/resources" },
};
const layout = layouts[process.platform];
if (!layout) throw new Error(`no desktop build for ${process.platform}`);
const exe = join(release, layout.exe);
const entry = join(release, layout.resources, "daemon", "bin", "ocw-runtime");
for (const p of [exe, entry]) if (!existsSync(p)) throw new Error(`missing ${p}`);

const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
const out = execFileSync(exe, [entry, "version"], { env, encoding: "utf8", timeout: 60_000 }).trim();
if (!/^\d+\.\d+\.\d+/.test(out)) throw new Error(`unexpected daemon version output: ${JSON.stringify(out)}`);
console.log(`packaged daemon runs: ocw-runtime ${out}`);
