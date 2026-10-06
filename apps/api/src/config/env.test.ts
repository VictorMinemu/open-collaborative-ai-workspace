import { describe, expect, it } from "vitest";
import { createEnvFileSecretStore } from "../lib/secret-store";
import { createObjectStorage } from "../modules/artifact/storage";
import { EnvError, loadEnv, SignInRatePerMinute } from "./env";

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
    });
    expect(env.OCW_CHATGPT_API_BASE_URL).toBe("http://127.0.0.1:4291/v1");
    expect(env.OCW_CHATGPT_AUTH_BASE_URL).toBe("http://127.0.0.1:4291");
    expect(env.OCW_AI_MOCK_BASE_URL).toBe("http://127.0.0.1:4291/v1");
    expect(env.OCW_AI_SEARXNG_URL).toBe("http://127.0.0.1:4291");
    expect(env.OCW_AI_SEND_RATE_LIMIT_PER_MINUTE).toBe(600);
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
