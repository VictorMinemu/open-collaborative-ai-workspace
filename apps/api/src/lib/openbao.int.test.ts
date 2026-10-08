import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenBaoSecretStore, OpenBaoError } from "./openbao";
import {
  createChainedSecretStore,
  createEnvFileSecretStore,
  MissingSecretError,
  parseSecretUri,
  type SecretReference,
  type SecretStore,
} from "./secret-store";

/**
 * SELF-02 / D-04 (plan 07-06): the env/file store and the OpenBao client implement one `SecretStore` contract, proven
 * against a real OpenBao 2.7.1 (dev mode in this test only; the compose `vault` profile runs server mode). AppRole and
 * the read-only `ocw-api` policy are set up with the dev root token exactly as `ocw enable vault` does. Then the real
 * `src/main.ts` boots with two of its secrets as openbao:// references.
 */

const OPENBAO_IMAGE =
  "openbao/openbao:2.7.1@sha256:6d2b93856e3fcf7b18ad855a0b51eaba474dc8b79cf554379ea32034797d2acf";
const ROOT_TOKEN = `root-${randomBytes(8).toString("hex")}`;
const CANARY = `canary-${randomBytes(12).toString("hex")}`;
const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const AUTH_SECRET = randomBytes(32).toString("hex");
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let bao: StartedTestContainer;
let addr: string;
let roleId: string;
let secretId: string;
const tmp = mkdtempSync(join(tmpdir(), "ocw-openbao-int-"));

async function root(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${addr}/v1/${path}`, {
    method,
    headers: { "X-Vault-Token": ROOT_TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const ref = (uri: string) => {
  const r = parseSecretUri(uri);
  if (r?.provider !== "openbao") throw new Error(`bad test reference ${uri}`);
  return r;
};

/** A free loopback port with nothing listening (for the unreachable case). */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Runs `fn` and returns the error it throws (fails the test when it does not throw). */
async function failure(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a failure");
}

beforeAll(async () => {
  bao = await new GenericContainer(OPENBAO_IMAGE)
    .withEnvironment({ BAO_DEV_ROOT_TOKEN_ID: ROOT_TOKEN, BAO_DEV_LISTEN_ADDRESS: "0.0.0.0:8200" })
    .withExposedPorts(8200)
    .withWaitStrategy(Wait.forHttp("/v1/sys/health", 8200).forStatusCode(200))
    .start();
  addr = `http://127.0.0.1:${bao.getMappedPort(8200)}`;
  // Dev mode mounts `secret/` as KV v2. The rest mirrors scripts/ocw/enable-vault.mjs.
  await root("POST", "sys/auth/approle", { type: "approle" });
  await root("PUT", "sys/policies/acl/ocw-api", {
    policy: 'path "secret/data/ocw/*" { capabilities = ["read"] }',
  });
  await root("POST", "auth/approle/role/ocw-api", { token_policies: ["ocw-api"], token_ttl: "5m" });
  roleId = ((await root("GET", "auth/approle/role/ocw-api/role-id")) as { data: { role_id: string } }).data
    .role_id;
  secretId = ((await root("POST", "auth/approle/role/ocw-api/secret-id")) as { data: { secret_id: string } })
    .data.secret_id;
  await root("POST", "secret/data/ocw/api", {
    data: { CANARY_FIELD: CANARY, OCW_ENCRYPTION_KEY: ENCRYPTION_KEY, BETTER_AUTH_SECRET: AUTH_SECRET },
  });
  await root("POST", "secret/data/other/app", { data: { CANARY_FIELD: CANARY } });
}, 180_000);

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await bao?.stop();
});

const PRESENT = "openbao://secret/ocw/api#CANARY_FIELD";
const MISSING = "openbao://secret/ocw/api#NOT_THERE";

interface Provider {
  name: string;
  /** A store holding CANARY at `present`, and nothing at `missing`. */
  make(): Promise<{
    store: SecretStore;
    present: SecretReference;
    missing: SecretReference;
    missingName: string;
  }>;
}

