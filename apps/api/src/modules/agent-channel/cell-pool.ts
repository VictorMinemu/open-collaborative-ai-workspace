import {
  type AgentChannelPoolHealthReport,
  type AgentChannelProviderAuthReport,
  CELL_CLAUDE_TOKENS,
  type CellAccountPool,
  type CellAuthProfileReport,
  claudeTokenProfileId,
  POOL_LIMITS,
  type PoolPolicy,
  type PoolProvider,
  type SubscriptionProviderKind,
} from "@ocw/contracts";
import { accountPoolAccounts, type Tx } from "@ocw/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import {
  insertPoolAccount,
  listPoolAccounts,
  loadPoolPolicy,
  lockPool,
  openPoolToken,
  type PoolAccountRow,
  servesConsumer,
} from "../account-pool";
import { notifyCell, POOL_OF_SUBSCRIPTION, subscriptionAccount } from "../agent";

/**
 * The account pool as the organization's bots use it (Phase 07.18, D-02, D-04, D-12, D-15, PD-12, PD-13, PD-18;
 * ADR-0044). `cellAccountPool` builds the `accountPool` of `GET /agent-channel/v1/cell`: the Claude setup-tokens that
 * serve bots (opened here, sent only over that authenticated route, never logged or audited) and the ChatGPT profiles
 * the cell holds, each with the order the strategy sets. OpenClaw keeps its own session stickiness, rate-limit failover
 * and cooldowns, so a cooling account is still sent; a disabled one is never in an explicit order (A-04). Subscriptions
 * come first: the org's Anthropic key is put last (`apiKeyLast`), after every pool token (D-15).
 */

export interface CellPoolView {
  /** The snapshot's `accountPool`; undefined when the organization never had a token or bot account (07.17 snapshot). */
  accountPool: CellAccountPool | undefined;
  /**
   * Subscription providers bots must not use although connected: the pool manages them and none of its accounts is
   * enabled. OpenClaw cannot hold an empty explicit order (every stored profile would serve again), so the provider
   * leaves the snapshot's `subscriptions` instead (07.18-07 SUMMARY).
   */
  withheldSubscriptions: SubscriptionProviderKind[];
  /** The pool accounts delivered to the cell (the config-read audit lists these ids, never a token). */
  accountIds: string[];
}

/** Explicit order under failover; none under round-robin and weighted while every bot account is enabled (PD-13). */
function orderFor(policy: PoolPolicy, sent: readonly string[], total: number): string[] | null {
  if (sent.length === 0) return null;
  if (policy.strategy !== "failover" && sent.length === total) return null;
  return [...sent];
}

