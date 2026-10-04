import { randomUUID } from "node:crypto";
import type {
  AgentChannelProviderAuthReport,
  CellSnapshot,
  ProviderAuthCancelEvent,
  ProviderAuthErrorCode,
  ProviderAuthRevokeEvent,
  ProviderAuthStartEvent,
  SubscriptionProviderId,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import type { EventStreamLogger } from "./event-stream.js";

/**
 * Subscription sign-in in the cell (ADR-0006). The Agent Channel API asks (`provider.auth.start`), the
 * driver runs OpenClaw's own device-code login (OpenClaw requests the code, polls, stores the tokens in
 * its auth store and refreshes them), and this module reports progress back: the code the admin must
 * type, then the signed-in identity, or a classified error. Tokens never leave OpenClaw; the code is
 * never logged.
 */

export type DeviceCodePrompt = { verificationUrl: string; userCode: string; expiresInMs: number };
export type SubscriptionAccount = { email: string | null; planType: string | null };

/** What the module needs from OpenClaw. Real: openclaw-auth.ts. Tests: in-memory fakes. */
export interface SubscriptionAuthDriver {
  /** Runs the device-code sign-in; resolves once the credential is stored in OpenClaw. */
  login(params: {
    provider: SubscriptionProviderId;
    signal: AbortSignal;
    onDeviceCode(prompt: DeviceCodePrompt): Promise<void>;
  }): Promise<SubscriptionAccount>;
  /** The usable stored credential for the provider, or null when there is none. */
  status(provider: SubscriptionProviderId): Promise<SubscriptionAccount | null>;
  /** Deletes the stored credentials for the provider. */
  logout(provider: SubscriptionProviderId): Promise<void>;
}

class FlowStopped extends Error {
  constructor(readonly why: "cancelled" | "claimed" | "superseded" | "stopping") {
    super(`sign-in ${why}`);
    this.name = "FlowStopped";
  }
}

/** Maps OpenClaw's login errors to the contract's codes. Messages are sanitized and short. */
export function classifyLoginError(
  error: unknown,
  userCode?: string,
): { code: ProviderAuthErrorCode; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw.replace(/\s+/gu, " ").trim();
  if (userCode) message = message.split(userCode).join("[code]");
  message = message.slice(0, 280) || "Sign-in failed";
  if (/timed out after 15 minutes|expired_token|\bexpired\b/iu.test(raw)) return { code: "expired", message };
  if (/access_denied|\bdenied\b|declined|rejected by the user/iu.test(raw))
    return { code: "denied", message };
  if (/not enabled for this server|device code login is not enabled|unsupported/iu.test(raw)) {
    return { code: "unsupported", message };
  }
  return { code: "failed", message };
}

export type SubscriptionAuthOptions = {
  client: Pick<AgentChannelClient, "reportProviderAuth">;
  driver: SubscriptionAuthDriver;
  /** Plugin lifetime: aborting it stops every running flow. */
  signal: AbortSignal;
  log?: EventStreamLogger;
  /** This plugin instance (default: random); the API lets the first reporter of a flow own it. */
  reporterId?: string;
};

export function createSubscriptionAuth(opts: SubscriptionAuthOptions) {
  const log = opts.log ?? {};
  const reporterId = opts.reporterId ?? `cell-${randomUUID()}`;
  const flows = new Map<
    string,
    { provider: SubscriptionProviderId; abort: AbortController; done: Promise<void> }
  >();
  /** Providers already reported as missing credentials (report once until it changes). */
  const reportedMissing = new Set<string>();

  const report = (body: Omit<AgentChannelProviderAuthReport, "reporterId">) =>
    opts.client.reportProviderAuth({ ...body, reporterId }, opts.signal);

  /** 409s mean the API no longer wants this flow (claimed by another instance, closed, superseded). */
  function isFlowRejected(error: unknown): boolean {
    return error instanceof AgentChannelHttpError && error.status === 409;
  }

  async function runFlow(ev: ProviderAuthStartEvent, abort: AbortController): Promise<void> {
    const { flowId, provider } = ev;
    let userCode: string | undefined;
    try {
      const account = await opts.driver.login({
        provider,
        signal: abort.signal,
        onDeviceCode: async (prompt) => {
          userCode = prompt.userCode;
          try {
            await report({
              provider,
              flowId,
              state: "pending",
              verificationUrl: prompt.verificationUrl,
              userCode: prompt.userCode,
              expiresAt: new Date(Date.now() + prompt.expiresInMs).toISOString(),
            });
          } catch (error) {
            if (isFlowRejected(error)) {
              abort.abort(new FlowStopped("claimed"));
              throw new FlowStopped("claimed");
            }
            throw error;
          }
          log.info?.(`sign-in ${flowId} (${provider}): code issued, waiting for approval`);
        },
      });
      reportedMissing.delete(provider);
      await report({ provider, flowId, state: "connected", account });
      log.info?.(`sign-in ${flowId} (${provider}): connected`);
    } catch (error) {
      const reason = abort.signal.reason;
      if (error instanceof FlowStopped || reason instanceof FlowStopped) {
        const why = error instanceof FlowStopped ? error.why : (reason as FlowStopped).why;
        log.info?.(`sign-in ${flowId} (${provider}): stopped (${why})`);
        return;
      }
      if (opts.signal.aborted) return; // plugin stopping; the API ages the flow out by itself
      const classified = classifyLoginError(error, userCode);
      log.warn?.(`sign-in ${flowId} (${provider}) failed: ${classified.code}: ${classified.message}`);
      await report({ provider, flowId, state: "error", error: classified }).catch((e: unknown) => {
        log.warn?.(`could not report the sign-in failure: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  function handleStart(ev: ProviderAuthStartEvent): void {
    if (Date.parse(ev.startBefore) < Date.now()) {
      log.info?.(`sign-in ${ev.flowId}: start command is stale (replayed); ignored`);
      return;
    }
    if (flows.has(ev.flowId)) return;
    // One sign-in per provider: a newer start supersedes a running one.
    for (const f of flows.values())
      if (f.provider === ev.provider) f.abort.abort(new FlowStopped("superseded"));
    const abort = new AbortController();
    const onStop = () => abort.abort(new FlowStopped("stopping"));
    opts.signal.addEventListener("abort", onStop, { once: true });
    const done = runFlow(ev, abort).finally(() => {
      opts.signal.removeEventListener("abort", onStop);
      flows.delete(ev.flowId);
    });
    flows.set(ev.flowId, { provider: ev.provider, abort, done });
    log.info?.(`sign-in ${ev.flowId} (${ev.provider}): starting device-code flow`);
  }

  function handleCancel(ev: ProviderAuthCancelEvent): void {
    flows.get(ev.flowId)?.abort.abort(new FlowStopped("cancelled"));
  }

  async function handleRevoke(ev: ProviderAuthRevokeEvent): Promise<void> {
    for (const f of flows.values())
      if (f.provider === ev.provider) f.abort.abort(new FlowStopped("cancelled"));
    await opts.driver.logout(ev.provider);
    reportedMissing.delete(ev.provider);
    log.info?.(`subscription ${ev.provider}: credentials removed (disconnected by an admin)`);
  }

  /**
   * Reconciles stored credentials with the snapshot (on every cell sync). Returns the subscription ids
   * that are usable right now; bots on the others are reported as `error` by the reconciler.
   * - listed + credential present → ready (identity refreshed when it changed, e.g. plan upgrade);
   * - listed + no credential (volume reset, revoked) → report `disconnected` once, unless a flow runs;
   * - not listed but a credential exists → an admin disconnected while the cell was offline: log out.
   *   Only when the API sent the field at all (older APIs omit it).
   */
  async function sync(cell: Pick<CellSnapshot, "subscriptions">): Promise<Set<string>> {
    const ready = new Set<string>();
    const listed = cell.subscriptions;
    for (const sub of listed ?? []) {
      const provider = sub.id as SubscriptionProviderId;
      let account: SubscriptionAccount | null;
      try {
        account = await opts.driver.status(provider);
      } catch (error) {
        log.warn?.(
          `subscription ${provider}: status check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (account) {
        ready.add(sub.id);
        reportedMissing.delete(provider);
        if ((sub.account?.email ?? null) !== account.email) {
          await report({ provider, flowId: null, state: "connected", account }).catch(() => undefined);
        }
        continue;
      }
      const flowRunning = [...flows.values()].some((f) => f.provider === provider);
      if (!flowRunning && !reportedMissing.has(provider)) {
        reportedMissing.add(provider);
        log.warn?.(
          `subscription ${provider}: no stored sign-in in this cell; reconnect in Settings › Models`,
        );
        await report({ provider, flowId: null, state: "disconnected" }).catch(() => undefined);
      }
    }
    if (listed) {
      for (const provider of ["openai-codex"] as const) {
        if (listed.some((s) => s.id === provider)) continue;
        if ([...flows.values()].some((f) => f.provider === provider)) continue;
        const stale = await opts.driver.status(provider).catch(() => null);
        if (stale) {
          await opts.driver.logout(provider);
          log.info?.(`subscription ${provider}: disconnected while offline; local credentials removed`);
        }
      }
    }
    return ready;
  }

  return {
    reporterId,
    handleStart,
    handleCancel,
    handleRevoke,
    sync,
    /** Running flows (tests / shutdown). */
    running: () => [...flows.values()].map((f) => f.done),
  };
}

export type SubscriptionAuth = ReturnType<typeof createSubscriptionAuth>;
