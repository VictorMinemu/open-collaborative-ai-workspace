// node --test 'scripts/**/*.test.mjs'
//
// `pnpm ocw enable vault` (SELF-01 "enable later", SELF-02, D-13, D-16) with Docker replaced by an in-memory OpenBao:
// the four API-only secrets move into KV and become openbao:// references, every other byte of .env is kept, the seal
// key and init material land in 0600 files under a 0700 secrets/, the root token is revoked, nothing secret is printed
// and no secret value is ever passed on a command line. A second run changes nothing. Temp directories only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "./enable-vault.mjs";
import { REPO_ROOT, readEnv } from "./env-file.mjs";

const ROOT_TOKEN = "s.root-canary-6f1e2d3c4b5a";
const ROLE_ID = "role-canary-0a1b2c3d";
const SECRET_ID = "secret-id-canary-9z8y7x";
const PLAIN = {
  BETTER_AUTH_SECRET: "auth-canary-".padEnd(64, "a"),
  OCW_SETUP_TOKEN: "setup-canary-".padEnd(32, "s"),
  OCW_ENCRYPTION_KEY: "enc-canary-".padEnd(44, "e"),
};
const SMTP = "smtp://user:smtp-canary-pass@mail.example.com:587";
const REF = (k) => `openbao://secret/ocw/api#${k}`;

const ORIGINAL = [
  "# Open Collaborative AI Workspace",
  "COMPOSE_PROJECT_NAME=ocw-test-vault",
  "COMPOSE_PROFILES=search",
  "",
  "# Database",
  "POSTGRES_PASSWORD=pg-canary-keepme",
  "DATABASE_URL=postgres://ocw_app:x@localhost:54329/ocw",
  `BETTER_AUTH_SECRET=${PLAIN.BETTER_AUTH_SECRET}`,
  `OCW_SETUP_TOKEN=${PLAIN.OCW_SETUP_TOKEN}`,
  "# the key below encrypts app.secrets",
  `OCW_ENCRYPTION_KEY=${PLAIN.OCW_ENCRYPTION_KEY}`,
  "OCW_CELL_TOKEN=ocw_cell_canary-keepme",
  "OCW_SMTP_URL=",
  "OCW_OPENBAO_ADDR=",
  "OCW_S3_SECRET_ACCESS_KEY=s3-canary-keepme",
  "",
].join("\n");

