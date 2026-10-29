// Builds the Local Runtime as one self-contained file (07.12, D-01, D-10, PD-03):
//   node scripts/build-bundle.mjs [--out <dir>] [--commit <sha>]
// writes <out>/ocw-runtime.mjs, <out>/npm-shrinkwrap.json and <out>/manifest.json (RuntimeDistManifest in
// @ocw/contracts). The API serves the bundle and the manifest and embeds the lockfile in install.sh (07.12-06); install.sh
// verifies the file and installs the Claude Agent SDK, its peers and their whole dependency tree beside it with
// `npm ci`, at the exact versions and integrity this checkout was built with (the SDK is never inside the file, D-10).
//
// Fails when any bundled input comes from the Claude Agent SDK, when a bundled third-party package's license is outside
// the allowlist, or when the SDK or one of its peer dependencies is not pinned to an exact version in package.json.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildExternalLock, EXTERNAL_LOCK_FILE, findPnpmLock } from "./external-lock.mjs";

/** Equal to `RUNTIME_BUNDLE_FILE` in packages/contracts/src/runtime-dist.ts. */
export const RUNTIME_BUNDLE_FILE = "ocw-runtime.mjs";
/** Equal to `BUNDLE_LICENSE_ALLOWLIST` in packages/contracts/src/runtime-dist.ts (bundle.test.ts checks it). */
export const BUNDLE_LICENSE_ALLOWLIST = [
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
];
export const CLAUDE_AGENT_SDK = "@anthropic-ai/claude-agent-sdk";
export const SOURCE_REPOSITORY = "https://github.com/VictorMinemu/open-collaborative-ai-workspace";
const MIN_NODE = 24;
/** `ws`'s optional native accelerators: loaded in a try/catch, ws falls back without them. */
const OPTIONAL_NATIVES = ["bufferutil", "utf-8-validate"];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`build-bundle: ${message}`);
}

function parseArgs(argv) {
  const out = { out: join(pkgRoot, "dist"), commit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg];
    const value = () => inline ?? argv[++i] ?? fail(`${name} needs a value`);
    if (name === "--out") {
      const dir = value();
      out.out = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    } else if (name === "--commit") out.commit = value();
    else fail(`unknown argument ${arg}`);
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** `--commit`, else `OCW_SOURCE_COMMIT`, else `git rev-parse HEAD` when this is a git checkout, else null. */
function sourceCommit(explicit) {
  const given = explicit ?? process.env.OCW_SOURCE_COMMIT;
  if (given !== undefined && given !== "") {
    if (!COMMIT.test(given)) fail(`the source commit must be 40 lowercase hex characters, got "${given}"`);
    return given;
  }
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: pkgRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return COMMIT.test(head) ? head : null;
  } catch {
    return null;
  }
}

/** The SDK followed by its peer dependencies, each at the exact version this package depends on (D-10). */
function externalPins(pkg) {
  const deps = pkg.dependencies ?? {};
  const pinned = (name) => {
    const version = deps[name];
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
      fail(
        `${name} must be pinned to an exact version in apps/local-runtime/package.json (found ${version ?? "none"})`,
      );
    }
    return { name, version };
  };
  const sdk = pinned(CLAUDE_AGENT_SDK);
  const sdkPkgPath = join(pkgRoot, "node_modules", ...CLAUDE_AGENT_SDK.split("/"), "package.json");
  if (!existsSync(sdkPkgPath)) fail(`${CLAUDE_AGENT_SDK} is not installed (run pnpm install)`);
  const sdkPkg = readJson(sdkPkgPath);
  if (sdkPkg.version !== sdk.version) {
    fail(
      `installed ${CLAUDE_AGENT_SDK} is ${sdkPkg.version}, package.json pins ${sdk.version} (run pnpm install)`,
    );
  }
  return [sdk, ...Object.keys(sdkPkg.peerDependencies ?? {}).map(pinned)];
}

/** `name` and package directory of a metafile input under node_modules; null for our own sources. */
function packageOf(input) {
  const path = input.replaceAll("\\", "/");
  const at = path.lastIndexOf("node_modules/");
  if (at === -1) return null;
  const rest = path.slice(at + "node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!name) return null;
  return { name, dir: resolve(pkgRoot, path.slice(0, at + "node_modules/".length) + name) };
}

/** One allowlisted license from a package.json `license` (an SPDX `A OR B` takes the first allowed alternative). */
function allowedLicense(raw) {
  const text = typeof raw === "string" ? raw : typeof raw?.type === "string" ? raw.type : "";
  const trimmed = text.trim().replace(/^\((.*)\)$/, "$1");
  if (/\sAND\s/i.test(trimmed)) return null;
  for (const alternative of trimmed.split(/\s+OR\s+/i)) {
    if (BUNDLE_LICENSE_ALLOWLIST.includes(alternative.trim())) return alternative.trim();
  }
  return null;
}

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
}

