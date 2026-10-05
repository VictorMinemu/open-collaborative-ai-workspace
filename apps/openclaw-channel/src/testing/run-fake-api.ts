/**
 * Standalone fake Agent Channel API for smoke runs against a real OpenClaw gateway:
 *   FAKE_API_PORT=4010 FAKE_API_TOKEN=… FAKE_MODEL_BASE_URL=http://fake-model:18999/v1 node src/testing/run-fake-api.ts
 * Inject a mention: POST /__test/mention (AgentMentionEvent minus seq/type/org/cell).
 * Publish any cell event (e.g. provider.auth.start): POST /__test/event {type, data}.
 * Read results: GET /__test/state.
 * FAKE_SUBSCRIPTION=1 adds a connected "ChatGPT subscription" (openai-codex) and a bot on it.
 * FAKE_AGENT_TOOLS=web_search,web_fetch  the bot's snapshot `capabilities.tools` (its alsoAllow).
 * FAKE_WEB_SEARCH_PROVIDER=searxng       snapshot `webSearch.provider`.
 * FAKE_DENY_TOOLS=web_fetch              `/tool-calls` denies these tools (allows everything else).
 * FAKE_MCP_SERVERS='[{"id":…,"safeName":…,"transport":…,"url":…,"headers":[…],"tools":[…]}]'
 *                                        snapshot `mcpServers` (CellMcpServer[], header values included).
 * Tool calls, their reported results, memory saves and MCP probe reports are listed in GET /__test/state
 * (`toolCalls`, `toolResults`, `memories`, `mcpProbes`).
 */
import { startFakeAgentChannelApi } from "./fake-agent-channel-api.ts";

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const api = await startFakeAgentChannelApi({
  port: Number(process.env.FAKE_API_PORT ?? 4010),
  host: process.env.FAKE_API_HOST ?? "0.0.0.0",
  token: process.env.FAKE_API_TOKEN ?? "dev-cell-token",
  ...(process.env.FAKE_CELL_ID ? { cellId: process.env.FAKE_CELL_ID } : {}),
  ...(process.env.FAKE_WEB_SEARCH_PROVIDER
    ? { webSearchProvider: process.env.FAKE_WEB_SEARCH_PROVIDER }
    : {}),
  denyTools: list(process.env.FAKE_DENY_TOOLS),
  ...(process.env.FAKE_MCP_SERVERS ? { mcpServers: JSON.parse(process.env.FAKE_MCP_SERVERS) } : {}),
  agents: [
    {
      id: process.env.FAKE_BOT_ID ?? "0199a000-0000-7000-8000-00000000a001",
      handle: "archie",
      displayName: "Archie",
      avatarUrl: "🏛️",
      description: "Architecture reviewer",
      instructions: "You are a pragmatic software architect. Be brief.",
      status: "provisioning",
      modelRef: process.env.FAKE_BOT_MODEL_REF ?? "fake/mock-1",
      model: { provider: "mock", providerId: "fake", id: "mock-1" },
      updatedAt: new Date().toISOString(),
      capabilities: { tools: list(process.env.FAKE_AGENT_TOOLS) },
    },
  ],
  providers: [
    {
      id: "fake",
      kind: "mock",
      api: "openai-completions",
      baseUrl: process.env.FAKE_MODEL_BASE_URL ?? "http://fake-model:18999/v1",
      apiKey: "mock-key-not-secret",
      models: ["mock-1"],
    },
  ],
});
if (process.env.FAKE_SUBSCRIPTION === "1") {
  api.cellSubscriptions = [
    {
      id: "openai-codex",
      kind: "openai-codex",
      runtimeProvider: "openai",
      models: ["gpt-6-astra"],
      account: { email: null },
    },
  ];
  api.agents = [
    ...api.agents,
    {
      id: process.env.FAKE_CODEX_BOT_ID ?? "0199a000-0000-7000-8000-00000000a002",
      handle: "codex",
      displayName: "Codex PM",
      avatarUrl: "🧭",
      description: "Product manager on a ChatGPT subscription",
      instructions: "You are a pragmatic product manager. Be brief.",
      status: "provisioning",
      modelRef: "openai-codex/gpt-6-astra",
      model: { provider: "openai-codex", providerId: "openai-codex", id: "gpt-6-astra" },
      updatedAt: new Date().toISOString(),
    },
  ];
}
console.log(`fake agent channel api on :${new URL(api.url).port} (${api.topic})`);
const stop = () => void api.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
