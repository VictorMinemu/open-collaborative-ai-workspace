// node --test infra/presidio/compose-pii.test.mjs
//
// The `pii` profile (MEM-05, D-06, D-08, C-04, T-07.2-05-01/05), proven with `docker compose config` only: no presidio
// service without the profile and the default service set unchanged; with it, a derived image built from this
// directory, no published port, read-only root, no capabilities, no-new-privileges, a memory limit, a healthcheck and
// only the internal `pii` network, which the api also joins. The api's Presidio variables default to empty (off). The
// Dockerfile pins the base image by digest and installs the Spanish model with --require-hashes. Temp env files, an
// explicit `-p ocw-gate-config-pii-<pid>` and a minimal environment; the repository's .env is never read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, "infra", "presidio");
const PROJECT = `ocw-gate-config-pii-${process.pid}`;
const DIGEST = "sha256:286e3fa7f3a7426e775e8564fe1870f1ba8f999d3ab8bbb8cc46a44355d9d6e9";
const PROFILE_FILE = readFileSync(path.join(DIR, "compose.yaml"), "utf8");
const DOCKERFILE = readFileSync(path.join(DIR, "Dockerfile"), "utf8");
const REQUIREMENTS = readFileSync(path.join(DIR, "requirements.txt"), "utf8");
const MINIMAL = ["api", "garage", "migrate", "openclaw", "postgres", "redis", "web"];
const REQUIRED = {
  POSTGRES_PASSWORD: "pg-x",
  OCW_DB_APP_PASSWORD: "app-x",
  OCW_DB_AUTH_PASSWORD: "auth-x",
  OCW_DB_MIGRATOR_PASSWORD: "migrator-x",
  BETTER_AUTH_SECRET: "auth-secret-x",
  OCW_SETUP_TOKEN: "setup-token-x",
  OCW_ENCRYPTION_KEY: "enc-key-x",
  OCW_CELL_TOKEN: "cell-token-x",
};
const PRESIDIO_VARS = ["OCW_PRESIDIO_URL", "OCW_PRESIDIO_LANGUAGES", "OCW_PRESIDIO_TIMEOUT_MS"];
const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const needsDocker = { skip: hasDocker ? false : "docker is not on PATH" };

