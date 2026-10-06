/**
 * The ocw channel's answer to OpenClaw's restart-loop breaker (stability 2026-10-06): after >= 3 unclean boots within
 * 5 minutes OpenClaw 2026.9.7 refuses every automatic channel start until the window drains, so a cell whose VM was
 * starved stayed "Offline" with nothing telling the admin why. The guard reads the account's state after gateway
 * start, reports the pause to the API and starts the channel itself (OpenClaw's own manual override) after a back-off.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentChannelRuntimeReport } from "./agent-channel-protocol.js";
import {
  type ChannelAccountState,
  createGatewayChannelControl,
  guardTimingFromEnv,
  parseBreakerSuppression,
  runAutostartGuard,
} from "./autostart-guard.js";

/** Verbatim from OpenClaw 2026.9.7 dist/run-*.mjs `beginBoot` (+ the manual-start hint it appends). */
const BREAKER_MESSAGE =
  "gateway restart-loop breaker tripped: 6 unclean boot(s) within 300000ms; suppressing channel/provider account " +
  "auto-start. Inspect the stability bundle and fix the startup crash before restarting the service. Start a channel " +
  `manually with: openclaw gateway call channels.start --params '{"channel":"<id>"}'`;

const NOW = Date.parse("2026-10-06T10:00:00.000Z");

