import type { AddressInfo } from "node:net";
import {
  type AiDeltaEvent,
  type ChatgptPlanStatus,
  type DurableFrame,
  EphemeralTypes,
  type ServerFrame,
  WS_AUTH_PROTOCOL_PREFIX,
  WS_PROTOCOL,
} from "@ocw/contracts";
import WebSocket from "ws";
import { createFakeModelServer, type FakeModelRequest } from "../../../infra/fake-model/server.mjs";
import { type BuiltApp, buildApp } from "./app";
import { createEnvFileSecretStore } from "./lib/secret-store";
import { startTestStack, type TestClient, type TestStack, WEB_ORIGIN } from "./testing";

/**
 * Phase 5 test harness (Wave 0): the in-process fake model (OpenAI Responses, chat-completions, Anthropic), an API
 * stack pointed at it with log capture, the ChatGPT-plan seed, a `conv:<id>` WebSocket subscriber and a second API
 * instance on the same database and Redis (05-06). No test ever calls a real provider (P-08, Pitfall 7).
 */

export interface FakeModel {
  /** e.g. http://127.0.0.1:54321 (append /v1 for OpenAI-shaped clients). */
  baseUrl: string;
  /** Captured model requests, optionally of one kind. */
  requests(kind?: FakeModelRequest["kind"]): FakeModelRequest[];
  reset(): void;
  stop(): Promise<void>;
}

export async function startFakeModel(): Promise<FakeModel> {
  const seen: FakeModelRequest[] = [];
  const server = createFakeModelServer({ onRequest: (r) => seen.push(r) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: (kind) => (kind ? seen.filter((r) => r.kind === kind) : [...seen]),
    reset() {
      seen.length = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface AiStack extends TestStack {
  fake: FakeModel;
  /** Every API log line (JSON) since start. */
  logs: string[];
}

/**
 * `startTestStack` with the mock model provider, the ChatGPT API and sign-in (SIWC, 05-05) overrides, the mock base URL and SearXNG all
 * pointing at an in-process fake, and log capture at `debug`. `chatgptOverride: false` leaves the override unset
 * (the production shape: no test seed route).
 */
export async function startAiStack(
  opts: { env?: Record<string, string>; chatgptOverride?: boolean; fake?: FakeModel } = {},
): Promise<AiStack> {
  const fake = opts.fake ?? (await startFakeModel());
  const logs: string[] = [];
  const stack = await startTestStack({
    env: {
      LOG_LEVEL: "debug",
      OCW_MODEL_PROVIDER: "mock",
      ...(opts.chatgptOverride === false
        ? {}
        : {
            OCW_CHATGPT_API_BASE_URL: `${fake.baseUrl}/v1`,
            OCW_CHATGPT_AUTH_BASE_URL: `${fake.baseUrl}/siwc`,
          }),
      OCW_AI_MOCK_BASE_URL: `${fake.baseUrl}/v1`,
      OCW_AI_SEARXNG_URL: fake.baseUrl,
      OCW_AI_SEND_RATE_LIMIT_PER_MINUTE: "600",
      ...opts.env,
    },
    logStream: { write: (line: string) => void logs.push(line) },
  });
  return {
    ...stack,
    fake,
    logs,
    async stop() {
      await stack.stop();
      if (!opts.fake) await fake.stop();
    },
  };
}

/** Connects the client's own ChatGPT plan with fake tokens (test-only route, P-12). */
export async function seedPlan(client: TestClient): Promise<ChatgptPlanStatus> {
  const res = await client.request("POST", "/api/v1/test/ai/chatgpt-plan", {});
  if (res.status !== 200) throw new Error(`seedPlan failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as unknown as ChatgptPlanStatus;
}

export interface ConvSubscription {
  /** Every frame received, in order. */
  frames: ServerFrame[];
  /** `subscribed` or `err` for the topic (whichever came first). */
  outcome: "subscribed" | "error";
  deltas(): AiDeltaEvent[];
  durable(type?: string): DurableFrame[];
  waitFor(pred: () => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Opens `/ws` with the client's access JWT and subscribes to `conv:<conversationId>`. */
export async function subscribeConv(
  baseUrl: string,
  client: TestClient,
  conversationId: string,
): Promise<ConvSubscription> {
  const token = await client.token();
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: ServerFrame[] = [];
  socket.on("message", (m) => frames.push(JSON.parse(String(m)) as ServerFrame));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const topic = `conv:${conversationId}`;
  socket.send(JSON.stringify({ op: "sub", topic }));
  const waitFor = async (pred: () => boolean, timeoutMs = 10_000) => {
    const until = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting on ${topic}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const settled = () =>
    frames.some((f) => (f.op === "subscribed" && f.topic === topic) || (f.op === "err" && f.topic === topic));
  await waitFor(settled, 5_000);
  const outcome = frames.some((f) => f.op === "subscribed" && f.topic === topic) ? "subscribed" : "error";
  return {
    frames,
    outcome,
    deltas: () =>
      frames
        .filter((f) => f.op === "eph" && f.topic === topic && f.type === EphemeralTypes.aiDelta)
        .map((f) => (f as { data: AiDeltaEvent }).data),
    durable: (type) =>
      frames.filter(
        (f): f is DurableFrame => f.op === "ev" && f.topic === topic && (!type || f.type === type),
      ),
    waitFor,
    close: () => socket.close(),
  };
}

/** A second API process on the stack's database and Redis (stop fan-out, sweeper: 05-06). */
export async function startSecondInstance(
  stack: TestStack,
): Promise<{ built: BuiltApp; baseUrl: string; stop(): Promise<void> }> {
  const built = await buildApp(stack.env, {
    logger: false,
    secretStore: createEnvFileSecretStore({ ...process.env }),
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = built.app.server.address() as AddressInfo;
  return { built, baseUrl: `http://127.0.0.1:${port}`, stop: () => built.close() };
}
