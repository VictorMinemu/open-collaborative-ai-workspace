// node --test infra/ci/slots.test.mjs
//
// The Woodpecker workflows run in parallel on one dind daemon (infra/ci/README.md). Read from .woodpecker/*.yaml as
// Woodpecker substitutes them (matrix entries, CI_COMMIT_SHA), every heavy workflow run owns a slot whose compose
// projects, label namespaces, names, port block and directories never meet another slot's, and
// infra/ci/slot-reset.sh, run against a fake `docker` listing every slot's objects (and a demo, a gate, Woodpecker's
// own and the pre-parallel CI names), removes exactly its own slot's objects.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { calls, installFakeDocker } from "./fake-docker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");
const WOODPECKER = path.join(ROOT, ".woodpecker");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SLOTS = ["verify", "e2e-desktop", "e2e-mobile", "cell-smoke", "sandbox"];
/** Keys whose value names Docker objects of the slot (compose projects, label namespaces, name prefixes). */
const NAME_KEYS = [
  "COMPOSE_PROJECT_NAME",
  "SMOKE_PREFIX",
  "OCW_SMOKE_NS_PREFIX",
  "OCW_E2E_STORAGE_PROJECT",
  "OCW_E2E_SANDBOX_NS",
  "OCW_PROOF_NS",
];
/** Ports browsers (ERR_UNSAFE_PORT) and Node `fetch` refuse (the Fetch standard's bad ports). */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const DIND_PORTS = [2375, 2376];
const EPHEMERAL_FROM = 32768;

// ---------------------------------------------------------------- the workflows as Woodpecker substitutes them

/** `matrix: include:` entries (flat `KEY: value` maps), or [{}] without a matrix. */
function matrixEntries(yaml) {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^matrix:\s*$/u.test(l));
  if (at === -1) return [{}];
  const entries = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/u.test(line)) break;
    const start = /^\s*-\s+([A-Z_][A-Z0-9_]*):\s*(.+?)\s*$/u.exec(line);
    const more = /^\s+([A-Z_][A-Z0-9_]*):\s*(.+?)\s*$/u.exec(line);
    if (start) entries.push({ [start[1]]: start[2] });
    else if (more && entries.length > 0) entries.at(-1)[more[1]] = more[2];
  }
  assert.ok(entries.length > 0, "matrix uses `include:` entries");
  return entries;
}

/** Woodpecker's substitution: `${NAME}` of the matrix entry and CI_COMMIT_SHA; `$${…}` stays for the shell. */
function substitute(yaml, vars) {
  return yaml.replace(/(?<!\$)\$\{([A-Z_][A-Z0-9_]*)\}/gu, (whole, name) => vars[name] ?? whole);
}

