// node --test infra/caddy/compose-proxy.test.mjs
//
// The `proxy` profile (SELF-05, D-07): proven with `docker compose config` and `caddy adapt` only (nothing is
// served). Without the profile there is no caddy; with it, the digest-pinned image publishes exactly 80, 443 and
// 443/udp from their variables, keeps certificates in named volumes and adds no other published port. The Caddyfile
// keeps the admin endpoint off, answers 404 for the Agent Channel API, sends the bucket path to Garage with Host and
// path untouched (SigV4 signs both) and everything else to the API or the web.
//
// Every compose call uses a temp env file, --project-directory the repo, `-p ocw-gate-config-<pid>` and a minimal
// environment (no inherited OCW_* / COMPOSE_* variables). The repository's .env is never read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = `ocw-gate-config-${process.pid}`;
const IMAGE = "caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f";
const CADDYFILE = path.join(ROOT, "infra", "caddy", "Caddyfile");
/** The Caddyfile without its comment lines (the comments name what must never be written). */
const caddyfile = readFileSync(CADDYFILE, "utf8")
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

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
const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const needsDocker = { skip: hasDocker ? false : "docker is not on PATH" };

let tmp;
let n = 0;
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ocw-compose-proxy-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function dockerEnv() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const k of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"])
    if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** `docker compose config --format json` with exactly `vars` in a temp env file. */
