import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID, readSection, resolveOcwAccount } from "./account.js";
import { isOcwAccountActive } from "./active-account.js";
import type { AgentChannelRuntimeReport } from "./agent-channel-protocol.js";
import { createAgentChannelClient } from "./api-client.js";
import { sleep as abortableSleep } from "./backoff.js";
import type { EventStreamLogger } from "./event-stream.js";
import { CHANNEL_ID } from "./mention-mapper.js";
import { runDetached } from "./openclaw-port.js";

/**
 * OpenClaw's restart-loop breaker vs. a cell whose only job is the `ocw` channel (stability 2026-10-06).
 *
 * OpenClaw 2026.9.7 counts unclean gateway boots (`gateway_boot_lifecycle` in its state DB). With 3 or more within
 * 5 minutes (a starved Docker VM is enough) the next boot "trips the breaker": the control plane starts, but every
 * automatic channel start is refused until a stable process has outlived the whole window and the health monitor
 * (5-minute interval) rechecks it, i.e. 5 to 10 minutes of a healthy-looking cell that answers no bot. Only a manual
 * `channels.start` (operator.admin) bypasses it (dist/server-channels-*.mjs `startChannelProcessOwned`).
 *
 * After gateway start this guard reads the account's state; when the breaker is what keeps it stopped it reports the
 * pause to the API (Settings › Bots runtime shows it instead of a bare "Offline"), waits a back-off and then makes
 * OpenClaw's own manual start, so the channel manager still owns the account (status, reloads, shutdown). The
 * back-off keeps the breaker's purpose: if starting the channel were what crashed the gateway, the loop still runs
 * at most once per back-off, which is all a cell without its channel could do anyway.
 *
 * The in-process route: `api.runtime.gateway.request` (OpenClaw's in-process dispatcher) is reserved to bundled or
 * trusted official plugins and grants operator.write only, so a path-loaded plugin cannot use it for channels.start.
 * `callGatewayFromCli` (public `openclaw/plugin-sdk/gateway-runtime`) is the code behind `openclaw gateway call`:
 * run inside the gateway it connects over loopback with the shared token already in this process's env (the cell
 * entrypoint sets OPENCLAW_GATEWAY_TOKEN), so no child process and no token on any command line.
 */

export const DEFAULT_BREAKER_BACKOFF_MS = 60_000;
const MAX_GRACE_MS = 10_000;
const MAX_BACKOFF_MS = 300_000;
const GATEWAY_CALL_TIMEOUT_MS = 15_000;
export const MANUAL_START_HINT = `openclaw gateway call channels.start --params '{"channel":"${CHANNEL_ID}"}'`;

/** OpenClaw's breaker wording (boot message and channel-manager refusal); numbers only in the boot message. */
const BREAKER = /\b(?:restart|crash)-loop breaker\b/iu;
const BREAKER_COUNTS = /(\d+) unclean boot\(s\) within (\d+)\s*ms/iu;

export type BreakerSuppression = { uncleanBoots: number | null; windowMs: number | null };

export function parseBreakerSuppression(lastError: string | null | undefined): BreakerSuppression | null {
  if (!lastError || !BREAKER.test(lastError)) return null;
  const m = BREAKER_COUNTS.exec(lastError);
  return m ? { uncleanBoots: Number(m[1]), windowMs: Number(m[2]) } : { uncleanBoots: null, windowMs: null };
}

/** "6 unclean restarts within 5 min": the admin-facing detail (never OpenClaw's whole operator message). */
function breakerDetail(b: BreakerSuppression): string | null {
  if (b.uncleanBoots === null) return null;
  const window = b.windowMs === null ? "" : ` within ${Math.round(b.windowMs / 60_000)} min`;
  return `${b.uncleanBoots} unclean restarts${window}`;
}

export type ChannelAccountState = { running: boolean; lastError: string | null };

/** The two gateway methods the guard needs, for the `ocw` default account. */
export type GatewayChannelControl = {
  /** `channels.status` (operator.read); null when the account is not listed. */
  accountState(): Promise<ChannelAccountState | null>;
  /** `channels.start` (operator.admin): OpenClaw's manual start, which the breaker does not refuse. */
  startAccount(): Promise<{ started: boolean }>;
};

type CallGatewayFromCli = (
  method: string,
  opts: { json?: boolean; timeout?: string },
  params?: unknown,
  extra?: { progress?: boolean },
) => Promise<unknown>;

