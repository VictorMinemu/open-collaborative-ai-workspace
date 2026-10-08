import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "./testing";

/**
 * FOUND-05 / D-05 tracer: the real API process (`node --import tsx --import ./src/telemetry.ts src/main.ts`, the
 * same line as `pnpm start`) exports OTLP/HTTP JSON to a local receiver; nothing secret or host-specific leaves it.
 */

const CANARY = "QUERY-CANARY";
const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const ADMIN = {
  name: "Ada Admin",
  email: "ada@example.test",
  password: "correct-horse-battery",
  orgName: "Acme",
};

interface Received {
  path: string;
  body: string;
}

/** A minimal OTLP/HTTP receiver: records every POST body (JSON exporters) and answers 200. */
async function startReceiver() {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    received,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Api {
  child: ChildProcess;
  baseUrl: string;
  stdout: string[];
  stop(): Promise<void>;
}

let db: TestDatabase;
let redis: StartedRedisContainer;

async function startApi(extraEnv: Record<string, string>): Promise<Api> {
  const port = await freePort();
  const stdout: string[] = [];
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", "./src/telemetry.ts", "src/main.ts"],
    {
      cwd: API_DIR,
      // A clean environment: nothing from the developer's shell (OTEL_*, .env) leaks into the child.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        LOG_LEVEL: "info",
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_URL: db.appUrl,
        AUTH_DATABASE_URL: db.authUrl,
        REDIS_URL: redis.getConnectionUrl(),
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        OCW_SETUP_TOKEN: TEST_SETUP_TOKEN,
        OCW_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        OCW_PUBLIC_WEB_URL: WEB_ORIGIN,
        OCW_PUBLIC_API_URL: `http://127.0.0.1:${port}`,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (d: Buffer) => stdout.push(d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => stdout.push(d.toString("utf8")));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}:\n${stdout.join("")}`);
    const ok = await fetch(`${baseUrl}/health`).then(
      (r) => r.status === 200,
      () => false,
    );
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`API did not start:\n${stdout.join("")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    child,
    baseUrl,
    stdout,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

const OTEL_FAST = {
  OTEL_BSP_SCHEDULE_DELAY: "100",
  OTEL_BLRP_SCHEDULE_DELAY: "100",
  OTEL_METRIC_EXPORT_INTERVAL: "300",
  OTEL_METRIC_EXPORT_TIMEOUT: "250",
};

// OTLP/JSON shapes, only the parts asserted here.
type KeyValue = { key: string; value: Record<string, unknown> };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  attributes?: KeyValue[];
};
const attr = (s: { attributes?: KeyValue[] }, key: string) =>
  s.attributes?.find((a) => a.key === key)?.value as { stringValue?: string } | undefined;

function spansOf(received: Received[]): Array<OtlpSpan & { scope: string }> {
  const out: Array<OtlpSpan & { scope: string }> = [];
  for (const r of received.filter((x) => x.path === "/v1/traces")) {
    const json = JSON.parse(r.body) as {
      resourceSpans: Array<{ scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }> }>;
    };
    for (const rs of json.resourceSpans)
      for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push({ ...s, scope: ss.scope.name });
  }
  return out;
}

async function until<T>(fn: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting for telemetry");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  [db, redis] = await Promise.all([startTestDatabase(), new RedisContainer("redis:8").start()]);
});

afterAll(async () => {
  await Promise.allSettled([db?.stop(), redis?.stop()]);
});

describe("telemetry on (OTEL_EXPORTER_OTLP_ENDPOINT set)", () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let api: Api;
  let traceId: string;

  beforeAll(async () => {
    receiver = await startReceiver();
    api = await startApi({ OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, ...OTEL_FAST });
    const client = new TestClient(api.baseUrl);
    const setup = await client.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN });
    expect(setup.status).toBe(200);
    // One authenticated request that reads the database, with a query-string canary.
    const me = await client.request("GET", `/api/v1/me?token=${CANARY}`);
    expect(me.status).toBe(200);
    const request = await until(() =>
      spansOf(receiver.received).find(
        (s) =>
          s.scope === "@fastify/otel" &&
          s.name === "request" &&
          attr(s, "http.route")?.stringValue === "/api/v1/me",
      ),
    );
    traceId = request.traceId;
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    await receiver?.close();
  });

  it("exports the fastify request span with http.route, the http server span and a pg span in one trace", async () => {
    const inTrace = await until(() => {
      const spans = spansOf(receiver.received).filter((s) => s.traceId === traceId);
      const http = spans.find((s) => s.scope === "@opentelemetry/instrumentation-http" && s.kind === 2);
      const pg = spans.find(
        (s) => s.scope === "@opentelemetry/instrumentation-pg" && s.name.startsWith("pg.query"),
      );
      return http && pg ? { http, pg } : undefined;
    });
    expect(attr(inTrace.http, "http.route")?.stringValue).toBe("/api/v1/me");
    expect(
      attr(inTrace.pg, "db.query.text")?.stringValue ?? attr(inTrace.pg, "db.statement")?.stringValue,
    ).toBeTruthy();
  });

  it("exports no query string, process path, argv or repository path", async () => {
    // Let the metric and log pipelines flush at least once too.
    await new Promise((r) => setTimeout(r, 1_000));
    const all = receiver.received.map((r) => r.body).join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain("process.executable.path");
    expect(all).not.toContain("process.command_args");
    expect(all).not.toContain(REPO_ROOT);
    expect(all).not.toContain(TEST_SETUP_TOKEN);
  });
});

describe("telemetry off (no endpoint)", () => {
  it("boots normally and sends nothing", async () => {
    const receiver = await startReceiver();
    // Only OTEL_EXPORTER_OTLP_ENDPOINT turns telemetry on. The per-signal variables point at the receiver: an SDK
    // that had loaded anyway would export there, so silence proves it never started.
    const api = await startApi({
      ...OTEL_FAST,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${receiver.url}/v1/traces`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${receiver.url}/v1/metrics`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${receiver.url}/v1/logs`,
    });
    try {
      expect((await fetch(`${api.baseUrl}/health?token=${CANARY}`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(receiver.received).toHaveLength(0);
      expect(api.stdout.join("")).not.toMatch(/OTEL_|opentelemetry|telemetry disabled/i);
    } finally {
      await api.stop();
      await receiver.close();
    }
  }, 120_000);
});

describe("telemetry with an unreachable collector", () => {
  it("keeps serving /health", async () => {
    const closed = await freePort();
    const api = await startApi({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${closed}`, ...OTEL_FAST });
    try {
      expect((await fetch(`${api.baseUrl}/health`)).status).toBe(200);
      // Several export attempts fail in the meantime.
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await fetch(`${api.baseUrl}/health`)).status).toBe(200);
      expect(api.child.exitCode).toBeNull();
    } finally {
      await api.stop();
    }
  }, 120_000);
});
