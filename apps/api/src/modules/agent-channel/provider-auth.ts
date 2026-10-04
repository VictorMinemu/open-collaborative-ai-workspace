import { randomUUID } from "node:crypto";
import {
  AgentChannelEventTypes,
  type AgentChannelProviderAuthReport,
  cellTopic,
  EphemeralTypes,
  type ProviderAuthError,
  type ProviderAuthState,
  type ProviderAuthStatus,
  type SubscriptionProviderKind,
} from "@ocw/contracts";
import type { Core } from "../../core";
import { conflict } from "../../lib/errors";
import { applySubscriptionConnected, markSubscriptionNeedsReconnect, subscriptionAccount } from "../agent";
import type { CellPresence } from "./presence";

/**
 * Subscription sign-in orchestration (ADR-0006). The device-code flow runs INSIDE the org's OpenClaw cell
 * (OpenClaw requests the code, polls, stores and refreshes the tokens). The API only:
 *   1. asks the cell to start (`provider.auth.start` on `cell:<org>`, same tx as the audit row),
 *   2. keeps the short-lived flow state the admin UI shows (Redis, auto-expiring),
 *   3. records the outcome (provider row + audit, same tx) when the cell reports it.
 * The user code is shown to admins only (GET below); it never travels on a stream, is never logged and
 * disappears from Redis when the flow ends.
 */

/** The cell must report a code within this window, otherwise the flow reads as `cell_offline`. */
export const START_TIMEOUT_MS = 45_000;
/** A replayed start event older than this is ignored by the cell (`startBefore`). */
const START_EVENT_TTL_MS = 60_000;
/** OpenAI device codes live 15 minutes; never trust a cell-reported expiry beyond that. */
const MAX_CODE_TTL_MS = 15 * 60_000;
/** How long a finished flow (connected / error) stays visible to the UI. */
const TERMINAL_TTL_S = 10 * 60;

interface FlowRecord {
  flowId: string;
  provider: SubscriptionProviderKind;
  state: Exclude<ProviderAuthState, "idle">;
  startedAt: string;
  startedBy: string;
  /** Plugin instance that owns this flow (first reporter wins). */
  reporterId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: ProviderAuthError | null;
}

const flowKey = (org: string, provider: string) => `ocw:provider-auth:${org}:${provider}`;

const ERROR_MESSAGES: Record<ProviderAuthError["code"], string> = {
  expired: "The code expired before it was approved. Start again to get a new one.",
  denied: "The sign-in was denied in the browser.",
  cancelled: "Sign-in cancelled.",
  cell_offline: "The bot runtime did not answer. Check Settings › Bots runtime and try again.",
  unsupported: "This account cannot sign in with a device code. Ask your ChatGPT workspace admin.",
  failed: "The sign-in failed. Try again.",
};

