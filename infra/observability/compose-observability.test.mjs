// node --test infra/observability/compose-observability.test.mjs
//
// The `observability` profile's compose contract (FOUND-05, D-05, D-13, T-07-07-02/03), proven with
// `docker compose config` only (nothing starts): off by default; with the profile, exactly the collector, Tempo,
// Prometheus, Loki and Grafana, each pinned by digest; only Grafana publishes a port, on 127.0.0.1; one named volume
// per stateful backend; Grafana's anonymous access is off, its admin password comes from OCW_GRAFANA_ADMIN_PASSWORD and
// its entrypoint refuses an empty or default one. Temp env file, `-p ocw-gate-config-obs-<pid>`, minimal environment:
// the repository's .env is never read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const PROJECT = `ocw-gate-config-obs-${process.pid}`;
const PROFILE_FILE = readFileSync(path.join(HERE, "compose.yaml"), "utf8");

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
const SERVICES = ["grafana", "loki", "otel-collector", "prometheus", "tempo"];
const STATEFUL = {
  grafana: "/var/lib/grafana",
  loki: "/loki",
  prometheus: "/prometheus",
  tempo: "/var/tempo",
};
const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
// A machine with Docker must run every case (the plan's fails_when: "any case skipped on a machine with Docker").
const needsDocker = { skip: hasDocker ? false : "docker is not on PATH" };

