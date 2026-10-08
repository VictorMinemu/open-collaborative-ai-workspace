// Shared helpers for every `pnpm ocw` command (Node builtins only): flags, env file resolution, in-place key updates,
// profiles, secret generators, names-only reporting and the `docker compose` arguments for an install's env file.
// Nothing here prints or logs a value read from or written to an env file.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The owner's running demo on the development machine (D-11). Its compose project is the main worktree's directory
 * name, so any `docker compose` there without `-p` would target it. No `ocw` command may operate on it, even when run
 * by hand: `composeArgs` refuses its project and its env files, `runCompose` refuses building under its image tag.
 * Its ports (3000/4000/3900/54329/63799) are the product defaults, so they are not refused here: a second project
 * publishing them cannot reach the demo (Docker refuses the bind); gate stacks use a `--ports` block instead.
 */
export const DEMO = Object.freeze({
  project: "t3code-81d72154",
  imageTag: "local",
  envDirs: [path.join(homedir(), ".ocw-demo"), path.join(homedir(), ".ocw")],
  envFileName: ".env.demo",
});

const KEY = /^[A-Z_][A-Z0-9_]*$/;
const LINE_KEY = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * Tiny flag parser. `spec = { boolean: [...], string: [...] }` (names without dashes). Returns
 * `{ opts, positionals }`; throws a usage error (message starts with the flag) on anything unexpected.
 */
export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.boolean ?? []);
  const strings = new Set(spec.string ?? []);
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (booleans.has(name)) {
      if (eq >= 0) throw usageError(`--${name} takes no value`);
      opts[name] = true;
    } else if (strings.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) {
        throw usageError(`--${name} needs a value`);
      }
      if (eq < 0) i++;
      opts[name] = value;
    } else {
      throw usageError(`Unknown option --${name}`);
    }
  }
  return { opts, positionals };
}

/** An Error commands report on stderr with exit code 2 (bad invocation, nothing was changed). */
export function usageError(message) {
  return Object.assign(new Error(message), { usage: true });
}

/** `--env-file <path>` | `--dir <dir>` → `<dir>/.env` | the repository's `.env`. */
export function resolveEnvFile(opts = {}) {
  if (opts["env-file"] && opts.dir) throw usageError("Use either --env-file or --dir, not both");
  if (opts["env-file"]) return path.resolve(opts["env-file"]);
  return path.join(opts.dir ? path.resolve(opts.dir) : REPO_ROOT, ".env");
}

/** `{ text, values }` of an env file. Values are for the caller's logic only; never log them. */
export function readEnv(file) {
  const text = readFileSync(file, "utf8");
  return { text, values: parseEnvText(text) };
}

/** KEY=value lines (comments and blank lines ignored; matching surrounding quotes stripped). Last one wins. */
export function parseEnvText(text) {
  const values = new Map();
  for (const line of text.split("\n")) {
    const m = LINE_KEY.exec(line);
    if (!m) continue;
    let value = line.slice(m[0].length).replace(/\r$/, "");
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    values.set(m[1], value);
  }
  return values;
}

/**
 * Pure text form of `setKeys`: replace each `KEY=…` line in place (with `uncomment`, a `# KEY=…` template line too)
 * and append the keys not found, under `# <header>` when given. Every other byte is kept.
 */
export function updateEnvText(text, entries, { header, uncomment = false } = {}) {
  const pairs = toPairs(entries);
  const lines = text.length === 0 ? [] : text.split("\n");
  const missing = [];
  for (const [key, value] of pairs) {
    const own = new RegExp(`^${key}=`);
    const commented = new RegExp(`^#\\s*${key}=`);
    let idx = lines.findIndex((l) => own.test(l));
    if (idx < 0 && uncomment) idx = lines.findIndex((l) => commented.test(l));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else missing.push(`${key}=${value}`);
  }
  let out = lines.join("\n");
  if (missing.length > 0) {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    if (header) out += `${out.length > 0 ? "\n" : ""}# ${header}\n`;
    out += `${missing.join("\n")}\n`;
  }
  return out;
}

/**
 * Replace `KEY=…` lines of `file` in place and append missing keys under an optional header; every other byte is
 * kept. Creates the file when missing. The file is left at mode 0600 after every write.
 */
export function setKeys(file, entries, { header } = {}) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  writePrivate(file, updateEnvText(current, entries, { header }));
}

/** Write `text` to `file` and force mode 0600 (writeFileSync's `mode` only applies when it creates the file). */
export function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Add `profile` to the comma list in COMPOSE_PROFILES (idempotent, existing order kept). */
export function addProfile(file, profile) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(profile)) throw usageError(`Invalid profile name: ${profile}`);
  const current = existsSync(file) ? (readEnv(file).values.get("COMPOSE_PROFILES") ?? "") : "";
  const list = current
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (list.includes(profile)) return false;
  setKeys(file, { COMPOSE_PROFILES: [...list, profile].join(",") });
  return true;
}

