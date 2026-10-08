// License checks for `pnpm guard` (D-08, D-14, SELF-06). Node builtins only.
//   evaluate(spdxExpr, policy)        → "allow" | "deny"   (OR: any operand allowed; AND: all; unparseable: deny)
//   checkGraph(entries, policy, notes) → failures[]         (entries: { name, version, license, source })
//   checkFields(packages)             → failures[]         (packages: { dir, json, hasLicenseFile })
//   collectGraph(root)                → entries            (full pnpm graph + infra/mcp-sandbox/package-lock.json)
//   collectPackages(root)             → packages           (root, apps/*, packages/*, infra/* package.json)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Licenses a workspace package may declare; the Apache set is fixed by PRD §102 (protocol, SDKs, plugins). */
const PROJECT_LICENSES = ["AGPL-3.0-only", "Apache-2.0"];
const APACHE_PACKAGES = [
  "packages/contracts",
  "packages/realtime-client",
  "packages/protocol",
  "apps/openclaw-channel",
];

function tokenize(expr) {
  const tokens = [];
  for (const raw of expr.replace(/[()]/g, " $& ").trim().split(/\s+/)) {
    if (raw === "") continue;
    if (raw === "(" || raw === ")" || raw === "AND" || raw === "OR" || raw === "WITH") tokens.push(raw);
    else if (/^[A-Za-z0-9.+-]+$/.test(raw)) tokens.push({ id: raw });
    else return null;
  }
  return tokens;
}

/** Parses an SPDX expression into a tree; null when it is not one ("SEE LICENSE IN …", dangling operators). */
function parse(expr) {
  const tokens = typeof expr === "string" ? tokenize(expr) : null;
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  const atom = () => {
    const t = tokens[i++];
    if (t === "(") {
      const node = or();
      if (tokens[i++] !== ")") throw new Error("unbalanced");
      return node;
    }
    if (typeof t !== "object") throw new Error("expected a license id");
    // "X WITH exception": an exception only adds permissions, so the base license decides.
    if (tokens[i] === "WITH") {
      i += 1;
      if (typeof tokens[i++] !== "object") throw new Error("expected an exception id");
    }
    return t;
  };
  const and = () => {
    const nodes = [atom()];
    while (tokens[i] === "AND") {
      i += 1;
      nodes.push(atom());
    }
    return nodes.length === 1 ? nodes[0] : { and: nodes };
  };
  const or = () => {
    const nodes = [and()];
    while (tokens[i] === "OR") {
      i += 1;
      nodes.push(and());
    }
    return nodes.length === 1 ? nodes[0] : { or: nodes };
  };
  try {
    const tree = or();
    return i === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );

export function evaluate(expr, policy) {
  const allowed = new Set(policy.allow);
  const denied = policy.deny.map(globToRegExp);
  const ok = (node) => {
    if (node.or) return node.or.some(ok);
    if (node.and) return node.and.every(ok);
    return allowed.has(node.id) && !denied.some((re) => re.test(node.id));
  };
  const tree = parse(expr);
  return tree && ok(tree) ? "allow" : "deny";
}

const describe = (e) => `${e.name}@${e.version} (${e.license}) [${e.source}]`;
const adrLabel = (adr) => {
  const n = /(\d{4})-[^/]*$/.exec(adr ?? "")?.[1];
  return n ? `ADR-${n}` : adr;
};

export function checkGraph(entries, policy, notes = []) {
  const failures = [];
  const used = new Map();
  for (const entry of entries) {
    const clarified = (policy.clarifications ?? []).find(
      (c) => c.name === entry.name && c.version === entry.version,
    );
    const license = clarified ? clarified.license : entry.license;
    if (evaluate(license, policy) === "allow") continue;
    const exception = (policy.exceptions ?? []).find((x) =>
      x.match.some((m) => globToRegExp(m).test(entry.name)),
    );
    if (exception) {
      if (!used.has(exception)) used.set(exception, []);
      used.get(exception).push(`${entry.name}@${entry.version}`);
      continue;
    }
    failures.push(`license not allowed: ${describe(entry)}`);
  }
  for (const [x, covered] of used) {
    notes.push(
      `exception: ${x.name} (${x.status}, ${adrLabel(x.adr)}) covers ${covered.join(", ")}; ${x.reason}`,
    );
  }
  return failures;
}

export function checkFields(packages) {
  const failures = [];
  for (const { dir, json, hasLicenseFile } of packages) {
    const name = `${json.name ?? dir} (${dir || "."})`;
    if (!json.license) {
      failures.push(`${name}: package.json declares no "license"`);
      continue;
    }
    if (!PROJECT_LICENSES.includes(json.license)) {
      failures.push(`${name}: license "${json.license}" is not one of ${PROJECT_LICENSES.join(", ")}`);
      continue;
    }
    if (APACHE_PACKAGES.includes(dir) && json.license !== "Apache-2.0") {
      failures.push(
        `${name}: must be Apache-2.0 (protocol, SDK or plugin; PRD §102), declares "${json.license}"`,
      );
      continue;
    }
    if (json.license === "Apache-2.0" && !hasLicenseFile) {
      failures.push(`${name}: Apache-2.0 package ships no LICENSE file`);
    }
  }
  return failures;
}

export function collectGraph(root) {
  // Through a shell: some pnpm installs are shell stubs without a shebang (spawning them directly gives ENOEXEC).
  // The command line is a constant.
  const res = spawnSync("pnpm licenses list --json -r", {
    cwd: root,
    encoding: "utf8",
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(
      `pnpm licenses list failed: ${(res.error?.message ?? res.stderr ?? res.stdout ?? "").trim()}`,
    );
  }
  const entries = [];
  for (const [license, pkgs] of Object.entries(JSON.parse(res.stdout))) {
    for (const pkg of pkgs) {
      for (const version of pkg.versions) entries.push({ name: pkg.name, version, license, source: "pnpm" });
    }
  }
  const lockPath = join(root, "infra", "mcp-sandbox", "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
      if (path === "" || pkg.link) continue;
      const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "Unknown");
      const name = pkg.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      entries.push({ name, version: pkg.version, license, source: "infra/mcp-sandbox/package-lock.json" });
    }
  }
  return entries;
}

export function collectPackages(root) {
  const dirs = [""];
  for (const parent of ["apps", "packages", "infra"]) {
    if (!existsSync(join(root, parent))) continue;
    for (const child of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (child.isDirectory() && existsSync(join(root, parent, child.name, "package.json"))) {
        dirs.push(`${parent}/${child.name}`);
      }
    }
  }
  return dirs.map((dir) => ({
    dir,
    json: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")),
    hasLicenseFile: existsSync(join(root, dir, "LICENSE")),
  }));
}
