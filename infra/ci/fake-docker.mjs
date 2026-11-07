// A fake `docker` CLI for the infra/ci script tests (slot-reset, slot-lease, disk-budget, gvisor-dind). It answers the
// listing and inspect calls those scripts make from a JSON state file and records every call, so the tests prove which
// objects a script would remove without touching a real daemon (and never another run's objects).
//   installFakeDocker(dir, state) writes <dir>/docker and <dir>/state.json; calls(dir) returns the recorded argv lists.
// State: { containers: [{ id, name, labels }], networks: [{ id, name, labels }], volumes: [{ name, labels, createdAt,
// dangling }], images: [{ id, ref, labels, createdAt }], self: { mounts: [names] } | null, df: ["1.5GB", ...] }.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

export function installFakeDocker(dir, state) {
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const bin = path.join(dir, "docker");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${SELF}" "${dir}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

export function calls(dir) {
  const log = path.join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- the fake itself (run as a script)

function matchesFilter(obj, filter) {
  const [key, ...rest] = filter.split("=");
  const value = rest.join("=");
  if (key === "label") {
    const [k, ...v] = value.split("=");
    if (!(k in (obj.labels ?? {}))) return false;
    return v.length === 0 || obj.labels[k] === v.join("=");
  }
  if (key === "dangling") return Boolean(obj.dangling) === (value === "true");
  if (key === "name") return (obj.name ?? "").includes(value);
  if (key === "reference") {
    const re = new RegExp(`^${value.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return re.test(obj.ref);
  }
  throw new Error(`fake docker: unsupported filter ${filter}`);
}

function render(format, obj) {
  const [repo, tag] = (obj.ref ?? ":").split(":");
  return format
    .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, k) => obj.labels?.[k] ?? "")
    .replace(/\{\{\.ID\}\}/g, obj.id ?? "")
    .replace(/\{\{\.Names?\}\}/g, obj.name ?? "")
    .replace(/\{\{\.Repository\}\}/g, repo)
    .replace(/\{\{\.Tag\}\}/g, tag)
    .replace(/\{\{\.CreatedAt\}\}/g, obj.createdAt ?? "");
}

function list(objects, args, defaultField) {
  const filters = [];
  let format = null;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--filter" || args[i] === "-f") filters.push(args[++i]);
    else if (args[i] === "--format") format = args[++i];
    else if (args[i] === "-q") quiet = true;
  }
  // Same-key filters are OR'ed (reference=a reference=b), different keys AND'ed, as Docker does.
  const byKey = new Map();
  for (const f of filters) {
    const k = f.split("=")[0];
    byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  const out = objects.filter((o) => [...byKey.values()].every((fs) => fs.some((f) => matchesFilter(o, f))));
  return out.map((o) => (quiet ? o[defaultField] : format ? render(format, o) : o[defaultField])).join("\n");
}

function main() {
  const [dir, ...args] = process.argv.slice(2);
  const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
  writeFileSync(path.join(dir, "calls.log"), `${JSON.stringify(args)}\n`, { flag: "a" });
  const print = (s) => {
    if (s) process.stdout.write(`${s}\n`);
  };
  const images = [...(state.images ?? [])].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
  const [a, b] = args;
  if (a === "ps") return print(list(state.containers ?? [], args.slice(1), "id"));
  if (a === "network" && b === "ls") return print(list(state.networks ?? [], args.slice(2), "id"));
  if (a === "volume" && b === "ls") return print(list(state.volumes ?? [], args.slice(2), "name"));
  if (a === "image" && b === "ls") {
    // As Docker's image formatter: an image row has no .Label / .Labels field (containers, networks and volumes do).
    // The template fails once a row is rendered, so a script relying on it silently matches nothing.
    const at = args.indexOf("--format");
    const rows = list(images, args.slice(2), "id");
    if (at >= 0 && /\{\{\s*\.Labels?\b/u.test(args[at + 1] ?? "") && rows) {
      process.stderr.write(
        `template parsing error: template: :1:10: executing "" at <.Label>: can't evaluate field Label in type *formatter.imageContext\n`,
      );
      process.exit(1);
    }
    return print(rows);
  }
  if (a === "volume" && b === "inspect") {
    const v = (state.volumes ?? []).find((x) => x.name === args.at(-1));
    if (!v) process.exit(1);
    return print(v.createdAt ?? "");
  }
  if (a === "image" && b === "inspect") {
    const image = images.find((x) => x.ref === args.at(-1) || x.id === args.at(-1));
    if (!image) {
      process.stderr.write(`Error response from daemon: No such image: ${args.at(-1)}\n`);
      process.exit(1);
    }
    const at = args.indexOf("--format");
    if (at < 0) return print("[]");
    // `{{.Id}}` and `{{index .Config.Labels "<key>"}}`: the image fields the scripts read.
    return print(
      args[at + 1]
        .replace(/\{\{index \.Config\.Labels "([^"]+)"\}\}/g, (_, k) => image.labels?.[k] ?? "<no value>")
        .replace(/\{\{\.Id\}\}/g, image.id),
    );
  }
  if (a === "inspect") {
    if (!state.self) process.exit(1);
    return print(state.self.mounts.join("\n"));
  }
  if (a === "system" && b === "df") return print((state.df ?? ["0B"]).join("\n"));
  // rm, prune, create, run, builder ...: recorded only.
}

if (process.argv[1] === SELF) main();
