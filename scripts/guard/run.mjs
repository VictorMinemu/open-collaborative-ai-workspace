#!/usr/bin/env node
// `pnpm guard`: the policy gate inside `pnpm verify` (D-08, FOUND-07). Node builtins only; never reads .env.
//   node scripts/guard/run.mjs                      # every check; reports every failure, then exits 1 if any
//   --only semgrep|licenses|fields|codeowners      # one check
//   --root <dir>                                    # scan another tree with this repository's rules (tests)
//   --rule-tests                                    # Semgrep's own fixture tests over .semgrep/tests/
// Semgrep is pinned and fails closed: `uvx --from semgrep==<pin>`, else the pinned Docker image, else exit 1 with an
// install hint. A missing runner is never a silent pass. Then: dependency licenses (full pnpm graph, the npm lockfiles
// outside it and the sbx Python lock joined with its licenses.json, against license-policy.json; the manifest itself
// must match its lock), workspace package license fields and LICENSE files, CODEOWNERS lint.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lint as lintCodeowners } from "./codeowners.mjs";
import { checkFields, checkGraph, checkPythonManifests, collectGraph, collectPackages } from "./licenses.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULES = join(REPO, ".semgrep", "rules.yml");
const FIXTURES = join(REPO, ".semgrep", "tests");
const SEMGREP_VERSION = "1.178.0";
const SEMGREP_IMAGE = `semgrep/semgrep:${SEMGREP_VERSION}@sha256:32e459968daabe7ab86968184a29109b9564aa00392401156f9788452b42786b`;
const SEMGREP_FLAGS = ["--metrics=off", "--disable-version-check"];
const TARGETS = ["apps", "packages", "infra", "e2e", "scripts"];
const POLICY = join(REPO, "scripts", "guard", "license-policy.json");
const CHECKS = ["semgrep", "licenses", "fields", "codeowners"];

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = option("--only");
const root = resolve(option("--root") ?? REPO);

const ok = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { stdio: "ignore", timeout: 20_000 }).status === 0;

/** The pinned Semgrep runner, or null. `mounts` are host directories the Docker runner must see. */
function semgrepRunner(cwd, mounts) {
  if (ok("uvx", ["--version"])) {
    return (semArgs) =>
      spawnSync("uvx", ["--from", `semgrep==${SEMGREP_VERSION}`, "semgrep", ...semArgs], {
        cwd,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
  }
  if (ok("docker", ["version", "--format", "{{.Server.Version}}"])) {
    const volumes = [...new Set([cwd, ...mounts])].flatMap((dir) => ["-v", `${dir}:${dir}`]);
    return (semArgs) =>
      spawnSync("docker", ["run", "--rm", ...volumes, "-w", cwd, SEMGREP_IMAGE, "semgrep", ...semArgs], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
  }
  return null;
}

const INSTALL_HINT =
  `Semgrep ${SEMGREP_VERSION} could not run: neither \`uvx\` nor a running \`docker\` was found.\n` +
  "  Install uv (https://docs.astral.sh/uv/getting-started/installation/, e.g. `brew install uv`) or start Docker,\n" +
  "  then re-run `pnpm guard`. The guard never skips Semgrep.";

function runSemgrep() {
  const runner = semgrepRunner(root, [REPO]);
  if (!runner) return [INSTALL_HINT];
  const targets = TARGETS.filter((t) => existsSync(join(root, t)));
  if (targets.length === 0) return [];
  const res = runner([
    "scan",
    "--config",
    RULES,
    "--error",
    "--json",
    "--quiet",
    ...SEMGREP_FLAGS,
    ...targets,
  ]);
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    return [`semgrep exited ${res.status} without a report:\n${(res.stderr || res.stdout || "").trim()}`];
  }
  const failures = report.results.map((r) => {
    const rule = /ocw\.[\w-]+$/.exec(r.check_id)?.[0] ?? r.check_id;
    return `${rule} ${r.path}:${r.start.line}`;
  });
  // Exit 1 = findings (with --error). Anything else non-zero is a Semgrep failure: fail closed.
  if (res.status !== 0 && !(res.status === 1 && failures.length > 0)) {
    const errors = (report.errors ?? []).map((e) => e.message ?? e.type).join("\n");
    failures.push(`semgrep exited ${res.status}${errors ? `:\n${errors}` : ""}`);
  }
  return failures;
}

function runRuleTests() {
  const runner = semgrepRunner(REPO, []);
  if (!runner) return [INSTALL_HINT];
  // `rules.<lang>` holds most rules' fixtures; a rule may keep its own file (07.8-16: live-input-logging.ts).
  const fixtures = readdirSync(FIXTURES).filter((f) => /\.(ts|sql)$/.test(f));
  if (fixtures.length === 0) return ["no rule fixtures under .semgrep/tests/"];
  const failures = [];
  // Semgrep's --test accepts one target at a time; each fixture holds annotated lines for one language.
  for (const fixture of fixtures.sort()) {
    const res = runner(["--test", "--config", RULES, join(FIXTURES, fixture), ...SEMGREP_FLAGS]);
    const out = `${res.stdout}${res.stderr}`.trim();
    if (res.status !== 0 || !/All tests passed/.test(out)) failures.push(`rule tests ${fixture}:\n${out}`);
    else console.log(`rule tests ${fixture}: ${out.split("\n")[0]}`);
  }
  return failures;
}

function runLicenses() {
  const policy = JSON.parse(readFileSync(POLICY, "utf8"));
  let entries;
  try {
    entries = collectGraph(root);
  } catch (error) {
    return [error.message];
  }
  const notes = [];
  const failures = [...checkGraph(entries, policy, notes), ...checkPythonManifests(root)];
  console.log(`licenses: ${entries.length} package versions checked`);
  for (const note of notes) console.log(note);
  return failures;
}

const runFields = () => checkFields(collectPackages(root));

function runCodeowners() {
  const file = join(root, ".github", "CODEOWNERS");
  if (!existsSync(file)) return [".github/CODEOWNERS is missing"];
  const tracked = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tracked.status !== 0) return [`git ls-files failed: ${tracked.stderr.trim()}`];
  return lintCodeowners(readFileSync(file, "utf8"), tracked.stdout.split("\0").filter(Boolean));
}

const RUNNERS = { semgrep: runSemgrep, licenses: runLicenses, fields: runFields, codeowners: runCodeowners };

function main() {
  if (args.includes("--rule-tests")) return report("rule-tests", runRuleTests());
  if (only && !CHECKS.includes(only)) {
    console.error(`unknown check "${only}"; expected one of ${CHECKS.join(", ")}`);
    return 1;
  }
  let failed = 0;
  for (const check of only ? [only] : CHECKS) failed += report(check, RUNNERS[check]());
  return failed > 0 ? 1 : 0;
}

function report(check, failures) {
  if (failures.length === 0) {
    console.log(`guard ${check}: ok${root !== REPO ? ` (${relative(process.cwd(), root) || "."})` : ""}`);
    return 0;
  }
  console.error(`guard ${check}: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  return 1;
}

process.exitCode = main();
