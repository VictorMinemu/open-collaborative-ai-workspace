import { randomBytes } from "node:crypto";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { type BuiltApp, buildApp } from "./app";
import { type Env, loadEnv } from "./config/env";
import { createEnvFileSecretStore } from "./lib/secret-store";

export const TEST_SETUP_TOKEN = "test-setup-token-0123456789";
export const WEB_ORIGIN = "http://localhost:3999";

export interface TestStack {
  db: TestDatabase;
  redis: StartedRedisContainer;
  env: Env;
  built: BuiltApp;
  baseUrl: string;
  stop(): Promise<void>;
}

/** Real PostgreSQL 18 + Redis 8 (testcontainers) and the full API listening on a random port. */
export async function startTestStack(
  opts: {
    /** Extra/overridden env vars (e.g. OCW_CELL_TOKEN, OCW_MODEL_PROVIDER). */
    env?: Record<string, string>;
    /** Capture API log lines (enables the logger at LOG_LEVEL, default silent). */
    logStream?: { write(msg: string): void };
    /** A lower Device Link frame limit for this stack (06.1-02 frame guard tests). */
    deviceFrameMaxBytes?: number;
  } = {},
): Promise<TestStack> {
  const [db, redis] = await Promise.all([startTestDatabase(), new RedisContainer("redis:8").start()]);
  const source = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: db.appUrl,
    AUTH_DATABASE_URL: db.authUrl,
    REDIS_URL: redis.getConnectionUrl(),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    OCW_SETUP_TOKEN: TEST_SETUP_TOKEN,
    OCW_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    OCW_PUBLIC_WEB_URL: WEB_ORIGIN,
    OCW_PUBLIC_API_URL: "http://localhost:4999",
    ...opts.env,
  };
  const env = loadEnv(source);
  // SecretReferences (env provider) resolve against the same values, e.g. OCW_S3_SECRET_ACCESS_KEY.
  const secretStore = createEnvFileSecretStore({ ...process.env, ...source });
  const built = await buildApp(env, {
    ...(opts.logStream ? { logger: true, logStream: opts.logStream } : { logger: false }),
    secretStore,
    ...(opts.deviceFrameMaxBytes ? { deviceFrameMaxBytes: opts.deviceFrameMaxBytes } : {}),
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = built.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    db,
    redis,
    env,
    built,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await built.close();
      await Promise.allSettled([db.stop(), redis.stop()]);
    },
  };
}

/** Minimal cookie-jar fetch for tests. */
export class TestClient {
  cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /**
   * Extra `opts.headers` are merged last (e.g. `authorization: Bearer <jwt>`); `noCookies` sends the request
   * without the cookie jar and leaves the jar untouched.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; noCookies?: boolean } = {},
  ) {
    const headers: Record<string, string> = { origin: WEB_ORIGIN };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size && !opts.noCookies) headers.cookie = this.cookieHeader;
    Object.assign(headers, opts.headers);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!opts.noCookies) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const idx = pair!.indexOf("=");
        const k = pair!.slice(0, idx);
        const v = pair!.slice(idx + 1);
        if (v === "" || /max-age=0/i.test(c)) this.cookies.delete(k);
        else this.cookies.set(k, v);
      }
    }
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  /** A fresh 10-minute access JWT for the signed-in session (GET /api/auth/token with the cookie jar). */
  async token(): Promise<string> {
    const res = await this.request("GET", "/api/auth/token");
    const token = res.body?.token;
    if (res.status !== 200 || typeof token !== "string")
      throw new Error(`token request failed: ${res.status}`);
    return token;
  }
}
