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

// 07.13-20 (D-18, PD-22): the Work Zone browser's engine. `browser-agent --check` loads playwright-core and the
// engine's serializer from the packaged daemon's own node_modules and prints `browser-agent ok <version>`, without
// launching a browser. A build that cannot load them fails here, before release.
let check;
try {
  check = execFileSync(exe, [entry, "browser-agent", "--check"], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
} catch (err) {
  const said = typeof err?.stdout === "string" ? err.stdout.trim() : "";
  throw new Error(`packaged daemon cannot load the browser engine: ${said || String(err)}`);
}
if (!/^browser-agent ok \d+\.\d+\.\d+/.test(check)) {
  throw new Error(`unexpected browser-agent check output: ${JSON.stringify(check)}`);
}
console.log(`packaged daemon loads the browser engine: ${check}`);
