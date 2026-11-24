import { type Tx, tenantOf } from "@ocw/db";
import type { SecretsService } from "../secrets";
import type { PoolAccountRow } from "./store";

/**
 * The only seal and open of pool tokens (Phase 07.18, PD-21, ADR-0044). A Claude setup-token is stored as a
 * `pool_token` secret sealed with AAD `<orgId>:account_pool:<accountId>`, so its ciphertext opens only for the one
 * account it was added to, in its own organization. No function here logs, returns a detail or audits the value; the
 * opened token goes only into the frame sent to the session's device (PD-02) or the cell snapshot (plan 14).
 */

/** The AAD that binds a pool token to its account. */
export const poolTokenAad = (organizationId: string, accountId: string) =>
  `${organizationId}:account_pool:${accountId}`;

/** Seals a new token for `accountId` (the id exists before the row, so the AAD binds this one account). */
export async function sealPoolToken(
  tx: Tx,
  secrets: SecretsService,
  accountId: string,
  token: string,
): Promise<string> {
  return secrets.putSealed(tx, {
    name: `account_pool:${accountId}`,
    kind: "pool_token",
    provider: "anthropic",
    value: token,
    aad: poolTokenAad(tenantOf(tx).organizationId, accountId),
  });
}

/** Re-seals the account's existing secret row in place with a new token (same secret id). */
export async function replacePoolToken(
  tx: Tx,
  secrets: SecretsService,
  secretId: string,
  accountId: string,
  token: string,
): Promise<void> {
  await secrets.replaceSealed(tx, secretId, token, poolTokenAad(tenantOf(tx).organizationId, accountId));
}

/**
 * The account's token, or null for a removed row, a row without a secret, another kind, or a seal that does not open
 * (a missing row, another account's ciphertext). Never throws a detail and never logs. Server-side only.
 */
export async function openPoolToken(
  tx: Tx,
  secrets: SecretsService,
  row: Pick<PoolAccountRow, "id" | "organizationId" | "kind" | "secretId" | "removedAt">,
): Promise<string | null> {
  if (row.kind !== "token" || row.removedAt !== null || row.secretId === null) return null;
  try {
    return await secrets.revealSealed(tx, row.secretId, poolTokenAad(row.organizationId, row.id));
  } catch {
    return null;
  }
}
