// node --test scripts/e2e-env-parity.test.mjs
// CI env parity tripwire (07.8-08, C-03; the 07.4 lesson: a variable the local runner sets and CI does not hides a
// failure until the next CI run). Every `OCW_*` variable `scripts/e2e-isolated.sh` exports in its default mode must be
// set to the same value in the `&env` block of `.woodpecker/e2e.yaml`, or be listed in ALLOWED_DIFFERENCES with the
// reason it differs (ports and URLs CI derives from its own stack). The checks run on text read from both files, so a
// mutated copy proves the tripwire fires. The `--sandbox` mode's parity case is 07.8-24's (`.woodpecker/sandbox.yaml`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const RUNNER = readFileSync(new URL("./e2e-isolated.sh", import.meta.url), "utf8");
const CI = readFileSync(new URL("../.woodpecker/e2e.yaml", import.meta.url), "utf8");

/** Runner variables CI sets differently or not at all, each with the reason. Every entry must still be exported. */
const ALLOWED_DIFFERENCES = {
  OCW_PUBLIC_API_URL:
    "CI's API listens on :4000 from the .env `pnpm setup:env` writes; the runner uses :4290",
  OCW_PUBLIC_WEB_URL: "CI's web listens on :3000 from .env; the runner uses :3290",
  OCW_E2E_BASE_URL: "derived from the web URL above (Playwright's default is CI's :3000)",
  OCW_E2E_API_URL: "derived from the API URL above (the specs' default is CI's :4000)",
  OCW_API_URL: "derived from the API URL above",
  OCW_TRUSTED_ORIGINS: "the runner clears the demo's .env value; CI's fresh .env carries its own origins",
  OCW_PRESIDIO_URL: "the runner never inherits the demo's Presidio; CI's fresh .env has none",
  OCW_S3_PORT:
    "CI uses its compose Garage (keys and port from `pnpm setup:env`); the runner its own on :4292",
  OCW_S3_ENDPOINT: "as OCW_S3_PORT",
  OCW_S3_PUBLIC_URL: "as OCW_S3_PORT",
  OCW_S3_BUCKET: "as OCW_S3_PORT",
  OCW_S3_REGION: "as OCW_S3_PORT",
  OCW_S3_ACCESS_KEY_ID: "as OCW_S3_PORT",
  OCW_S3_SECRET_ACCESS_KEY: "as OCW_S3_PORT",
};

// ---------------------------------------------------------------- the runner (bash)

/** Top-level `NAME=value` assignments (the script's constants), for `$NAME` expansion. */
function constants(script) {
  const out = {};
  for (const line of script.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s#]*)/u.exec(line);
    if (m && !m[2].includes("$(")) out[m[1]] = unquote(m[2]);
  }
  return out;
}

const unquote = (v) => (/^".*"$|^'.*'$/su.test(v) ? v.slice(1, -1) : v);

/** `$NAME`, `${NAME}` and `${NAME:-default}` against `vars`; a caller's value is unknown, so the default wins. */
function expand(value, vars) {
  if (value.includes("$(")) return "<command substitution>";
  return value
    .replace(/\$\{([A-Z_][A-Z0-9_]*):-([^}]*)\}/gu, (_, name, def) =>
      name in vars && !name.startsWith("OCW_") ? vars[name] : expand(def, vars),
    )
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/gu, (_, a, b) => vars[a ?? b] ?? "");
}

/** The default mode only: the `--sandbox` section (its own header comment up to the next section) is dropped. */
function defaultMode(script) {
  const start = script.indexOf(
    "# ---------------------------------------------------------------- real sandboxd",
  );
  if (start === -1) return script;
  const next = script.indexOf(
    "# ----------------------------------------------------------------",
    start + 10,
  );
  return script.slice(0, start) + (next === -1 ? "" : script.slice(next));
}

/** Every `OCW_*` the runner exports in its default mode, with its value (later exports win, as in bash). */
function runnerExports(script) {
  const vars = constants(script);
  const out = {};
  for (const raw of defaultMode(script).split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("export ")) continue;
    const re = /([A-Z_][A-Z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s]*)/gu;
    for (const m of line.slice("export ".length).matchAll(re)) {
      const value = expand(unquote(m[2]), { ...vars, ...out });
      vars[m[1]] = value;
      if (m[1].startsWith("OCW_")) out[m[1]] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------- CI (the `&env` anchor of .woodpecker/e2e.yaml)

/** The `- &env` mapping: `KEY: value` lines indented under it (comments and quotes handled; flat values only). */
function ciEnv(yaml) {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^\s*- &env\s*$/u.test(l));
  assert.notEqual(at, -1, "the `&env` anchor exists in .woodpecker/e2e.yaml");
  const base = lines[at].search(/\S/u);
  const out = {};
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/u) <= base) break;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/u.exec(line);
    if (!m) continue;
    out[m[1]] = unquote(m[2].replace(/\s+#.*$/u, ""));
  }
  return out;
}

