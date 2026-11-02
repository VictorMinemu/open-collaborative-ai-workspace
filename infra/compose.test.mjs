// node --test infra/compose.test.mjs
//
// The compose contract Phase 7 builds on (FOUND-06, D-02, D-18), proven with `docker compose config` only (no
// container starts): a missing required secret fails interpolation naming it, the default service set is exactly the
// minimal profile, image tags follow OCW_IMAGE_TAG, api/web publish on OCW_PUBLISH_ADDRESS, and the api receives the
// proxy / telemetry / OpenBao pass-throughs (empty or false by default). Each optional profile (proxy,
// observability, vault) tests its own services in infra/<profile>/compose-*.test.mjs; this file never changes for them.
//
// Every call uses a temp env file, --project-directory the repo, an explicit `-p ocw-gate-config-<pid>` and a
// minimal environment (no inherited OCW_* / COMPOSE_* variables). The repository's .env is never read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = `ocw-gate-config-${process.pid}`;
const compose = readFileSync(path.join(ROOT, "compose.yaml"), "utf8");

/** Every variable compose.yaml requires (`:?` guard). */
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
const MINIMAL = ["api", "garage", "migrate", "openclaw", "postgres", "redis", "web"];
const PROFILE_FILES = [
  "infra/caddy/compose.yaml",
  "infra/observability/compose.yaml",
  "infra/openbao/compose.yaml",
];
const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const needsDocker = { skip: hasDocker ? false : "docker is not on PATH" };

let tmp;
let n = 0;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ocw-compose-contract-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** `docker compose config` with exactly `vars` in a temp env file; returns the raw spawn result. */
function configRaw(vars, { files = ["compose.yaml"], args = [] } = {}) {
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
  return spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      ROOT,
      "--env-file",
      envFile,
      "-p",
      PROJECT,
      ...files.flatMap((f) => ["-f", path.join(ROOT, f)]),
      ...args,
      "config",
      "--format",
      "json",
    ],
    { cwd: tmp, env, encoding: "utf8" },
  );
}

