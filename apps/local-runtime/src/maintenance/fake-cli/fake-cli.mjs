#!/usr/bin/env node
// Phase 07.11 (runtime CLI auto-updates): a fake `claude`, `codex` and `npm` for the maintenance tests, 09's e2e
// specs and the Linux proof. Never a real installer: it only rewrites files inside the fake tree it was copied into
// (PD-19), so no test ever runs a real `claude update`, `codex update` or `npm install -g` on the machine.
//
// Plain Node with no import statements (built-ins through `process.getBuiltinModule`), so every copy runs whatever
// its file name is (`versions/2.1.290`, `bin/codex`, `bin/npm`) without a package.json next to it.
//
//   fake-cli.mjs install-fake claude-native <home> <version>
//   fake-cli.mjs install-fake codex-standalone <home> <version> [codexHome]
//   fake-cli.mjs install-fake claude-npm <prefix> <version>
//   fake-cli.mjs install-fake codex-npm <prefix> <version>
//
// Roles (by the name it was invoked as, else by where its real file lives):
//   claude --version → "<v> (Claude Code)";  claude update
//   codex --version  → "codex-cli <v>";       codex update
//   npm install -g --prefix <p> <pkg>@<v>
//   npm ci --prefix <p> …   (07.17.1 self-update: requires <p>/package.json and <p>/npm-shrinkwrap.json, writes a
//                            stub @anthropic-ai/claude-agent-sdk under <p>/node_modules)
// Control file `fake-update.json` in the install root: { next?, delayMs?, exitCode?, noise? } (all optional).
// Report file `fake-update-env.json` in the install root: the NAMES (never values) of the received variables that
// start with OCW_ or end with _API_KEY, and the first PATH entry.
// For `npm ci` both files live in <p>'s parent (the staging directory's, so they survive its rename): control
// `fake-update.json` ({ exitCode?, delayMs? }) and report `fake-npm-report.json` ({ argv, names, pathHead }).

const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");

const PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };

function self() {
  return fs.realpathSync(process.argv[1]);
}

function copySelf(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(self(), dest);
  fs.chmodSync(dest, 0o755);
}

/** Repoint `link` to `target` atomically: a temp symlink renamed over the old one. */
function repoint(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    fs.unlinkSync(tmp);
  } catch {}
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---- layouts ----

function installNpmPackage(prefix, role, version) {
  const pkg = PACKAGES[role];
  const pkgDir = path.join(prefix, "lib", "node_modules", pkg);
  writeJson(path.join(pkgDir, "package.json"), { name: pkg, version });
  copySelf(path.join(pkgDir, "bin", role));
  repoint(path.join(prefix, "bin", role), path.join(pkgDir, "bin", role));
  copySelf(path.join(prefix, "bin", "npm"));
}

function installFake(layout, dir, version, extra) {
  if (!layout || !dir || !version) {
    process.stderr.write("usage: fake-cli.mjs install-fake <layout> <dir> <version> [codexHome]\n");
    return 64;
  }
  const root = path.resolve(dir);
  if (layout === "claude-native") {
    const target = path.join(root, ".local", "share", "claude", "versions", version);
    copySelf(target);
    repoint(path.join(root, ".local", "bin", "claude"), target);
    return 0;
  }
  if (layout === "codex-standalone") {
    const codexHome = extra ? path.resolve(extra) : path.join(root, ".codex");
    const standalone = path.join(codexHome, "packages", "standalone");
    copySelf(path.join(standalone, "releases", `${version}-fake`, "bin", "codex"));
    repoint(path.join(standalone, "current"), path.join("releases", `${version}-fake`));
    repoint(path.join(root, ".local", "bin", "codex"), path.join(standalone, "current", "bin", "codex"));
    return 0;
  }
  if (layout === "claude-npm") {
    installNpmPackage(root, "claude", version);
    return 0;
  }
  if (layout === "codex-npm") {
    installNpmPackage(root, "codex", version);
    return 0;
  }
  process.stderr.write(`unknown layout: ${layout}\n`);
  return 64;
}

