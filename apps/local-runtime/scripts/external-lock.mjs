// The npm lockfile for everything installed beside the bundle (07.12 review ME-03, D-10). The Claude Agent SDK and its
// peers are pinned exactly in package.json, but their own dependencies have ranges, so a plain `npm install` of the pins
// would load whatever the registry serves that day into the daemon that holds the device token. This builds an
// `npm-shrinkwrap.json` (lockfileVersion 3) for the whole tree the runtime was built and tested with:
//   - the tree and every package.json come from this checkout's installed node_modules (what pnpm resolved);
//   - every version's integrity (and the os/cpu of optional platform packages not installed here) comes from
//     pnpm-lock.yaml, so `npm ci` refuses any tarball whose bytes differ;
//   - packages are placed in npm's nested node_modules layout (hoisted when no other version is in the way).
// install.sh writes it with a matching package.json and runs `npm ci`, which installs exactly this tree or fails.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const EXTERNAL_LOCK_FILE = "npm-shrinkwrap.json";
/** The root package name in the lockfile and in the package.json install.sh writes next to it. */
export const EXTERNAL_LOCK_ROOT_NAME = "ocw-runtime-deps";
const REGISTRY = "https://registry.npmjs.org";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function fail(message) {
  throw new Error(`build-bundle: ${message}`);
}

/** The nearest pnpm-lock.yaml at or above `dir` (the repository root, or the pruned /app in the image build). */
export function findPnpmLock(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const candidate = join(d, "pnpm-lock.yaml");
    if (existsSync(candidate)) return candidate;
    if (dirname(d) === d) fail("pnpm-lock.yaml not found above apps/local-runtime");
  }
}

/** `name@version` → integrity and platform fields, from the `packages:` section of a pnpm v9 lockfile. */
export function readPnpmPackages(text) {
  const out = new Map();
  let inPackages = false;
  let current = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line === "packages:";
      current = null;
      continue;
    }
    if (!inPackages) continue;
    const header = /^ {2}(\S.*):$/.exec(line);
    if (header) {
      current = { key: header[1].replace(/^'(.*)'$/, "$1") };
      out.set(current.key, current);
      continue;
    }
    if (!current) continue;
    const integrity = /^ {4}resolution: \{integrity: ([A-Za-z0-9+/=-]+)\}$/.exec(line);
    if (integrity) current.integrity = integrity[1];
    const list = /^ {4}(os|cpu|libc): \[(.*)\]$/.exec(line);
    if (list) current[list[1]] = list[2].split(",").map((s) => s.trim().replace(/^'(.*)'$/, "$1"));
  }
  return out;
}

