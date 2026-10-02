// `pnpm --filter @ocw/desktop dev`: build, then run Electron against the configured server
// (default http://localhost:3000; override the first-run default with OCW_WEB_URL).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await import("./build.mjs");

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
// Shells spawned from other Electron apps inherit this and would turn Electron into plain Node.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
