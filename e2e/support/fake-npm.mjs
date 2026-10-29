// A fake `npm` for the headless-server e2e (07.12-09, PD-19): the workspace's install.sh runs
//   npm install --prefix <versions/<sha12>> --no-audit --no-fund --omit=optional --ignore-scripts <pins…>
// and this script answers it without the network or the real registry: it links the workspace's Claude Agent SDK (its
// real path in the pnpm store, so the SDK's own dependencies resolve from there) at <prefix>/node_modules and appends
// its arguments as one JSON line to <prefix>/../fake-npm.log. Any other call fails with "fake npm: unsupported", so a
// real npm call can never pass for a faked one. e2e/support/headless-server.ts puts a two-line `npm` wrapper that execs
// this file first on the scratch PATH.

import { appendFileSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SDK = "@anthropic-ai/claude-agent-sdk";
const WORKSPACE_SDK = join(
  import.meta.dirname,
  "..",
  "..",
  "apps",
  "local-runtime",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
);

const argv = process.argv.slice(2);
const prefixAt = argv.indexOf("--prefix");
const prefixArg = prefixAt >= 0 ? argv[prefixAt + 1] : undefined;
const wantsSdk = argv.some((a) => a.startsWith(`${SDK}@`));

if (argv[0] !== "install" || !prefixArg || prefixArg.startsWith("-") || !wantsSdk) {
  process.stderr.write(`fake npm: unsupported call: npm ${argv.join(" ")}\n`);
  process.exit(1);
}

const prefix = resolve(prefixArg);
mkdirSync(prefix, { recursive: true });
appendFileSync(join(prefix, "..", "fake-npm.log"), `${JSON.stringify(argv)}\n`);
const link = join(prefix, "node_modules", SDK);
mkdirSync(dirname(link), { recursive: true });
rmSync(link, { force: true });
symlinkSync(realpathSync(WORKSPACE_SDK), link, "dir");
