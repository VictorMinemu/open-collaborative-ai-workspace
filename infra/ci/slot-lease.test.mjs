// node --test infra/ci/slot-lease.test.mjs
//
// infra/ci/slot-lease.sh keeps one run per CI slot across pipelines: it waits while another pipeline's LIVE workflow
// (its Woodpecker workflow volume exists and is younger than the age bound) holds the slot, takes over at once from a
// cancelled or killed one, and of two runs asking at the same moment exactly one gets it. Against a fake `docker`
// (infra/ci/fake-docker.mjs) and a temp slots dir, never a real daemon.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { installFakeDocker } from "./fake-docker.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "slot-lease.sh");
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Docker's volume CreatedAt for `minutesAgo` minutes ago (UTC, RFC 3339). */
const created = (minutesAgo) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d+Z$/u, "Z");

/** A temp setup: fake docker whose daemon has `volumes` (name → minutes ago) and where this step mounts `own`. */
function setup({ volumes = {}, own = "wp_me_0_default" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ocw-slot-lease-"));
  dirs.push(dir);
  installFakeDocker(dir, {
    volumes: Object.entries(volumes).map(([name, ago]) => ({ name, createdAt: created(ago), labels: {} })),
    self: own ? { mounts: [own, "some-other-volume"] } : null,
  });
  const slots = path.join(dir, "slots");
  const run = (verb, env = {}) =>
    spawnSync("sh", [SCRIPT, verb], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        OCW_CI_SLOT: "e2e-desktop",
        OCW_CI_SLOTS_DIR: slots,
        CI_PIPELINE_NUMBER: "60",
        OCW_CI_LEASE_WAIT_S: "2",
        OCW_CI_LEASE_POLL_S: "1",
        ...env,
      },
      encoding: "utf8",
    });
  const lease = path.join(slots, "e2e-desktop.lease");
  const read = () => (existsSync(lease) ? readFileSync(lease, "utf8").trim().split(" ") : null);
  const write = (line) => {
    spawnSync("mkdir", ["-p", slots]);
    writeFileSync(lease, `${line}\n`);
  };
  return { dir, slots, run, read, write, lease };
}

const now = () => Math.floor(Date.now() / 1000);

describe("infra/ci/slot-lease.sh", () => {
  it("takes a free slot with this pipeline and its workflow volume, and gives it back", () => {
    const s = setup();
    const res = s.run("acquire");
    assert.equal(res.status, 0, res.stderr);
    const [pipeline, volume, at] = s.read();
    assert.deepEqual([pipeline, volume], ["60", "wp_me_0_default"]);
    assert.ok(Math.abs(Number(at) - now()) < 10);
    assert.equal(s.run("acquire").status, 0, "acquiring again is a no-op");
    assert.equal(s.run("release").status, 0);
    assert.equal(s.read(), null);
  });

  it("waits while another pipeline's live run holds the slot, then gives up without touching it", () => {
    const s = setup({ volumes: { wp_other_0_default: 10 } });
    s.write(`59 wp_other_0_default ${now() - 600}`);
    const res = s.run("acquire");
    assert.equal(res.status, 1);
    assert.match(res.stdout, /in use by pipeline 59 \(running\); waiting/u);
    assert.match(res.stderr, /still held by pipeline 59/u);
    assert.deepEqual(s.read().slice(0, 2), ["59", "wp_other_0_default"]);
  });

  it("takes over at once from a cancelled run (its workflow volume is gone) or one past the age bound", () => {
    for (const volumes of [{}, { wp_other_0_default: 200 }]) {
      const s = setup({ volumes });
      s.write(`59 wp_other_0_default ${now() - 60}`);
      const res = s.run("acquire");
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /pipeline 59's run has ended; taking its slot over/u);
      assert.deepEqual(s.read().slice(0, 2), ["60", "wp_me_0_default"]);
    }
  });

  it("a holder whose volume was unknown counts as live until the age bound", () => {
    const young = setup();
    young.write(`59 - ${now() - 60}`);
    assert.equal(young.run("acquire").status, 1);
    const old = setup();
    old.write(`59 - ${now() - 151 * 60}`);
    assert.equal(old.run("acquire").status, 0);
  });

  it("release never drops another run's lease", () => {
    const s = setup({ volumes: { wp_other_0_default: 5 } });
    s.write(`59 wp_other_0_default ${now()}`);
    assert.equal(s.run("release").status, 0);
    assert.deepEqual(s.read().slice(0, 2), ["59", "wp_other_0_default"]);
  });

  it("of two runs taking over at the same moment, exactly one gets the slot", async () => {
    const s = setup({ volumes: { wp_a_0_default: 1, wp_b_0_default: 1 } });
    const ask = (pipeline, own) => {
      const d = mkdtempSync(path.join(tmpdir(), "ocw-slot-lease-peer-"));
      dirs.push(d);
      installFakeDocker(d, {
        volumes: [
          { name: "wp_a_0_default", createdAt: created(1), labels: {} },
          { name: "wp_b_0_default", createdAt: created(1), labels: {} },
        ],
        self: { mounts: [own] },
      });
      return new Promise((resolve) => {
        const p = spawn("sh", [SCRIPT, "acquire"], {
          env: {
            PATH: `${d}:${process.env.PATH}`,
            OCW_CI_SLOT: "e2e-desktop",
            OCW_CI_SLOTS_DIR: s.slots,
            CI_PIPELINE_NUMBER: pipeline,
            OCW_CI_LEASE_WAIT_S: "1",
            OCW_CI_LEASE_POLL_S: "1",
          },
        });
        p.on("exit", (code) => resolve(code));
      });
    };
    for (let round = 0; round < 3; round++) {
      // A cancelled run's lease: both read it (one `docker volume inspect` each) before either writes.
      s.write(`59 wp_gone_0_default ${now() - 60}`);
      const codes = await Promise.all([ask("70", "wp_a_0_default"), ask("71", "wp_b_0_default")]);
      assert.deepEqual([...codes].sort(), [0, 1], `round ${round}: ${codes}`);
      const [holder] = s.read();
      assert.equal(holder, codes[0] === 0 ? "70" : "71");
    }
  });

  it("refuses to run without a slot", () => {
    const s = setup();
    assert.notEqual(s.run("acquire", { OCW_CI_SLOT: "" }).status, 0);
  });
});