/** The parity problems: runner variables CI lacks or sets differently without an allowlist reason, and stale reasons. */
function parityProblems(script, yaml, allowed = ALLOWED_DIFFERENCES) {
  const runner = runnerExports(script);
  const ci = ciEnv(yaml);
  const problems = [];
  for (const [key, value] of Object.entries(runner)) {
    if (key in allowed) continue;
    if (!(key in ci))
      problems.push(`${key} is exported by scripts/e2e-isolated.sh but not set in .woodpecker/e2e.yaml`);
    else if (ci[key] !== value) problems.push(`${key}: runner "${value}" vs CI "${ci[key]}"`);
  }
  for (const key of Object.keys(allowed)) {
    if (!(key in runner)) problems.push(`${key} is allowlisted but the runner no longer exports it`);
  }
  return problems;
}

// ---------------------------------------------------------------- tests

describe("e2e env parity: scripts/e2e-isolated.sh (default mode) ↔ .woodpecker/e2e.yaml", () => {
  it("parses the runner's exports with their values", () => {
    const r = runnerExports(RUNNER);
    assert.equal(r.OCW_MODEL_PROVIDER, "mock");
    assert.equal(r.OCW_E2E_FAKE_URL, "http://127.0.0.1:4291");
    assert.equal(r.OCW_SIGNIN_RATE_LIMIT_PER_MINUTE, "600");
    assert.equal(r.OCW_CLAWHUB_URL, "http://127.0.0.1:4291");
    assert.equal(r.OCW_SANDBOX_URL, "http://127.0.0.1:4291/__sandboxd");
    assert.ok((r.OCW_SANDBOX_TOKEN ?? "").length >= 32, "a sandbox token of at least 32 characters");
    assert.equal(r.OCW_E2E_SANDBOX, "fake", "the --sandbox section is not the default mode");
  });

  it("every OCW_* the runner exports is set identically in CI or allowlisted with a reason", () => {
    assert.deepEqual(parityProblems(RUNNER, CI), []);
    for (const [key, reason] of Object.entries(ALLOWED_DIFFERENCES)) {
      assert.ok(reason.length >= 10, `${key} has a reason`);
    }
  });

  it("the tripwire fires: a CI copy without OCW_SANDBOX_TOKEN, or with another value, fails", () => {
    const without = CI.split("\n")
      .filter((l) => !/^\s*OCW_SANDBOX_TOKEN:/u.test(l))
      .join("\n");
    assert.match(parityProblems(RUNNER, without).join("\n"), /OCW_SANDBOX_TOKEN is exported .* but not set/u);
    const changed = CI.replace(/(OCW_SANDBOX_URL:\s*).*/u, "$1http://127.0.0.1:9999/__sandboxd");
    assert.match(parityProblems(RUNNER, changed).join("\n"), /OCW_SANDBOX_URL: runner/u);
    const newVar = RUNNER.replace(
      "export OCW_E2E_SANDBOX=fake",
      "export OCW_E2E_SANDBOX=fake OCW_NEW_THING=1",
    );
    assert.match(parityProblems(newVar, CI).join("\n"), /OCW_NEW_THING is exported/u);
  });

  it("a stale allowlist entry fails", () => {
    assert.match(
      parityProblems(RUNNER, CI, {
        ...ALLOWED_DIFFERENCES,
        OCW_GONE: "a reason that no longer applies",
      }).join("\n"),
      /OCW_GONE is allowlisted/u,
    );
  });

  it("CI starts the fake server with the fake sandboxd behind the same token, as the runner does", () => {
    const token = runnerExports(RUNNER).OCW_SANDBOX_TOKEN;
    assert.match(
      RUNNER,
      /FAKE_SANDBOX_TOKEN="\$FAKE_SANDBOX_TOKEN"[^\n]*\n?[^\n]*infra\/fake-model\/server\.mjs/u,
    );
    const start = CI.split("\n").find((l) => l.includes("infra/fake-model/server.mjs")) ?? "";
    assert.ok(
      start.includes(`FAKE_SANDBOX_TOKEN=${token}`) ||
        start.includes("FAKE_SANDBOX_TOKEN=$${OCW_SANDBOX_TOKEN}"),
      "the CI fake server gets FAKE_SANDBOX_TOKEN",
    );
  });
});
