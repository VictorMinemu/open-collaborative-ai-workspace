// A fake `npm` for the headless-server e2e (07.12-09, PD-19): the workspace's install.sh runs
//   npm ci --prefix <versions/<sha12>> --no-audit --no-fund --omit=optional --ignore-scripts
// from the package.json and npm-shrinkwrap.json it wrote there (07.12 review ME-03), and this script answers it without
// the network or the real registry. It checks what `npm ci` would refuse to start without (both files, a v3 lockfile
// whose root dependencies equal package.json's, the Claude Agent SDK in it at that exact version with an integrity),
// links the workspace's Claude Agent SDK (its real path in the pnpm store, so the SDK's own dependencies resolve from
// there) at <prefix>/node_modules and appends its arguments as one JSON line to <prefix>/../fake-npm.log. Any other call
// fails with "fake npm: unsupported", so a real npm call can never pass for a faked one.
// e2e/support/headless-server.ts puts a two-line `npm` wrapper that execs this file first on the scratch PATH.

import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
const die = (message) => {
  process.stderr.write(`fake npm: ${message}\n`);
  process.exit(1);
};

if (argv[0] !== "ci" || !prefixArg || prefixArg.startsWith("-") || !argv.includes("--ignore-scripts")) {
  die(`unsupported call: npm ${argv.join(" ")}`);
}

const prefix = resolve(prefixArg);
let pkg;
let lock;
try {
  pkg = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"));
  lock = JSON.parse(readFileSync(join(prefix, "npm-shrinkwrap.json"), "utf8"));
} catch (err) {
  die(`npm ci needs package.json and npm-shrinkwrap.json in ${prefix}: ${err.message}`);
}
const pins = pkg.dependencies ?? {};
if (
  lock.lockfileVersion !== 3 ||
  JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify(pins)
) {
  die("package.json and npm-shrinkwrap.json are not in sync");
}
const sdkEntry = lock.packages[`node_modules/${SDK}`];
if (!pins[SDK] || sdkEntry?.version !== pins[SDK] || !/^sha512-/.test(sdkEntry.integrity ?? "")) {
  die(`${SDK} is not pinned with an integrity in npm-shrinkwrap.json`);
}

appendFileSync(join(prefix, "..", "fake-npm.log"), `${JSON.stringify(argv)}\n`);
const link = join(prefix, "node_modules", SDK);
mkdirSync(dirname(link), { recursive: true });
rmSync(link, { force: true });
symlinkSync(realpathSync(WORKSPACE_SDK), link, "dir");