/** An in-memory OpenBao behind `docker compose …` (the injectable runner). Records every call. */
function fakeDocker({ initialized = false } = {}) {
  const state = {
    initialized,
    kv: null,
    revoked: false,
    mounts: { "cubbyhole/": {} },
    auths: { "token/": {} },
    policy: null,
    role: null,
    calls: [],
  };
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  state.compose = (envFile, args, { input = "" } = {}) => {
    state.calls.push({ envFile, args: [...args], input });
    if (args[0] === "up") return ok();
    if (args[0] !== "exec") return { status: 1, stdout: "", stderr: `unexpected ${args[0]}` };
    const i = args.indexOf("openbao");
    const cmd = args.slice(i + 1);
    if (cmd[0] === "bao" && cmd[1] === "status") {
      return {
        status: state.initialized ? 0 : 2,
        stdout: JSON.stringify({ initialized: state.initialized, sealed: !state.initialized }),
        stderr: "",
      };
    }
    if (cmd[0] === "bao" && cmd[1] === "operator" && cmd[2] === "init") {
      assert.ok(!state.initialized, "init runs once");
      state.initialized = true;
      return ok(
        JSON.stringify({
          unseal_keys_b64: [],
          recovery_keys_b64: ["recovery-canary"],
          recovery_keys_shares: 1,
          recovery_keys_threshold: 1,
          root_token: ROOT_TOKEN,
        }),
      );
    }
    if (cmd[0] === "sh") {
      const [token, ...rest] = input.split("\n");
      if (token !== ROOT_TOKEN || state.revoked)
        return { status: 2, stdout: "", stderr: "permission denied" };
      const stdin = rest.join("\n");
      const bao = cmd.slice(cmd.indexOf("sh", 1) + 1);
      const sub = bao.join(" ");
      if (sub === "secrets list -format=json") return ok(JSON.stringify(state.mounts));
      if (sub === "auth list -format=json") return ok(JSON.stringify(state.auths));
      if (sub === "secrets enable -path=secret -version=2 kv") {
        state.mounts["secret/"] = { type: "kv" };
        return ok();
      }
      if (sub === "auth enable approle") {
        state.auths["approle/"] = { type: "approle" };
        return ok();
      }
      if (sub === "policy write ocw-api -") {
        state.policy = stdin;
        return ok();
      }
      if (bao[0] === "write" && bao[1] === "auth/approle/role/ocw-api") {
        state.role = bao.slice(2);
        return ok();
      }
      if (sub === "read -format=json auth/approle/role/ocw-api/role-id") {
        return ok(JSON.stringify({ data: { role_id: ROLE_ID } }));
      }
      if (sub === "write -f -format=json auth/approle/role/ocw-api/secret-id") {
        return ok(JSON.stringify({ data: { secret_id: SECRET_ID } }));
      }
      if (sub === "kv put -mount=secret ocw/api -") {
        state.kv = JSON.parse(stdin);
        return ok();
      }
      if (sub === "token revoke -self") {
        state.revoked = true;
        return ok();
      }
      return { status: 1, stdout: "", stderr: `unexpected bao ${sub}` };
    }
    return { status: 1, stdout: "", stderr: `unexpected exec ${cmd.join(" ")}` };
  };
  return state;
}

let dir;
const envFile = () => path.join(dir, ".env");
const secretsDir = () => path.join(dir, "secrets");

async function enable(docker, ...args) {
  const out = [];
  const code = await main(["--env-file", envFile(), ...args], {
    compose: docker.compose,
    log: (l) => out.push(String(l)),
    error: (l) => out.push(String(l)),
    sleep: async () => {},
  });
  return { code, out: out.join("\n") };
}

/** Every secret the run handles: none may appear in output or in any command-line argument. */
const SECRETS = () => {
  const list = [...Object.values(PLAIN), SMTP, ROOT_TOKEN, SECRET_ID, "recovery-canary"];
  const seal = path.join(secretsDir(), "openbao-seal.key");
  if (existsSync(seal)) {
    const key = readFileSync(seal);
    list.push(key.toString("hex"), key.toString("base64"));
  }
  return list;
};