function config(vars, opts) {
  const res = configRaw(vars, opts);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

describe("compose.yaml: required secrets fail fast (FOUND-06)", () => {
  for (const name of Object.keys(REQUIRED)) {
    it(`a missing ${name} fails interpolation naming it`, needsDocker, () => {
      const vars = { ...REQUIRED };
      delete vars[name];
      const res = configRaw(vars);
      assert.notEqual(res.status, 0, `config succeeded without ${name}`);
      assert.match(res.stderr, new RegExp(name));
    });
  }

  it("keeps every `:?` guard for the required variables", () => {
    for (const name of Object.keys(REQUIRED)) assert.match(compose, new RegExp(`\\$\\{${name}:\\?`), name);
  });
});

describe("compose.yaml: default service set is the minimal profile (D-02)", () => {
  it("is exactly postgres, redis, garage, migrate, api, web and the openclaw cell", needsDocker, () => {
    assert.deepEqual(Object.keys(config(REQUIRED).services).sort(), MINIMAL);
  });

  it("includes the proxy, observability and vault profile files, which exist", () => {
    assert.match(compose, /^include:$/m);
    for (const f of PROFILE_FILES) {
      assert.match(compose, new RegExp(`^ {2}- ${f.replaceAll(".", "\\.")}$`, "m"), f);
      assert.ok(existsSync(path.join(ROOT, f)), `${f} exists`);
    }
  });
});

describe("compose.yaml: isolation knobs (D-18)", () => {
  it(
    "OCW_IMAGE_TAG tags every built image, including the e2e fake model and profile-only images",
    needsDocker,
    () => {
      const cfg = config(
        { ...REQUIRED, OCW_IMAGE_TAG: "gate-x" },
        { files: ["compose.yaml", "compose.e2e.yaml"], args: ["--profile", "*"] },
      );
      const ours = Object.entries(cfg.services).filter(([, s]) => s.build || s.image?.startsWith("ocw-"));
      assert.ok(
        ours.length >= 6,
        `expected api, migrate, web, openclaw, mcp-sandbox, fake-model; got ${ours.length}`,
      );
      for (const [name, s] of ours) {
        assert.match(s.image, /^ocw-[a-z-]+:gate-x$/, name);
        assert.doesNotMatch(s.image, /:local$/, name);
      }
      assert.equal(cfg.services.api.image, cfg.services.migrate.image, "api and migrate share one image");
      assert.equal(cfg.services["fake-model"].image, "ocw-fake-model:gate-x");
    },
  );

  it("without OCW_IMAGE_TAG the images stay :local (unchanged default)", needsDocker, () => {
    const cfg = config(REQUIRED, { files: ["compose.yaml", "compose.e2e.yaml"] });
    assert.equal(cfg.services.api.image, "ocw-api:local");
    assert.equal(cfg.services.migrate.image, "ocw-api:local");
    assert.equal(cfg.services.web.image, "ocw-web:local");
    assert.equal(cfg.services.openclaw.image, "ocw-openclaw:local");
    assert.equal(cfg.services["fake-model"].image, "ocw-fake-model:local");
  });

  it("OCW_PUBLISH_ADDRESS binds the api and web ports; unset keeps every interface", needsDocker, () => {
    const pinned = config({
      ...REQUIRED,
      OCW_PUBLISH_ADDRESS: "127.0.0.1",
      OCW_API_PORT: "3401",
      OCW_WEB_PORT: "3400",
    });
    assert.equal(pinned.services.api.ports[0].host_ip, "127.0.0.1");
    assert.equal(pinned.services.api.ports[0].published, "3401");
    assert.equal(pinned.services.api.ports[0].target, 4000);
    assert.equal(pinned.services.web.ports[0].host_ip, "127.0.0.1");
    assert.equal(pinned.services.web.ports[0].published, "3400");
    assert.equal(pinned.services.web.ports[0].target, 3000);
    const dflt = config(REQUIRED);
    for (const svc of ["api", "web"]) {
      const p = dflt.services[svc].ports[0];
      assert.ok(p.host_ip === undefined || p.host_ip === "0.0.0.0", `${svc} host_ip ${p.host_ip}`);
    }
    assert.equal(dflt.services.api.ports[0].published, "4000");
    assert.equal(dflt.services.web.ports[0].published, "3000");
  });

  it(
    "the api receives the proxy, telemetry and OpenBao pass-throughs, empty or false by default",
    needsDocker,
    () => {
      const api = config(REQUIRED).services.api.environment;
      assert.equal(api.OCW_TRUST_PROXY, "false");
      assert.equal(api.OTEL_EXPORTER_OTLP_ENDPOINT, "");
      assert.equal(api.OTEL_SERVICE_NAME, "ocw-api");
      for (const k of [
        "OCW_OPENBAO_ADDR",
        "OCW_OPENBAO_ROLE_ID",
        "OCW_OPENBAO_SECRET_ID",
        "OCW_OPENBAO_TOKEN",
      ]) {
        assert.equal(api[k], "", k);
      }
      const set = config({
        ...REQUIRED,
        OCW_TRUST_PROXY: "1",
        OCW_OTEL_ENDPOINT: "http://otel-collector:4318",
        OCW_OPENBAO_ADDR: "http://openbao:8200",
      }).services.api.environment;
      assert.equal(set.OCW_TRUST_PROXY, "1");
      assert.equal(set.OTEL_EXPORTER_OTLP_ENDPOINT, "http://otel-collector:4318");
      assert.equal(set.OCW_OPENBAO_ADDR, "http://openbao:8200");
    },
  );

  it(
    "the api passes OCW_JOBS_WORKER through, empty by default (the API reads empty as on; 07.6, ADR-0028)",
    needsDocker,
    () => {
      assert.equal(config(REQUIRED).services.api.environment.OCW_JOBS_WORKER, "");
      const off = config({ ...REQUIRED, OCW_JOBS_WORKER: "off" }).services.api.environment;
      assert.equal(off.OCW_JOBS_WORKER, "off");
    },
  );
});

describe("compose.yaml: the `sandbox` profile (07.8-24; D-01, D-11, D-12, principle 10)", () => {
  const SANDBOX_SERVICES = ["sandboxd", "sandbox-sbx-image", "sandbox-brw-image", "sandbox-egress-image"];
  const IMAGE_SERVICES = {
    "sandbox-sbx-image": "OCW_SANDBOX_SBX_IMAGE",
    "sandbox-brw-image": "OCW_SANDBOX_BRW_IMAGE",
    "sandbox-egress-image": "OCW_SANDBOX_EGRESS_IMAGE",
  };
  /** Every profile and the e2e override: the widest service set an install or a gate can run. */
  const everything = (vars = REQUIRED) =>
    config(vars, { files: ["compose.yaml", "compose.e2e.yaml"], args: ["--profile", "*"] });
  const withSandbox = (vars = REQUIRED) => config(vars, { args: ["--profile", "sandbox"] });
  const mountsSocket = (s) =>
    (s.volumes ?? []).some(
      (v) => String(v.source ?? v).includes("docker.sock") || String(v.target).includes("docker.sock"),
    );

  it(
    "sandboxd is the only service, in any profile, that mounts the Docker socket (T-07.8-24-01)",
    needsDocker,
    () => {
      const cfg = everything();
      const holders = Object.entries(cfg.services)
        .filter(([, s]) => mountsSocket(s))
        .map(([name]) => name);
      assert.deepEqual(holders, ["sandboxd"]);
      const sock = cfg.services.sandboxd.volumes.find((v) => String(v.target).includes("docker.sock"));
      assert.equal(sock.source, "/var/run/docker.sock");
      assert.equal(sock.target, "/var/run/docker.sock");
      assert.match(compose, /\/var\/run\/docker\.sock/);
      assert.equal(
        compose.split("\n").filter((l) => l.includes("/var/run/docker.sock")).length,
        1,
        "one line of compose.yaml names the socket: its mount",
      );
    },
  );

  it(
    "sandboxd: no port, read-only root, no capability, no-new-privileges, init, only `sandbox-control`",
    needsDocker,
    () => {
      const s = withSandbox().services.sandboxd;
      assert.equal(s.ports, undefined, "no published port");
      assert.equal(s.expose, undefined, "nothing exposed");
      assert.equal(s.read_only, true);
      assert.deepEqual(s.cap_drop, ["ALL"]);
      assert.equal(s.cap_add, undefined);
      assert.equal(s.privileged ?? false, false);
      assert.ok((s.security_opt ?? []).includes("no-new-privileges:true"));
      assert.equal(s.init, true);
      assert.ok(
        (s.tmpfs ?? []).some((t) => t.startsWith("/tmp")),
        "a tmpfs at /tmp",
      );
      assert.deepEqual(Object.keys(s.networks ?? {}), ["sandbox-control"]);
      assert.equal(s.image, "ocw-sandboxd:local");
      assert.equal(s.build.dockerfile, "infra/sandbox/sandboxd/Dockerfile");
    },
  );

  it(
    "`sandbox-control` is internal and its members are exactly api and sandboxd (T-07.8-24-05)",
    needsDocker,
    () => {
      for (const cfg of [everything(), withSandbox(), config(REQUIRED)]) {
        assert.equal(cfg.networks["sandbox-control"]?.internal, true);
        const members = Object.entries(cfg.services)
          .filter(([, s]) => Object.keys(s.networks ?? {}).includes("sandbox-control"))
          .map(([name]) => name)
          .sort();
        const expected = "sandboxd" in cfg.services ? ["api", "sandboxd"] : ["api"];
        assert.deepEqual(members, expected);
      }
    },
  );

  it("the openclaw cell carries no OCW_SANDBOX_* variable, with or without the profile", needsDocker, () => {
    const vars = { ...REQUIRED, OCW_SANDBOX_URL: "http://sandboxd:8090", OCW_SANDBOX_TOKEN: "t".repeat(48) };
    for (const cfg of [config(vars), withSandbox(vars), everything(vars)]) {
      const keys = Object.keys(cfg.services.openclaw.environment ?? {});
      assert.deepEqual(
        keys.filter((k) => k.startsWith("OCW_SANDBOX")),
        [],
      );
    }
  });

  it("the image-only services never start and build exactly the images sandboxd runs", needsDocker, () => {
    const cfg = withSandbox({ ...REQUIRED, OCW_IMAGE_TAG: "gate-x" });
    const env = cfg.services.sandboxd.environment;
    for (const [svc, variable] of Object.entries(IMAGE_SERVICES)) {
      const s = cfg.services[svc];
      assert.equal(s.scale, 0, `${svc} has scale 0`);
      assert.ok(s.build, `${svc} is built by compose`);
      assert.match(s.image, /^ocw-sandbox-(sbx|brw|egress):gate-x$/, svc);
      assert.equal(env[variable], s.image, `${variable} is ${svc}'s image`);
      assert.equal(s.networks, undefined, `${svc} joins no network`);
    }
    assert.equal(cfg.services.sandboxd.image, "ocw-sandboxd:gate-x");
  });

  it(
    "sandboxd's environment: namespace = project, registries, ClawHub equal to the API's, sweep, seccomp",
    needsDocker,
    () => {
      const env = withSandbox({ ...REQUIRED, OCW_SANDBOX_TOKEN: "t".repeat(48) }).services.sandboxd
        .environment;
      assert.equal(env.OCW_SANDBOX_TOKEN, "t".repeat(48));
      assert.equal(env.OCW_SANDBOX_NAMESPACE, PROJECT);
      assert.equal(env.OCW_SANDBOXD_HOST, "0.0.0.0");
      assert.equal(env.OCW_SANDBOXD_PORT, "8090");
      assert.equal(env.OCW_SANDBOX_RUNTIME, "auto");
      assert.equal(env.OCW_SANDBOX_BRW_SECCOMP, "/app/brw-seccomp.json");
      assert.equal(env.OCW_SANDBOXD_SWEEP_MS, "60000");
      assert.equal(env.OCW_SANDBOX_NPM_REGISTRY, "https://registry.npmjs.org/");
      assert.equal(env.OCW_SANDBOX_PYPI_INDEX, "https://pypi.org/simple/");
      assert.equal(env.OCW_SANDBOX_REGISTRIES, "");
      assert.equal(env.DOCKER_SOCKET, undefined, "the image's default socket path, the mounted one");
      // No value sandboxd would refuse: every variable it parses is set or has a default (an empty string is not unset).
      for (const k of ["OCW_SANDBOX_SBX_IMAGE", "OCW_SANDBOX_BRW_IMAGE", "OCW_SANDBOX_EGRESS_IMAGE"])
        assert.ok(env[k], k);

      const set = withSandbox({
        ...REQUIRED,
        OCW_CLAWHUB_URL: "http://clawhub.internal:8080",
        OCW_SANDBOX_RUNTIME: "runsc",
        OCW_SANDBOX_NAMESPACE: "ocw-prod",
        OCW_SANDBOXD_SWEEP_MS: "5000",
        OCW_SANDBOX_NPM_REGISTRY: "https://npm.internal/",
        OCW_SANDBOX_PYPI_INDEX: "https://pypi.internal/simple/",
        OCW_SANDBOX_REGISTRIES: "npm.internal,pypi.internal",
      }).services;
      assert.equal(set.sandboxd.environment.OCW_CLAWHUB_URL, set.api.environment.OCW_CLAWHUB_URL);
      assert.equal(set.sandboxd.environment.OCW_CLAWHUB_URL, "http://clawhub.internal:8080");
      assert.equal(set.sandboxd.environment.OCW_SANDBOX_RUNTIME, "runsc");
      assert.equal(set.sandboxd.environment.OCW_SANDBOX_NAMESPACE, "ocw-prod");
      assert.equal(set.sandboxd.environment.OCW_SANDBOXD_SWEEP_MS, "5000");
      assert.equal(set.sandboxd.environment.OCW_SANDBOX_NPM_REGISTRY, "https://npm.internal/");
      assert.equal(set.sandboxd.environment.OCW_SANDBOX_PYPI_INDEX, "https://pypi.internal/simple/");
      assert.equal(set.sandboxd.environment.OCW_SANDBOX_REGISTRIES, "npm.internal,pypi.internal");
    },
  );

  it(
    "without the profile: no sandbox service, the api's sandboxd URL is empty; the API takes URL and token from .env",
    needsDocker,
    () => {
      const cfg = config(REQUIRED);
      for (const s of SANDBOX_SERVICES) assert.equal(cfg.services[s], undefined, s);
      assert.equal(cfg.services.api.environment.OCW_SANDBOX_URL, "");
      assert.equal(cfg.services.api.environment.OCW_SANDBOX_TOKEN, "");
      const set = config({
        ...REQUIRED,
        OCW_SANDBOX_URL: "http://sandboxd:8090",
        OCW_SANDBOX_TOKEN: "t".repeat(48),
      });
      assert.equal(set.services.api.environment.OCW_SANDBOX_URL, "http://sandboxd:8090");
      assert.equal(set.services.api.environment.OCW_SANDBOX_TOKEN, "t".repeat(48));
      assert.doesNotMatch(
        compose,
        /\$\{OCW_SANDBOX_TOKEN:\?/,
        "no guard: compose interpolates inactive profiles too",
      );
    },
  );
});
