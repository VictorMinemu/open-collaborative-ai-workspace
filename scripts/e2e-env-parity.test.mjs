// node --test scripts/e2e-env-parity.test.mjs
// CI env parity tripwire (07.8-08, C-03; the 07.4 lesson: a variable the local runner sets and CI does not hides a
// failure until the next CI run). Every `OCW_*` variable `scripts/e2e-isolated.sh` exports in its default mode must be
// set to the same value in the `&env` block of `.woodpecker/e2e.yaml`, or be listed in ALLOWED_DIFFERENCES with the
// reason it differs (ports and URLs CI derives from its own stack). CI runs one stack per viewport, each on its own port
// block (infra/ci/README.md): every matrix entry is compared with the runner's exports for that entry's fake port, and
// its fake, API and web must listen where its URLs point. The checks run on text read from both files, so a mutated
// copy proves the tripwire fires. The `--sandbox` mode's case (07.8-24) compares the `sandbox-proof` step of
// `.woodpecker/sandbox.yaml` with the canonical local command of the real-stack proof and the runner's `--sandbox` mode.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const RUNNER = readFileSync(new URL("./e2e-isolated.sh", import.meta.url), "utf8");
const CI = readFileSync(new URL("../.woodpecker/e2e.yaml", import.meta.url), "utf8");
const SANDBOX_CI = readFileSync(new URL("../.woodpecker/sandbox.yaml", import.meta.url), "utf8");
const PROOF = readFileSync(new URL("./sandbox-proof.sh", import.meta.url), "utf8");

/** Runner variables CI sets differently or not at all, each with the reason. Every entry must still be exported. */
const ALLOWED_DIFFERENCES = {
  OCW_PUBLIC_API_URL:
    "CI's API listens on its slot's NN01 from the .env `pnpm setup:env --ports NN` writes; the runner uses :4290",
  OCW_PUBLIC_WEB_URL: "CI's web listens on its slot's NN00 from .env; the runner uses :3290",
  OCW_E2E_BASE_URL: "derived from the web URL above (CI: http://localhost:NN00)",
  OCW_E2E_API_URL: "derived from the API URL above (CI: http://localhost:NN01)",
  OCW_API_URL: "derived from the API URL above",
  OCW_TRUSTED_ORIGINS: "the runner clears the demo's .env value; CI's fresh .env carries its own origins",
  OCW_PRESIDIO_URL: "the runner never inherits the demo's Presidio; CI's fresh .env has none",
  OCW_S3_PORT:
    "CI uses its compose Garage (keys and port NN04 from `pnpm setup:env --ports NN`); the runner its own on :4292",
  OCW_S3_ENDPOINT: "as OCW_S3_PORT",
  OCW_S3_PUBLIC_URL: "as OCW_S3_PORT",
  OCW_S3_BUCKET: "as OCW_S3_PORT",
  OCW_S3_REGION: "as OCW_S3_PORT",
  OCW_S3_ACCESS_KEY_ID: "as OCW_S3_PORT",
  OCW_S3_SECRET_ACCESS_KEY: "as OCW_S3_PORT",
};

// ---------------------------------------------------------------- the runner (bash)

