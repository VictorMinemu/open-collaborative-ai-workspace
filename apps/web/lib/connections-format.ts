import type { DmSummary, MemberConnector, ReadersPreview } from "@ocw/contracts";
import { relativeTime } from "./utils";

/**
 * Settings › Connections copy and states (07.4-UI-SPEC § 2, § Copywriting › Member › Connections). Pure: the page,
 * the shares list and the shared-use dialog read every sentence from here, and the unit tests pin them.
 */

/** A row's display state: the API's three statuses plus the display-only "revoked" (R2) and "unavailable". */
export type ConnectorDisplayStatus =
  | "not_connected"
  | "connected"
  | "needs_reconnect"
  | "revoked"
  | "unavailable";

/** The row's primary action: an OAuth (re)connect, or the key dialog. */
export interface ConnectorPrimary {
  kind: "connect" | "key";
  label: string;
  disabled?: boolean;
}

export type ConnectorSecondary = "replace" | "disconnect";

export interface ConnectorView {
  status: ConnectorDisplayStatus;
  pill: "Not connected" | "Connected" | "Needs reconnect" | "Access revoked";
  meta: string;
  modeLabel: "Sign in" | "Your key";
  primary: ConnectorPrimary | null;
  secondary: ConnectorSecondary[];
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `{date}` of the spec: `today`, `yesterday`, `Oct 8`, or `Oct 8, 2025` outside the current year. */
export function connectionDate(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return new Date(t).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function usage(c: MemberConnector, now: number): string {
  const since = c.connectedAt ? `since ${connectionDate(c.connectedAt, now)}` : null;
  const used = c.lastUsedAt ? `last used ${relativeTime(c.lastUsedAt, now)}` : "never used";
  return [since, used].filter(Boolean).join(" · ");
}

/** One row of the § 2 state table for this member's connection. */
export function connectorView(
  c: MemberConnector,
  oauth: { oauthAvailable: boolean },
  now: number = Date.now(),
): ConnectorView {
  const key = c.authMode === "per_member_secret";
  const modeLabel = key ? "Your key" : "Sign in";
  if (c.status === "connected") {
    return {
      status: "connected",
      pill: "Connected",
      meta: key
        ? `Key set · ${usage(c, now)}`
        : [c.accountLabel ? `as ${c.accountLabel}` : null, usage(c, now)].filter(Boolean).join(" · "),
      modeLabel,
      primary: null,
      secondary: key ? ["replace", "disconnect"] : ["disconnect"],
    };
  }
  if (c.status === "needs_reconnect") {
    if (key) {
      return {
        status: "needs_reconnect",
        pill: "Needs reconnect",
        meta: "Your key stopped working. Add a new one to keep using it.",
        modeLabel,
        primary: { kind: "key", label: "Add a new key" },
        secondary: ["disconnect"],
      };
    }
    const blocked = !oauth.oauthAvailable;
    const primary: ConnectorPrimary = {
      kind: "connect",
      label: "Reconnect",
      ...(blocked ? { disabled: true } : {}),
    };
    if (c.reconnectReason === "revoked") {
      return {
        status: "revoked",
        pill: "Access revoked",
        meta: `Access was revoked at ${c.name}. Reconnect to use it again.`,
        modeLabel,
        primary,
        secondary: ["disconnect"],
      };
    }
    return {
      status: "needs_reconnect",
      pill: "Needs reconnect",
      meta: "Your sign-in expired. Bots can't use it until you reconnect.",
      modeLabel,
      primary,
      secondary: ["disconnect"],
    };
  }
  if (key) {
    return {
      status: "not_connected",
      pill: "Not connected",
      meta: "Add your own key. It's never shown again.",
      modeLabel,
      primary: { kind: "key", label: "Add your key" },
      secondary: [],
    };
  }
  if (!oauth.oauthAvailable || c.oauthStatus === "https_required") {
    return {
      status: "unavailable",
      pill: "Not connected",
      meta: "Sign-in needs HTTPS on this workspace.",
      modeLabel,
      primary: { kind: "connect", label: "Connect", disabled: true },
      secondary: [],
    };
  }
  if (c.oauthStatus === "needs_client" || c.oauthStatus === "error") {
    return {
      status: "unavailable",
      pill: "Not connected",
      meta: `Not ready yet. An admin has to finish setting up ${c.name}.`,
      modeLabel,
      primary: { kind: "connect", label: "Connect", disabled: true },
      secondary: [],
    };
  }
  return {
    status: "not_connected",
    pill: "Not connected",
    meta: "Sign in once. Bots use it only when you ask.",
    modeLabel,
    primary: { kind: "connect", label: "Connect" },
    secondary: [],
  };
}

/** Codes whose fix is an admin's, not another attempt: their banner has no Try again. */
const NO_RETRY = new Set(["https_required", "needs_client", "pkce_unsupported", "egress_refused"]);

const ERROR_SENTENCES: Record<string, (name: string) => string> = {
  access_denied: (n) => `You didn't allow access at ${n}.`,
  session_mismatch: () => "This sign-in was started from another account. Try again.",
  flow_expired: () => "That sign-in took too long or was already used. Try again.",
  issuer_mismatch: () =>
    "The sign-in came back from an unexpected server, so OCW stopped it. Try again, and tell an admin if it happens again.",
  token_exchange_failed: (n) => `${n} didn't finish the sign-in. Try again.`,
  discovery_failed: (n) => `Couldn't reach ${n}'s sign-in. Try again later, or tell an admin.`,
  https_required: () => "Signing in needs HTTPS on this workspace. Ask an admin to set it up.",
  needs_client: (n) => `${n} isn't ready for sign-in yet. An admin has to finish setting it up.`,
  pkce_unsupported: (n) => `${n}'s sign-in doesn't meet OCW's security requirements. Tell an admin.`,
  egress_refused: (n) => `${n}'s sign-in points to an address OCW won't contact. Tell an admin.`,
  not_connected: (n) => `You aren't connected to ${n}.`,
  needs_reconnect: (n) => `Your ${n} sign-in stopped working. Reconnect to keep using it.`,
};

/**
 * The fixed sentence for a `ConnectorErrorCode` (UI-SPEC R8, T-07.4-13-02). The code comes from a URL, so anything
 * unknown, a provider's own error text included, reads as the generic sentence: provider text is never shown.
 */
export function connectorErrorSentence(code: string, name: string): { text: string; retry: boolean } {
  const sentence = Object.hasOwn(ERROR_SENTENCES, code) ? ERROR_SENTENCES[code] : undefined;
  if (!sentence) return { text: `Couldn't connect ${name}. Try again.`, retry: true };
  return { text: sentence(name), retry: !NO_RETRY.has(code) };
}

/** The spec's fallback for a conversation the member cannot open any more. */
export const UNKNOWN_CONVERSATION = "a conversation you can no longer open";

/**
 * How a conversation reads in "{resource} in {conversation}": the API's `#name` or AI chat title, else (a DM or a
 * group, which the API leaves unnamed) the member's own DM list, else the unknown sentence.
 */
export function conversationLabel(
  conversationId: string,
  apiName: string | null,
  dms: readonly Pick<DmSummary, "id" | "counterpart">[] | undefined,
): string {
  if (apiName) return apiName;
  const dm = dms?.find((d) => d.id === conversationId);
  if (!dm) return UNKNOWN_CONVERSATION;
  const c = dm.counterpart;
  return c.kind === "group" ? `your group with ${c.name}` : `your DM with ${c.name}`;
}

/** "{n} people can read results here", or the whole group of an unbounded audience (a public channel, a unit grant). */
export function readersLine(p: Pick<ReadersPreview, "readers" | "unbounded">, unit: string | null): string {
  if (p.unbounded) return `Everyone in ${unit ?? "the organization"} can read results here`;
  return p.readers === 1 ? "1 person can read results here" : `${p.readers} people can read results here`;
}