export function createGatewayChannelControl(
  opts: {
    /** Test seam: the `openclaw/plugin-sdk/gateway-runtime` module. */
    load?: () => Promise<{ callGatewayFromCli: CallGatewayFromCli }>;
    accountId?: string;
  } = {},
): GatewayChannelControl {
  // Literal specifier: OpenClaw's plugin loader only aliases `openclaw/plugin-sdk/*` it can see statically.
  const load =
    opts.load ??
    (async () =>
      (await import("openclaw/plugin-sdk/gateway-runtime")) as unknown as {
        callGatewayFromCli: CallGatewayFromCli;
      });
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const call = async (method: string, params: Record<string, unknown>) =>
    (await load()).callGatewayFromCli(
      method,
      { json: true, timeout: String(GATEWAY_CALL_TIMEOUT_MS) },
      params,
      { progress: false },
    );
  return {
    async accountState() {
      const payload = (await call("channels.status", { probe: false, channel: CHANNEL_ID })) as {
        channelAccounts?: Record<string, unknown>;
      } | null;
      const accounts = payload?.channelAccounts?.[CHANNEL_ID];
      const list = (Array.isArray(accounts) ? accounts : []) as Array<Record<string, unknown>>;
      const account = list.find((a) => a?.accountId === accountId);
      if (!account) return null;
      return {
        running: account.running === true,
        lastError: typeof account.lastError === "string" ? account.lastError : null,
      };
    },
    async startAccount() {
      const result = (await call("channels.start", { channel: CHANNEL_ID, accountId })) as {
        started?: unknown;
      } | null;
      return { started: result?.started === true };
    },
  };
}

/** `OCW_BREAKER_BACKOFF_MS` (default 60 s); the grace after gateway start is the back-off, at most 10 s. */
export function guardTimingFromEnv(env: Record<string, string | undefined>): {
  graceMs: number;
  backoffMs: number;
} {
  const raw = env.OCW_BREAKER_BACKOFF_MS?.trim();
  const parsed = raw && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  const backoffMs = Number.isSafeInteger(parsed) ? parsed : DEFAULT_BREAKER_BACKOFF_MS;
  return { graceMs: Math.min(MAX_GRACE_MS, backoffMs), backoffMs };
}

export type AutostartGuardResult =
  /** OpenClaw started the account (the normal boot). */
  | "running"
  /** Stopped for another reason (or not listed): OpenClaw's own restart policy handles it. */
  | "not-suppressed"
  /** The guard started the channel after the back-off. */
  | "started"
  /** Something else started it during the back-off (OpenClaw's recovery, an operator). */
  | "recovered"
  /** Every start attempt failed; OpenClaw's own recovery still applies once its window drains. */
  | "gave-up"
  /** The gateway could not be asked. */
  | "unknown"
  | "aborted";