// ---- where am I ----

/** The role and the install this copy belongs to, from the invoked name and the real file. */
function whoAmI() {
  const invoked = path.basename(process.argv[1]);
  const real = self();
  const native = /^(.*)\/\.local\/share\/claude\/versions\/([^/]+)$/.exec(real);
  if (native) {
    const root = path.join(native[1], ".local", "share", "claude");
    return { role: "claude", kind: "native", root, home: native[1], version: native[2] };
  }
  const standalone = /^(.*\/packages\/standalone)\/releases\/([^/]+)\/bin\/codex$/.exec(real);
  if (standalone) {
    const dir = standalone[2];
    const version = dir.endsWith("-fake") ? dir.slice(0, -5) : (/^\d+\.\d+\.\d+/.exec(dir)?.[0] ?? "0.0.0");
    return { role: "codex", kind: "standalone", root: standalone[1], version };
  }
  const npmPkg =
    /^(.*)\/lib\/node_modules\/(@anthropic-ai\/claude-code|@openai\/codex)\/bin\/(claude|codex)$/.exec(real);
  if (npmPkg) {
    const pkgJson = readJson(path.join(npmPkg[1], "lib", "node_modules", npmPkg[2], "package.json"));
    return { role: npmPkg[3], kind: "npm", root: npmPkg[1], version: pkgJson?.version ?? "0.0.0" };
  }
  if (invoked === "npm") return { role: "npm", kind: "npm", root: path.dirname(path.dirname(real)) };
  const role = invoked === "codex" ? "codex" : invoked === "claude" ? "claude" : null;
  return { role, kind: "unknown", root: path.dirname(real), version: "0.0.0" };
}