/** Top-level `NAME=value` assignments (the script's constants, `${OCW_E2E_*:-default}` read as the default). */
function constants(script) {
  const out = {};
  for (const line of script.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s#]*)/u.exec(line);
    if (m && !m[2].includes("$(")) out[m[1]] = expand(unquote(m[2]), out);
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

/**
 * Every `OCW_*` the runner exports in its default mode, with its value (later exports win, as in bash). `consts`
 * overrides the script's constants (a CI stack's fake port).
 */
function runnerExports(script, { sandbox = false, consts = {} } = {}) {
  const vars = { ...constants(script), ...consts };
  const out = {};
  for (const raw of (sandbox ? script : defaultMode(script)).split("\n")) {
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

/** `matrix: include:` entries of the workflow (flat `KEY: value` maps). */
function matrixEntries(yaml) {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^matrix:\s*$/u.test(l));
  assert.notEqual(at, -1, "the e2e workflow has a matrix");
  const entries = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/u.test(line)) break;
    const start = /^\s*-\s+([A-Z_][A-Z0-9_]*):\s*(.+?)\s*$/u.exec(line);
    const more = /^\s+([A-Z_][A-Z0-9_]*):\s*(.+?)\s*$/u.exec(line);
    if (start) entries.push({ [start[1]]: start[2] });
    else if (more && entries.length > 0) entries.at(-1)[more[1]] = more[2];
  }
  assert.ok(entries.length > 0, "the matrix lists its entries under `include:`");
  return entries;
}

/** The workflow text of one matrix entry, as Woodpecker substitutes it (`$${…}` stays for the shell). */
function forEntry(yaml, entry) {
  return yaml.replace(/(?<!\$)\$\{([A-Z_][A-Z0-9_]*)\}/gu, (whole, name) => entry[name] ?? whole);
}

const portOf = (url) => new URL(url).port;

/**
 * The parity problems of every matrix entry: runner variables CI lacks or sets differently without an allowlist
 * reason (the runner's exports taken with that entry's fake port), and stale reasons.
 */
function parityProblems(script, yaml, allowed = ALLOWED_DIFFERENCES) {
  const problems = [];
  for (const entry of matrixEntries(yaml)) {
    const ci = ciEnv(forEntry(yaml, entry));
    const fakePort = ci.OCW_E2E_FAKE_URL ? portOf(ci.OCW_E2E_FAKE_URL) : "";
    const runner = runnerExports(script, { consts: fakePort ? { FAKE_PORT: fakePort } : {} });
    const at = `[${Object.values(entry).join(" ")}] `;
    for (const [key, value] of Object.entries(runner)) {
      if (key in allowed) continue;
      if (!(key in ci))
        problems.push(
          `${at}${key} is exported by scripts/e2e-isolated.sh but not set in .woodpecker/e2e.yaml`,
        );
      else if (ci[key] !== value) problems.push(`${at}${key}: runner "${value}" vs CI "${ci[key]}"`);
    }
    for (const key of Object.keys(allowed)) {
      if (!(key in runner)) problems.push(`${key} is allowlisted but the runner no longer exports it`);
    }
  }
  return [...new Set(problems)];
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
  it("each viewport's fake, API and web listen where its URLs point, all in its own port block", () => {
    const entries = matrixEntries(CI);
    assert.equal(entries.length, 2, "desktop and mobile");
    const blocks = new Set();
    for (const entry of entries) {
      const text = forEntry(CI, entry);
      const ci = ciEnv(text);
      const fake = portOf(ci.OCW_E2E_FAKE_URL);
      const api = portOf(ci.OCW_E2E_API_URL);
      const web = portOf(ci.OCW_E2E_BASE_URL);
      const block = /pnpm setup:env --ports (\d+)/u.exec(text)?.[1];
      assert.ok(block, "setup:env writes the entry's port block");
      blocks.add(block);
      assert.deepEqual([web, api, fake], [`${block}00`, `${block}01`, `${block}91`]);
      const start = text.split("\n").find((l) => l.includes("infra/fake-model/server.mjs")) ?? "";
      assert.ok(start.includes(`(PORT=${fake} `), "the fake listens on the fake URL's port");
      assert.ok(
        start.includes(`FAKE_MCP_OAUTH_REDIRECTS=http://localhost:${api}/`),
        "OAuth redirects to this API",
      );
      assert.match(
        text,
        new RegExp(`cd apps/api && PORT=${api} `, "u"),
        "the API listens on the API URL's port",
      );
      assert.match(text, new RegExp(`next start -p ${web} `, "u"), "the web listens on the base URL's port");
    }
    assert.equal(blocks.size, entries.length, "one port block per viewport");
  });
});

// ---------------------------------------------------------------- --sandbox mode ↔ the `sandbox-proof` CI step (07.8-24)

/** Step env entries the `--sandbox` exports may differ from, each with the reason (none today). */
const SANDBOX_ALLOWED_OVERRIDES = {};

/**
 * The canonical local command of the real-stack proof, from scripts/sandbox-proof.sh's header: the `NAME=value`
 * assignments before `bash scripts/e2e-isolated.sh --sandbox --cmd "bash scripts/sandbox-proof.sh"`.
 */
