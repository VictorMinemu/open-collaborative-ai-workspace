import {
  CELL_CLAUDE_TOKENS,
  type CellAccountPool,
  claudeTokenProfileId,
  type PoolPolicy,
  type SubscriptionProviderKind,
} from "@ocw/contracts";
import { accountPoolAccounts, type Tx } from "@ocw/db";
import { asc, inArray } from "drizzle-orm";
import type { Core } from "../../core";
import { loadPoolPolicy, openPoolToken, type PoolAccountRow, servesConsumer } from "../account-pool";

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
