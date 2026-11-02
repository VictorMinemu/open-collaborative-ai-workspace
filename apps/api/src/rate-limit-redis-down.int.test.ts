import { connect, createServer, type Server, type Socket } from "node:net";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "./testing";

/**
 * 07.6 review A HI-02: every rate-limited route counts in Redis, so losing Redis must not lock people out. With the
 * stack's Redis gone, sign-in still answers at once and its limit still holds (counted in this instance's memory until
 * Redis is back), instead of hanging on the client's offline queue or failing with a 500.
 *
 * The API reaches Redis through a TCP relay the test owns: "Redis down" closes every connection and stops listening
 * (connections are refused, as when the server stops), and bringing it back lets the clients reconnect, so the stack
 * shuts down normally afterwards.
 */

const ADMIN = {
  name: "Ada Admin",
  email: "ada@example.test",
  password: "correct-horse-battery",
  orgName: "Acme",
};
const LIMIT = 3;

let stack: TestStack;
let redis: StartedRedisContainer;
let relay: Relay;

/** A TCP relay to Redis on a fixed local port that can go down and come back. */
class Relay {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;

  constructor(
    private readonly host: string,
    private readonly targetPort: number,
  ) {}

  async up(): Promise<void> {
    const server = createServer((client) => {
      const upstream = connect(this.targetPort, this.host);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on("close", () => this.sockets.delete(s));
        s.on("error", () => s.destroy());
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }

  async down(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function signIn(password: string): Promise<{ status: number; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${stack.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3999" },
    body: JSON.stringify({ email: ADMIN.email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  await res.text();
  return { status: res.status, ms: Date.now() - started };
}

beforeAll(async () => {
  // The API's Redis, reached only through the relay.
  redis = await new RedisContainer("redis:8").start();
  relay = new Relay(redis.getHost(), redis.getFirstMappedPort());
  await relay.up();
  stack = await startTestStack({
    env: {
      OCW_SIGNIN_RATE_LIMIT_PER_MINUTE: String(LIMIT),
      REDIS_URL: `redis://127.0.0.1:${relay.port}`,
    },
  });
  const setup = await new TestClient(stack.baseUrl).request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
  });
  expect(setup.status).toBe(200);
}, 180_000);

afterAll(async () => {
  try {
    await stack?.stop();
  } finally {
    await relay?.down();
    await redis?.stop();
  }
});

describe("rate-limited routes with Redis down (07.6 review A HI-02)", () => {
  it("sign-in answers quickly and its limit still applies while Redis is unreachable", async () => {
    await relay.down();
    try {
      const ok = await signIn(ADMIN.password);
      expect(ok.status).toBe(200);
      expect(ok.ms).toBeLessThan(3_000);
      const answers: number[] = [];
      for (let i = 0; i < LIMIT; i++) {
        const r = await signIn("definitely-the-wrong-one");
        expect(r.ms).toBeLessThan(3_000);
        answers.push(r.status);
      }
      // Four attempts in the window with a limit of three: the last is refused, not let through.
      expect(answers.slice(0, LIMIT - 1).every((s) => s === 401)).toBe(true);
      expect(answers.at(-1)).toBe(429);
    } finally {
      await relay.up();
    }
  }, 60_000);
});