export async function cellAccountPool(
  tx: Tx,
  core: Pick<Core, "secrets" | "log">,
  opts: {
    /** Whether the cell has the organization's Anthropic API key (a usable `anthropic` provider). */
    anthropicKey: boolean;
    /** A-05 (07.18-07: holds); tests pass false to prove the fallback. */
    claudeTokens?: boolean;
  },
): Promise<CellPoolView> {
  // Removed rows count too: a pool whose accounts were all removed still tells the cell to drop its tokens and order.
  const rows = await tx
    .select()
    .from(accountPoolAccounts)
    .where(inArray(accountPoolAccounts.kind, ["token", "cell_profile"]))
    .orderBy(
      asc(accountPoolAccounts.priority),
      asc(accountPoolAccounts.createdAt),
      asc(accountPoolAccounts.id),
    );
  if (rows.length === 0) return { accountPool: undefined, withheldSubscriptions: [], accountIds: [] };
  const live = (kind: PoolAccountRow["kind"]) => rows.filter((r) => r.kind === kind && r.removedAt === null);

  // ---- Claude: token profiles that serve bots (scope `all` or `bots`, enabled, credential ok; PD-18).
  const claudePolicy = await loadPoolPolicy(tx, "claude");
  const forBots = { consumer: "bots" as const, deviceId: null, scope: claudePolicy.scope };
  const botTokens =
    (opts.claudeTokens ?? CELL_CLAUDE_TOKENS) && claudePolicy.scope !== "work_zone" ? live("token") : [];
  const tokens: CellAccountPool["claude"]["tokens"] = [];
  for (const row of botTokens) {
    if (!servesConsumer(row, forBots)) continue;
    const token = await openPoolToken(tx, core.secrets, row);
    if (token === null) {
      core.log.warn({ accountId: row.id }, "pool token did not open; the cell does not get this account");
      continue;
    }
    tokens.push({
      accountId: row.id,
      profileId: claudeTokenProfileId(row.id),
      envName: `OCW_POOL_TOKEN_${tokens.length + 1}`,
      token,
    });
  }

  // ---- ChatGPT: the profiles signed in inside the cell (credentials never leave it, ADR-0006).
  const chatgptPolicy = await loadPoolPolicy(tx, "chatgpt");
  const profileRows = live("cell_profile").filter((r) => r.cellProfileId !== null);
  const profiles = profileRows.map((r) => ({
    accountId: r.id,
    profileId: r.cellProfileId as string,
    enabled: r.enabled,
  }));
  const enabledProfiles = profiles.filter((p) => p.enabled).map((p) => p.profileId);
  const chatgptManaged = rows.some((r) => r.kind === "cell_profile");

  return {
    accountPool: {
      claude: {
        order: orderFor(
          claudePolicy,
          tokens.map((t) => t.profileId),
          botTokens.length,
        ),
        tokens,
        apiKeyLast: opts.anthropicKey,
      },
      chatgpt: { order: orderFor(chatgptPolicy, enabledProfiles, profiles.length), profiles },
    },
    withheldSubscriptions: chatgptManaged && enabledProfiles.length === 0 ? ["openai-codex"] : [],
    accountIds: [...tokens.map((t) => t.accountId), ...profiles.map((p) => p.accountId)],
  };
}

// ---------------------------------------------------------------- what the cell reports (PD-11, PD-12, E14)

/** "ChatGPT for bots" (D-10): the account id and profile id are fixed when the admin starts the sign-in. */
export interface PoolSignInFlow {
  accountId: string;
  label: string;
  /** The profile id asked of the cell (`poolProfileId(accountId)`). */
  profileId: string;
}

/** The sign-in flow a `connected` report finishes. */
export interface CellProfileFlow {
  flowId: string;
  /** Null for a sign-in started without a pool account (the Models page card). */
  poolAccount: PoolSignInFlow | null;
}

export interface CellProfileResult {
  /** Whether the pool changed (the cell was then told to re-read its config). */
  changed: boolean;
  /** Usable profiles in a credential state report's list; null when the report carries none (an older cell). */
  usableProfiles: number | null;
}

const FALLBACK_LABEL = "ChatGPT account";
const labelOf = (email: string | null | undefined) =>
  email?.trim().slice(0, POOL_LIMITS.labelMax).trim() || FALLBACK_LABEL;
const planOf = (plan: string | null | undefined) => plan?.trim().toLowerCase().slice(0, 64) || null;

type AccountPatch = Partial<typeof accountPoolAccounts.$inferInsert>;

async function liveProfiles(tx: Tx, provider: PoolProvider): Promise<PoolAccountRow[]> {
  return (await listPoolAccounts(tx, provider)).filter((r) => r.kind === "cell_profile");
}

async function patchAccount(tx: Tx, id: string, patch: AccountPatch): Promise<void> {
  await tx
    .update(accountPoolAccounts)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(accountPoolAccounts.id, id));
}

/** A cell profile row at the end of the order; a full pool leaves the profile out (logged by provider only). */
async function addProfile(
  core: Core,
  tx: Tx,
  input: {
    id?: string;
    provider: PoolProvider;
    label: string;
    origin: "admin" | "adopted";
    cellProfileId: string;
    planType: string | null;
  },
): Promise<PoolAccountRow | null> {
  try {
    return await insertPoolAccount(tx, core.audit, { ...input, kind: "cell_profile" });
  } catch (err) {
    if (err instanceof HttpError && err.code === "too_many_accounts") {
      core.log.warn({ provider: input.provider }, "account pool full; a cell profile was not added");
      return null;
    }
    throw err;
  }
}

