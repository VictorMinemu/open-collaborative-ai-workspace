import {
  type AuthTestStep,
  authFailureFix,
  type ConnectorAuthFailure,
  type ConnectorReconnectReason,
  isOrgCredentialMode,
  isPerMemberMode,
  type McpServer,
  type OrgConnection,
  OrgSignInError,
  usesConnectorProxy,
} from "@ocw/contracts";
import { relativeTime } from "./utils";

/**
 * Settings › MCP servers copy for the organization's connection (07.14 PD-12 › Row; extends 07.4-UI-SPEC § 1). Pure:
 * the row, the arrival banner and the delete dialog read every sentence from here, and the unit tests pin them. Fix
 * lines come only from the contract (`authFailureFix`), never from a response body or a URL: provider text is never
 * shown (D-10).
 */

export type OrgRowStatus = OrgConnection["status"];

/** The row's state: no organization connection reads as not connected. */
export function orgConnectionStatus(c: OrgConnection | null): OrgRowStatus {
  return c?.status ?? "not_connected";
}

/** `Connected as {account} · by {name} · {time}` (or `Connected · by …`; client credentials `Client {clientId} · …`). */
export function orgConnectionLine(c: OrgConnection, now: number = Date.now()): string {
  const head =
    c.method === "client_credentials"
      ? c.clientId
        ? `Client ${c.clientId}`
        : "Client credentials"
      : c.accountLabel
        ? `Connected as ${c.accountLabel}`
        : "Connected";
  const by = c.connectedBy ? `by ${c.connectedBy.name}` : null;
  const when = c.connectedAt ? relativeTime(c.connectedAt, now) : null;
  return [head, by, when].filter(Boolean).join(" · ");
}

/** What a not-connected row says, by mode. */
export function notConnectedLine(mode: McpServer["authMode"], server: string): string {
  return mode === "org_client_credentials"
    ? "No client credentials yet."
    : `Not connected. Bots can't use ${server} until an admin connects it.`;
}

const REASON: Record<ConnectorReconnectReason, string> = {
  expired: "The sign-in expired.",
  revoked: "Access was revoked at the provider.",
  provider_changed: "The provider's sign-in server changed.",
};

/** The `needs_reconnect` explanation (D-08). */
export function reasonLine(reason: ConnectorReconnectReason | null): string {
  return REASON[reason ?? "expired"];
}

const STEP_LABEL: Record<AuthTestStep, string> = {
  public_url: "This workspace's address",
  discovery: "Sign-in information",
  issuer: "Sign-in server identity",
  endpoints: "Secure endpoints",
  pkce: "PKCE (S256)",
  client_registration: "Client registration",
  token: "Token",
};

/** The diagnosis step's label (PD-12; the Test sign-in step list of plan 12 reads it too). */
export function stepLabel(step: AuthTestStep): string {
  return STEP_LABEL[step];
}

const FAILURE_STEP: Record<ConnectorAuthFailure, AuthTestStep> = {
  https_required: "public_url",
  discovery_failed: "discovery",
  issuer_mismatch: "issuer",
  token_endpoint_untrusted: "endpoints",
  pkce_unsupported: "pkce",
  client_registration_unavailable: "client_registration",
  scope_rejected: "token",
  token_exchange_failed: "token",
};

/** The step a failure code stopped at (PD-08 order). */
export function stepOfFailure(code: ConnectorAuthFailure): AuthTestStep {
  return FAILURE_STEP[code];
}

/** The stored `authFailure` box: `Last sign-in failed: {step}.` and the contract's fix line. */
export function failureBox(code: ConnectorAuthFailure, server: string): { title: string; fix: string } {
  return {
    title: `Last sign-in failed: ${stepLabel(stepOfFailure(code))}.`,
    fix: authFailureFix(code, server),
  };
}

/** The Disconnect confirmation (D-08): the provider sign-out is best effort, so the copy says "when it can". */
export function disconnectCopy(server: string): { title: string; body: string } {
  return {
    title: `Disconnect ${server}?`,
    body: `Bots stop using the organization's account on ${server}. OCW also signs it out at the provider when it can.`,
  };
}