export function createProviderAuth(core: Core, presence: CellPresence) {
  const redis = core.bus.pub;

  async function read(org: string, provider: SubscriptionProviderKind): Promise<FlowRecord | null> {
    const raw = await redis.get(flowKey(org, provider));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FlowRecord;
    } catch {
      return null;
    }
  }

  async function write(org: string, flow: FlowRecord): Promise<void> {
    const active = flow.state === "starting" || flow.state === "pending";
    const ttl = active
      ? Math.ceil(
          (Math.max(
            new Date(flow.expiresAt ?? 0).getTime(),
            new Date(flow.startedAt).getTime() + MAX_CODE_TTL_MS,
          ) -
            Date.now()) /
            1000,
        ) + 60
      : TERMINAL_TTL_S;
    await redis.set(flowKey(org, flow.provider), JSON.stringify(flow), {
      expiration: { type: "EX", value: Math.max(ttl, 60) },
    });
  }

  /** Lazily ages a flow: a silent cell or an unapproved code becomes an error without any timer. */
  function effective(flow: FlowRecord | null, now = Date.now()): FlowRecord | null {
    if (!flow) return null;
    if (flow.state === "starting" && now - new Date(flow.startedAt).getTime() > START_TIMEOUT_MS) {
      return {
        ...flow,
        state: "error",
        error: { code: "cell_offline", message: ERROR_MESSAGES.cell_offline },
      };
    }
    if (flow.state === "pending" && flow.expiresAt && now > new Date(flow.expiresAt).getTime()) {
      return {
        ...flow,
        state: "error",
        userCode: null,
        verificationUrl: null,
        error: { code: "expired", message: ERROR_MESSAGES.expired },
      };
    }
    return flow;
  }

  const isActive = (flow: FlowRecord | null) => flow?.state === "starting" || flow?.state === "pending";

  async function notifyBrowsers(org: string, provider: SubscriptionProviderKind, state: ProviderAuthState) {
    // Only the state: admins refetch the code over the authenticated REST endpoint.
    await core.realtime
      .publishEphemeral(`org:${org}`, EphemeralTypes.providerAuth, { provider, state })
      .catch(() => {});
  }

  async function status(org: string, provider: SubscriptionProviderKind): Promise<ProviderAuthStatus> {
    const [flow, account, cell] = await Promise.all([
      read(org, provider).then((f) => effective(f)),
      core.db.withTenant({ organizationId: org, userId: null }, (tx) => subscriptionAccount(tx, provider)),
      presence.status(org, null),
    ]);
    // A finished "connected" flow without a row means it was disconnected since: show idle.
    const state: ProviderAuthState = !flow || (flow.state === "connected" && !account) ? "idle" : flow.state;
    const showCode = state === "pending";
    return {
      provider,
      state,
      flowId: state === "idle" ? null : (flow?.flowId ?? null),
      verificationUrl: showCode ? (flow?.verificationUrl ?? null) : null,
      userCode: showCode ? (flow?.userCode ?? null) : null,
      expiresAt: showCode ? (flow?.expiresAt ?? null) : null,
      startedAt: state === "idle" ? null : (flow?.startedAt ?? null),
      error: state === "error" ? (flow?.error ?? null) : null,
      account,
      cellConnected: cell.connected,
    };
  }

  /** Admin "Connect": idempotent while a flow is active (unless `restart`). */
  async function start(
    ctx: { organizationId: string; userId: string; sessionId: string | null },
    provider: SubscriptionProviderKind,
    opts: { restart?: boolean } = {},
  ): Promise<ProviderAuthStatus> {
    const org = ctx.organizationId;
    const cell = await presence.status(org, null);
    if (!cell.connected) {
      throw conflict(
        "The bot runtime is offline. Start it (Settings › Bots runtime) and try again.",
        "cell_offline",
      );
    }
    const current = effective(await read(org, provider));
    if (isActive(current) && !opts.restart) return status(org, provider);

    const flowId = randomUUID();
    const now = new Date();
    await core.db.withTenant({ organizationId: org, userId: ctx.userId }, async (tx) => {
      if (current && isActive(current)) {
        await core.realtime.appendEvent(tx, cellTopic(org), AgentChannelEventTypes.providerAuthCancel, {
          type: AgentChannelEventTypes.providerAuthCancel,
          organizationId: org,
          cellId: org,
          flowId: current.flowId,
          provider,
        });
      }
      await core.audit.record(tx, {
        action: "model_provider.connect_started",
        resourceType: "model_provider",
        resourceId: null,
        sessionId: ctx.sessionId,
        clientKind: "web",
        metadata: { provider, flowId, method: "device-code", restart: !!opts.restart },
      });
      await core.realtime.appendEvent(tx, cellTopic(org), AgentChannelEventTypes.providerAuthStart, {
        type: AgentChannelEventTypes.providerAuthStart,
        organizationId: org,
        cellId: org,
        flowId,
        provider,
        method: "device-code",
        startBefore: new Date(now.getTime() + START_EVENT_TTL_MS).toISOString(),
      });
      // Written before commit so a fast cell report always finds its flow.
      await write(org, {
        flowId,
        provider,
        state: "starting",
        startedAt: now.toISOString(),
        startedBy: ctx.userId,
        reporterId: null,
        verificationUrl: null,
        userCode: null,
        expiresAt: null,
        error: null,
      });
    });
    await notifyBrowsers(org, provider, "starting");
    return status(org, provider);
  }

  /** Admin "Cancel" on a pending flow. */
  async function cancel(
    ctx: { organizationId: string; userId: string; sessionId: string | null },
    provider: SubscriptionProviderKind,
  ): Promise<ProviderAuthStatus> {
    const org = ctx.organizationId;
    const current = effective(await read(org, provider));
    if (!current || !isActive(current)) return status(org, provider);
    await core.db.withTenant({ organizationId: org, userId: ctx.userId }, async (tx) => {
      await core.audit.record(tx, {
        action: "model_provider.connect_cancelled",
        resourceType: "model_provider",
        resourceId: null,
        sessionId: ctx.sessionId,
        clientKind: "web",
        metadata: { provider, flowId: current.flowId },
      });
      await core.realtime.appendEvent(tx, cellTopic(org), AgentChannelEventTypes.providerAuthCancel, {
        type: AgentChannelEventTypes.providerAuthCancel,
        organizationId: org,
        cellId: org,
        flowId: current.flowId,
        provider,
      });
      await write(org, {
        ...current,
        state: "error",
        userCode: null,
        verificationUrl: null,
        error: { code: "cancelled", message: ERROR_MESSAGES.cancelled },
      });
    });
    await notifyBrowsers(org, provider, "error");
    return status(org, provider);
  }

  /** `POST /agent-channel/v1/provider-auth` from the cell. */
  async function report(org: string, body: AgentChannelProviderAuthReport): Promise<void> {
    const { provider } = body;

    // Out-of-band credential state (no flow): refresh identity or flag a lost sign-in.
    if (body.flowId === null) {
      if (body.state === "connected") {
        const account = await core.db.withTenant({ organizationId: org, userId: null }, (tx) =>
          subscriptionAccount(tx, provider),
        );
        if (!account) throw conflict("This subscription is not connected", "not_connected");
        await core.db.withTenant({ organizationId: org, userId: null }, (tx) =>
          applySubscriptionConnected(core, tx, provider, normalizeAccount(body.account), { flowId: null }),
        );
      } else if (body.state === "disconnected") {
        await core.db.withTenant({ organizationId: org, userId: null }, (tx) =>
          markSubscriptionNeedsReconnect(core, tx, provider, body.error?.code ?? "missing_credentials"),
        );
      } else {
        throw conflict("A flow id is required for this state", "flow_required");
      }
      await notifyBrowsers(org, provider, body.state === "connected" ? "connected" : "idle");
      return;
    }

    const raw = await read(org, provider);
    if (!raw || raw.flowId !== body.flowId) throw conflict("Unknown or superseded sign-in", "unknown_flow");
    if (raw.reporterId && raw.reporterId !== body.reporterId) {
      throw conflict("Another bot runtime instance owns this sign-in", "flow_claimed");
    }
    const flow = effective(raw) as FlowRecord;

    switch (body.state) {
      case "pending": {
        if (!isActive(flow)) throw conflict("This sign-in is no longer active", "flow_closed");
        if (!body.verificationUrl || !body.userCode) {
          throw conflict("A pending report needs the verification URL and code", "bad_report");
        }
        const cap = new Date(flow.startedAt).getTime() + MAX_CODE_TTL_MS;
        const reported = body.expiresAt ? new Date(body.expiresAt).getTime() : cap;
        await write(org, {
          ...flow,
          state: "pending",
          reporterId: body.reporterId,
          verificationUrl: body.verificationUrl,
          userCode: body.userCode,
          expiresAt: new Date(Math.min(reported, cap)).toISOString(),
          error: null,
        });
        await notifyBrowsers(org, provider, "pending");
        return;
      }
      case "connected": {
        // Accepted even after a cancel: the owner approved it in the browser, so the cell holds it now.
        await core.db.withTenant({ organizationId: org, userId: flow.startedBy }, async (tx) => {
          await applySubscriptionConnected(core, tx, provider, normalizeAccount(body.account), {
            flowId: flow.flowId,
          });
          await write(org, {
            ...flow,
            state: "connected",
            reporterId: body.reporterId,
            verificationUrl: null,
            userCode: null,
            expiresAt: null,
            error: null,
          });
        });
        await notifyBrowsers(org, provider, "connected");
        return;
      }
      case "error":
      case "disconnected": {
        const code = body.error?.code ?? "failed";
        if (flow.state === "error" && flow.error?.code === "cancelled") return; // expected after a cancel
        await core.db.withTenant({ organizationId: org, userId: flow.startedBy }, async (tx) => {
          await core.audit.record(tx, {
            action: "model_provider.connect_failed",
            resourceType: "model_provider",
            resourceId: null,
            result: "error",
            clientKind: "agent",
            metadata: { provider, flowId: flow.flowId, code, source: "openclaw_cell" },
          });
          await write(org, {
            ...flow,
            state: "error",
            reporterId: body.reporterId,
            verificationUrl: null,
            userCode: null,
            error: { code, message: ERROR_MESSAGES[code] },
          });
        });
        await notifyBrowsers(org, provider, "error");
        return;
      }
    }
  }

  return { status, start, cancel, report };
}

function normalizeAccount(account: AgentChannelProviderAuthReport["account"]) {
  const email = account?.email?.trim() || null;
  const planType = account?.planType?.trim().toLowerCase() || null;
  return { email, planType };
}

export type ProviderAuth = ReturnType<typeof createProviderAuth>;