function canonicalCallerVars(proof) {
  const header = proof
    .split("\n")
    .filter((l) => l.startsWith("#"))
    .map((l) => l.replace(/^#\s?/u, ""))
    .join("\n")
    .replace(/\\\n\s*/gu, " ");
  const line = header
    .split("\n")
    .find((l) => l.includes('bash scripts/e2e-isolated.sh --sandbox --cmd "bash scripts/sandbox-proof.sh"'));
  assert.ok(line, "scripts/sandbox-proof.sh documents its canonical command");
  const out = {};
  for (const m of line.split("bash scripts/e2e-isolated.sh")[0].matchAll(/([A-Z_][A-Z0-9_]*)=(\S+)/gu)) {
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** Variables the runner reads from its caller (`${NAME:-…}`, `${NAME-}`, `${!v-}` lists, `-z "${NAME:-}"`). */
function runnerCallerVars(script) {
  const out = new Set();
  for (const m of script.matchAll(/\$\{([A-Z_][A-Z0-9_]*):?-/gu)) out.add(m[1]);
  for (const m of script.matchAll(/^for v in ([A-Z0-9_ ]+); do$/gmu))
    for (const v of m[1].split(" ")) out.add(v);
  return out;
}

/** The `environment` mapping of the step named `name` (flat `KEY: value` lines). */
function stepEnv(yaml, name) {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*- name: ${name}\\s*$`, "u").test(l));
  assert.notEqual(at, -1, `the ${name} step exists`);
  const stepIndent = lines[at].search(/\S/u);
  const out = {};
  let envIndent = -1;
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/u);
    if (indent <= stepIndent) break;
    if (envIndent === -1) {
      if (/^\s*environment:\s*$/u.test(line)) envIndent = indent;
      continue;
    }
    if (indent <= envIndent) break;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/u.exec(line);
    if (m) out[m[1]] = unquote(m[2].replace(/\s+#.*$/u, ""));
  }
  assert.ok(Object.keys(out).length > 0, `the ${name} step has an inline environment mapping`);
  return out;
}

/** The step's commands as one string (to check it runs the canonical command). */
function stepCommands(yaml, name) {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*- name: ${name}\\s*$`, "u").test(l));
  const stepIndent = lines[at].search(/\S/u);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.search(/\S/u) <= stepIndent) break;
    body.push(line);
  }
  return body.join("\n");
}

function sandboxParityProblems(script, yaml, proof, allowed = SANDBOX_ALLOWED_OVERRIDES) {
  const problems = [];
  const canonical = canonicalCallerVars(proof);
  const step = stepEnv(yaml, "sandbox-proof");
  const honoured = runnerCallerVars(script);
  for (const [key, value] of Object.entries(canonical)) {
    if (!honoured.has(key) && !proof.includes(`\${${key}`))
      problems.push(`${key} is in the canonical command but neither the runner nor the proof reads it`);
    if (!(key in step))
      problems.push(`${key} is set by the canonical command but not in the sandbox-proof step`);
    else if (step[key] !== value) problems.push(`${key}: canonical "${value}" vs CI "${step[key]}"`);
  }
  const exports = runnerExports(script, { sandbox: true });
  for (const [key, value] of Object.entries(step)) {
    if (!(key in exports) || key in allowed) continue;
    if (exports[key] !== value)
      problems.push(`${key}: the step overrides the --sandbox export "${exports[key]}" with "${value}"`);
  }
  for (const key of Object.keys(step)) {
    if (key.startsWith("OCW_SANDBOX_") && !honoured.has(key) && !(key in exports))
      problems.push(`${key} is set in the step but the runner never reads it`);
  }
  if (
    !stepCommands(yaml, "sandbox-proof").includes(
      'bash scripts/e2e-isolated.sh --sandbox --cmd "bash scripts/sandbox-proof.sh"',
    )
  )
    problems.push("the sandbox-proof step does not run the canonical command");
  return problems;
}

describe("e2e env parity: scripts/e2e-isolated.sh --sandbox ↔ the sandbox-proof step of .woodpecker/sandbox.yaml", () => {
  it("reads the canonical command and the runner's --sandbox exports", () => {
    assert.deepEqual(canonicalCallerVars(PROOF), {
      OCW_BUNDLED_PLUGINS: "none",
      OCW_E2E_API_HOST: "0.0.0.0",
      OCW_MOCK_MODEL_BASE_URL: "http://fake-model:18999/v1",
      PROOF_BUILD: "1",
    });
    const exports = runnerExports(RUNNER, { sandbox: true });
    assert.equal(exports.OCW_E2E_SANDBOX, "real");
    assert.equal(exports.OCW_SANDBOX_URL, "http://127.0.0.1:4293");
    const honoured = runnerCallerVars(RUNNER);
    for (const v of [
      "OCW_BUNDLED_PLUGINS",
      "OCW_MOCK_MODEL_BASE_URL",
      "OCW_E2E_API_HOST",
      "OCW_SANDBOX_RUNTIME",
    ]) {
      assert.ok(honoured.has(v), `the runner reads ${v} from its caller`);
    }
  });

  it("the step sets every caller variable of the canonical command with the same value and overrides no export", () => {
    assert.deepEqual(sandboxParityProblems(RUNNER, SANDBOX_CI, PROOF), []);
  });

  it("the tripwire fires: a step without OCW_E2E_API_HOST, with PROOF_BUILD 0, or overriding an export fails", () => {
    const without = SANDBOX_CI.split("\n")
      .filter((l) => !/^\s*OCW_E2E_API_HOST:/u.test(l))
      .join("\n");
    assert.match(
      sandboxParityProblems(RUNNER, without, PROOF).join("\n"),
      /OCW_E2E_API_HOST is set by the canonical command but not in the sandbox-proof step/u,
    );
    const noBuild = SANDBOX_CI.replace(/(\n\s*PROOF_BUILD:\s*)"1"/u, '$1"0"');
    assert.notEqual(noBuild, SANDBOX_CI);
    assert.match(
      sandboxParityProblems(RUNNER, noBuild, PROOF).join("\n"),
      /PROOF_BUILD: canonical "1" vs CI "0"/u,
    );
    const override = SANDBOX_CI.replace(
      /(\n(\s*)PROOF_BUILD: "1")/u,
      "$1\n$2OCW_SANDBOX_URL: http://127.0.0.1:4291/__sandboxd",
    );
    assert.match(
      sandboxParityProblems(RUNNER, override, PROOF).join("\n"),
      /OCW_SANDBOX_URL: the step overrides/u,
    );
    const otherCmd = SANDBOX_CI.replace('--cmd "bash scripts/sandbox-proof.sh"', '--cmd "true"');
    assert.match(
      sandboxParityProblems(RUNNER, otherCmd, PROOF).join("\n"),
      /does not run the canonical command/u,
    );
  });
});