/**
 * A PATCH that deletes saved accounts, asked before it is sent (PD-11; 07.14 review CR-01): `kind` = whose accounts
 * (`members` with their count, or the organization's), `reason` = a mode switch, or a new URL on a proxied server (a
 * token or key belongs to the URL it was granted for, so the server deletes it).
 */
export interface CredentialConfirm {
  kind: "members" | "org";
  count: number;
  reason: "mode" | "url";
}

/** Whether this edit of `base` needs the confirmation, from what the list already knows (the server's 409 is the fallback). */
export function credentialConfirmation(
  base: Pick<McpServer, "authMode" | "memberConnections" | "orgConnection">,
  body: { authMode?: McpServer["authMode"]; url?: string; name?: string },
): CredentialConfirm | null {
  const modeChanged = body.authMode !== undefined && body.authMode !== base.authMode;
  const urlChanged = body.url !== undefined && usesConnectorProxy(base.authMode);
  if (!modeChanged && !urlChanged) return null;
  const reason = modeChanged ? "mode" : "url";
  if (isPerMemberMode(base.authMode) && base.memberConnections > 0) {
    return { kind: "members", count: base.memberConnections, reason };
  }
  if (isOrgCredentialMode(base.authMode) && base.orgConnection !== null)
    return { kind: "org", count: 0, reason };
  return null;
}

/** The confirmation dialog's copy; nothing is revoked at the provider, so it promises only the deletion. */
export function clearConnectionsCopy(
  c: CredentialConfirm,
  server: string,
  to: { mode: McpServer["authMode"]; label: string },
): { title: string; body: string; action: string } {
  const title =
    c.kind === "org"
      ? "Disconnect the organization's account?"
      : c.count === 1
        ? "Disconnect 1 member?"
        : `Disconnect ${c.count} members?`;
  const change = c.reason === "url" ? `Changing the URL of ${server}` : `Switching ${server} to ${to.label}`;
  const after =
    c.kind === "org"
      ? c.reason === "url"
        ? "Connect it again for the new URL."
        : "Bots stop using it."
      : c.reason === "mode" && !isPerMemberMode(to.mode)
        ? "Bots stop acting with members' own accounts."
        : "They'll need to connect again.";
  const what = c.kind === "org" ? "the organization's saved sign-in" : "every member's saved sign-in or key";
  const verb = c.reason === "url" ? "Change URL and disconnect" : "Switch and disconnect";
  return {
    title,
    body: `${change} deletes ${what}. ${after}`,
    action: c.kind === "org" ? verb : `${verb} ${c.count}`,
  };
}

/** The delete dialog's extra sentence when the organization's connection goes with the server (PD-11). */
export function orgDeleteSentence(server: string): string {
  return `The organization's sign-in to ${server} is deleted too.`;
}

export interface ArrivalBanner {
  kind: "success" | "error";
  title: string;
  body: string | null;
}

const OUTCOME: Record<"access_denied" | "flow_expired" | "session_mismatch", (server: string) => string> = {
  access_denied: (s) => `${s} didn't allow access.`,
  flow_expired: () => "That sign-in took too long or was already used. Try Connect again.",
  session_mismatch: () =>
    "That sign-in was started from another account. Sign in as the admin who started it and try again.",
};

/**
 * The banner of an organization sign-in's return (`?connected=<id>` or `?error=<OrgSignInError>`). The code comes
 * from a URL: only the closed set renders, through fixed copy; anything else is ignored (null, T-07.14-11-01).
 */
export function arrivalBanner(
  params: { connected?: string | null; error?: string | null },
  server: string,
): ArrivalBanner | null {
  if (params.connected) {
    return { kind: "success", title: `Connected ${server} for the organization.`, body: null };
  }
  if (!params.error) return null;
  const parsed = OrgSignInError.safeParse(params.error);
  if (!parsed.success) return null;
  const code = parsed.data;
  if (code === "access_denied" || code === "flow_expired" || code === "session_mismatch") {
    return { kind: "error", title: OUTCOME[code](server), body: null };
  }
  return {
    kind: "error",
    title: `Couldn't connect ${server}: ${stepLabel(stepOfFailure(code))}.`,
    body: authFailureFix(code, server),
  };
}