let tmp;
let n = 0;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ocw-compose-pii-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function config(vars, args = []) {
  const envFile = path.join(tmp, `case-${++n}.env`);
  writeFileSync(
    envFile,
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
    { mode: 0o600 },
  );
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const k of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"])
    if (process.env[k]) env[k] = process.env[k];
  const res = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      ROOT,
      "--env-file",
      envFile,
      "-p",
      PROJECT,
      "-f",
      path.join(ROOT, "compose.yaml"),
      ...args,
      "config",
      "--format",
      "json",
    ],
    { cwd: tmp, env, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

describe("pii profile (infra/presidio)", () => {
  it("is off by default: no presidio service and the default service set is unchanged", needsDocker, () => {
    const cfg = config(REQUIRED);
    assert.equal(cfg.services.presidio, undefined);
    assert.deepEqual(Object.keys(cfg.services).sort(), MINIMAL);
  });

  it("COMPOSE_PROFILES=pii turns it on", needsDocker, () => {
    const cfg = config({ ...REQUIRED, COMPOSE_PROFILES: "pii" });
    assert.ok(cfg.services.presidio);
    assert.deepEqual(Object.keys(cfg.services).sort(), [...MINIMAL, "presidio"].sort());
  });

  it(
    "hardened: derived image, no published port, read-only, no capabilities, internal network only, healthcheck",
    needsDocker,
    () => {
      const cfg = config(REQUIRED, ["--profile", "pii"]);
      const svc = cfg.services.presidio;
      assert.ok(svc, "presidio service");
      assert.equal(svc.build.context, DIR);
      assert.equal(svc.image, "ocw-presidio:local");
      assert.equal(svc.ports, undefined, "Presidio publishes no port");
      assert.equal(svc.volumes, undefined, "no volume");
      assert.equal(svc.read_only, true);
      assert.deepEqual(svc.cap_drop, ["ALL"]);
      assert.equal(svc.cap_add, undefined);
      assert.deepEqual(svc.security_opt, ["no-new-privileges:true"]);
      assert.ok(
        Number(svc.mem_limit) > 0 && Number(svc.mem_limit) <= 2 * 1024 ** 3,
        `mem_limit ${svc.mem_limit}`,
      );
      assert.ok(
        svc.tmpfs.some((t) => t.startsWith("/tmp:")),
        "tmpfs /tmp",
      );
      assert.match(svc.healthcheck.test.join(" "), /http:\/\/127\.0\.0\.1:3000\/health/);
      assert.deepEqual(Object.keys(svc.networks), ["pii"]);
      assert.equal(cfg.networks.pii.internal, true);
    },
  );

  it(
    "the api joins the internal pii network and its Presidio variables default to empty (off)",
    needsDocker,
    () => {
      for (const args of [[], ["--profile", "pii"]]) {
        const cfg = config(REQUIRED, args);
        // `sandbox-control` (07.8-24) is the sandbox profile's own internal network, asserted in infra/compose.test.mjs.
        assert.deepEqual(Object.keys(cfg.services.api.networks).sort(), [
          "default",
          "pii",
          "sandbox-control",
        ]);
        for (const k of PRESIDIO_VARS) assert.equal(cfg.services.api.environment[k], "", k);
      }
      const on = config(
        {
          ...REQUIRED,
          COMPOSE_PROFILES: "pii",
          OCW_PRESIDIO_URL: "http://presidio:3000",
          OCW_PRESIDIO_LANGUAGES: "es",
          OCW_PRESIDIO_TIMEOUT_MS: "1500",
        },
        [],
      ).services.api.environment;
      assert.equal(on.OCW_PRESIDIO_URL, "http://presidio:3000");
      assert.equal(on.OCW_PRESIDIO_LANGUAGES, "es");
      assert.equal(on.OCW_PRESIDIO_TIMEOUT_MS, "1500");
    },
  );

  it("only presidio and the api are on the pii network", needsDocker, () => {
    const cfg = config(REQUIRED, ["--profile", "*"]);
    const members = Object.entries(cfg.services)
      .filter(([, s]) => s.networks && "pii" in s.networks)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(members, ["api", "presidio"]);
  });

  it("the profile file holds no port, no volume and no credential", () => {
    assert.doesNotMatch(PROFILE_FILE, /^\s*ports:/m);
    assert.doesNotMatch(PROFILE_FILE, /^\s*volumes:/m);
    const settings = PROFILE_FILE.split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(settings, /password|secret|token/i);
    assert.match(PROFILE_FILE, /profiles: \["pii"\]/);
  });

  it("the Dockerfile pins the base by digest, installs the model by hash and keeps a non-root user", () => {
    const from = DOCKERFILE.split("\n").filter((l) => l.startsWith("FROM "));
    assert.deepEqual(from, [`FROM mcr.microsoft.com/presidio-analyzer:2.2.362@${DIGEST}`]);
    assert.match(DOCKERFILE, /pip install --no-cache-dir --no-deps --require-hashes -r /);
    const users = DOCKERFILE.split("\n").filter((l) => l.startsWith("USER "));
    assert.equal(users.at(-1), "USER 1001", "the last USER is the image's non-root user");
    for (const f of ["ANALYZER_CONF_FILE", "NLP_CONF_FILE", "RECOGNIZER_REGISTRY_CONF_FILE"])
      assert.match(DOCKERFILE, new RegExp(`${f}=/app/ocw-conf/`), f);
  });

  it("requirements.txt pins exactly one wheel from the official release by sha256", () => {
    const reqs = REQUIREMENTS.split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .join("\n")
      .replace(/\\\n\s*/g, " ");
    assert.match(
      reqs,
      /^es-core-news-md @ https:\/\/github\.com\/explosion\/spacy-models\/releases\/download\/es_core_news_md-3\.8\.0\/es_core_news_md-3\.8\.0-py3-none-any\.whl\s+--hash=sha256:[0-9a-f]{64}$/,
    );
  });

  it("the NLP and registry configuration cover es and en", () => {
    const nlp = readFileSync(path.join(DIR, "nlp-config.yaml"), "utf8");
    assert.match(nlp, /lang_code: es\n\s+model_name: es_core_news_md/);
    assert.match(nlp, /lang_code: en\n\s+model_name: en_core_web_lg/);
    for (const f of ["recognizers.yaml", "analyzer-config.yaml"]) {
      const text = readFileSync(path.join(DIR, f), "utf8");
      assert.match(text, /^supported_languages:\n {2}- es\n {2}- en$/m, f);
    }
    const registry = readFileSync(path.join(DIR, "recognizers.yaml"), "utf8");
    for (const r of ["EsNifRecognizer", "EsNieRecognizer", "EmailRecognizer", "IbanRecognizer"])
      assert.match(registry, new RegExp(`name: ${r}`), r);
  });
});