function harness(opts: {
  state?: ChannelAccountState | null | Error;
  start?: Array<{ started: boolean } | Error>;
  /** Becomes true after this many `accountActive()` calls (OpenClaw recovering on its own). */
  activeAfter?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}) {
  const sleeps: number[] = [];
  const reports: AgentChannelRuntimeReport["paused"][] = [];
  const logs: Array<[string, string]> = [];
  let activeChecks = 0;
  let now = NOW;
  const starts = [...(opts.start ?? [{ started: true }])];
  const control = {
    accountState: vi.fn(async () => {
      if (opts.state instanceof Error) throw opts.state;
      return opts.state === undefined ? { running: false, lastError: BREAKER_MESSAGE } : opts.state;
    }),
    startAccount: vi.fn(async () => {
      const next = starts.shift() ?? { started: true };
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const run = () =>
    runAutostartGuard({
      control,
      accountActive: () => opts.activeAfter !== undefined && ++activeChecks > opts.activeAfter,
      report: async (paused) => {
        reports.push(paused);
      },
      log: {
        info: (m) => logs.push(["info", m]),
        warn: (m) => logs.push(["warn", m]),
        error: (m) => logs.push(["error", m]),
      },
      signal: opts.signal ?? new AbortController().signal,
      graceMs: 10_000,
      backoffMs: 60_000,
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        if (opts.signal?.aborted) throw opts.signal.reason;
      },
    });
  return { control, run, sleeps, reports, logs };
}

describe("parseBreakerSuppression", () => {
  it("reads OpenClaw's breaker message (unclean boots and window)", () => {
    expect(parseBreakerSuppression(BREAKER_MESSAGE)).toEqual({ uncleanBoots: 6, windowMs: 300_000 });
  });

  it("also recognises the channel manager's wording, without numbers", () => {
    expect(
      parseBreakerSuppression(
        "channel autostart suppressed by crash-loop breaker; refusing automatic start for ocw account default.",
      ),
    ).toEqual({ uncleanBoots: null, windowMs: null });
  });

  it("anything else is not the breaker", () => {
    expect(parseBreakerSuppression(undefined)).toBeNull();
    expect(parseBreakerSuppression(null)).toBeNull();
    expect(
      parseBreakerSuppression(
        "ambient channel credentials suppressed; configure the channel or start the gateway with --ambient-channels",
      ),
    ).toBeNull();
    expect(parseBreakerSuppression("ocw channel is not configured: set OCW_API_URL")).toBeNull();
  });
});

describe("runAutostartGuard", () => {
  it("a normal boot (OpenClaw started the account) costs one grace period and nothing else", async () => {
    const h = harness({ activeAfter: 0 });
    expect(await h.run()).toBe("running");
    expect(h.sleeps).toEqual([10_000]);
    expect(h.control.accountState).not.toHaveBeenCalled();
    expect(h.control.startAccount).not.toHaveBeenCalled();
    expect(h.reports).toEqual([]);
  });

  it("breaker: reports the pause, waits the back-off, then starts the channel with OpenClaw's manual override", async () => {
    const h = harness({});
    expect(await h.run()).toBe("started");
    expect(h.sleeps).toEqual([10_000, 60_000]);
    expect(h.reports).toEqual([
      {
        reason: "restart_loop_breaker",
        detail: "6 unclean restarts within 5 min",
        resumeAt: new Date(NOW + 10_000 + 60_000).toISOString(),
      },
    ]);
    expect(h.control.startAccount).toHaveBeenCalledTimes(1);
    const warn = h.logs.find(([level]) => level === "warn")?.[1] ?? "";
    expect(warn).toContain("restart-loop breaker");
    expect(warn).toContain("6 unclean boots within 300 s");
    expect(warn).toContain("in 60 s");
    expect(h.logs.at(-1)).toEqual(["info", expect.stringContaining("started the ocw channel")]);
  });

  it("OpenClaw recovering on its own (or an operator) during the back-off wins: no second start", async () => {
    const h = harness({ activeAfter: 1 });
    expect(await h.run()).toBe("recovered");
    expect(h.control.startAccount).not.toHaveBeenCalled();
    expect(h.reports).toHaveLength(1);
  });

  it("an account already running (or not listed) needs nothing", async () => {
    expect(await harness({ state: { running: true, lastError: null } }).run()).toBe("running");
    const missing = harness({ state: null });
    expect(await missing.run()).toBe("not-suppressed");
    expect(missing.control.startAccount).not.toHaveBeenCalled();
  });

  it("any other reason is OpenClaw's business: no report, no start", async () => {
    const h = harness({
      state: { running: false, lastError: "ocw channel is not configured: set OCW_API_URL" },
    });
    expect(await h.run()).toBe("not-suppressed");
    expect(h.reports).toEqual([]);
    expect(h.control.startAccount).not.toHaveBeenCalled();
  });

  it("when the gateway cannot be asked, it says how to start the channel by hand", async () => {
    const h = harness({ state: new Error("gateway closed (1008): unauthorized") });
    expect(await h.run()).toBe("unknown");
    expect(h.control.startAccount).not.toHaveBeenCalled();
    const warn = h.logs.find(([level]) => level === "warn")?.[1] ?? "";
    expect(warn).toContain("unauthorized");
    expect(warn).toContain(`openclaw gateway call channels.start --params '{"channel":"ocw"}'`);
  });

  it("a failing start is retried with a doubling back-off, then the pause stays without a schedule", async () => {
    const h = harness({ start: [new Error("boom"), { started: false }, new Error("boom")], maxAttempts: 3 });
    expect(await h.run()).toBe("gave-up");
    expect(h.sleeps).toEqual([10_000, 60_000, 120_000, 240_000]);
    expect(h.control.startAccount).toHaveBeenCalledTimes(3);
    expect(h.reports.map((r) => r?.resumeAt ?? null)).toEqual([
      new Date(NOW + 70_000).toISOString(),
      new Date(NOW + 190_000).toISOString(),
      new Date(NOW + 430_000).toISOString(),
      null,
    ]);
  });

  it("stops quietly when the gateway shuts down during the back-off", async () => {
    const abort = new AbortController();
    const h = harness({ signal: abort.signal });
    abort.abort(new Error("gateway stopping"));
    expect(await h.run()).toBe("aborted");
    expect(h.control.startAccount).not.toHaveBeenCalled();
  });
});

describe("createGatewayChannelControl (OpenClaw's own gateway client, in process)", () => {
  function fakeGatewayRuntime(responses: Record<string, unknown>) {
    const calls: unknown[][] = [];
    const callGatewayFromCli = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return responses[args[0] as string];
    });
    return { calls, load: async () => ({ callGatewayFromCli }) };
  }

  it("channels.status → the default ocw account's snapshot", async () => {
    const gw = fakeGatewayRuntime({
      "channels.status": {
        channelAccounts: {
          ocw: [
            { accountId: "other", running: true },
            { accountId: "default", running: false, lastError: BREAKER_MESSAGE },
          ],
        },
      },
    });
    const control = createGatewayChannelControl({ load: gw.load });
    expect(await control.accountState()).toEqual({ running: false, lastError: BREAKER_MESSAGE });
    expect(gw.calls).toEqual([
      [
        "channels.status",
        { json: true, timeout: "15000" },
        { probe: false, channel: "ocw" },
        { progress: false },
      ],
    ]);
  });

  it("an unlisted account is null; channels.start asks for the default account", async () => {
    const gw = fakeGatewayRuntime({
      "channels.status": { channelAccounts: {} },
      "channels.start": {
        channel: "ocw",
        accountId: "default",
        started: true,
        outcome: { status: "started" },
      },
    });
    const control = createGatewayChannelControl({ load: gw.load });
    expect(await control.accountState()).toBeNull();
    expect(await control.startAccount()).toEqual({ started: true });
    expect(gw.calls[1]).toEqual([
      "channels.start",
      { json: true, timeout: "15000" },
      { channel: "ocw", accountId: "default" },
      { progress: false },
    ]);
  });
});

describe("guardTimingFromEnv", () => {
  it("defaults to a 60 s back-off after a 10 s grace; OCW_BREAKER_BACKOFF_MS shortens both", () => {
    expect(guardTimingFromEnv({})).toEqual({ graceMs: 10_000, backoffMs: 60_000 });
    expect(guardTimingFromEnv({ OCW_BREAKER_BACKOFF_MS: "5000" })).toEqual({
      graceMs: 5_000,
      backoffMs: 5_000,
    });
    expect(guardTimingFromEnv({ OCW_BREAKER_BACKOFF_MS: "nope" })).toEqual({
      graceMs: 10_000,
      backoffMs: 60_000,
    });
    expect(guardTimingFromEnv({ OCW_BREAKER_BACKOFF_MS: "-1" })).toEqual({
      graceMs: 10_000,
      backoffMs: 60_000,
    });
  });
});
