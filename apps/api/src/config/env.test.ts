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

describe("Presidio variables (MEM-05, D-06)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };

  it("defaults: off (no URL), Spanish and English, a 2 s deadline", () => {
    const env = loadEnv(base);
    expect(env.OCW_PRESIDIO_URL).toBeNull();
    expect(env.OCW_PRESIDIO_LANGUAGES).toEqual(["es", "en"]);
    expect(env.OCW_PRESIDIO_TIMEOUT_MS).toBe(2000);
  });

  it("compose's empty values mean the defaults", () => {
    const env = loadEnv({
      ...base,
      OCW_PRESIDIO_URL: "",
      OCW_PRESIDIO_LANGUAGES: "",
      OCW_PRESIDIO_TIMEOUT_MS: "",
    });
    expect(env.OCW_PRESIDIO_URL).toBeNull();
    expect(env.OCW_PRESIDIO_LANGUAGES).toEqual(["es", "en"]);
    expect(env.OCW_PRESIDIO_TIMEOUT_MS).toBe(2000);
  });

  it("accepts a URL with a path, one language, a custom deadline", () => {
    const env = loadEnv({
      ...base,
      OCW_PRESIDIO_URL: "http://presidio:3000/analyzer/",
      OCW_PRESIDIO_LANGUAGES: " EN ",
      OCW_PRESIDIO_TIMEOUT_MS: "500",
    });
    expect(env.OCW_PRESIDIO_URL).toBe("http://presidio:3000/analyzer/");
    expect(env.OCW_PRESIDIO_LANGUAGES).toEqual(["en"]);
    expect(env.OCW_PRESIDIO_TIMEOUT_MS).toBe(500);
  });

  it("refuses an unsupported language, a bad URL and an out-of-range deadline, naming the variable", () => {
    expect(() => loadEnv({ ...base, OCW_PRESIDIO_LANGUAGES: "fr" })).toThrow(/OCW_PRESIDIO_LANGUAGES/);
    expect(() => loadEnv({ ...base, OCW_PRESIDIO_LANGUAGES: "es,fr" })).toThrow(EnvError);
    expect(() => loadEnv({ ...base, OCW_PRESIDIO_URL: "not a url" })).toThrow(/OCW_PRESIDIO_URL/);
    expect(() => loadEnv({ ...base, OCW_PRESIDIO_TIMEOUT_MS: "50" })).toThrow(/OCW_PRESIDIO_TIMEOUT_MS/);
    expect(() => loadEnv({ ...base, OCW_PRESIDIO_TIMEOUT_MS: "10001" })).toThrow(EnvError);
  });
});

