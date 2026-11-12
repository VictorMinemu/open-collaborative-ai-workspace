import { randomBytes } from "node:crypto";
import type { RuntimeCompatibilityManifest } from "@ocw/contracts";
import { startAllOrNone, startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { type BuiltApp, buildApp } from "./app";
import { type Env, loadEnv } from "./config/env";
import { createEnvFileSecretStore } from "./lib/secret-store";
import type { BrowserBudgets, SandboxBudgets } from "./modules/agent-channel";

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

export interface TestStackOptions {
  /** Extra/overridden env vars (e.g. OCW_CELL_TOKEN, OCW_MODEL_PROVIDER). */
  env?: Record<string, string>;
  /** Capture API log lines (enables the logger at LOG_LEVEL, default silent). */
  logStream?: { write(msg: string): void };
  /** A lower Device Link frame limit for this stack (06.1-02 frame guard tests). */
  deviceFrameMaxBytes?: number;
  /** A compatibility manifest other than the bundled one, e.g. with a broken range (07.11 PD-12 start tests). */
  runtimeManifest?: RuntimeCompatibilityManifest;
  /** Shorter bot browser call deadlines for this stack (CI p64/p66 deadline tests). */
  browserBudgetsMs?: BrowserBudgets;
  /** Shorter bot sandbox call budgets for this stack (CI p142/p164/p178 cold-start tests). */
  sandboxBudgetsMs?: SandboxBudgets;
  /** Shorter bot file transfer deadlines for this stack (07.17.1.1 timeout tests). */
  botFileDeadlineMs?: (bytes: number) => number;
}

/** Real PostgreSQL 18 + Redis 8 (testcontainers) and the full API listening on a random port. */
export async function startTestStack(opts: TestStackOptions = {}): Promise<TestStack> {
  // Both containers or neither (WINDOWS #213): a failed start stops the one that came up.
  const [db, redis] = await startAllOrNone([startTestDatabase(), new RedisContainer("redis:8").start()]);
  const stopContainers = () => Promise.allSettled([db.stop(), redis.stop()]);
  try {
    return await buildStack(db, redis, opts, stopContainers);
  } catch (err) {
    await stopContainers();
    throw err;
  }
}

async function buildStack(
  db: TestDatabase,
  redis: StartedRedisContainer,
  opts: TestStackOptions,
  stopContainers: () => Promise<unknown>,
): Promise<TestStack> {
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
    ...(opts.runtimeManifest ? { runtimeManifest: opts.runtimeManifest } : {}),
    ...(opts.browserBudgetsMs ? { browserBudgetsMs: opts.browserBudgetsMs } : {}),
    ...(opts.sandboxBudgetsMs ? { sandboxBudgetsMs: opts.sandboxBudgetsMs } : {}),
    ...(opts.botFileDeadlineMs ? { botFileDeadlineMs: opts.botFileDeadlineMs } : {}),
  });
  try {
    await built.app.listen({ host: "127.0.0.1", port: 0 });
  } catch (err) {
    await built.close().catch(() => {});
    throw err;
  }
  const addr = built.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    db,
    redis,
    env,
    built,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      // The containers stop whatever the app's close does (WINDOWS #213); its failure is still reported.
      try {
        await built.close();
      } finally {
        await stopContainers();
      }
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
