import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { OpenBaoConfig, OpenBaoReference } from "../lib/openbao";
import { OpenBaoError } from "../lib/openbao";
import { createEnvFileSecretStore, MissingSecretError, type SecretStore } from "../lib/secret-store";
import { createObjectStorage } from "../modules/artifact/storage";
import {
  EnvError,
  fastifyTrustProxy,
  loadConfig,
  loadEnv,
  OPENBAO_ALLOWED,
  SignInRatePerMinute,
} from "./env";

describe("OCW_SIGNIN_RATE_LIMIT_PER_MINUTE", () => {
  it("defaults to 30 sign-ins per minute (production brake)", () => {
    expect(SignInRatePerMinute.parse(undefined)).toBe(30);
  });

  it("accepts a raised value for test harnesses and rejects nonsense", () => {
    expect(SignInRatePerMinute.parse("600")).toBe(600);
    expect(SignInRatePerMinute.safeParse("0").success).toBe(false);
    expect(SignInRatePerMinute.safeParse("abc").success).toBe(false);
  });
});

describe("object storage (OCW_S3_*, P-10)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };

  it("loads without any OCW_S3_* and leaves storage unconfigured", () => {
    const env = loadEnv(base);
    expect(env.OCW_S3_ENDPOINT).toBeNull();
    expect(env.OCW_S3_PUBLIC_URL).toBeNull();
    expect(env.OCW_S3_ACCESS_KEY_ID).toBeNull();
    expect(env.OCW_S3_BUCKET).toBe("ocw-attachments");
    expect(env.OCW_S3_REGION).toBe("garage");
    expect(env.OCW_ATTACHMENT_MAX_BYTES).toBe(26214400);
    expect(createObjectStorage(env, createEnvFileSecretStore({}))).toBeNull();
  });

  it("compose's empty values mean unset", () => {
    const env = loadEnv({
      ...base,
      OCW_S3_ENDPOINT: "",
      OCW_S3_PUBLIC_URL: "",
      OCW_S3_BUCKET: "",
      OCW_S3_REGION: "",
      OCW_S3_ACCESS_KEY_ID: "",
      OCW_ATTACHMENT_MAX_BYTES: "",
    });
    expect(env.OCW_S3_ENDPOINT).toBeNull();
    expect(env.OCW_S3_BUCKET).toBe("ocw-attachments");
    expect(env.OCW_ATTACHMENT_MAX_BYTES).toBe(26214400);
  });

  it("OCW_S3_PUBLIC_URL defaults to OCW_S3_ENDPOINT", () => {
    const env = loadEnv({ ...base, OCW_S3_ENDPOINT: "http://garage:3900" });
    expect(env.OCW_S3_PUBLIC_URL).toBe("http://garage:3900");
    const two = loadEnv({
      ...base,
      OCW_S3_ENDPOINT: "http://garage:3900",
      OCW_S3_PUBLIC_URL: "http://localhost:3900",
    });
    expect(two.OCW_S3_PUBLIC_URL).toBe("http://localhost:3900");
  });

  it("storage is configured only with endpoint, key id and the secret (never part of Env)", () => {
    const env = loadEnv({ ...base, OCW_S3_ENDPOINT: "http://garage:3900", OCW_S3_ACCESS_KEY_ID: "GK0123" });
    expect(createObjectStorage(env, createEnvFileSecretStore({}))).toBeNull();
    const storage = createObjectStorage(
      env,
      createEnvFileSecretStore({ OCW_S3_SECRET_ACCESS_KEY: "x".repeat(64) }),
    );
    expect(storage?.bucket).toBe("ocw-attachments");
    expect(JSON.stringify(env)).not.toContain("x".repeat(64));
  });

  it("OCW_ATTACHMENT_MAX_BYTES above 1 GiB is rejected", () => {
    expect(loadEnv({ ...base, OCW_ATTACHMENT_MAX_BYTES: String(1024 ** 3) }).OCW_ATTACHMENT_MAX_BYTES).toBe(
      1024 ** 3,
    );
    expect(() => loadEnv({ ...base, OCW_ATTACHMENT_MAX_BYTES: String(1024 ** 3 + 1) })).toThrow(EnvError);
    expect(() => loadEnv({ ...base, OCW_S3_ENDPOINT: "not a url" })).toThrow(EnvError);
  });
});