describe("sandboxd variables (07.8-05, D-11)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };
  const token = "t".repeat(32);

  it("unset or compose-empty: the service is not configured", () => {
    for (const env of [loadEnv(base), loadEnv({ ...base, OCW_SANDBOX_URL: "", OCW_SANDBOX_TOKEN: "" })]) {
      expect(env.OCW_SANDBOX_URL).toBeNull();
      expect(env.OCW_SANDBOX_TOKEN).toBeNull();
    }
  });

  it("both set: the URL and the token (also from a _FILE)", () => {
    const env = loadEnv({ ...base, OCW_SANDBOX_URL: "http://sandboxd:8090", OCW_SANDBOX_TOKEN: token });
    expect(env.OCW_SANDBOX_URL).toBe("http://sandboxd:8090");
    expect(env.OCW_SANDBOX_TOKEN).toBe(token);
    const dir = mkdtempSync(join(tmpdir(), "ocw-sbx-"));
    try {
      writeFileSync(join(dir, "token"), `${token}\n`);
      const fromFile = loadEnv({
        ...base,
        OCW_SANDBOX_URL: "http://sandboxd:8090",
        OCW_SANDBOX_TOKEN_FILE: join(dir, "token"),
      });
      expect(fromFile.OCW_SANDBOX_TOKEN).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a token without a URL is an install with the `sandbox` profile off: not configured, boots (07.8-24)", () => {
    // `pnpm ocw setup` writes the token for every install; the URL is set only when the profile is enabled.
    const env = loadEnv({ ...base, OCW_SANDBOX_URL: "", OCW_SANDBOX_TOKEN: token });
    expect(env.OCW_SANDBOX_URL).toBeNull();
    expect(env.OCW_SANDBOX_TOKEN).toBe(token);
  });

  it("a URL needs a token of at least 32 characters, never the value in the message", () => {
    expect(() => loadEnv({ ...base, OCW_SANDBOX_URL: "http://sandboxd:8090" })).toThrow(/OCW_SANDBOX_TOKEN/);
    const short = "short-sandbox-token";
    let message = "";
    try {
      loadEnv({ ...base, OCW_SANDBOX_URL: "http://sandboxd:8090", OCW_SANDBOX_TOKEN: short });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/OCW_SANDBOX_TOKEN/);
    expect(message).not.toContain(short);
    expect(() => loadEnv({ ...base, OCW_SANDBOX_URL: "not a url", OCW_SANDBOX_TOKEN: token })).toThrow(
      /OCW_SANDBOX_URL/,
    );
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

describe("egress variables (D-07)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };

  it("OCW_EGRESS_TEST_HOSTS unset or empty is an empty map", () => {
    expect(loadEnv(base).OCW_EGRESS_TEST_HOSTS).toEqual(new Map());
    expect(loadEnv({ ...base, OCW_EGRESS_TEST_HOSTS: "" }).OCW_EGRESS_TEST_HOSTS).toEqual(new Map());
  });

  it("OCW_EGRESS_TEST_HOSTS maps test host names to loopback addresses", () => {
    const env = loadEnv({ ...base, OCW_EGRESS_TEST_HOSTS: "fake-mcp=127.0.0.1, Other.Test=::1" });
    expect(env.OCW_EGRESS_TEST_HOSTS).toEqual(
      new Map([
        ["fake-mcp", "127.0.0.1"],
        ["other.test", "::1"],
      ]),
    );
  });

  it("a malformed entry or a non-loopback address fails naming the variable", () => {
    for (const value of ["bad", "fake-mcp=", "=127.0.0.1", "fake-mcp=10.0.0.1", "fake-mcp=example.com"]) {
      expect(() => loadEnv({ ...base, OCW_EGRESS_TEST_HOSTS: value })).toThrow(/OCW_EGRESS_TEST_HOSTS/);
    }
  });

  it("production refuses OCW_EGRESS_TEST_HOSTS (test-only)", () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: "production", OCW_EGRESS_TEST_HOSTS: "fake-mcp=127.0.0.1" }),
    ).toThrow(/OCW_EGRESS_TEST_HOSTS: is test-only/);
    expect(loadEnv({ ...base, NODE_ENV: "production" }).OCW_EGRESS_TEST_HOSTS).toEqual(new Map());
  });

  it("OCW_OPENBAO_ADDR is part of the configuration (the egress platform list), empty means unset", () => {
    expect(loadEnv(base).OCW_OPENBAO_ADDR).toBeNull();
    expect(loadEnv({ ...base, OCW_OPENBAO_ADDR: "" }).OCW_OPENBAO_ADDR).toBeNull();
    expect(loadEnv({ ...base, OCW_OPENBAO_ADDR: "http://openbao:8200" }).OCW_OPENBAO_ADDR).toBe(
      "http://openbao:8200",
    );
  });
});

describe("OCW_JOBS_WORKER (07.6-03, AUTO-01)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };

  it("defaults to on, and to off when NODE_ENV is test (test stacks drain jobs themselves)", () => {
    expect(loadEnv(base).OCW_JOBS_WORKER).toBe("on");
    expect(loadEnv({ ...base, NODE_ENV: "production" }).OCW_JOBS_WORKER).toBe("on");
    expect(loadEnv({ ...base, OCW_JOBS_WORKER: "" }).OCW_JOBS_WORKER).toBe("on");
    expect(loadEnv({ ...base, NODE_ENV: "test" }).OCW_JOBS_WORKER).toBe("off");
  });

  it("accepts on and off, explicitly in any environment, and rejects anything else naming the variable", () => {
    expect(loadEnv({ ...base, OCW_JOBS_WORKER: "off" }).OCW_JOBS_WORKER).toBe("off");
    expect(loadEnv({ ...base, NODE_ENV: "test", OCW_JOBS_WORKER: "on" }).OCW_JOBS_WORKER).toBe("on");
    expect(() => loadEnv({ ...base, OCW_JOBS_WORKER: "yes" })).toThrow(/OCW_JOBS_WORKER/);
  });
});

describe("OCW_BUNDLED_PLUGINS (D-06, D-09)", () => {
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };
  const bundled = (value?: string) =>
    loadEnv(value === undefined ? base : { ...base, OCW_BUNDLED_PLUGINS: value }).OCW_BUNDLED_PLUGINS;

  it("unset means every bundled search plugin", () => {
    expect(bundled()).toEqual(["duckduckgo", "searxng"]);
  });

  it("compose's empty value (and whitespace) means unset, as in the cell", () => {
    expect(bundled("")).toEqual(["duckduckgo", "searxng"]);
    expect(bundled("   ")).toEqual(["duckduckgo", "searxng"]);
  });

  it("`none` bundles nothing and a comma list picks plugins (trimmed, lower-cased)", () => {
    expect(bundled("none")).toEqual([]);
    expect(bundled(" None ")).toEqual([]);
    expect(bundled("duckduckgo")).toEqual(["duckduckgo"]);
    expect(bundled(" SearXNG , ")).toEqual(["searxng"]);
  });
});
