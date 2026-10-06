/**
 * Contract: our real entry (index.ts) in a gateway boot whose restart-loop breaker tripped, modelled on OpenClaw
 * 2026.9.7 (testing/openclaw-host.ts mirrors the dist). Regression for the demo cell that stayed "Offline · last seen
 * just now" after a starved Docker VM restarted it 6 times: OpenClaw refused the ocw channel's automatic start and
 * nothing ever started it or told the API why.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeAgentChannelApi, startFakeAgentChannelApi } from "./testing/fake-agent-channel-api.js";
import {
  breakerMessage,
  createHostChannelManager,
  type HostChannelManager,
  loadRegistry,
  type PluginEntry,
  runGatewayStart,
} from "./testing/openclaw-host.js";

vi.mock(
  "openclaw/plugin-sdk/channel-core",
  async () => (await import("./testing/openclaw-host.js")).channelCoreModule,
);
vi.mock(
  "openclaw/plugin-sdk/gateway-runtime",
  async () => (await import("./testing/openclaw-host.js")).gatewayRuntimeModule,
);

const { default: entry } = (await import("./index.js")) as unknown as { default: PluginEntry };
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as {
  id: string;
  contracts?: { tools?: string[] };
};

const ENV_KEYS = [
  "OCW_API_URL",
  "OCW_CELL_TOKEN",
  "OCW_CELL_TOKEN_FILE",
  "OCW_BREAKER_BACKOFF_MS",
  "OPENCLAW_STATE_DIR",
];
const config = { channels: { ocw: { enabled: true } } };

describe("a gateway boot after OpenClaw's restart-loop breaker tripped", () => {
  let api: FakeAgentChannelApi;
  let manager: HostChannelManager | undefined;
  let gateway: AbortController;
  let stateDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    api = await startFakeAgentChannelApi({ agents: [], providers: [] });
    stateDir = mkdtempSync(path.join(tmpdir(), "ocw-breaker-"));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.OCW_CELL_TOKEN_FILE;
    process.env.OCW_API_URL = api.url;
    process.env.OCW_CELL_TOKEN = api.token;
    process.env.OCW_BREAKER_BACKOFF_MS = "40";
    process.env.OPENCLAW_STATE_DIR = stateDir;
    gateway = new AbortController();
  });

  afterEach(async () => {
    gateway.abort();
    manager?.stopAll();
    manager = undefined;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await api.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** One gateway boot: boot registry ("full"), channel auto-start, then gateway_start observers. */
  async function boot(suppression: { reason: "crash-loop-breaker"; message: string } | null) {
    const registry = loadRegistry(entry, manifest, { activate: true });
    manager = createHostChannelManager({ registry, config, suppression });
    manager.startChannels();
    await runGatewayStart(registry, { port: 18789, config, abortSignal: gateway.signal });
    return manager;
  }

  it("OpenClaw refuses the automatic start; the plugin reports the pause, then starts ocw with a manual start", async () => {
    const m = await boot({ reason: "crash-loop-breaker", message: breakerMessage(6) });
    expect(m.starts[0]).toEqual({
      channelId: "ocw",
      accountId: "default",
      manual: false,
      outcome: "autostart-suppressed",
    });
    expect(m.account("ocw", "default")).toMatchObject({ running: false, lastError: breakerMessage(6) });

    await api.waitFor(() => m.starts.some((s) => s.manual), 5_000);
    expect(m.starts).toEqual([
      { channelId: "ocw", accountId: "default", manual: false, outcome: "autostart-suppressed" },
      { channelId: "ocw", accountId: "default", manual: true, outcome: "started" },
    ]);
    expect(api.runtimeReports).toEqual([
      {
        paused: {
          reason: "restart_loop_breaker",
          detail: "6 unclean restarts within 5 min",
          resumeAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        },
      },
    ]);
    // The real account loop runs under OpenClaw's channel manager: it asks the API for the cell.
    await api.waitFor(() => api.cellReads > 0, 5_000);
    expect(m.account("ocw", "default")?.running).toBe(true);
  });

  it("a normal boot: OpenClaw starts the account, the guard reports nothing and starts nothing", async () => {
    const m = await boot(null);
    await api.waitFor(() => api.cellReads > 0, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    expect(m.starts).toEqual([{ channelId: "ocw", accountId: "default", manual: false, outcome: "started" }]);
    expect(api.runtimeReports).toEqual([]);
  });

  it("loading the plugin outside a gateway boot (a CLI process, no gateway_start) arms nothing", async () => {
    const registry = loadRegistry(entry, manifest, { activate: true });
    manager = createHostChannelManager({
      registry,
      config,
      suppression: { reason: "crash-loop-breaker", message: breakerMessage(3) },
    });
    manager.startChannels();
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.starts.filter((s) => s.manual)).toEqual([]);
    expect(api.runtimeReports).toEqual([]);
  });

  it("the gateway shutting down during the back-off cancels the start", async () => {
    process.env.OCW_BREAKER_BACKOFF_MS = "300";
    const m = await boot({ reason: "crash-loop-breaker", message: breakerMessage(4) });
    await api.waitFor(() => api.runtimeReports.length > 0, 5_000);
    gateway.abort();
    await new Promise((r) => setTimeout(r, 450));
    expect(m.starts.filter((s) => s.manual)).toEqual([]);
  });
});