const providers: Provider[] = [
  {
    name: "env/file",
    async make() {
      return {
        store: createEnvFileSecretStore({ CANARY_KEY: CANARY }),
        present: { provider: "env", key: "CANARY_KEY" },
        missing: { provider: "env", key: "NOT_THERE" },
        missingName: "NOT_THERE",
      };
    },
  },
  {
    name: "openbao (AppRole)",
    async make() {
      // A store only knows the references it preloaded; the missing one is preloaded as part of the contract check
      // below (load fails), so this store gets the present one only.
      return {
        store: await createOpenBaoSecretStore({ addr, roleId, secretId }, [ref(PRESENT)]),
        present: ref(PRESENT),
        missing: ref(MISSING),
        missingName: MISSING,
      };
    },
  },
  {
    name: "chained env/file → openbao",
    async make() {
      const bao = await createOpenBaoSecretStore({ addr, roleId, secretId }, [ref(PRESENT)]);
      return {
        store: createChainedSecretStore([createEnvFileSecretStore({}), bao]),
        present: ref(PRESENT),
        missing: { provider: "env", key: "NOT_THERE" },
        missingName: "NOT_THERE",
      };
    },
  },
];

describe.each(providers)("SecretStore contract: $name", (provider) => {
  it("resolves a present secret to its value", async () => {
    const { store, present } = await provider.make();
    expect(store.resolveSync(present)).toBe(CANARY);
  });

  it("a missing secret throws MissingSecretError naming the reference, never a value", async () => {
    const { store, missing, missingName } = await provider.make();
    let err: unknown;
    try {
      store.resolveSync(missing);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingSecretError);
    expect((err as Error).message).toContain(missingName);
    expect((err as Error).message).not.toContain(CANARY);
  });
});

