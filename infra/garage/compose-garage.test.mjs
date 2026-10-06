// node --test 'infra/**/*.test.mjs'
//
// Garage in the self-hosted stack (ADR-0015, P-10, principle 10): the service shape, loopback-only S3 port, a
// secret-free garage.toml, and no `:?` guard on any Garage/S3 variable, so `docker compose up postgres redis` keeps
// working for installs whose .env predates Garage. `docker compose config` runs with an empty env file and dummy
// values for the pre-existing required variables only; the repository's .env is never read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = path.join(ROOT, "compose.yaml");
const TOML = path.join(ROOT, "infra", "garage", "garage.toml");
const compose = readFileSync(COMPOSE, "utf8");

/** Variables compose.yaml already required before Garage (each has a `:?` guard). */
const REQUIRED = {
  POSTGRES_PASSWORD: "x",
  OCW_DB_APP_PASSWORD: "x",
  OCW_DB_AUTH_PASSWORD: "x",
  OCW_DB_MIGRATOR_PASSWORD: "x",
  BETTER_AUTH_SECRET: "x",
  OCW_SETUP_TOKEN: "x",
  OCW_ENCRYPTION_KEY: "x",
  OCW_CELL_TOKEN: "x",
};
const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

let tmp;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ocw-compose-garage-"));
  writeFileSync(path.join(tmp, "empty.env"), "");
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** `docker compose config --format json` with only `vars` in the environment (plus what docker itself needs). */
function config(vars) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...vars };
  for (const k of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"])
    if (process.env[k]) env[k] = process.env[k];
  const res = spawnSync(
    "docker",
    ["compose", "--env-file", path.join(tmp, "empty.env"), "-f", COMPOSE, "config", "--format", "json"],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

describe("compose.yaml garage service", () => {
  it("runs dxflrs/garage:v2.4.1 single-node with the default bucket and no init container", () => {
    assert.match(compose, /^ {2}garage:\n {4}image: dxflrs\/garage:v2\.4\.1$/m);
    assert.match(compose, /command: \["\/garage", "server", "--single-node", "--default-bucket"\]/);
    assert.doesNotMatch(compose, /garage-init|garage layout|garage key create/);
  });

  it("uses no `:?` guard for any Garage or S3 variable", () => {
    assert.doesNotMatch(compose, /\$\{(GARAGE_[A-Z_]*|OCW_S3_[A-Z_]*|OCW_ATTACHMENT_[A-Z_]*):\?/);
  });

  it("garage.toml holds no secret", () => {
    const toml = readFileSync(TOML, "utf8");
    const settings = toml
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(settings, /rpc_secret|secret|token/i);
    assert.match(settings, /^replication_factor = 1$/m);
    assert.match(settings, /^s3_region = "garage"$/m);
  });

  it("interpolates with every Garage/S3 variable absent, binds S3 to loopback and wires the API", {
    skip: hasDocker ? false : "docker is not on PATH",
  }, () => {
    const cfg = config(REQUIRED);
    const garage = cfg.services.garage;
    assert.equal(garage.image, "dxflrs/garage:v2.4.1");
    assert.deepEqual(garage.command, ["/garage", "server", "--single-node", "--default-bucket"]);
    assert.equal(garage.ports.length, 1);
    assert.equal(garage.ports[0].host_ip, "127.0.0.1");
    assert.equal(garage.ports[0].target, 3900);
    assert.equal(garage.ports[0].published, "3900");
    const toml = garage.volumes.find((v) => v.target === "/etc/garage.toml");
    assert.equal(toml.type, "bind");
    assert.equal(toml.read_only, true);
    assert.equal(path.relative(ROOT, toml.source), path.join("infra", "garage", "garage.toml"));
    assert.equal(garage.environment.GARAGE_RPC_SECRET, "");
    assert.equal(garage.environment.GARAGE_DEFAULT_ACCESS_KEY, "");
    assert.equal(garage.environment.GARAGE_DEFAULT_BUCKET, "ocw-attachments");
    const api = cfg.services.api;
    assert.equal(api.environment.OCW_S3_ENDPOINT, "http://garage:3900");
    assert.equal(api.environment.OCW_S3_PUBLIC_URL, "http://localhost:3900");
    assert.equal(api.environment.OCW_S3_ACCESS_KEY_ID, "");
    assert.equal(api.environment.OCW_S3_SECRET_ACCESS_KEY, "");
    assert.equal(api.depends_on.garage.condition, "service_started");
    // postgres and redis are untouched by the new service.
    assert.equal(cfg.services.postgres.depends_on, undefined);
    assert.equal(cfg.services.redis.depends_on, undefined);
  });

  it("passes the generated keys to both Garage and the API and honours OCW_S3_PORT", {
    skip: hasDocker ? false : "docker is not on PATH",
  }, () => {
    const cfg = config({
      ...REQUIRED,
      GARAGE_RPC_SECRET: "a".repeat(64),
      OCW_S3_ACCESS_KEY_ID: `GK${"b".repeat(24)}`,
      OCW_S3_SECRET_ACCESS_KEY: "c".repeat(64),
      OCW_S3_PORT: "4292",
    });
    const { garage, api } = cfg.services;
    assert.equal(garage.environment.GARAGE_RPC_SECRET, "a".repeat(64));
    assert.equal(garage.environment.GARAGE_DEFAULT_ACCESS_KEY, `GK${"b".repeat(24)}`);
    assert.equal(garage.environment.GARAGE_DEFAULT_SECRET_KEY, "c".repeat(64));
    assert.equal(api.environment.OCW_S3_ACCESS_KEY_ID, `GK${"b".repeat(24)}`);
    assert.equal(api.environment.OCW_S3_SECRET_ACCESS_KEY, "c".repeat(64));
    assert.equal(garage.ports[0].published, "4292");
  });
});
