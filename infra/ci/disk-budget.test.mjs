// node --test infra/ci/disk-budget.test.mjs
//
// infra/ci/disk-budget.sh runs while workflows of other pipelines may still be running on the same dind daemon. Against
// a fake `docker` (infra/ci/fake-docker.mjs) and a temp scratch dir: with another workflow alive it removes only what
// no running workflow can use (dangling images, and stopped containers, unused networks and volumes past the age
// window), never a tag, the unused images or the shared caches; once nothing else runs it also drops stale tags, the
// other commits' step image tags and, over budget, unused images and the caches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { calls, installFakeDocker } from "./fake-docker.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "disk-budget.sh");
const SHA = "abc123";
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/u, "Z");
/** `docker image ls` CreatedAt: "2026-10-22 07:22:10 +0000 UTC". */
const imageTime = (hoursAgo) => `${iso(hoursAgo).replace("T", " ").replace("Z", "")} +0000 UTC`;

function run({ othersAlive, overBudget }) {
  const dir = mkdtempSync(path.join(tmpdir(), "ocw-disk-budget-"));
  dirs.push(dir);
  const scratch = path.join(dir, "scratch");
  mkdirSync(path.join(scratch, "cache", "pnpm-store"), { recursive: true });
  const volumes = [
    { name: "wp_me_0_default", createdAt: iso(0.1), dangling: true },
    { name: "old-leftover", createdAt: iso(5), dangling: true },
    { name: "young-unused", createdAt: iso(1), dangling: true },
    { name: "in-use", createdAt: iso(9), dangling: false },
  ];
  if (othersAlive) volumes.push({ name: "wp_other_0_default", createdAt: iso(0.5), dangling: true });
  installFakeDocker(dir, {
    self: { mounts: ["wp_me_0_default"] },
    volumes,
    images: [
      { id: "i1", ref: "ocw-sandbox-sbx:smoke-old", createdAt: imageTime(30) },
      { id: "i2", ref: "ocw-sandbox-sbx:smoke-new", createdAt: imageTime(2) },
      { id: "i3", ref: "ocw-api:ci", createdAt: imageTime(48) },
      { id: "i4", ref: `ocw-ci:${SHA}`, createdAt: imageTime(3) },
      { id: "i4", ref: "ocw-ci:other-commit", createdAt: imageTime(3) },
      { id: "i5", ref: "ocw-ci:local", createdAt: imageTime(40) },
    ],
    df: overBudget ? ["70GB", "10GB"] : ["1GB", "0B"],
  });
  const res = spawnSync("sh", [SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      OCW_CI_SCRATCH: scratch,
      CI_COMMIT_SHA: SHA,
      OCW_CI_MIN_HOST_FREE_GB: "0",
      OCW_CI_SCRATCH_BUDGET_GB: overBudget ? "-1" : "1000",
    },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const log = calls(dir).map((c) => c.join(" "));
  return { log, out: res.stdout, cacheKept: existsSync(path.join(scratch, "cache")) };
}

const has = (log, re) => log.some((l) => re.test(l));

describe("infra/ci/disk-budget.sh with workflows of other pipelines running", () => {
  it("removes only objects no running workflow can use, and defers tags, unused images and caches", () => {
    const { log, out, cacheKept } = run({ othersAlive: true, overBudget: true });
    assert.match(out, /1 other workflow\(s\) running/u);
    assert.ok(log.includes("image prune -f"), "dangling images");
    assert.ok(log.includes("container prune -f --filter until=3h"));
    assert.ok(log.includes("network prune -f --filter until=3h"));
    assert.ok(log.includes("volume rm old-leftover"));
    for (const v of ["young-unused", "in-use", "wp_me_0_default", "wp_other_0_default"]) {
      assert.ok(!has(log, new RegExp(`volume rm .*${v}`, "u")), `${v} is kept`);
    }
    assert.ok(!has(log, /volume prune/u), "never an unfiltered volume prune");
    assert.ok(!has(log, /image rm/u), "no tag is removed");
    assert.ok(!has(log, /image prune -af/u), "unused images wait");
    assert.ok(has(log, /builder prune -f --max-used-space 15gb/u), "the build cache is bounded anyway");
    assert.ok(cacheKept, "the pnpm and uv caches stay");
  });
});

describe("infra/ci/disk-budget.sh with nothing else running", () => {
  it("also drops stale tags and other commits' step image tags, keeping this pipeline's", () => {
    const { log, out } = run({ othersAlive: false, overBudget: false });
    assert.doesNotMatch(out, /other workflow/u);
    assert.ok(log.includes("image rm ocw-sandbox-sbx:smoke-old"));
    assert.ok(log.includes("image rm ocw-api:ci"));
    assert.ok(!log.includes("image rm ocw-sandbox-sbx:smoke-new"), "inside the 24 h window");
    assert.ok(log.includes("image rm ocw-ci:other-commit"));
    assert.ok(log.includes("image rm ocw-ci:local"));
    assert.ok(!log.includes(`image rm ocw-ci:${SHA}`), "this pipeline's step image");
    assert.ok(!has(log, /image prune -af/u), "under budget");
  });

  it("over budget: unused images (except the step image) and the caches go", () => {
    const { log, cacheKept } = run({ othersAlive: false, overBudget: true });
    assert.ok(log.includes("image prune -af --filter label!=ocw.ci.keep=1"));
    assert.ok(!cacheKept);
  });
});