function assertNothingLeaked(docker, out) {
  for (const s of SECRETS()) {
    assert.ok(!out.includes(s), "a secret value appears in the output");
    for (const call of docker.calls) {
      assert.ok(
        !call.args.some((a) => a.includes(s)),
        `a secret value was passed as an argument: ${call.args[0]}`,
      );
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-enable-vault-"));
  writeFileSync(envFile(), ORIGINAL, { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ocw enable vault", () => {
  it("moves the set API-only secrets into OpenBao and leaves references; every other byte is kept", async () => {
    const docker = fakeDocker();
    const { code, out } = await enable(docker, "--no-up");
    assert.equal(code, 0, out);

    const { text, values } = readEnv(envFile());
    for (const key of Object.keys(PLAIN)) assert.equal(values.get(key), REF(key));
    assert.equal(values.get("OCW_SMTP_URL"), "", "an empty OCW_SMTP_URL is left alone");
    assert.deepEqual(docker.kv, PLAIN);

    assert.equal(values.get("OCW_OPENBAO_ADDR"), "http://openbao:8200");
    assert.equal(values.get("OCW_OPENBAO_ROLE_ID"), ROLE_ID);
    assert.equal(values.get("OCW_OPENBAO_SECRET_ID"), SECRET_ID);
    assert.equal(values.get("OCW_OPENBAO_SEAL_KEY_FILE"), path.join(secretsDir(), "openbao-seal.key"));
    assert.equal(values.get("COMPOSE_PROFILES"), "search,vault");

    // Every other line is untouched, in order (the OpenBao settings are appended at the end).
    const changed =
      /^(BETTER_AUTH_SECRET|OCW_SETUP_TOKEN|OCW_ENCRYPTION_KEY|OCW_OPENBAO_[A-Z_]+|COMPOSE_PROFILES)=/;
    const before = ORIGINAL.split("\n").filter((l) => !changed.test(l));
    const after = text.split("\n").filter((l) => !changed.test(l));
    assert.deepEqual(after.slice(0, before.length), before);
    assert.ok(after.slice(before.length).every((l) => l === "" || l.startsWith("#")));
    assert.equal(statSync(envFile()).mode & 0o777, 0o600);

    assert.match(docker.policy, /path "secret\/data\/ocw\/\*" \{ capabilities = \["read"\] \}/);
    assert.ok(docker.role.includes("token_policies=ocw-api"));
    assert.ok(docker.revoked, "the root token is revoked");
    assertNothingLeaked(docker, out);
  });

  it("writes the seal key and the init material to 0600 files in a 0700 secrets/; the revoked root token is dropped", async () => {
    const docker = fakeDocker();
    const { code, out } = await enable(docker, "--no-up");
    assert.equal(code, 0, out);
    assert.equal(statSync(secretsDir()).mode & 0o777, 0o700);
    const seal = path.join(secretsDir(), "openbao-seal.key");
    const init = path.join(secretsDir(), "openbao-init.json");
    assert.equal(statSync(seal).mode & 0o777, 0o600);
    assert.equal(statSync(init).mode & 0o777, 0o600);
    assert.equal(readFileSync(seal).length, 32);
    const material = JSON.parse(readFileSync(init, "utf8"));
    assert.deepEqual(material.recovery_keys_b64, ["recovery-canary"]);
    assert.equal(material.root_token, undefined);
    assert.equal(material.root_token_revoked, true);
  });

  it("prints key names and file paths only", async () => {
    const docker = fakeDocker();
    const { code, out } = await enable(docker, "--no-up");
    assert.equal(code, 0, out);
    assert.match(out, /BETTER_AUTH_SECRET, OCW_SETUP_TOKEN, OCW_ENCRYPTION_KEY/);
    assert.match(out, /OCW_OPENBAO_ROLE_ID/);
    assert.match(out, /secrets\/openbao-seal\.key/);
    assert.match(out, /back up/i);
    assert.doesNotMatch(out, /OCW_SMTP_URL.*moved/i);
    assertNothingLeaked(docker, out);
  });

  it("moves a set OCW_SMTP_URL too", async () => {
    writeFileSync(envFile(), ORIGINAL.replace("OCW_SMTP_URL=", `OCW_SMTP_URL=${SMTP}`), { mode: 0o600 });
    const docker = fakeDocker();
    const { code, out } = await enable(docker, "--no-up");
    assert.equal(code, 0, out);
    assert.equal(readEnv(envFile()).values.get("OCW_SMTP_URL"), REF("OCW_SMTP_URL"));
    assert.equal(docker.kv.OCW_SMTP_URL, SMTP);
    assertNothingLeaked(docker, out);
  });

  it("passes the root token and values through stdin only, and starts openbao before configuring it", async () => {
    const docker = fakeDocker();
    await enable(docker, "--no-up");
    const ups = docker.calls.filter((c) => c.args[0] === "up").map((c) => c.args.join(" "));
    assert.deepEqual(ups, ["up -d openbao", "up -d --wait openbao"]);
    const baoCalls = docker.calls.filter((c) => c.args.includes("sh"));
    assert.ok(baoCalls.length > 0);
    for (const c of baoCalls) assert.ok(c.input.startsWith(`${ROOT_TOKEN}\n`));
  });

  it("without --no-up, restarts the stack so the api reads its secrets from OpenBao", async () => {
    const docker = fakeDocker();
    const { code } = await enable(docker);
    assert.equal(code, 0);
    const last = docker.calls.at(-1);
    assert.deepEqual(last.args, ["up", "-d", "--wait"]);
  });

  it("a second run reports 'already enabled' and changes nothing", async () => {
    await enable(fakeDocker(), "--no-up");
    const text = readFileSync(envFile(), "utf8");
    const docker = fakeDocker({ initialized: true });
    const { code, out } = await enable(docker, "--no-up");
    assert.equal(code, 0);
    assert.match(out, /already enabled/);
    assert.equal(readFileSync(envFile(), "utf8"), text);
    assert.equal(docker.calls.length, 0);
  });

  it("resumes an interrupted run with the saved root token instead of initialising twice", async () => {
    const first = fakeDocker();
    // Interrupted after init: the kv write fails once.
    const failing = {
      ...first,
      compose: (f, args, opts) =>
        args.includes("kv") ? { status: 1, stdout: "", stderr: "boom" } : first.compose(f, args, opts),
    };
    const broken = await enable(failing, "--no-up");
    assert.equal(broken.code, 1);
    assert.equal(readEnv(envFile()).values.get("OCW_ENCRYPTION_KEY"), PLAIN.OCW_ENCRYPTION_KEY);
    first.calls.length = 0;
    const { code, out } = await enable(first, "--no-up");
    assert.equal(code, 0, out);
    assert.ok(!first.calls.some((c) => c.args.includes("init")));
    assert.equal(readEnv(envFile()).values.get("OCW_ENCRYPTION_KEY"), REF("OCW_ENCRYPTION_KEY"));
  });

  it("refuses an initialised OpenBao whose init material is missing", async () => {
    const docker = fakeDocker({ initialized: true });
    const { code, out } = await enable(docker, "--no-up");
    assert.equal(code, 1);
    assert.match(out, /openbao-init\.json/);
    assert.equal(readEnv(envFile()).values.get("OCW_ENCRYPTION_KEY"), PLAIN.OCW_ENCRYPTION_KEY);
  });

  it("when OpenBao never answers, reports the tail of its log (nothing secret is in it)", async () => {
    const docker = fakeDocker();
    const stuck = {
      ...docker,
      compose: (f, args, opts) => {
        if (args.includes("status")) {
          return {
            status: 1,
            stdout: "",
            stderr: "container is restarting, wait until the container is running",
          };
        }
        if (args[0] === "logs") {
          return {
            status: 0,
            stdout: 'openbao-1  | Error configuring seal "static": permission denied\n',
            stderr: "",
          };
        }
        return docker.compose(f, args, opts);
      },
    };
    const { code, out } = await enable(stuck, "--no-up");
    assert.equal(code, 1);
    assert.match(out, /waiting for OpenBao to answer failed/);
    assert.match(out, /Error configuring seal "static": permission denied/);
  });

  it("refuses the demo's env files by path, and a missing env file", async () => {
    const docker = fakeDocker();
    const demo = path.join(dir, ".env.demo");
    writeFileSync(demo, "X=1\n");
    const res = await main(["--env-file", demo], { compose: docker.compose, log() {}, error() {} }).catch(
      (e) => e,
    );
    assert.ok(res instanceof Error || res !== 0);
    assert.equal(docker.calls.length, 0);
    const missing = await main(["--env-file", path.join(dir, "nope.env")], {
      compose: docker.compose,
      log() {},
      error() {},
    }).catch((e) => e);
    assert.ok(missing instanceof Error || missing !== 0);
  });

  it("is reachable through the dispatcher (help only, no Docker)", () => {
    const res = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "ocw.mjs"), "enable", "vault", "--help"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ocw enable vault/);
  });
});