/** Random values from crypto.randomBytes. */
export const gen = Object.freeze({
  hex: (n) => randomBytes(n).toString("hex"),
  base64: (n) => randomBytes(n).toString("base64"),
  base64url: (n) => randomBytes(n).toString("base64url"),
  /** Database role passwords: 24 random bytes as hex (no characters that need URL encoding). */
  password: () => randomBytes(24).toString("hex"),
});

/** Print (and return) "Wrote KEY_A, KEY_B to <file>". Only names: anything that is not a key name is refused. */
export function reportWritten(keys, file, { log = console.log } = {}) {
  for (const key of keys) {
    if (!KEY.test(key)) throw new Error("reportWritten prints key names only");
  }
  const line = `Wrote ${keys.join(", ")} to ${file}`;
  log(line);
  return line;
}

/** Compose's default project name for a directory: lowercase, only [a-z0-9_-]. */
export function defaultProjectName(dir) {
  return path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

/** Throws when `file` is one of the demo's env files. By path only: the file is never opened. */
export function assertNotDemoEnvFile(file) {
  const abs = path.resolve(file);
  const inDemoDir = DEMO.envDirs.some((d) => abs === d || abs.startsWith(`${d}${path.sep}`));
  if (path.basename(abs) === DEMO.envFileName || inDemoDir) {
    throw new Error(`Refusing ${abs}: it belongs to the running demo, which ocw never operates on.`);
  }
}

/** Throws when `project` is the demo's compose project. */
export function assertNotDemoProject(project) {
  if (project === DEMO.project) {
    throw usageError(
      `Refusing compose project ${project}: it is the running demo, which ocw never operates on. ` +
        "Set COMPOSE_PROJECT_NAME in the env file (ocw setup --project <name>).",
    );
  }
}

/**
 * `docker compose` arguments for the install described by `file`:
 * `--project-directory <repo> --env-file <file> -p <project> [-f <file>…]`.
 * The project comes from the file's COMPOSE_PROJECT_NAME, else Compose's default for the project directory, and is
 * always passed explicitly so what is checked is what runs. COMPOSE_FILE entries are resolved against the project
 * directory (Compose 5.3 resolves them against the cwd). COMPOSE_PROFILES is honoured by Compose from --env-file.
 */
export function composeArgs(file, { projectDir = REPO_ROOT } = {}) {
  const abs = path.resolve(file);
  assertNotDemoEnvFile(abs);
  if (!existsSync(abs)) throw usageError(`${abs} does not exist: run \`pnpm ocw setup\` first.`);
  const { values } = readEnv(abs);
  const project = values.get("COMPOSE_PROJECT_NAME") || defaultProjectName(projectDir);
  assertNotDemoProject(project);
  const args = ["--project-directory", projectDir, "--env-file", abs, "-p", project];
  const composeFile = values.get("COMPOSE_FILE");
  if (composeFile) {
    const sep = values.get("COMPOSE_PATH_SEPARATOR") || (process.platform === "win32" ? ";" : ":");
    for (const f of composeFile.split(sep).filter(Boolean)) args.push("-f", path.resolve(projectDir, f));
  }
  return args;
}

/**
 * `docker compose <composeArgs(file)> <args>` with inherited stdio by default; returns the exit status.
 * Building under the demo's image tag is refused (it would retag the images the demo runs): set OCW_IMAGE_TAG.
 * `opts`: `{ env = process.env, stdio = "inherit", projectDir }`; other spawnSync options pass through.
 */
export function runCompose(file, args, opts = {}) {
  const { env = process.env, stdio = "inherit", projectDir, ...spawnOpts } = opts;
  const base = composeArgs(file, projectDir ? { projectDir } : {});
  const builds = args[0] === "build" || args.includes("--build");
  if (builds) {
    // Compose interpolation: a shell variable wins over the env file.
    const tag = env.OCW_IMAGE_TAG || readEnv(file).values.get("OCW_IMAGE_TAG") || DEMO.imageTag;
    if (tag === DEMO.imageTag) {
      throw usageError(
        "Refusing to build images tagged :local from ocw (the running demo uses them). " +
          "Set OCW_IMAGE_TAG in the env file (ocw setup --image-tag <tag>).",
      );
    }
  }
  const res = spawnSync("docker", ["compose", ...base, ...args], {
    cwd: projectDir ?? REPO_ROOT,
    env,
    stdio,
    ...spawnOpts,
  });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

function toPairs(entries) {
  const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
  for (const [key, value] of pairs) {
    if (!KEY.test(key)) throw usageError(`Invalid env key: ${JSON.stringify(key)}`);
    if (/[\r\n]/.test(String(value))) throw usageError(`The value for ${key} contains a newline`);
  }
  return pairs.map(([k, v]) => [k, String(v)]);
}