/** Every third-party package inlined into the bundle, sorted by name; fails on the SDK or a disallowed license. */
function bundledPackages(metafile) {
  const found = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const pkg = packageOf(input);
    if (!pkg) continue;
    if (pkg.name === CLAUDE_AGENT_SDK || pkg.name.startsWith(`${CLAUDE_AGENT_SDK}-`)) {
      fail(`${input} comes from ${CLAUDE_AGENT_SDK}, which is never bundled (D-10)`);
    }
    if (found.has(pkg.name)) continue;
    const meta = readJson(join(pkg.dir, "package.json"));
    const license = allowedLicense(meta.license);
    if (!license) {
      fail(
        `${pkg.name}@${meta.version} is licensed "${JSON.stringify(meta.license)}", outside the bundle allowlist`,
      );
    }
    found.set(pkg.name, { name: pkg.name, version: meta.version, license, text: licenseText(pkg.dir) });
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function noticesFooter(packages) {
  const lines = ["", "/*", " * Third-party software included in this file, with its license notices:"];
  for (const p of packages) {
    lines.push(" *", ` * ${p.name} ${p.version} (${p.license})`);
    if (p.text) {
      lines.push(" *");
      for (const line of p.text.replaceAll("*/", "* /").split(/\r?\n/)) lines.push(` *   ${line}`.trimEnd());
    }
  }
  lines.push(" */", "");
  return lines.join("\n");
}

export async function buildBundle({ out, commit } = {}) {
  const outDir = out ?? join(pkgRoot, "dist");
  const pkg = readJson(join(pkgRoot, "package.json"));
  const version = pkg.version;
  const external = externalPins(pkg);
  const result = await build({
    absWorkingDir: pkgRoot,
    entryPoints: [join(pkgRoot, "src", "cli.ts")],
    outfile: join(outDir, RUNTIME_BUNDLE_FILE),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    write: false,
    metafile: true,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    external: [CLAUDE_AGENT_SDK, ...OPTIONAL_NATIVES],
    define: { __OCW_RUNTIME_VERSION__: JSON.stringify(version) },
  });
  const packages = bundledPackages(result.metafile);
  const code = result.outputFiles.find((f) => f.path.endsWith(RUNTIME_BUNDLE_FILE));
  if (!code) fail("esbuild produced no bundle");

  // Line 1 names the file; line 2 gives CommonJS dependencies (ws) a `require` in ESM (RESEARCH Pitfall 1).
  const banner = [
    `// ocw-runtime ${version}: Open Collaborative AI Workspace Local Runtime. License: AGPL-3.0-only. Source: ${SOURCE_REPOSITORY}`,
    `import { createRequire as __ocwCreateRequire } from "node:module"; const require = __ocwCreateRequire(import.meta.url);`,
    "",
  ].join("\n");
  const text = `${banner}${code.text}${noticesFooter(packages)}`;
  const bytes = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // The whole external tree, exact versions and integrity (ME-03): install.sh installs it with `npm ci`.
  const lock = buildExternalLock({
    pkgRoot,
    pins: external,
    pnpmLockText: readFileSync(findPnpmLock(pkgRoot), "utf8"),
  });
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");

  const manifest = {
    version,
    sha256,
    bytes: bytes.length,
    file: RUNTIME_BUNDLE_FILE,
    minNode: MIN_NODE,
    external,
    externalLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    bundled: packages.map(({ name, version: v, license }) => ({ name, version: v, license })),
    source: { repository: SOURCE_REPOSITORY, commit: sourceCommit(commit) },
    builtAt: new Date().toISOString(),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, RUNTIME_BUNDLE_FILE), bytes);
  writeFileSync(join(outDir, EXTERNAL_LOCK_FILE), lockBytes);
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { manifest, outDir } = await buildBundle(parseArgs(process.argv.slice(2)));
    const mb = (manifest.bytes / 1024 / 1024).toFixed(1);
    process.stdout.write(
      `ocw-runtime ${manifest.version} sha256 ${manifest.sha256.slice(0, 12)} ${mb} MB (${manifest.bundled.length} bundled packages) → ${outDir}\n`,
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