let tmp;
let n = 0;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ocw-compose-obs-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** `docker compose config --format json` of compose.yaml with exactly `vars` in a temp env file. */
function config(vars) {
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
      "config",
      "--format",
      "json",
    ],
    { cwd: tmp, env, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const withProfile = (extra = {}) =>
  config({
    ...REQUIRED,
    COMPOSE_PROFILES: "observability",
    OCW_GRAFANA_ADMIN_PASSWORD: "grafana-pw-x",
    ...extra,
  });
const profileServices = (cfg) => Object.keys(cfg.services).filter((s) => SERVICES.includes(s));

describe("observability profile: off by default (SELF-01, D-05)", () => {
  it("no observability service runs without the profile", needsDocker, () => {
    assert.deepEqual(profileServices(config(REQUIRED)), []);
  });

  it("every service of the file belongs to the profile", () => {
    const blocks = PROFILE_FILE.split(/^ {2}(?=[a-z][a-z-]*:$)/m).slice(1);
    assert.equal(blocks.length, SERVICES.length);
    for (const block of blocks)
      assert.match(block, /^ {4}profiles: \["observability"\]$/m, block.split("\n")[0]);
  });
});

describe("observability profile: services and images", () => {
  it("adds exactly the collector, Tempo, Prometheus, Loki and Grafana", needsDocker, () => {
    assert.deepEqual(profileServices(withProfile()).sort(), SERVICES);
  });

  it("pins every image by digest (no grafana/otel-lgtm all-in-one)", needsDocker, () => {
    const cfg = withProfile();
    for (const s of SERVICES) {
      assert.match(cfg.services[s].image, /^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/, s);
      assert.doesNotMatch(cfg.services[s].image, /otel-lgtm/, s);
    }
    assert.equal(PROFILE_FILE.match(/@sha256:/g)?.length, 5);
  });

  it("the collector uses the contrib image (transform processor) and a memory cap", needsDocker, () => {
    const c = withProfile().services["otel-collector"];
    assert.match(c.image, /^otel\/opentelemetry-collector-contrib:/);
    assert.ok(Number(c.mem_limit) > 0, "mem_limit set");
  });
});

describe("observability profile: exposure (D-13, T-07-07-03)", () => {
  it("only Grafana publishes a port, on 127.0.0.1 (OCW_GRAFANA_PORT, default 3301)", needsDocker, () => {
    const cfg = withProfile();
    for (const s of SERVICES.filter((x) => x !== "grafana")) {
      assert.deepEqual(cfg.services[s].ports ?? [], [], `${s} publishes a port`);
    }
    const ports = cfg.services.grafana.ports;
    assert.equal(ports.length, 1);
    assert.equal(ports[0].host_ip, "127.0.0.1");
    assert.equal(ports[0].published, "3301");
    assert.equal(ports[0].target, 3000);
    const custom = withProfile({ OCW_GRAFANA_PORT: "3405" }).services.grafana.ports[0];
    assert.equal(custom.published, "3405");
    assert.equal(custom.host_ip, "127.0.0.1");
  });
});

describe("observability profile: storage", () => {
  it("each stateful backend keeps its data on its own named volume", needsDocker, () => {
    const cfg = withProfile();
    const seen = new Set();
    for (const [s, target] of Object.entries(STATEFUL)) {
      const vol = (cfg.services[s].volumes ?? []).find((v) => v.target === target);
      assert.ok(vol, `${s} mounts ${target}`);
      assert.equal(vol.type, "volume", `${s} uses a named volume`);
      assert.ok(!seen.has(vol.source), `${s} shares a volume`);
      seen.add(vol.source);
      assert.ok(cfg.volumes[vol.source], `${vol.source} is declared`);
    }
  });

  it("config files are mounted read-only from infra/observability", needsDocker, () => {
    const cfg = withProfile();
    for (const s of SERVICES) {
      for (const v of (cfg.services[s].volumes ?? []).filter((x) => x.type === "bind")) {
        assert.equal(v.read_only, true, `${s} ${v.target}`);
        assert.ok(v.source.startsWith(path.join(ROOT, "infra", "observability")), `${s} ${v.source}`);
      }
    }
  });
});

describe("observability profile: Grafana access (D-13, T-07-07-02)", () => {
  it(
    "anonymous access and sign-up are off; the admin password is OCW_GRAFANA_ADMIN_PASSWORD",
    needsDocker,
    () => {
      const env = withProfile().services.grafana.environment;
      assert.equal(env.GF_AUTH_ANONYMOUS_ENABLED, "false");
      assert.equal(env.GF_USERS_ALLOW_SIGN_UP, "false");
      assert.equal(env.GF_SECURITY_ADMIN_PASSWORD, "grafana-pw-x");
      assert.match(PROFILE_FILE, /GF_SECURITY_ADMIN_PASSWORD: \$\{OCW_GRAFANA_ADMIN_PASSWORD:-\}/);
    },
  );

  it(
    "no `:?` guard: installs without the profile (and without the password) still pass config",
    needsDocker,
    () => {
      assert.doesNotMatch(PROFILE_FILE, /:\?/);
      const env = config({ ...REQUIRED, COMPOSE_PROFILES: "observability" }).services.grafana.environment;
      assert.equal(env.GF_SECURITY_ADMIN_PASSWORD, "");
    },
  );

  it(
    "the entrypoint refuses an empty or default password, naming OCW_GRAFANA_ADMIN_PASSWORD",
    needsDocker,
    () => {
      const g = withProfile().services.grafana;
      const script = g.entrypoint.join(" ");
      assert.match(script, /OCW_GRAFANA_ADMIN_PASSWORD/);
      assert.match(script, /exit 1/);
      assert.match(script, /exec \/run\.sh/);
    },
  );

  it("Grafana does not phone home or install plugins at start", needsDocker, () => {
    const env = withProfile().services.grafana.environment;
    for (const k of [
      "GF_ANALYTICS_REPORTING_ENABLED",
      "GF_ANALYTICS_CHECK_FOR_UPDATES",
      "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES",
    ]) {
      assert.equal(env[k], "false", k);
    }
    assert.equal(env.GF_PLUGINS_PREINSTALL_DISABLED, "true");
  });

  it("provisions the Prometheus, Loki and Tempo datasources, linked both ways", () => {
    const ds = readFileSync(path.join(HERE, "grafana", "datasources.yaml"), "utf8");
    for (const t of ["prometheus", "loki", "tempo"]) assert.match(ds, new RegExp(`type: ${t}$`, "m"));
    assert.match(ds, /derivedFields:[\s\S]*datasourceUid: ocw-tempo/);
    assert.match(ds, /tracesToLogsV2:[\s\S]*datasourceUid: ocw-loki/);
  });
});

describe("observability profile: collector redaction and backends", () => {
  const collector = readFileSync(path.join(HERE, "otel-collector.yaml"), "utf8");

  it("drops query strings and process attributes before export (D-18)", () => {
    for (const key of ["url.query", "url.full", "process.executable.path", "process.command_args"]) {
      assert.ok(collector.includes(`"${key}"`), key);
    }
  });

  it("sends traces to Tempo, metrics to Prometheus' OTLP receiver and logs to Loki's /otlp", () => {
    assert.match(collector, /endpoint: tempo:4317/);
    assert.match(collector, /endpoint: http:\/\/prometheus:9090\/api\/v1\/otlp/);
    assert.match(collector, /endpoint: http:\/\/loki:3100\/otlp/);
    for (const p of ["traces", "metrics", "logs"]) assert.match(collector, new RegExp(`^ {4}${p}:$`, "m"), p);
  });

  it("Prometheus has the OTLP receiver and 15 days of retention", needsDocker, () => {
    const cmd = withProfile().services.prometheus.command.join(" ");
    assert.match(cmd, /--web\.enable-otlp-receiver/);
    assert.match(cmd, /--storage\.tsdb\.retention\.time=15d/);
  });
});