describe("AI chat variables (P-12)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };

  it("defaults: no ChatGPT overrides, AI mock/SearXNG follow the cell-facing values, 30 sends per minute", () => {
    const env = loadEnv(base);
    expect(env.OCW_CHATGPT_API_BASE_URL).toBeNull();
    expect(env.OCW_CHATGPT_AUTH_BASE_URL).toBeNull();
    expect(env.OCW_AI_MOCK_BASE_URL).toBe("http://fake-model:18999/v1");
    expect(env.OCW_AI_SEARXNG_URL).toBeNull();
    expect(env.OCW_AI_SEND_RATE_LIMIT_PER_MINUTE).toBe(30);
    expect(env.OCW_AI_TITLE_TIMEOUT_MS).toBe(20_000);
  });

  it("AI mock and SearXNG fall back to OCW_MOCK_MODEL_BASE_URL and OCW_SEARXNG_URL; empty means unset", () => {
    const env = loadEnv({
      ...base,
      OCW_MOCK_MODEL_BASE_URL: "http://fake:1/v1",
      OCW_SEARXNG_URL: "http://searxng:8080",
      OCW_CHATGPT_API_BASE_URL: "",
      OCW_AI_MOCK_BASE_URL: "",
      OCW_AI_SEARXNG_URL: "",
    });
    expect(env.OCW_AI_MOCK_BASE_URL).toBe("http://fake:1/v1");
    expect(env.OCW_AI_SEARXNG_URL).toBe("http://searxng:8080");
    expect(env.OCW_CHATGPT_API_BASE_URL).toBeNull();
  });

  it("explicit values win over the fallbacks", () => {
    const env = loadEnv({
      ...base,
      OCW_CHATGPT_API_BASE_URL: "http://127.0.0.1:4291/v1",
      OCW_CHATGPT_AUTH_BASE_URL: "http://127.0.0.1:4291",
      OCW_AI_MOCK_BASE_URL: "http://127.0.0.1:4291/v1",
      OCW_AI_SEARXNG_URL: "http://127.0.0.1:4291",
      OCW_AI_SEND_RATE_LIMIT_PER_MINUTE: "600",
      OCW_AI_TITLE_TIMEOUT_MS: "1500",
    });
    expect(env.OCW_CHATGPT_API_BASE_URL).toBe("http://127.0.0.1:4291/v1");
    expect(env.OCW_CHATGPT_AUTH_BASE_URL).toBe("http://127.0.0.1:4291");
    expect(env.OCW_AI_MOCK_BASE_URL).toBe("http://127.0.0.1:4291/v1");
    expect(env.OCW_AI_SEARXNG_URL).toBe("http://127.0.0.1:4291");
    expect(env.OCW_AI_SEND_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(env.OCW_AI_TITLE_TIMEOUT_MS).toBe(1_500);
  });

  it("rejects a bad URL and an out-of-range send limit", () => {
    expect(() => loadEnv({ ...base, OCW_CHATGPT_API_BASE_URL: "not a url" })).toThrow(EnvError);
    expect(() => loadEnv({ ...base, OCW_AI_SEND_RATE_LIMIT_PER_MINUTE: "0" })).toThrow(EnvError);
    expect(() => loadEnv({ ...base, OCW_AI_SEND_RATE_LIMIT_PER_MINUTE: "10001" })).toThrow(EnvError);
  });

  it("production refuses either ChatGPT override (test-only, T-05-02-07)", () => {
    for (const name of ["OCW_CHATGPT_API_BASE_URL", "OCW_CHATGPT_AUTH_BASE_URL"]) {
      expect(() => loadEnv({ ...base, NODE_ENV: "production", [name]: "http://127.0.0.1:1" })).toThrow(
        new RegExp(name),
      );
      expect(loadEnv({ ...base, NODE_ENV: "development", [name]: "http://127.0.0.1:1" })).toBeTruthy();
    }
    expect(loadEnv({ ...base, NODE_ENV: "production" }).OCW_CHATGPT_API_BASE_URL).toBeNull();
  });
});

describe("OCW_TRUST_PROXY (SELF-05, D-18)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };
  const trust = (value?: string) =>
    loadEnv(value === undefined ? base : { ...base, OCW_TRUST_PROXY: value }).OCW_TRUST_PROXY;

  it("defaults to false: X-Forwarded-For is ignored unless configured", () => {
    expect(trust()).toBe(false);
    expect(trust("")).toBe(false);
    expect(trust("false")).toBe(false);
  });

  it("accepts true, a hop count and a list of proxy IPs/CIDRs", () => {
    expect(trust("true")).toBe(true);
    expect(trust("1")).toBe(1);
    expect(trust("2")).toBe(2);
    expect(trust("10.0.0.0/8,127.0.0.1")).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(trust(" 172.16.0.0/12 , ::1 ")).toEqual(["172.16.0.0/12", "::1"]);
  });

  it("rejects anything else, naming the variable", () => {
    for (const bad of ["maybe", "10.0.0.0/33", "300.1.1.1", "-1", "1.5"]) {
      expect(() => trust(bad)).toThrow(EnvError);
      expect(() => trust(bad)).toThrow(/OCW_TRUST_PROXY/);
    }
  });

  it("hands Fastify a hop count as the equivalent trust function (Fastify fails closed on a bare number)", () => {
    const one = fastifyTrustProxy(1);
    expect(typeof one).toBe("function");
    if (typeof one !== "function") throw new Error("unreachable");
    expect(one("10.0.0.5", 0)).toBe(true);
    expect(one("203.0.113.77", 1)).toBe(false);
    expect(fastifyTrustProxy(false)).toBe(false);
    expect(fastifyTrustProxy(true)).toBe(true);
    expect(fastifyTrustProxy(["10.0.0.0/8"])).toEqual(["10.0.0.0/8"]);
  });
});

