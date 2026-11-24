import { randomUUID } from "node:crypto";
import type {
  AgentChannelProviderAuthReport,
  CellAuthProfileReport,
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
/** A finished sign-in: the account, and (07.18, PD-12) the profile id OpenClaw stored it under. */
export type SubscriptionSignIn = SubscriptionAccount & { profileId?: string };

/** What the module needs from OpenClaw. Real: openclaw-auth.ts. Tests: in-memory fakes. */
export interface SubscriptionAuthDriver {
  /**
   * Runs the device-code sign-in; resolves once the credential is stored in OpenClaw. 07.18 (PD-12): `profileId` =
   * store it under this profile id (a pool account for bots), next to the provider's other profiles.
   */
  login(params: {
    provider: SubscriptionProviderId;
    profileId?: string;
    signal: AbortSignal;
    onDeviceCode(prompt: DeviceCodePrompt): Promise<void>;
  }): Promise<SubscriptionSignIn>;
  /** The first usable stored credential for the provider, or null when there is none. */
  status(provider: SubscriptionProviderId): Promise<SubscriptionAccount | null>;
  /** 07.18 (PD-12): every stored profile of the provider (identity and usability, never a token). */
  profiles?(provider: SubscriptionProviderId): Promise<CellAuthProfileReport[]>;
  /**
   * Deletes the stored credentials for the provider. 07.18 (E15): `profileIds` = only these profiles; absent = every
   * profile of the provider, as before.
   */
  logout(provider: SubscriptionProviderId, profileIds?: readonly string[]): Promise<void>;
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
    {
      provider: SubscriptionProviderId;
      /** 07.18: the profile this sign-in stores (absent = the provider's default). */
      profileId?: string;
      abort: AbortController;
      done: Promise<void>;
    }
  >();
  /** Providers already reported as missing credentials (report once until it changes). */
  const reportedMissing = new Set<string>();
  /**
   * 07.18 (PD-12): the profile list this instance last reported per provider (JSON). A credential state report goes
   * out when it changes (the first sync after start included), so the API adopts and updates its pool rows.
   */
  const reportedProfiles = new Map<string, string>();

  /** Every stored profile (at most the contract's 20), or undefined when the driver cannot list them. */
  async function storedProfiles(
    provider: SubscriptionProviderId,
  ): Promise<CellAuthProfileReport[] | undefined> {
    if (!opts.driver.profiles) return undefined;
    try {
      return (await opts.driver.profiles(provider)).slice(0, 20);
    } catch (error) {
      log.warn?.(
        `subscription ${provider}: profile list failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** A credential state report (flowId null) with every profile; remembers the list once the API took it. */
  async function reportCredentialState(
    provider: SubscriptionProviderId,
    account: SubscriptionAccount | null,
    profiles: CellAuthProfileReport[] | undefined,
  ): Promise<void> {
    try {
      await report({
        provider,
        flowId: null,
        ...(account ? { state: "connected" as const, account } : { state: "disconnected" as const }),
        ...(profiles ? { profiles } : {}),
      });
      if (profiles) reportedProfiles.set(provider, JSON.stringify(profiles));
    } catch {
      // Retried on the next sync (the remembered list is unchanged).
    }
  }

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
      const signedIn = await opts.driver.login({
        provider,
        ...(ev.profileId ? { profileId: ev.profileId } : {}),
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
      const account: SubscriptionAccount = { email: signedIn.email, planType: signedIn.planType };
      // 07.18 (PD-12): the profile id OpenClaw stored (the requested one when the flow honoured it, else its own
      // `openai:<email>`). Sent for every sign-in (07.18-16): a Models page sign-in then joins the pool at once, also
      // when the pool keeps bots off the subscription (every bot account removed or off), where the snapshot no
      // longer lists it and no credential state report would ever name the new profile.
      const profileId = signedIn.profileId ?? ev.profileId;
      await report({
        provider,
        flowId,
        state: "connected",
        account,
        ...(profileId ? { profileId } : {}),
      });
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
    flows.set(ev.flowId, {
      provider: ev.provider,
      ...(ev.profileId ? { profileId: ev.profileId } : {}),
      abort,
      done,
    });
    log.info?.(`sign-in ${ev.flowId} (${ev.provider}): starting device-code flow`);
  }

  function handleCancel(ev: ProviderAuthCancelEvent): void {
    flows.get(ev.flowId)?.abort.abort(new FlowStopped("cancelled"));
  }

  async function handleRevoke(ev: ProviderAuthRevokeEvent): Promise<void> {
    const only = ev.profileIds;
    for (const f of flows.values()) {
      if (f.provider !== ev.provider) continue;
      // 07.18 (E15): a per-profile revoke stops only a sign-in of one of those profiles.
      if (only && !(f.profileId && only.includes(f.profileId))) continue;
      f.abort.abort(new FlowStopped("cancelled"));
    }
    if (!only) {
      await opts.driver.logout(ev.provider);
      reportedMissing.delete(ev.provider);
      log.info?.(`subscription ${ev.provider}: credentials removed (disconnected by an admin)`);
      return;
    }
    await opts.driver.logout(ev.provider, only);
    log.info?.(`subscription ${ev.provider}: ${only.length} profile(s) removed (by an admin)`);
    // The API learns what is left: the other profiles, or that the provider is signed out.
    const [account, profiles] = await Promise.all([
      opts.driver.status(ev.provider).catch(() => null),
      storedProfiles(ev.provider),
    ]);
    if (account) reportedMissing.delete(ev.provider);
    else reportedMissing.add(ev.provider);
    await reportCredentialState(ev.provider, account, profiles);
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
      const profiles = await storedProfiles(provider);
      const profilesChanged =
        profiles !== undefined && reportedProfiles.get(provider) !== JSON.stringify(profiles);
      if (account) {
        ready.add(sub.id);
        reportedMissing.delete(provider);
        if ((sub.account?.email ?? null) !== account.email || profilesChanged) {
          await reportCredentialState(provider, account, profiles);
        }
        continue;
      }
      const flowRunning = [...flows.values()].some((f) => f.provider === provider);
      if (!flowRunning && !reportedMissing.has(provider)) {
        reportedMissing.add(provider);
        log.warn?.(
          `subscription ${provider}: no stored sign-in in this cell; reconnect in Settings › Models`,
        );
        await reportCredentialState(provider, null, profiles);
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