export type AutostartGuardOptions = {
  control: GatewayChannelControl;
  /** True while an `ocw` account loop runs in this process (channel.ts). */
  accountActive: () => boolean;
  /** `POST /runtime`; failures are the caller's to swallow. */
  report?: (paused: AgentChannelRuntimeReport["paused"]) => Promise<void>;
  log: EventStreamLogger;
  signal: AbortSignal;
  graceMs: number;
  backoffMs: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAutostartGuard(opts: AutostartGuardOptions): Promise<AutostartGuardResult> {
  const { control, log, signal } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const maxAttempts = opts.maxAttempts ?? 5;
  const report = async (paused: AgentChannelRuntimeReport["paused"]) => {
    try {
      await opts.report?.(paused);
    } catch (error) {
      log.warn?.(`could not report the paused channel to the API: ${message(error)}`);
    }
  };
  try {
    await sleep(opts.graceMs, signal);
    if (opts.accountActive()) return "running";
    let state: ChannelAccountState | null;
    try {
      state = await control.accountState();
    } catch (error) {
      log.warn?.(
        `the ocw channel did not start with the gateway and its state cannot be read (${message(error)}); ` +
          `to start it by hand: ${MANUAL_START_HINT}`,
      );
      return "unknown";
    }
    if (state?.running) return "running";
    const breaker = parseBreakerSuppression(state?.lastError);
    if (!breaker) {
      // Not ours to fix (OpenClaw restarts it on its own), but say what was seen: a silent guard is undiagnosable.
      log.info?.(
        `the ocw channel did not start with the gateway (${state ? `lastError: ${state.lastError ?? "none"}` : "account not listed"}); not the restart-loop breaker, leaving it to OpenClaw`,
      );
      return "not-suppressed";
    }

    const counts =
      breaker.uncleanBoots === null
        ? ""
        : ` (${breaker.uncleanBoots} unclean boots within ${Math.round((breaker.windowMs ?? 0) / 1000)} s)`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const delay = Math.min(MAX_BACKOFF_MS, opts.backoffMs * 2 ** attempt);
      await report({
        reason: "restart_loop_breaker",
        detail: breakerDetail(breaker),
        resumeAt: new Date(now() + delay).toISOString(),
      });
      log.warn?.(
        attempt === 0
          ? `OpenClaw's restart-loop breaker suppressed this channel's auto-start${counts}, e.g. after a starved ` +
              `Docker VM restarted the cell. This cell runs nothing but the ocw channel, so it starts it itself in ` +
              `${Math.round(delay / 1000)} s instead of waiting for OpenClaw's window to drain.`
          : `retrying the ocw channel start in ${Math.round(delay / 1000)} s (attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(delay, signal);
      if (opts.accountActive()) return "recovered";
      try {
        const { started } = await control.startAccount();
        if (started || opts.accountActive()) {
          log.info?.(
            "started the ocw channel after the restart-loop breaker back-off (OpenClaw manual start)",
          );
          return "started";
        }
        log.warn?.("OpenClaw's channels.start did not start the ocw channel");
      } catch (error) {
        log.warn?.(`OpenClaw's channels.start failed: ${message(error)}`);
      }
    }
    await report({ reason: "restart_loop_breaker", detail: breakerDetail(breaker), resumeAt: null });
    log.error?.(
      `could not start the ocw channel after ${maxAttempts} attempts; OpenClaw starts it once its breaker window ` +
        `drains, or by hand: ${MANUAL_START_HINT}`,
    );
    return "gave-up";
  } catch (error) {
    if (signal.aborted) return "aborted";
    throw error;
  }
}

const GUARD_KEY = Symbol.for("ocw.openclaw-channel.autostart-guard");
type GuardRegistry = { [GUARD_KEY]?: AbortController };

export type AutostartGuardDeps = {
  control?: GatewayChannelControl;
  accountActive?: () => boolean;
  env?: Record<string, string | undefined>;
  /** Called with the guard's outcome (tests). */
  onSettled?: (result: AutostartGuardResult | "error") => void;
};

/**
 * Arms the guard on OpenClaw's `gateway_start` (boot registry, gateway process only: never in a CLI process that
 * loads plugins in "full" mode). The hook is awaited with a timeout, so the guard runs detached; one guard per
 * process (a re-fired hook replaces the previous one), aborted on gateway shutdown or restart drain.
 */
export function registerAutostartGuard(api: OpenClawPluginApi, deps: AutostartGuardDeps = {}): void {
  api.on("gateway_start", (_event, ctx) => {
    const registry = globalThis as GuardRegistry;
    registry[GUARD_KEY]?.abort();
    const local = new AbortController();
    registry[GUARD_KEY] = local;
    const signal = ctx.abortSignal ? AbortSignal.any([local.signal, ctx.abortSignal]) : local.signal;
    const account = resolveOcwAccount(readSection(ctx.config), deps.env ?? process.env);
    const client =
      account.configured && account.apiUrl
        ? createAgentChannelClient({ apiUrl: account.apiUrl, token: account.readToken })
        : null;
    const log = {
      info: (m: string) => api.logger?.info?.(`[ocw] ${m}`),
      warn: (m: string) => api.logger?.warn?.(`[ocw] ${m}`),
      error: (m: string) => (api.logger?.error ?? api.logger?.warn)?.(`[ocw] ${m}`),
    };
    // Detached from the hook's async work scope, which OpenClaw closes once the startup observers settle.
    runDetached(() => {
      void runAutostartGuard({
        control: deps.control ?? createGatewayChannelControl(),
        accountActive: deps.accountActive ?? isOcwAccountActive,
        report: client ? (paused) => client.reportRuntime({ paused }, signal) : undefined,
        log,
        signal,
        ...guardTimingFromEnv(deps.env ?? process.env),
      })
        .then(
          (result) => deps.onSettled?.(result),
          (error: unknown) => {
            log.warn(`restart-loop breaker guard failed: ${message(error)}`);
            deps.onSettled?.("error");
          },
        )
        .finally(() => {
          if (registry[GUARD_KEY] === local) delete registry[GUARD_KEY];
        });
    });
  });
}