async function auditSignedIn(
  core: Core,
  tx: Tx,
  row: Pick<PoolAccountRow, "id" | "provider" | "label" | "origin" | "planType">,
  flowId: string,
): Promise<void> {
  await core.audit.record(tx, {
    action: "account_pool.signed_in",
    resourceType: "account_pool_account",
    resourceId: row.id,
    // The cell completed the flow; the tenant user of tx is the admin who started it.
    clientKind: "agent",
    metadata: {
      provider: row.provider,
      kind: "cell_profile",
      label: row.label,
      origin: row.origin,
      planType: row.planType,
      flowId,
      source: "openclaw_cell",
    },
  });
}

/** A finished sign-in: its profile joins the pool (or, signed in again, is ok again). A replay changes nothing. */
async function applySignedIn(
  core: Core,
  tx: Tx,
  provider: PoolProvider,
  profileId: string,
  report: AgentChannelProviderAuthReport,
  flow: CellProfileFlow,
): Promise<boolean> {
  const plan = planOf(report.account?.planType);
  const pool = flow.poolAccount;
  const existing = (await liveProfiles(tx, provider)).find((r) => r.cellProfileId === profileId);
  if (existing) {
    const patch: AccountPatch = {};
    if (existing.credentialState !== "ok") patch.credentialState = "ok";
    if (plan !== null && plan !== existing.planType) patch.planType = plan;
    // The cell listed the profile before this report arrived: the admin's label wins.
    if (pool && existing.origin === "adopted") Object.assign(patch, { origin: "admin", label: pool.label });
    if (Object.keys(patch).length === 0) return false;
    await patchAccount(tx, existing.id, patch);
    await auditSignedIn(core, tx, { ...existing, ...patch }, flow.flowId);
    return true;
  }
  if (pool) {
    // A replayed report for an account removed since is not revived.
    const [taken] = await tx
      .select({ id: accountPoolAccounts.id })
      .from(accountPoolAccounts)
      .where(eq(accountPoolAccounts.id, pool.accountId));
    if (taken) return false;
  }
  const row = await addProfile(core, tx, {
    ...(pool ? { id: pool.accountId } : {}),
    provider,
    label: pool?.label ?? labelOf(report.account?.email),
    origin: pool ? "admin" : "adopted",
    cellProfileId: profileId,
    planType: plan,
  });
  if (!row) return false;
  await auditSignedIn(core, tx, row, flow.flowId);
  return true;
}

/**
 * A credential state report's profile list (PD-12, E14): a profile the pool lacks is adopted (only while the
 * subscription is connected), a pool profile the cell no longer holds leaves the pool, and each one's credential
 * follows `usable`. The report binds to the cell's own organization (the transaction's tenant), so it never writes
 * another organization's rows.
 */
async function reconcileProfiles(
  core: Core,
  tx: Tx,
  provider: PoolProvider,
  report: AgentChannelProviderAuthReport,
  profiles: readonly CellAuthProfileReport[],
): Promise<boolean> {
  const reported = new Map<string, CellAuthProfileReport>();
  for (const p of profiles) if (!reported.has(p.profileId)) reported.set(p.profileId, p);
  const live = await liveProfiles(tx, provider);
  const byProfile = new Map(live.map((r) => [r.cellProfileId, r]));
  const connected = (await subscriptionAccount(tx, report.provider)) !== null;
  let changed = false;

  for (const p of reported.values()) {
    const state = p.usable ? "ok" : "needs_sign_in";
    const plan = planOf(p.planType);
    const row = byProfile.get(p.profileId);
    if (row) {
      const patch: AccountPatch = {};
      if (row.credentialState !== state) patch.credentialState = state;
      if (plan !== null && plan !== row.planType) patch.planType = plan;
      const keys = Object.keys(patch);
      if (keys.length === 0) continue;
      await patchAccount(tx, row.id, patch);
      await core.audit.record(tx, {
        action: "account_pool.account_updated",
        resourceType: "account_pool_account",
        resourceId: row.id,
        actorKind: "system",
        clientKind: "agent",
        metadata: {
          provider,
          kind: row.kind,
          label: row.label,
          changed: keys,
          credentialState: state,
          source: "openclaw_cell",
        },
      });
      changed = true;
      continue;
    }
    if (!connected) continue;
    const added = await addProfile(core, tx, {
      provider,
      label: labelOf(p.email),
      origin: "adopted",
      cellProfileId: p.profileId,
      planType: plan,
    });
    if (!added) continue;
    if (!p.usable) await patchAccount(tx, added.id, { credentialState: "needs_sign_in" });
    changed = true;
  }

  for (const row of live) {
    if (row.cellProfileId !== null && reported.has(row.cellProfileId)) continue;
    const at = new Date().toISOString();
    await tx
      .update(accountPoolAccounts)
      .set({ removedAt: at, updatedAt: at })
      .where(and(eq(accountPoolAccounts.id, row.id), isNull(accountPoolAccounts.removedAt)));
    await core.audit.record(tx, {
      action: "account_pool.account_removed",
      resourceType: "account_pool_account",
      resourceId: row.id,
      actorKind: "system",
      clientKind: "agent",
      metadata: {
        provider,
        kind: row.kind,
        origin: row.origin,
        label: row.label,
        reason: "not_in_cell",
        source: "openclaw_cell",
      },
    });
    changed = true;
  }
  return changed;
}

