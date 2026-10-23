// node --test infra/ci/smoke-reset.test.mjs
//
// infra/ci/smoke-reset.sh (07.8-24, Pitfalls 9 and 14): after a killed CI run it removes the smoke, e2e and proof
// objects by their `ocw.namespace` label and leaves every other namespace alone. Proven against a fake `docker` on
// PATH that lists objects of several namespaces and records what it is asked to remove, so the test never touches a
// real daemon (and never another run's objects).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "smoke-reset.sh");
let dir;
let calls;

const LISTED = {
  ps: [
    "c-smoke ocw-smoke-4242",
    "c-smoke-pkg ocw-smoke-pkg-77",
    "c-e2e ocw-e2e",
    "c-proof ocw-proof-sandbox",
    "c-gate ocw-gate-abc123",
    "c-install open-collaborative-ai-workspace",
    "c-e2e-other ocw-e2e-storage",
    "c-demo t3code-81d72154",
  ],
  network: ["n-smoke ocw-smoke-4242", "n-gate ocw-gate-abc123", "n-proof ocw-proof-browser"],
  volume: ["v-e2e ocw-e2e", "v-install ocw-prod", "v-smoke ocw-smoke-9"],
};

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-smoke-reset-"));
  calls = path.join(dir, "calls.log");
  const fake = path.join(dir, "docker");
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "ps -a") printf '%s\\n' ${LISTED.ps.map((l) => `'${l}'`).join(" ")} ;;
  "network ls") printf '%s\\n' ${LISTED.network.map((l) => `'${l}'`).join(" ")} ;;
  "volume ls") printf '%s\\n' ${LISTED.volume.map((l) => `'${l}'`).join(" ")} ;;
esac
exit 0
`,
  );
  chmodSync(fake, 0o755);
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("infra/ci/smoke-reset.sh", () => {
  it("removes ocw-smoke-*, ocw-e2e and ocw-proof-* objects by label and nothing else", () => {
    const res = spawnSync("sh", [SCRIPT], {
      env: { PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(calls, "utf8").trim().split("\n");
    const removed = (verb) =>
      log
        .filter((l) => l.startsWith(verb))
        .flatMap((l) => l.split(" ").slice(verb.split(" ").length))
        .filter((w) => !w.startsWith("-") && !w.startsWith("ocw-smoke-"));
    // The cell smoke's fixed names still go first.
    assert.ok(log.some((l) => l.startsWith("rm -fv ocw-smoke-openclaw")));
    assert.deepEqual(
      removed("rm -fv").filter((w) => w.startsWith("c-")),
      ["c-smoke", "c-smoke-pkg", "c-e2e", "c-proof"],
    );
    assert.deepEqual(
      removed("network rm").filter((w) => w.startsWith("n-")),
      ["n-smoke", "n-proof"],
    );
    assert.deepEqual(
      removed("volume rm").filter((w) => w.startsWith("v-")),
      ["v-e2e", "v-smoke"],
    );
    for (const kept of ["c-gate", "c-install", "c-e2e-other", "c-demo", "n-gate", "v-install"]) {
      assert.ok(!log.some((l) => / rm /.test(` ${l} `) && l.split(" ").includes(kept)), `${kept} is kept`);
    }
    // Listing is by label only; nothing is ever pruned.
    assert.ok(
      log.every((l) => !/\bprune\b/.test(l)),
      "no prune",
    );
    assert.ok(
      log
        .filter((l) => /^(ps -a|network ls|volume ls)/.test(l))
        .every((l) => l.includes("label=ocw.namespace")),
    );
  });
});