describe("createOpenBaoSecretStore against OpenBao 2.7.1", () => {
  it("AppRole login reads secret/ocw/api once for several fields and revokes its token", async () => {
    const store = await createOpenBaoSecretStore({ addr, roleId, secretId }, [
      ref("openbao://secret/ocw/api#OCW_ENCRYPTION_KEY"),
      ref("openbao://secret/ocw/api#BETTER_AUTH_SECRET"),
    ]);
    expect(store.resolveSync(ref("openbao://secret/ocw/api#OCW_ENCRYPTION_KEY"))).toBe(ENCRYPTION_KEY);
    expect(store.resolveSync(ref("openbao://secret/ocw/api#BETTER_AUTH_SECRET"))).toBe(AUTH_SECRET);
    // The AppRole token it used is gone: the role has issued tokens, but none is still valid for lookups.
    const accessors = (await root("GET", "auth/token/accessors?list=true")) as { data: { keys: string[] } };
    for (const accessor of accessors.data.keys) {
      const info = (await root("POST", "auth/token/lookup-accessor", { accessor })) as {
        data: { policies: string[] };
      };
      expect(info.data.policies).not.toContain("ocw-api");
    }
  });

  it("token auth works too (not revoked)", async () => {
    const store = await createOpenBaoSecretStore({ addr, token: ROOT_TOKEN }, [ref(PRESENT)]);
    expect(store.resolveSync(ref(PRESENT))).toBe(CANARY);
    expect(await root("GET", "auth/token/lookup-self")).toBeTruthy();
  });

  it("a path outside the policy fails naming the reference and 'permission denied'", async () => {
    const uri = "openbao://secret/other/app#CANARY_FIELD";
    const err = await failure(() => createOpenBaoSecretStore({ addr, roleId, secretId }, [ref(uri)]));
    expect(err).toBeInstanceOf(OpenBaoError);
    expect(err.message).toContain(uri);
    expect(err.message).toContain("permission denied");
    expect(err.message).not.toContain(CANARY);
    expect(err.message).not.toContain(secretId);
  });

  it("a missing path or field fails naming openbao://…#FIELD", async () => {
    const noPath = "openbao://secret/ocw/nothing-here#X";
    const e1 = await failure(() => createOpenBaoSecretStore({ addr, roleId, secretId }, [ref(noPath)]));
    expect(e1).toBeInstanceOf(MissingSecretError);
    expect(e1.message).toContain(noPath);
    const e2 = await failure(() =>
      createOpenBaoSecretStore({ addr, roleId, secretId }, [ref(PRESENT), ref(MISSING)]),
    );
    expect(e2).toBeInstanceOf(MissingSecretError);
    expect(e2.message).toContain(MISSING);
    expect(e2.message).not.toContain(CANARY);
  });

  it("a bad secret_id is a login error that reveals neither the secret id nor a value", async () => {
    const wrong = `wrong-${randomBytes(8).toString("hex")}`;
    const err = await failure(() =>
      createOpenBaoSecretStore({ addr, roleId, secretId: wrong }, [ref(PRESENT)]),
    );
    expect(err).toBeInstanceOf(OpenBaoError);
    expect(err.message).toMatch(/AppRole login at http:\/\/127\.0\.0\.1:\d+ failed \(400/);
    expect(err.message).not.toContain(wrong);
    expect(err.message).not.toContain(roleId);
    expect(err.message).not.toContain(CANARY);
  });

  it("a bad token is refused naming the reference", async () => {
    const err = await failure(() => createOpenBaoSecretStore({ addr, token: "not-a-token" }, [ref(PRESENT)]));
    expect(err).toBeInstanceOf(OpenBaoError);
    expect(err.message).toContain(PRESENT);
    expect(err.message).not.toContain("not-a-token");
  });

  it("a closed port fails fast naming the address", async () => {
    const port = await closedPort();
    const err = await failure(() =>
      createOpenBaoSecretStore({ addr: `http://127.0.0.1:${port}`, roleId, secretId }, [ref(PRESENT)]),
    );
    expect(err).toBeInstanceOf(OpenBaoError);
    expect(err.message).toContain(`unreachable at http://127.0.0.1:${port}`);
    expect(err.message).not.toContain(secretId);
  });
});

describe("API boot with secrets in OpenBao (main.ts → loadConfig)", () => {
  let tdb: TestDatabase;
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    [tdb, redis] = await Promise.all([startTestDatabase(), new RedisContainer("redis:8").start()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.allSettled([tdb?.stop(), redis?.stop()]);
  });

  async function boot(extra: Record<string, string>, onListening?: (url: string) => Promise<void>) {
    const port = await closedPort();
    const secretIdFile = join(tmp, "secret-id");
    writeFileSync(secretIdFile, secretId, { mode: 0o600 });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: tdb.appUrl,
      AUTH_DATABASE_URL: tdb.authUrl,
      REDIS_URL: redis.getConnectionUrl(),
      OCW_SETUP_TOKEN: "test-setup-token-0123456789",
      OCW_PUBLIC_WEB_URL: "http://localhost:3999",
      OCW_PUBLIC_API_URL: "http://localhost:4999",
      OCW_OPENBAO_ADDR: addr,
      OCW_OPENBAO_ROLE_ID: roleId,
      OCW_OPENBAO_SECRET_ID_FILE: secretIdFile,
      OCW_ENCRYPTION_KEY: "openbao://secret/ocw/api#OCW_ENCRYPTION_KEY",
      BETTER_AUTH_SECRET: "openbao://secret/ocw/api#BETTER_AUTH_SECRET",
      ...extra,
    };
    return await new Promise<{ code: number | null; out: string; listening: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: API_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let listening = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`API did not exit in time\n${out}`));
      }, 60_000);
      const onData = (chunk: Buffer) => {
        out += chunk.toString();
        const m = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (m?.[1] && !listening) {
          listening = true;
          void (onListening ? onListening(m[1]) : Promise.resolve())
            .catch((err: unknown) => {
              out += `\n[test] onListening failed: ${String(err)}`;
            })
            .finally(() => child.kill("SIGTERM"));
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, out, listening });
      });
    });
  }

  it("boots on references only and answers /health 200; no value reaches the logs", async () => {
    let health = 0;
    const run = await boot({}, async (url) => {
      health = (await fetch(`${url}/health`)).status;
    });
    expect(run.listening, run.out).toBe(true);
    expect(health).toBe(200);
    for (const v of [ENCRYPTION_KEY, AUTH_SECRET, secretId]) expect(run.out).not.toContain(v);
  });

  it("exits 1 before the schema check when OpenBao is unreachable, naming the address", async () => {
    const port = await closedPort();
    const run = await boot({ OCW_OPENBAO_ADDR: `http://127.0.0.1:${port}` });
    expect(run.code).toBe(1);
    expect(run.listening).toBe(false);
    expect(run.out).toContain("Invalid API configuration");
    expect(run.out).toContain(`unreachable at http://127.0.0.1:${port}`);
    expect(run.out).not.toMatch(/Database schema|never been migrated/);
    expect(run.out).not.toContain(secretId);
  });

  it("exits 1 when a database URL is given as a reference (it must stay env/file)", async () => {
    const run = await boot({ DATABASE_URL: "openbao://secret/ocw/api#DATABASE_URL" });
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/DATABASE_URL: an openbao:\/\/ reference is only allowed for/);
  });
});