function reportEnv(root) {
  const names = Object.keys(process.env)
    .filter((k) => k.startsWith("OCW_") || k.endsWith("_API_KEY"))
    .sort();
  const pathHead = (process.env.PATH ?? "").split(path.delimiter)[0] ?? "";
  writeJson(path.join(root, "fake-update-env.json"), {
    names,
    pathHead,
    noColor: process.env.NO_COLOR ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function control(root) {
  const c = readJson(path.join(root, "fake-update.json")) ?? {};
  if (typeof c.delayMs === "number" && c.delayMs > 0) await sleep(c.delayMs);
  if (typeof c.noise === "number" && c.noise > 0) {
    for (let i = 0; i < c.noise; i++) process.stdout.write(`progress line ${i} ${"#".repeat(60)}\n`);
  }
  return c;
}

async function update(me) {
  reportEnv(me.root);
  const c = await control(me.root);
  if (typeof c.exitCode === "number" && c.exitCode !== 0) {
    process.stderr.write(`Error: fake update failed with code ${c.exitCode} (${me.root})\n`);
    return c.exitCode;
  }
  const next = typeof c.next === "string" ? c.next : null;
  if (me.role === "claude") {
    if (!next || next === me.version) {
      process.stdout.write(`Claude Code is up to date (${me.version})\n`);
      return 0;
    }
    if (me.kind !== "native") {
      process.stderr.write("Error: this fake only updates a native install\n");
      return 1;
    }
    const target = path.join(me.root, "versions", next);
    copySelf(target);
    repoint(path.join(me.home, ".local", "bin", "claude"), target);
    process.stdout.write(`Installed to ${target}\n`);
    process.stdout.write(`Successfully updated from ${me.version} to version ${next}\n`);
    return 0;
  }
  if (!next || next === me.version) {
    process.stdout.write("Codex is up to date\n");
    return 0;
  }
  if (me.kind !== "standalone") {
    process.stderr.write("Error: this fake only updates a standalone install\n");
    return 1;
  }
  const release = path.join("releases", `${next}-fake`);
  copySelf(path.join(me.root, release, "bin", "codex"));
  repoint(path.join(me.root, "current"), release);
  process.stdout.write(`Installed to ${path.join(me.root, release)}\n`);
  process.stdout.write(`Updated Codex to ${next}\n`);
  return 0;
}

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

async function npmCi(args) {
  // npm ci --prefix <p> --no-audit --no-fund --omit=optional --ignore-scripts
  const at = args.indexOf("--prefix");
  if (at === -1 || !args[at + 1]) {
    process.stderr.write("npm error fake npm ci needs --prefix <p>\n");
    return 1;
  }
  const prefix = path.resolve(args[at + 1]);
  const parent = path.dirname(prefix);
  const names = Object.keys(process.env)
    .filter((k) => k.startsWith("OCW_") || k.endsWith("_API_KEY"))
    .sort();
  const pathHead = (process.env.PATH ?? "").split(path.delimiter)[0] ?? "";
  writeJson(path.join(parent, "fake-npm-report.json"), { argv: args, names, pathHead });
  const c = await control(parent);
  if (typeof c.exitCode === "number" && c.exitCode !== 0) {
    process.stderr.write(`npm error code EACCES\nnpm error path ${prefix}/node_modules\n`);
    return c.exitCode;
  }
  // `npm ci` installs only what package.json and the lockfile beside it name.
  for (const f of ["package.json", "npm-shrinkwrap.json"]) {
    if (!fs.existsSync(path.join(prefix, f))) {
      process.stderr.write(`npm error code EUSAGE\nnpm error fake npm ci: no ${f} in ${prefix}\n`);
      return 1;
    }
  }
  const sdk = path.join(prefix, "node_modules", SDK_PACKAGE);
  writeJson(path.join(sdk, "package.json"), { name: SDK_PACKAGE, version: "0.3.282", main: "index.js" });
  fs.writeFileSync(path.join(sdk, "index.js"), "module.exports = {};\n");
  process.stdout.write("\nadded 1 package in 1s\n");
  return 0;
}

async function npm(args) {
  if (args[0] === "ci") return npmCi(args);
  // npm install -g --prefix <p> <pkg>@<v>
  const at = args.indexOf("--prefix");
  if (args[0] !== "install" || !args.includes("-g") || at === -1 || !args[at + 1]) {
    process.stderr.write(`npm error fake npm only supports install -g --prefix <p> <pkg>@<v>\n`);
    return 1;
  }
  const prefix = path.resolve(args[at + 1]);
  const spec = args[args.length - 1] ?? "";
  const m = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(spec);
  if (!m) {
    process.stderr.write(`npm error invalid spec ${spec}\n`);
    return 1;
  }
  const [, pkg, wanted] = m;
  const pkgDir = path.join(prefix, "lib", "node_modules", pkg);
  const pkgJson = readJson(path.join(pkgDir, "package.json"));
  reportEnv(prefix);
  const c = await control(prefix);
  if (typeof c.exitCode === "number" && c.exitCode !== 0) {
    process.stderr.write(`npm error code EACCES\nnpm error path ${pkgDir}\n`);
    return c.exitCode;
  }
  const next = typeof c.next === "string" ? c.next : wanted;
  if (!pkgJson || pkgJson.version === next) {
    process.stdout.write(`\nup to date, audited 1 package in 1s\n`);
    return 0;
  }
  writeJson(path.join(pkgDir, "package.json"), { ...pkgJson, version: next });
  process.stdout.write(`\nchanged 1 package in 1s (${pkgDir})\nadded 1 package in 1s\n`);
  return 0;
}

async function main(argv) {
  if (argv[0] === "install-fake") return installFake(argv[1], argv[2], argv[3], argv[4]);
  const me = whoAmI();
  if (me.role === "npm") return npm(argv);
  if (me.role === null) {
    process.stderr.write("fake-cli: unknown role\n");
    return 64;
  }
  if (argv[0] === "--version") {
    process.stdout.write(
      me.role === "claude" ? `${me.version} (Claude Code)\n` : `codex-cli ${me.version}\n`,
    );
    return 0;
  }
  if (argv[0] === "update") return update(me);
  process.stderr.write(`fake-cli: unsupported arguments for ${me.role}\n`);
  return 64;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`fake-cli: ${err?.message ?? err}\n`);
    process.exitCode = 70;
  },
);
