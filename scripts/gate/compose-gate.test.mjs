// node --test scripts/gate/compose-gate.test.mjs
//
// `pnpm gate:compose` stage selection (no Docker): the default run, --steps subsets in canonical order, the profile
// flags appending their stages (--with-sandbox after compose and Playwright), and unknown names refused before anything starts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkRuntimeDist, DEFAULT_STAGES, STAGES, selectStages, stackOptions } from "./compose-gate.mjs";

describe("selectStages", () => {
  it("runs compose, playwright, proxy, schema-refusal and backup by default", () => {
    assert.deepEqual(selectStages(), ["compose", "playwright", "proxy", "schema-refusal", "backup"]);
    assert.deepEqual(selectStages(), DEFAULT_STAGES);
  });

  it("--with-observability and --with-vault add their stages after the default ones", () => {
    assert.deepEqual(
      selectStages({ withObservability: true, withVault: true }),
      STAGES.filter((s) => s !== "sandbox"),
    );
    assert.deepEqual(selectStages({ withVault: true }).slice(-2), ["vault", "vault-backup"]);
  });

  it("--steps picks a subset and always runs it in canonical order", () => {
    assert.deepEqual(selectStages({ steps: "playwright" }), ["playwright"]);
    assert.deepEqual(selectStages({ steps: "backup, proxy,compose" }), ["compose", "proxy", "backup"]);
    assert.deepEqual(selectStages({ steps: "playwright", withVault: true }), [
      "playwright",
      "vault",
      "vault-backup",
    ]);
  });

  it("--with-sandbox adds the sandbox stage after compose and Playwright's first-run setup (07.8-24)", () => {
    assert.deepEqual(selectStages({ withSandbox: true }), [
      "compose",
      "playwright",
      "sandbox",
      "proxy",
      "schema-refusal",
      "backup",
    ]);
    assert.deepEqual(selectStages({ steps: "compose,sandbox", withSandbox: true }), ["compose", "sandbox"]);
    assert.deepEqual(selectStages({ steps: "compose", withSandbox: true }), ["compose", "sandbox"]);
    assert.deepEqual(selectStages({ withObservability: true, withVault: true, withSandbox: true }), STAGES);
    assert.ok(!selectStages().includes("sandbox"), "not in the default run");
  });

  it("the sandbox stage needs the sandbox profile: --steps sandbox without --with-sandbox is refused", () => {
    assert.throws(() => selectStages({ steps: "compose,sandbox" }), /--with-sandbox/);
  });

  it("the stack runs the sandbox profile (and the broker URL) only with --with-sandbox", () => {
    assert.deepEqual(stackOptions({ withSandbox: false }), { profiles: [], extra: {} });
    assert.deepEqual(stackOptions({ withSandbox: true }), {
      profiles: ["sandbox"],
      extra: { OCW_SANDBOX_URL: "http://sandboxd:8090" },
    });
  });

  it("refuses an unknown stage name", () => {
    assert.throws(() => selectStages({ steps: "playwright,scenario-c" }), /unknown stage.*scenario-c/);
  });
});

describe("checkRuntimeDist (07.12-06)", () => {
  const bundle = Buffer.from('console.log("ocw-runtime");\n');
  const sha = createHash("sha256").update(bundle).digest("hex");
  /** A fake fetch over a route → [status, body] table; records the URLs asked for. */
  const fakeFetch =
    (table, asked = []) =>
    async (url) => {
      asked.push(url);
      const route = url.replace(/^.*\/api\/v1\/runtime\//, "");
      const [status, body] = table[route] ?? [404, "{}"];
      return new Response(body, { status });
    };
  const good = () => ({
    version: [200, JSON.stringify({ version: "0.1.0", sha256: sha })],
    "bundle.sha256": [200, `${sha}  ocw-runtime.mjs\n`],
    bundle: [200, bundle],
    "install.sh": [200, "#!/bin/sh\nset -eu\n"],
  });

  it("passes when the four routes agree, with only the version and a sha prefix in its details", async () => {
    const asked = [];
    const res = await checkRuntimeDist("http://127.0.0.1:3400", { fetchImpl: fakeFetch(good(), asked) });
    assert.deepEqual(res, { ok: true, version: "0.1.0", sha: sha.slice(0, 12), commit: null });
    assert.deepEqual(asked, [
      "http://127.0.0.1:3400/api/v1/runtime/version",
      "http://127.0.0.1:3400/api/v1/runtime/bundle.sha256",
      "http://127.0.0.1:3400/api/v1/runtime/bundle",
      "http://127.0.0.1:3400/api/v1/runtime/install.sh",
    ]);
  });

  it("fails on a missing dist, a bundle that does not hash, a wrong checksum line or a non-sh script", async () => {
    const cases = [
      { version: [404, '{"error":{"code":"runtime_unavailable"}}'] },
      { bundle: [200, Buffer.from("tampered")] },
      { "bundle.sha256": [200, `${"0".repeat(64)}  ocw-runtime.mjs\n`] },
      { "install.sh": [200, "<html>"] },
    ];
    for (const override of cases) {
      const res = await checkRuntimeDist("http://x", { fetchImpl: fakeFetch({ ...good(), ...override }) });
      assert.equal(res.ok, false, JSON.stringify(override).slice(0, 40));
    }
  });

  it("names the AGPL source: the manifest's source.commit must be the commit the gate built (07.12-11)", async () => {
    const built = "a".repeat(40);
    const withCommit = (commit) => ({
      ...good(),
      version: [
        200,
        JSON.stringify({ version: "0.1.0", sha256: sha, source: { repository: "https://x", commit } }),
      ],
    });
    const same = await checkRuntimeDist("http://x", {
      fetchImpl: fakeFetch(withCommit(built)),
      sourceCommit: built,
    });
    assert.deepEqual(same, { ok: true, version: "0.1.0", sha: sha.slice(0, 12), commit: built.slice(0, 12) });
    for (const commit of [null, "b".repeat(40)]) {
      const res = await checkRuntimeDist("http://x", {
        fetchImpl: fakeFetch(withCommit(commit)),
        sourceCommit: built,
      });
      assert.equal(res.ok, false, String(commit));
      assert.match(res.reason, /source\.commit/);
    }
    // A dirty tree has no commit that is its source: nothing is required then.
    const dirty = await checkRuntimeDist("http://x", {
      fetchImpl: fakeFetch(withCommit(null)),
      sourceCommit: "",
    });
    assert.equal(dirty.ok, true);
  });

  it("compose passes OCW_SOURCE_COMMIT to the api image build (07.12-11)", () => {
    const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
    const migrate = compose.slice(compose.indexOf("\n  migrate:"), compose.indexOf("\n  api:"));
    assert.match(migrate, /dockerfile: apps\/api\/Dockerfile/);
    assert.match(migrate, /args:\n\s+OCW_SOURCE_COMMIT: \$\{OCW_SOURCE_COMMIT:-\}/);
  });
});
