// node --test infra/openbao/compose-vault.test.mjs
//
// The `vault` profile (SELF-02, D-04, D-16, T-07-06-02), proven with `docker compose config` only: no openbao service
// without the profile; with it, OpenBao pinned by digest, server mode (never dev mode), no published port, a named
// storage volume, the static seal key mounted read-only from OCW_OPENBAO_SEAL_KEY_FILE and a healthcheck. Temp env
// files, an explicit `-p ocw-gate-config-vault-<pid>` and a minimal environment; the repository's .env is never read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = `ocw-gate-config-vault-${process.pid}`;
const DIGEST = "sha256:6d2b93856e3fcf7b18ad855a0b51eaba474dc8b79cf554379ea32034797d2acf";
const PROFILE_FILE = readFileSync(path.join(ROOT, "infra", "openbao", "compose.yaml"), "utf8");
const HCL = readFileSync(path.join(ROOT, "infra", "openbao", "openbao.hcl"), "utf8");
const REQUIRED = {
  POSTGRES_PASSWORD: "pg-x",
  OCW_DB_APP_PASSWORD: "app-x",
  OCW_DB_AUTH_PASSWORD: "auth-x",
  OCW_DB_MIGRATOR_PASSWORD: "migrator-x",
  BETTER_AUTH_SECRET: "openbao://secret/ocw/api#BETTER_AUTH_SECRET",
  OCW_SETUP_TOKEN: "openbao://secret/ocw/api#OCW_SETUP_TOKEN",
  OCW_ENCRYPTION_KEY: "openbao://secret/ocw/api#OCW_ENCRYPTION_KEY",
  OCW_CELL_TOKEN: "cell-token-x",
};
const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const needsDocker = { skip: hasDocker ? false : "docker is not on PATH" };

let tmp;
let n = 0;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ocw-compose-vault-"));
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

describe("vault profile (infra/openbao)", () => {
  it("is off by default: no openbao service without the profile", needsDocker, () => {
    const cfg = config(REQUIRED);
    assert.equal(cfg.services.openbao, undefined);
  });

  it("COMPOSE_PROFILES=vault (what ocw enable vault writes) turns it on", needsDocker, () => {
    const cfg = config({ ...REQUIRED, COMPOSE_PROFILES: "vault", OCW_OPENBAO_SEAL_KEY_FILE: "/k/seal.key" });
    assert.ok(cfg.services.openbao);
  });

  it(
    "server mode, pinned by digest, no published port, named volume, read-only seal key, healthcheck",
    needsDocker,
    () => {
      const seal = path.join(tmp, "secrets", "openbao-seal.key");
      const cfg = config({ ...REQUIRED, OCW_OPENBAO_SEAL_KEY_FILE: seal }, ["--profile", "vault"]);
      const svc = cfg.services.openbao;
      assert.ok(svc, "openbao service");
      assert.equal(svc.image, `openbao/openbao:2.7.1@${DIGEST}`);
      assert.equal(svc.ports, undefined, "OpenBao publishes no port");
      const command = [...(svc.entrypoint ?? []), ...(svc.command ?? [])].join(" ");
      assert.match(command, /docker-entrypoint\.sh server/);
      assert.doesNotMatch(command, /-dev\b|-dev-/);

      const storage = svc.volumes.find((v) => v.target === "/openbao/file");
      assert.equal(storage?.type, "volume");
      assert.ok(cfg.volumes[storage.source], "a named storage volume");

      const key = svc.volumes.find((v) => v.target === "/run/secrets/openbao_seal_key");
      assert.equal(key?.type, "bind");
      assert.equal(key.source, seal);
      assert.equal(key.read_only, true);

      const hcl = svc.volumes.find((v) => v.target === "/openbao/config/openbao.hcl");
      assert.equal(hcl?.source, path.join(ROOT, "infra", "openbao", "openbao.hcl"));
      assert.equal(hcl.read_only, true);

      assert.match(svc.healthcheck.test.join(" "), /\/v1\/sys\/health/);
      assert.deepEqual(svc.cap_drop, ["ALL"]);
      // Exactly what the root wrapper needs to hand the 0600 key to the openbao user (gate run 1 lacked FOWNER).
      assert.deepEqual([...svc.cap_add].sort(), ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);
      assert.match(command, /chown openbao:openbao \/run\/openbao/);
      assert.deepEqual(svc.security_opt, ["no-new-privileges:true"]);
    },
  );

  it("the api keeps its secrets as references and receives the OpenBao settings", needsDocker, () => {
    const cfg = config(
      {
        ...REQUIRED,
        OCW_OPENBAO_ADDR: "http://openbao:8200",
        OCW_OPENBAO_ROLE_ID: "role-x",
        OCW_OPENBAO_SECRET_ID: "secret-x",
      },
      ["--profile", "vault"],
    );
    const env = cfg.services.api.environment;
    assert.equal(env.OCW_ENCRYPTION_KEY, "openbao://secret/ocw/api#OCW_ENCRYPTION_KEY");
    assert.equal(env.OCW_OPENBAO_ADDR, "http://openbao:8200");
    assert.equal(env.OCW_OPENBAO_ROLE_ID, "role-x");
  });

  it("the profile file holds no port, no credential and no dev mode", () => {
    assert.doesNotMatch(PROFILE_FILE, /^\s*ports:/m);
    assert.doesNotMatch(PROFILE_FILE, /BAO_DEV_|-dev\b|root_token|ROOT_TOKEN/);
    assert.match(PROFILE_FILE, /profiles: \["vault"\]/);
  });

  it("openbao.hcl: integrated storage, static seal from the tmpfs copy, no secret", () => {
    const settings = HCL.split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.match(settings, /storage "raft"/);
    assert.match(settings, /seal "static"/);
    assert.match(settings, /current_key\s*=\s*"file:\/\/\/run\/openbao\/seal\.key"/);
    assert.match(settings, /tls_disable\s*=\s*true/);
    assert.doesNotMatch(settings, /token|password|secret_id/i);
  });
});