/** Every `KEY: value` line with an upper-case key (the env maps), as [key, value] pairs. */
function envPairs(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*([A-Z_][A-Z0-9_]*):\s*"?([^"#]*?)"?\s*(?:#.*)?$/u.exec(line);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

const code = (text) =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

/** One entry per workflow run: file, matrix entry, substituted text, slot and env pairs. */
function runs() {
  const out = [];
  for (const file of readdirSync(WOODPECKER).filter((f) => f.endsWith(".yaml"))) {
    const raw = readFileSync(path.join(WOODPECKER, file), "utf8");
    for (const entry of matrixEntries(raw)) {
      const text = substitute(raw, { ...entry, CI_COMMIT_SHA: SHA });
      const env = envPairs(text);
      const slots = [...new Set(env.filter(([k]) => k === "OCW_CI_SLOT").map(([, v]) => v))];
      assert.ok(slots.length <= 1, `${file}: one slot per run (${slots})`);
      out.push({ file, entry, text, env, slot: slots[0] ?? null });
    }
  }
  return out;
}

/** The port block NN of `pnpm setup:env --ports NN` and every port the run binds or calls on the dind's network. */
function ports(run) {
  const body = code(run.text);
  const blocks = [...body.matchAll(/setup:env --ports (\d+)/gu)].map((m) => Number(m[1]));
  const found = new Set();
  for (const re of [
    /(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)/gu,
    /\bPORT=(\d+)/gu,
    /\s-p (\d+)\b/gu,
    /_PORT:\s*"?(\d+)/gu,
  ]) {
    for (const m of body.matchAll(re)) found.add(Number(m[1]));
  }
  for (const nn of blocks) for (const n of [0, 1, 2, 3, 4]) found.add(nn * 100 + n); // setup:env publishes these
  return { blocks: [...new Set(blocks)], ports: [...found].sort((a, b) => a - b) };
}

const RUNS = runs();
const SLOTTED = RUNS.filter((r) => r.slot);
const prefixOf = (slot) => `ocw-ci-${slot}`;
const ofSlot = (slot, name) => name === prefixOf(slot) || name.startsWith(`${prefixOf(slot)}-`);
const valuesOf = (run, keys) => run.env.filter(([k]) => keys.includes(k)).map(([, v]) => v);

// ---------------------------------------------------------------- tests

describe("CI slots: each parallel workflow run owns its names, ports and directories", () => {
  it("the heavy workflows (and each e2e viewport) are exactly the slots, each once", () => {
    assert.deepEqual(SLOTTED.map((r) => r.slot).sort(), [...SLOTS].sort());
    for (const r of RUNS.filter((x) => !x.slot)) {
      assert.ok(["images.yaml", "housekeeping.yaml"].includes(r.file), `${r.file} has a slot`);
      assert.doesNotMatch(code(r.text), /compose|network_mode: host|slot-reset/u, `${r.file} needs no slot`);
    }
  });

  it("no slot name is another's name followed by a dash (a slot's prefix never matches another slot)", () => {
    for (const a of SLOTS)
      for (const b of SLOTS) if (a !== b) assert.ok(!ofSlot(b, prefixOf(a)), `${a} vs ${b}`);
  });

  it("every compose project, label namespace and name prefix a run sets belongs to its slot", () => {
    for (const r of SLOTTED) {
      const names = valuesOf(r, NAME_KEYS);
      for (const m of code(r.text).matchAll(/--project "?([^"\s]+)"?/gu)) {
        names.push(m[1] === "$${COMPOSE_PROJECT_NAME}" ? valuesOf(r, ["COMPOSE_PROJECT_NAME"])[0] : m[1]);
      }
      for (const n of names) assert.ok(ofSlot(r.slot, n), `${r.file} (${r.slot}): ${n}`);
      // The pre-parallel shared names and scripts are gone.
      assert.doesNotMatch(code(r.text), /ocw-e2e-|smoke-reset\.sh|e2e-reset\.sh|ocw-ci:local/u, r.file);
    }
    const all = SLOTTED.flatMap((r) => valuesOf(r, NAME_KEYS).map((n) => `${r.slot}:${n}`));
    const names = all.map((x) => x.split(":")[1]);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    for (const n of new Set(dup)) {
      const owners = new Set(all.filter((x) => x.endsWith(`:${n}`)).map((x) => x.split(":")[0]));
      assert.equal(owners.size, 1, `${n} is set by ${[...owners]}`);
    }
  });

  it("workspaces, temp dirs and failure reports live under the slot's own name", () => {
    for (const r of SLOTTED) {
      for (const w of valuesOf(r, ["W"])) assert.equal(w, `/home/ocw-ci/ws/${r.slot}`, r.file);
      for (const t of valuesOf(r, ["TMPDIR"])) assert.equal(t, `/home/ocw-ci/tmp/${r.slot}`, r.file);
      for (const o of valuesOf(r, ["PROOF_OUT"]))
        assert.ok(o.startsWith(`/home/ocw-ci/tmp/${r.slot}/`), r.file);
      for (const m of code(r.text).matchAll(/artifacts\/\$\$\{CI_PIPELINE_NUMBER\}-([a-z0-9-]+)/gu)) {
        assert.equal(m[1], r.slot, `${r.file}: failure reports of ${r.slot}`);
      }
    }
  });

  it("each slot's ports lie in its own block, below the ephemeral range, clear of dind and of refused ports", () => {
    const owner = new Map();
    for (const r of SLOTTED) {
      const { blocks, ports: ps } = ports(r);
      if (ps.length === 0) continue;
      assert.equal(blocks.length, 1, `${r.slot} publishes ports, so it owns exactly one block (${blocks})`);
      const [nn] = blocks;
      assert.ok(!owner.has(nn), `block ${nn} is ${owner.get(nn)}'s and ${r.slot}'s`);
      owner.set(nn, r.slot);
      assert.ok(nn * 100 + 99 < EPHEMERAL_FROM, `block ${nn} is below ${EPHEMERAL_FROM}`);
      for (const p of DIND_PORTS) assert.ok(Math.floor(p / 100) !== nn, `block ${nn} holds dind's ${p}`);
      for (const p of ps) {
        assert.equal(Math.floor(p / 100), nn, `${r.slot}: port ${p} outside its block ${nn}`);
        assert.ok(!BAD_PORTS.has(p), `${r.slot}: port ${p} is refused by browsers and fetch`);
      }
    }
    // Both e2e viewports and the sandbox proof publish ports.
    assert.deepEqual([...owner.values()].sort(), ["e2e-desktop", "e2e-mobile", "sandbox"]);
  });

  it("a slot is leased before anything of it is touched and released at the end of its cleanup", () => {
    for (const r of SLOTTED) {
      const body = code(r.text);
      const acquire = body.indexOf("sh infra/ci/slot-lease.sh acquire");
      assert.ok(acquire !== -1, `${r.slot} acquires its slot`);
      for (const first of ['rm -rf "$${W}"', "slot-reset.sh", "docker compose", "run-sandbox-smoke"]) {
        const at = body.indexOf(first);
        if (at !== -1) assert.ok(acquire < at, `${r.slot}: ${first} before the lease`);
      }
      const cleanup = body.slice(body.lastIndexOf("- name: cleanup"));
      const cmds = [...cleanup.matchAll(/^\s+- (.+)$/gmu)].map((m) => m[1]);
      assert.equal(cmds.at(-1), "sh infra/ci/slot-lease.sh release", `${r.slot}: release closes its cleanup`);
    }
  });

  it("every step image is this pipeline's ocw-ci:<commit>, built by build-image.sh with that tag", () => {
    for (const r of SLOTTED) {
      const images = [...code(r.text).matchAll(/image: (ocw-ci:\S+)/gu)].map((m) => m[1]);
      assert.ok(images.length > 0);
      for (const i of images) assert.equal(i, `ocw-ci:${SHA}`, r.file);
      assert.match(code(r.text), new RegExp(`sh infra/ci/build-image.sh ocw-ci:${SHA}`, "u"));
    }
  });
});