function config(vars, { files = ["compose.yaml"] } = {}) {
  const envFile = path.join(tmp, `case-${++n}.env`);
  writeFileSync(
    envFile,
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
    { mode: 0o600 },
  );
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
      ...files.flatMap((f) => ["-f", path.join(ROOT, f)]),
      "config",
      "--format",
      "json",
    ],
    { cwd: tmp, env: dockerEnv(), encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

/** "service host_ip:published:target/protocol" for every published port. */
function published(cfg) {
  return Object.entries(cfg.services).flatMap(([name, s]) =>
    (s.ports ?? []).map(
      (p) => `${name} ${p.host_ip ?? ""}:${p.published}:${p.target}/${p.protocol ?? "tcp"}`,
    ),
  );
}

describe("proxy profile: compose (D-07)", () => {
  it("has no caddy unless the profile is enabled", needsDocker, () => {
    assert.equal(config(REQUIRED).services.caddy, undefined);
  });

  it("runs the digest-pinned caddy image with the Caddyfile, both volumes and its env", needsDocker, () => {
    const caddy = config({ ...REQUIRED, COMPOSE_PROFILES: "proxy" }).services.caddy;
    assert.ok(caddy, "caddy is in the config with COMPOSE_PROFILES=proxy");
    assert.equal(caddy.image, IMAGE);
    assert.deepEqual(caddy.profiles, ["proxy"]);
    const mounts = Object.fromEntries(caddy.volumes.map((v) => [v.target, v]));
    assert.equal(mounts["/etc/caddy/Caddyfile"].source, CADDYFILE);
    assert.equal(mounts["/etc/caddy/Caddyfile"].read_only, true);
    assert.equal(mounts["/data"].type, "volume");
    assert.equal(mounts["/data"].source, "caddy-data");
    assert.equal(mounts["/config"].type, "volume");
    assert.equal(mounts["/config"].source, "caddy-config");
    assert.equal(caddy.environment.OCW_SITE_ADDRESS, "localhost");
    assert.equal(caddy.environment.OCW_S3_BUCKET, "ocw-attachments");
    assert.equal(caddy.depends_on.api.condition, "service_healthy");
  });

  it("publishes 80, 443 and 443/udp by default and the variables' ports when set", needsDocker, () => {
    const ports = (vars) =>
      published(config({ ...REQUIRED, COMPOSE_PROFILES: "proxy", ...vars })).filter((p) =>
        p.startsWith("caddy "),
      );
    assert.deepEqual(ports({}).sort(), ["caddy :443:443/tcp", "caddy :443:443/udp", "caddy :80:80/tcp"]);
    assert.deepEqual(ports({ OCW_PROXY_HTTP_PORT: "3480", OCW_PROXY_HTTPS_PORT: "3443" }).sort(), [
      "caddy :3443:443/tcp",
      "caddy :3443:443/udp",
      "caddy :3480:80/tcp",
    ]);
  });

  it("the loopback override publishes the same three ports on 127.0.0.1 only", needsDocker, () => {
    const cfg = config(
      { ...REQUIRED, COMPOSE_PROFILES: "proxy", OCW_PROXY_HTTP_PORT: "3480", OCW_PROXY_HTTPS_PORT: "3443" },
      { files: ["compose.yaml", "infra/caddy/compose.loopback.yaml"] },
    );
    assert.deepEqual(
      published(cfg)
        .filter((p) => p.startsWith("caddy "))
        .sort(),
      ["caddy 127.0.0.1:3443:443/tcp", "caddy 127.0.0.1:3443:443/udp", "caddy 127.0.0.1:3480:80/tcp"],
    );
    assert.equal(cfg.services.caddy.image, IMAGE, "only the ports change");
  });

  it("adds no other published port and passes site address and bucket through", needsDocker, () => {
    const vars = { ...REQUIRED, OCW_SITE_ADDRESS: "ocw.example.com", OCW_S3_BUCKET: "files" };
    const without = published(config(vars));
    const withProxy = config({ ...vars, COMPOSE_PROFILES: "proxy" });
    const added = published(withProxy).filter((p) => !without.includes(p));
    assert.deepEqual(added.map((p) => p.split(" ")[0]).sort(), ["caddy", "caddy", "caddy"]);
    assert.deepEqual(
      without.filter((p) => !published(withProxy).includes(p)),
      [],
      "no port removed",
    );
    assert.equal(withProxy.services.caddy.environment.OCW_SITE_ADDRESS, "ocw.example.com");
    assert.equal(withProxy.services.caddy.environment.OCW_S3_BUCKET, "files");
  });
});

describe("proxy profile: Caddyfile (D-07, D-18)", () => {
  it("turns the admin endpoint off", () => {
    assert.match(caddyfile, /^\s*admin off\s*$/m);
  });

  it("never strips the bucket prefix nor rewrites Host towards Garage", () => {
    assert.match(caddyfile, /reverse_proxy garage:3900/);
    assert.doesNotMatch(caddyfile, /handle_path/);
    assert.doesNotMatch(caddyfile, /strip_prefix/);
    assert.doesNotMatch(caddyfile, /header_up\s+Host/i);
  });

  it("does not trust forwarded headers from clients", () => {
    assert.doesNotMatch(caddyfile, /trusted_proxies/);
  });

  // `caddy adapt` parses the Caddyfile into Caddy's JSON config without serving anything.
  it(
    "adapts to routes: agent-channel 404 first, API prefixes, bucket to Garage, the rest to the web",
    needsDocker,
    () => {
      const res = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "-e",
          "OCW_SITE_ADDRESS=ocw.example.com",
          "-e",
          "OCW_S3_BUCKET=files",
          "-v",
          `${CADDYFILE}:/etc/caddy/Caddyfile:ro`,
          IMAGE,
          "caddy",
          "adapt",
          "--config",
          "/etc/caddy/Caddyfile",
        ],
        { env: dockerEnv(), encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      const json = JSON.parse(res.stdout);
      assert.equal(json.admin?.disabled, true, "admin endpoint disabled");
      const server = Object.values(json.apps.http.servers)[0];
      const site = server.routes.find((r) => r.match?.[0]?.host?.includes("ocw.example.com"));
      assert.ok(site, "a route for the site address");
      const flat = JSON.stringify(site);
      const at = (needle) => {
        const i = flat.indexOf(needle);
        assert.ok(i >= 0, `${needle} in the adapted routes`);
        return i;
      };
      // Order: the 404 for the Agent Channel API comes before every proxy.
      const agent = at('"/agent-channel/*"');
      assert.ok(agent < at('"api:4000"'));
      assert.ok(agent < at('"garage:3900"'));
      assert.ok(agent < at('"web:3000"'));
      assert.match(flat, /"status_code":404/);
      for (const p of [
        '"/api/*"',
        '"/ws"',
        '"/runtime/ws"',
        '"/docs"',
        '"/docs/*"',
        '"/health"',
        '"/files/*"',
      ]) {
        at(p);
      }
      // No Host rewrite and no path rewrite anywhere.
      assert.doesNotMatch(flat, /"Host":/);
      assert.doesNotMatch(flat, /strip_path_prefix|"rewrite"/);
    },
  );
});