/** The installed package directory `name` resolves to from `fromDir` (Node's node_modules walk), or null. */
function findInstalled(fromDir, name) {
  for (let d = fromDir; ; d = dirname(d)) {
    if (!d.endsWith("/node_modules")) {
      const candidate = join(d, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    if (dirname(d) === d) return null;
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function tarballUrl(name, version) {
  const base = name.includes("/") ? name.split("/")[1] : name;
  return `${REGISTRY}/${name}/-/${base}-${version}.tgz`;
}

/** The lockfile fields npm reads from a package.json (edges, bins, platform), in a fixed order. */
function lockFields(meta) {
  const out = {};
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "engines",
    "os",
    "cpu",
    "libc",
  ]) {
    const value = meta[key];
    if (value !== undefined && !(typeof value === "object" && Object.keys(value).length === 0))
      out[key] = value;
  }
  // A string `bin` is the package's own name (without its scope), as npm writes it in a lockfile.
  if (typeof out.bin === "string") out.bin = { [meta.name.split("/").pop()]: out.bin };
  if (typeof meta.license === "string") out.license = meta.license;
  return out;
}

/**
 * The lockfile object for `pins` (the SDK and its peers, exact versions) as installed under `pkgRoot`. Every package
 * the runtime can load is in it with a version, its registry URL and its integrity; optional platform packages are
 * marked optional (install.sh omits them); optional peers nobody else requires are left out, as npm does.
 */
export function buildExternalLock({ pkgRoot, pins, pnpmLockText }) {
  const known = readPnpmPackages(pnpmLockText);
  /** location ("node_modules/a/node_modules/b") → { name, version, dir|null, meta, optional } */
  const placed = new Map();
  const queue = [];

  const locationsUp = (location) => {
    // From the deepest node_modules a package at `location` resolves through, up to the root's.
    const out = [];
    let loc = location;
    for (;;) {
      out.push(loc ? `${loc}/node_modules` : "node_modules");
      if (!loc) return out;
      const at = loc.lastIndexOf("/node_modules/");
      loc = at === -1 ? "" : loc.slice(0, at);
    }
  };

  const place = (name, version, dir, fromLocation, optional) => {
    const levels = locationsUp(fromLocation);
    for (const level of levels) {
      const existing = placed.get(`${level}/${name}`);
      if (!existing) continue;
      if (existing.version === version) {
        if (!optional) existing.optional = false;
        return;
      }
      // Another version is in the way from here up: nest right under the dependent.
      const nested = `${levels[0]}/${name}`;
      if (placed.has(nested)) fail(`cannot place ${name}@${version} at ${nested}`);
      return add(nested, name, version, dir, optional);
    }
    return add(`node_modules/${name}`, name, version, dir, optional);
  };

  const add = (location, name, version, dir, optional) => {
    const entry = known.get(`${name}@${version}`);
    if (!entry?.integrity) fail(`${name}@${version} has no integrity in pnpm-lock.yaml`);
    let meta;
    if (dir) {
      meta = readJson(join(dir, "package.json"));
      if (meta.version !== version) fail(`${dir} holds ${meta.name}@${meta.version}, not ${version}`);
    } else {
      // An optional platform package this machine did not install: what pnpm-lock.yaml records about it.
      meta = { ...(entry.os ? { os: entry.os } : {}), ...(entry.cpu ? { cpu: entry.cpu } : {}) };
      if (entry.libc) meta.libc = entry.libc;
    }
    const node = { name, version, dir, meta, optional, integrity: entry.integrity };
    placed.set(location, node);
    queue.push(location);
  };

  for (const { name, version } of pins) {
    const dir = findInstalled(pkgRoot, name);
    if (!dir) fail(`${name} is not installed (run pnpm install)`);
    place(name, version, dir, "", false);
  }

  while (queue.length > 0) {
    const location = queue.shift();
    const node = placed.get(location);
    if (!node.dir) continue;
    const meta = node.meta;
    const peerMeta = meta.peerDependenciesMeta ?? {};
    const edges = [
      ...Object.keys(meta.dependencies ?? {}).map((n) => [n, meta.dependencies[n], false]),
      ...Object.keys(meta.optionalDependencies ?? {}).map((n) => [n, meta.optionalDependencies[n], true]),
      ...Object.keys(meta.peerDependencies ?? {})
        .filter((n) => peerMeta[n]?.optional !== true)
        .map((n) => [n, meta.peerDependencies[n], false]),
    ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [depName, range, optionalEdge] of edges) {
      const depDir = findInstalled(node.dir, depName);
      if (depDir) {
        const depVersion = readJson(join(depDir, "package.json")).version;
        place(depName, depVersion, depDir, location, node.optional || optionalEdge);
      } else if (optionalEdge && EXACT_VERSION.test(range)) {
        place(depName, range, null, location, true);
      } else {
        fail(
          `${node.name}@${node.version} needs ${depName}@${range}, which is not installed (run pnpm install)`,
        );
      }
    }
  }

  const packages = {
    "": {
      name: EXTERNAL_LOCK_ROOT_NAME,
      dependencies: Object.fromEntries(pins.map((p) => [p.name, p.version])),
    },
  };
  for (const location of [...placed.keys()].sort()) {
    const node = placed.get(location);
    packages[location] = {
      version: node.version,
      resolved: tarballUrl(node.name, node.version),
      integrity: node.integrity,
      ...(node.optional ? { optional: true } : {}),
      ...lockFields(node.meta),
    };
  }
  return { name: EXTERNAL_LOCK_ROOT_NAME, lockfileVersion: 3, requires: true, packages };
}
