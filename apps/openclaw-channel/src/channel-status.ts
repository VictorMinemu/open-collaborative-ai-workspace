import type { ResolvedOcwAccount } from "./account.js";

const MAX_ERROR_CHARS = 500;
const BOOLEAN_FIELDS = ["connected", "restartPending"] as const;
const NUMBER_FIELDS = ["reconnectAttempts", "lastStartAt", "lastStopAt", "lastConnectedAt"] as const;
const LIFECYCLES = new Set(["starting", "ready", "recovering", "blocked", "stopped"]);

/**
 * The ocw channel's `status.buildAccountSnapshot` (what `channels.status` reports for the account).
 *
 * Without it OpenClaw 2026.9.7 projects the runtime through `projectSafeChannelAccountSnapshotFields`
 * (dist/account-snapshot-fields-*.mjs), which keeps running/connected/lifecycle but drops `lastError`, so a stopped
 * account never says why: not to an operator running `openclaw channels status`, and not to our restart-loop breaker
 * guard (autostart-guard.ts), which reads the breaker refusal OpenClaw stores there. Only explicit fields: never the
 * account object (its token reader) and never unknown runtime keys. `lastError` comes from OpenClaw's channel manager
 * or from our own account loop; neither carries secrets.
 */
export function buildOcwAccountSnapshot(params: {
  account: ResolvedOcwAccount;
  runtime?: Record<string, unknown>;
}): Record<string, unknown> {
  const runtime = params.runtime ?? {};
  const snapshot: Record<string, unknown> = {
    accountId: params.account.accountId,
    enabled: params.account.enabled,
    configured: params.account.configured,
    running: runtime.running === true,
  };
  for (const key of BOOLEAN_FIELDS) if (typeof runtime[key] === "boolean") snapshot[key] = runtime[key];
  for (const key of NUMBER_FIELDS) if (typeof runtime[key] === "number") snapshot[key] = runtime[key];
  if (typeof runtime.lifecycle === "string" && LIFECYCLES.has(runtime.lifecycle))
    snapshot.lifecycle = runtime.lifecycle;
  snapshot.lastError =
    typeof runtime.lastError === "string" ? runtime.lastError.slice(0, MAX_ERROR_CHARS) : null;
  return snapshot;
}