// ---------------------------------------------------------------- slot-reset.sh against every slot's real names

describe("infra/ci/slot-reset.sh removes its own slot's objects and nothing else", () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** The objects each slot's run creates, built from the names its workflow sets (and those its scripts derive). */
  function fixture() {
    const containers = [];
    const networks = [];
    const volumes = [];
    const images = [];
    const owner = new Map();
    let n = 0;
    const add = (slot, kind, obj) => {
      const id = `${kind[0]}${++n}`;
      const o = { id, ...obj };
      ({ c: containers, n: networks, v: volumes, i: images })[kind[0]].push(o);
      owner.set(kind === "v" ? o.name : id, slot);
    };
    const project = (slot, p) => {
      const labels = { "com.docker.compose.project": p };
      add(slot, "c", { name: `${p}-postgres-1`, labels });
      add(slot, "n", { name: `${p}_default`, labels });
      add(slot, "v", { name: `${p}_pgdata`, labels });
    };
    const namespace = (slot, ns) => {
      const labels = { "ocw.namespace": ns };
      add(slot, "c", { name: `ocw-sbx-${ns}-1a2b3c4d5e6f`, labels });
      add(slot, "n", { name: `${ns}-fixtures`, labels });
      add(slot, "v", { name: `ocw-ws-${ns}-1a2b3c4d5e6f`, labels });
      add(slot, "i", { ref: `ocw-sandbox-sbx:smoke-${ns}`, labels });
    };
    const named = (slot, p) => {
      add(slot, "c", { name: `${p}-openclaw`, labels: {} });
      add(slot, "n", { name: `${p}-net`, labels: {} });
      add(slot, "v", { name: `${p}-state`, labels: {} });
    };
    for (const r of SLOTTED) {
      const get = (k) => valuesOf(r, [k])[0];
      if (get("COMPOSE_PROJECT_NAME")) project(r.slot, get("COMPOSE_PROJECT_NAME"));
      if (get("OCW_E2E_STORAGE_PROJECT")) project(r.slot, get("OCW_E2E_STORAGE_PROJECT"));
      if (get("OCW_SMOKE_NS_PREFIX")) {
        namespace(r.slot, `${get("OCW_SMOKE_NS_PREFIX")}-42`);
        namespace(r.slot, `${get("OCW_SMOKE_NS_PREFIX")}-pkg-42`);
      }
      if (get("OCW_E2E_SANDBOX_NS")) namespace(r.slot, get("OCW_E2E_SANDBOX_NS"));
      if (get("OCW_PROOF_NS")) namespace(r.slot, get("OCW_PROOF_NS"));
      if (get("SMOKE_PREFIX")) named(r.slot, get("SMOKE_PREFIX"));
      if (r.slot === "sandbox") {
        // infra/ci/gvisor-dind.sh: its daemon and volumes carry the slot's gvisor namespace.
        const res = spawnSync("sh", [path.join(HERE, "gvisor-dind.sh"), "sock"], {
          env: { PATH: process.env.PATH, OCW_CI_SLOT: r.slot },
          encoding: "utf8",
        });
        assert.equal(res.stdout.trim(), `/home/ocw-ci/run/${prefixOf(r.slot)}-gvisor/docker.sock`);
        namespace(r.slot, `${prefixOf(r.slot)}-gvisor`);
      }
    }
    // Never any slot's: Woodpecker's own objects, a demo, a gate stack, an install and the pre-parallel CI names.
    for (const name of [
      "wp_01abcdef_0_default",
      "t3code-81d72154",
      "ocw-gate-abc123",
      "open-collaborative-ai-workspace",
    ]) {
      project("none", name);
    }
    for (const ns of ["ocw-e2e", "ocw-proof-sandbox", "ocw-smoke-4242", "ocw-smoke-pkg-7", "ocw-ci-gvisor"]) {
      namespace("none", ns);
    }
    project("none", "ocw-e2e-desktop");
    // A name that merely starts with a slot's prefix (no dash) is not the slot's.
    for (const slot of SLOTS) {
      project("none", `${prefixOf(slot)}x`);
      namespace("none", `${prefixOf(slot)}2`);
    }
    named("none", "ocw-smoke");
    named("none", "ocw-ci");
    return { state: { containers, networks, volumes, images }, owner };
  }

  for (const slot of SLOTS) {
    it(`slot ${slot}`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), "ocw-slot-reset-"));
      dirs.push(dir);
      const { state, owner } = fixture();
      installFakeDocker(dir, state);
      const res = spawnSync("sh", [path.join(HERE, "slot-reset.sh")], {
        env: { PATH: `${dir}:${process.env.PATH}`, OCW_CI_SLOT: slot },
        encoding: "utf8",
      });
      assert.equal(res.status, 0, res.stderr);
      const removed = calls(dir)
        .filter((c) => c.some((w) => w === "rm"))
        .flatMap((c) =>
          c.filter((w) => !w.startsWith("-") && !["rm", "network", "volume", "image"].includes(w)),
        );
      const expected = [...owner.entries()].filter(([, s]) => s === slot).map(([k]) => k);
      // verify creates nothing named (testcontainers only): its reset must remove nothing.
      assert.equal(expected.length > 0, slot !== "verify", `${slot}'s objects in the fixture`);
      assert.deepEqual([...new Set(removed)].sort(), expected.sort());
      for (const c of calls(dir)) assert.ok(!c.includes("prune"), "never a prune");
    });
  }

  it("refuses to run without a slot", () => {
    const res = spawnSync("sh", [path.join(HERE, "slot-reset.sh")], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0);
  });
});