describe("loadConfig: openbao:// references for the API-only secrets (SELF-02, D-04, D-16)", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };
  const bao = {
    OCW_OPENBAO_ADDR: "http://openbao:8200",
    OCW_OPENBAO_ROLE_ID: "role-id",
    OCW_OPENBAO_SECRET_ID: "secret-id",
  };
  const ref = (field: string) => `openbao://secret/ocw/api#${field}`;
  const dir = mkdtempSync(join(tmpdir(), "ocw-load-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in for createOpenBaoSecretStore that serves `values` by field and records how it was called. */
  function stub(values: Record<string, string>) {
    const calls: Array<{ cfg: OpenBaoConfig; refs: OpenBaoReference[] }> = [];
    const create = vi.fn(async (cfg: OpenBaoConfig, refs: OpenBaoReference[]): Promise<SecretStore> => {
      calls.push({ cfg, refs });
      return {
        resolveSync(r) {
          if (r.provider !== "openbao") throw new MissingSecretError("openbao only");
          const v = values[r.field];
          if (v === undefined) throw new MissingSecretError(`${ref(r.field)} not found`);
          return v;
        },
      };
    });
    return { create, calls };
  }

  it("allows exactly the four API-only secrets", () => {
    expect([...OPENBAO_ALLOWED].sort()).toEqual(
      ["BETTER_AUTH_SECRET", "OCW_ENCRYPTION_KEY", "OCW_SETUP_TOKEN", "OCW_SMTP_URL"].sort(),
    );
  });

  it("resolves a reference through OpenBao before validation", async () => {
    const { create, calls } = stub({ OCW_ENCRYPTION_KEY: KEY });
    const env = await loadConfig(
      { ...base, ...bao, OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY") },
      { createOpenBaoStore: create },
    );
    expect(env.OCW_ENCRYPTION_KEY).toBe(KEY);
    expect(env.BETTER_AUTH_SECRET).toBe(base.BETTER_AUTH_SECRET);
    expect(create).toHaveBeenCalledTimes(1);
    expect(calls[0]?.cfg).toEqual({
      addr: "http://openbao:8200",
      roleId: "role-id",
      secretId: "secret-id",
      token: undefined,
    });
    expect(calls[0]?.refs).toEqual([
      { provider: "openbao", mount: "secret", path: "ocw/api", field: "OCW_ENCRYPTION_KEY" },
    ]);
  });

  it("resolves all four, a reference given through NAME_FILE, and the OpenBao secret id from a file", async () => {
    const refFile = join(dir, "auth-ref");
    writeFileSync(refFile, `${ref("BETTER_AUTH_SECRET")}\n`);
    const idFile = join(dir, "secret-id");
    writeFileSync(idFile, "secret-id-from-file\n");
    const { create, calls } = stub({
      BETTER_AUTH_SECRET: "B".repeat(40),
      OCW_ENCRYPTION_KEY: KEY,
      OCW_SETUP_TOKEN: "T".repeat(20),
      OCW_SMTP_URL: "smtp://mail.example.com:587",
    });
    const { BETTER_AUTH_SECRET: _drop, ...rest } = base;
    const env = await loadConfig(
      {
        ...rest,
        OCW_OPENBAO_ADDR: "http://openbao:8200",
        OCW_OPENBAO_ROLE_ID: "role-id",
        OCW_OPENBAO_SECRET_ID_FILE: idFile,
        BETTER_AUTH_SECRET_FILE: refFile,
        OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY"),
        OCW_SETUP_TOKEN: ref("OCW_SETUP_TOKEN"),
        OCW_SMTP_URL: ref("OCW_SMTP_URL"),
      },
      { createOpenBaoStore: create },
    );
    expect(env.BETTER_AUTH_SECRET).toBe("B".repeat(40));
    expect(env.OCW_SETUP_TOKEN).toBe("T".repeat(20));
    expect(env.OCW_SMTP_URL).toBe("smtp://mail.example.com:587");
    expect(calls[0]?.cfg.secretId).toBe("secret-id-from-file");
    expect(calls[0]?.refs).toHaveLength(4);
  });

  it("a token instead of AppRole is passed through (NAME or NAME_FILE)", async () => {
    const { create, calls } = stub({ OCW_SETUP_TOKEN: "T".repeat(20) });
    await loadConfig(
      {
        ...base,
        OCW_OPENBAO_ADDR: "http://openbao:8200",
        OCW_OPENBAO_TOKEN: "tok",
        OCW_SETUP_TOKEN: ref("OCW_SETUP_TOKEN"),
      },
      { createOpenBaoStore: create },
    );
    expect(calls[0]?.cfg).toEqual({
      addr: "http://openbao:8200",
      roleId: undefined,
      secretId: undefined,
      token: "tok",
    });
  });

  it("never contacts OpenBao when no reference is present", async () => {
    const { create } = stub({});
    const env = await loadConfig({ ...base, ...bao }, { createOpenBaoStore: create });
    expect(env.OCW_ENCRYPTION_KEY).toBe(base.OCW_ENCRYPTION_KEY);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a reference in any other variable: it must stay env/file", async () => {
    const { create } = stub({});
    for (const name of [
      "DATABASE_URL",
      "AUTH_DATABASE_URL",
      "REDIS_URL",
      "OCW_CELL_TOKEN",
      "OCW_S3_SECRET_ACCESS_KEY",
      "OCW_PUBLIC_WEB_URL",
    ]) {
      const run = loadConfig({ ...base, ...bao, [name]: ref(name) }, { createOpenBaoStore: create });
      await expect(run).rejects.toThrow(EnvError);
      await expect(
        loadConfig({ ...base, ...bao, [name]: ref(name) }, { createOpenBaoStore: create }),
      ).rejects.toThrow(new RegExp(`${name}: .*must stay env/file`));
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("a malformed reference or a missing OCW_OPENBAO_ADDR fails naming the variable", async () => {
    const { create } = stub({});
    await expect(
      loadConfig(
        { ...base, ...bao, OCW_ENCRYPTION_KEY: "openbao://secret#KEY" },
        { createOpenBaoStore: create },
      ),
    ).rejects.toThrow(/OCW_ENCRYPTION_KEY: .*openbao:\/\/<mount>\/<path>#<field>/);
    await expect(
      loadConfig({ ...base, OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY") }, { createOpenBaoStore: create }),
    ).rejects.toThrow(/OCW_OPENBAO_ADDR/);
    await expect(
      loadConfig(
        { ...base, OCW_OPENBAO_ADDR: "http://openbao:8200", OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY") },
        { createOpenBaoStore: create },
      ),
    ).rejects.toThrow(/OCW_OPENBAO_ROLE_ID.*OCW_OPENBAO_TOKEN/);
    expect(create).not.toHaveBeenCalled();
  });

  it("OpenBao failures become an EnvError naming the variable and reference, never a value", async () => {
    const failing = vi.fn(async () => {
      throw new OpenBaoError("OpenBao is unreachable at http://openbao:8200");
    });
    const run = loadConfig(
      { ...base, ...bao, OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY") },
      { createOpenBaoStore: failing },
    );
    await expect(run).rejects.toThrow(EnvError);
    await expect(
      loadConfig(
        { ...base, ...bao, OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY") },
        { createOpenBaoStore: failing },
      ),
    ).rejects.toThrow(/unreachable at http:\/\/openbao:8200/);

    const { create } = stub({ OCW_ENCRYPTION_KEY: KEY });
    const err = await loadConfig(
      {
        ...base,
        ...bao,
        OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY"),
        OCW_SETUP_TOKEN: ref("OCW_SETUP_TOKEN"),
      },
      { createOpenBaoStore: create },
    ).then(
      () => new Error("expected a rejection"),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(EnvError);
    expect(err.message).toContain("OCW_SETUP_TOKEN");
    expect(err.message).toContain(ref("OCW_SETUP_TOKEN"));
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("secret-id");
  });

  it("a value from OpenBao is still validated, and the message never contains it", async () => {
    const { create } = stub({ OCW_ENCRYPTION_KEY: "too-short-canary" });
    const err = await loadConfig(
      { ...base, ...bao, OCW_ENCRYPTION_KEY: ref("OCW_ENCRYPTION_KEY") },
      { createOpenBaoStore: create },
    ).then(
      () => new Error("expected a rejection"),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(EnvError);
    expect(err.message).toMatch(/OCW_ENCRYPTION_KEY: must be 32 bytes/);
    expect(err.message).not.toContain("too-short-canary");
  });

  it('a missing variable still fails fast with "set NAME or NAME_FILE"', async () => {
    const { OCW_ENCRYPTION_KEY: _drop, ...rest } = base;
    await expect(loadConfig(rest)).rejects.toThrow(
      /OCW_ENCRYPTION_KEY: .*\(set OCW_ENCRYPTION_KEY or OCW_ENCRYPTION_KEY_FILE\)/,
    );
  });
});
