import {
  type AuthTestStep,
  authFailureFix,
  type ConnectorAuthFailure,
  type ConnectorReconnectReason,
  type McpServer,
  type OrgConnection,
  OrgSignInError,
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
