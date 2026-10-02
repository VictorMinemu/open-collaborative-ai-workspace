import { randomBytes } from "node:crypto";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { type BuiltApp, buildApp } from "./app";
import { type Env, loadEnv } from "./config/env";

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
export async function startTestStack(): Promise<TestStack> {
  const [db, redis] = await Promise.all([startTestDatabase(), new RedisContainer("redis:8").start()]);
  const env = loadEnv({
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
  });
  const built = await buildApp(env, { logger: false });
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

  async request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { origin: WEB_ORIGIN };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = this.cookieHeader;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const idx = pair!.indexOf("=");
      const k = pair!.slice(0, idx);
      const v = pair!.slice(idx + 1);
      if (v === "" || /max-age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }
}