/**
 * What a cell's `POST /provider-auth` means for the pool, in the caller's transaction (the one that updates the
 * provider row): a `connected` report of a flow adds or refreshes its profile (the profile id the cell reports, else the
 * one asked for; A-03), and a credential state report with `profiles` reconciles the pool's bot accounts. Any change
 * tells the cell to re-read its config. A report with neither changes nothing (an older cell).
 */
export async function applyCellProfileReport(
  core: Core,
  tx: Tx,
  report: AgentChannelProviderAuthReport,
  flow: CellProfileFlow | null,
): Promise<CellProfileResult> {
  const provider = POOL_OF_SUBSCRIPTION[report.provider];
  const profileId =
    flow && report.state === "connected" ? (report.profileId ?? flow.poolAccount?.profileId ?? null) : null;
  const profiles = report.flowId === null ? (report.profiles ?? null) : null;
  if (!profileId && !profiles) return { changed: false, usableProfiles: null };

  await lockPool(tx, provider);
  let changed = false;
  if (flow && profileId) changed = await applySignedIn(core, tx, provider, profileId, report, flow);
  if (profiles) changed = (await reconcileProfiles(core, tx, provider, report, profiles)) || changed;
  if (changed) await notifyCell(core, tx, "providers.updated", null);
  return {
    changed,
    usableProfiles: profiles ? new Set(profiles.filter((p) => p.usable).map((p) => p.profileId)).size : null,
  };
}

/**
 * 07.18-19 R2.2: the cell's `POST /pool-health`. A Claude token profile OpenClaw refused for an auth failure (revoked,
 * disabled) moves its live pool account to `needs_sign_in`, as the Work Zone's `auth_failed` does: it leaves the cell's
 * snapshot and every selection until an admin pastes a new token. One-way: `usable: true` never revives an account (the
 * cell no longer holds its token). Only the transaction's organization (the cell's own) is read and written; unknown or
 * foreign profile ids are ignored. Audited `account_pool.account_updated` with ids and labels only, never a token.
 */
export async function applyCellTokenHealth(
  core: Core,
  tx: Tx,
  report: AgentChannelPoolHealthReport,
): Promise<{ changed: number }> {
  const refused = new Set(report.claude.filter((p) => !p.usable).map((p) => p.profileId));
  if (refused.size === 0) return { changed: 0 };
  await lockPool(tx, "claude");
  const rows = (await listPoolAccounts(tx, "claude")).filter(
    (r) => r.kind === "token" && r.credentialState === "ok" && refused.has(claudeTokenProfileId(r.id)),
  );
  for (const row of rows) {
    await patchAccount(tx, row.id, { credentialState: "needs_sign_in" });
    await core.audit.record(tx, {
      action: "account_pool.account_updated",
      resourceType: "account_pool_account",
      resourceId: row.id,
      actorKind: "system",
      clientKind: "agent",
      metadata: {
        provider: "claude",
        kind: "token",
        label: row.label,
        changed: ["credentialState"],
        credentialState: "needs_sign_in",
        source: "openclaw_cell",
      },
    });
  }
  // The token leaves the snapshot: the cell re-reads its config and drops the profile.
  if (rows.length > 0) await notifyCell(core, tx, "providers.updated", null);
  return { changed: rows.length };
}
