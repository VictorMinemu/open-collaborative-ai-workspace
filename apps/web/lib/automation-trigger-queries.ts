"use client";

import {
  type Automation,
  type AutomationInbound,
  AutomationRunReason,
  type InboundAction,
  type InboundConfig,
  JsonPointer,
  Mailbox,
  type MailboxConfigInput,
  type MailboxPollMinutes,
  type MailboxTestRequest,
  MailboxTestResult,
  RotateWebhookSecretResponse,
  resolveJsonPointer,
  type VaultItem,
  type WebhookDelivery,
  WebhookEndpoint,
  type WebhookRejectReason,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cardNumberLabel } from "@/components/chat/board/card-tile";
import { api, isApiError } from "./api";
import { automationKeys, type ResultTone, runReasonSentence } from "./automation-queries";
import { useKeychain } from "./keychain-queries";
import { permalinkPath } from "./permalink";
import { relativeTime } from "./utils";

/**
 * Webhook and mail triggers in the web (07.6-18, AUTO-02, D-02, D-07, R3, R4, R8, UI-SPEC Surfaces 2-4): the endpoint
 * and mailbox reads, rotation and the connection test, and every sentence the panels show. A signing secret never
 * enters the query cache: rotation is a mutation that is dropped from the mutation cache once read (`gcTime: 0` plus
 * `reset()` by the caller), and no response holding one is ever written to a query.
 */

export const triggerKeys = {
  webhook: (id: string) => ["automations", "webhook", id] as const,
  mailbox: (id: string) => ["automations", "mailbox", id] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

const BASE = "/api/v1/automations";

// ---------------------------------------------------------------- reads and writes

/** `GET /automations/:id/webhook`: the URL, deliveries and the latest rejection; never the secret. */
export function useWebhookEndpoint(id: string | null) {
  return useQuery({
    queryKey: triggerKeys.webhook(id ?? ""),
    queryFn: ({ signal }) =>
      api.get(`${BASE}/${encodeURIComponent(id ?? "")}/webhook`, { schema: WebhookEndpoint, signal }),
    enabled: !!id,
    retry: noRetryOn4xx,
  });
}

/**
 * `POST /automations/:id/webhook/rotate` → `{secret, previousValidUntil}` once. The response stays out of every cache:
 * `gcTime: 0` removes the mutation as soon as the caller `reset()`s it, and only the endpoint query is refetched.
 */
export function useRotateWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (id: string) =>
      api.post(`${BASE}/${encodeURIComponent(id)}/webhook/rotate`, { schema: RotateWebhookSecretResponse }),
    onSuccess: (_res, id) => {
      void qc.invalidateQueries({ queryKey: triggerKeys.webhook(id) });
      void qc.invalidateQueries({ queryKey: automationKeys.detail(id) });
    },
  });
}

/** `GET /automations/:id/mailbox`: the saved mailbox and its status (the key by name only). */
export function useMailbox(id: string | null) {
  return useQuery({
    queryKey: triggerKeys.mailbox(id ?? ""),
    queryFn: ({ signal }) =>
      api.get(`${BASE}/${encodeURIComponent(id ?? "")}/mailbox`, { schema: Mailbox, signal }),
    enabled: !!id,
    retry: noRetryOn4xx,
  });
}

/** `POST /mailboxes/test`: tries the connection with the form's values; never saves anything. */
export function useTestMailbox() {
  return useMutation({
    gcTime: 0,
    mutationFn: (body: MailboxTestRequest) =>
      api.post("/api/v1/mailboxes/test", { body, schema: MailboxTestResult }),
  });
}

/** The viewer's Keychain items of kind `Username & password` (personal first, then unit keys they may use). */
export function useBasicKeychainItems(enabled = true) {
  const q = useKeychain(enabled);
  const items: VaultItem[] = q.data
    ? [...q.data.personal, ...q.data.unit].filter((i) => i.kind === "basic")
    : [];
  return { items, isPending: q.isPending && enabled, isError: q.isError };
}

// ---------------------------------------------------------------- inbound rule (What happens + mapping)

export interface InboundValue {
  /** null: the target's default (a board card on a board, a thread or the DM elsewhere). */
  action: InboundAction | null;
  askBot: boolean;
  titlePointer: string;
  bodyPointer: string;
  threadKeyPointer: string;
}

export const EMPTY_INBOUND: InboundValue = {
  action: null,
  askBot: true,
  titlePointer: "",
  bodyPointer: "",
  threadKeyPointer: "",
};

export function inboundValueOf(i: AutomationInbound | null | undefined): InboundValue {
  if (!i) return EMPTY_INBOUND;
  return {
    action: i.action,
    askBot: i.askBot,
    titlePointer: i.config.titlePointer ?? "",
    bodyPointer: i.config.bodyPointer ?? "",
    threadKeyPointer: i.config.threadKeyPointer ?? "",
  };
}

type TargetKind = Automation["target"]["kind"];

/** The inbound action follows the delivery target: only a board offers a card (its default). */
export function effectiveInboundAction(v: InboundValue, target: TargetKind): InboundAction {
  return target === "board" ? (v.action ?? "board_card") : "post";
}

export function inboundOf(v: InboundValue, target: TargetKind): AutomationInbound {
  const config: InboundConfig = {};
  const title = v.titlePointer.trim();
  const body = v.bodyPointer.trim();
  const key = v.threadKeyPointer.trim();
  if (title) config.titlePointer = title;
  if (body) config.bodyPointer = body;
  if (key) config.threadKeyPointer = key;
  return { action: effectiveInboundAction(v, target), askBot: v.askBot, config };
}

const POINTER_ERROR = "Use a JSON pointer like /order/name";

/** An empty field means "unset"; anything else must be an RFC 6901 pointer (`/a/b`, `~0`, `~1`). */
export function pointerError(p: string): string | null {
  const t = p.trim();
  if (!t) return null;
  return t.startsWith("/") && JsonPointer.safeParse(t).success ? null : POINTER_ERROR;
}

export type InboundErrors = Partial<Record<"titlePointer" | "bodyPointer" | "threadKeyPointer", string>>;

export function inboundErrors(v: InboundValue): InboundErrors {
  const e: InboundErrors = {};
  for (const k of ["titlePointer", "bodyPointer", "threadKeyPointer"] as const) {
    const err = pointerError(v[k]);
    if (err) e[k] = err;
  }
  return e;
}

const LIVE_MAX = 80;

/**
 * The value a pointer names in the last delivery, as plain text in curly quotes (≤ 80 characters), `no value` when it
 * names nothing; null when there is no valid pointer to resolve.
 */
export function liveValueText(payload: unknown, pointer: string): string | null {
  const p = pointer.trim();
  if (!p || pointerError(p)) return null;
  const v = resolveJsonPointer(payload, p);
  if (v === undefined || v === null) return "no value";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const shown = s.length > LIVE_MAX ? `${s.slice(0, LIVE_MAX)}…` : s;
  return `“${shown}”`;
}

// ---------------------------------------------------------------- webhook panel words

const REJECTION: Record<WebhookRejectReason, string> = {
  signature: "the signature didn't match. Check that the sender uses the current secret.",
  timestamp: "the timestamp was more than 5 minutes off. Check the sender's clock.",
  too_large: "the payload was over 64 KB.",
  rate_limited: "too many requests (over 60 a minute).",
};

/** The amber notice for the latest rejection, only when it is newer than the last request that got through. */
export function rejectionNotice(
  ep: Pick<WebhookEndpoint, "lastRejectedAt" | "lastRejectedReason" | "deliveries">,
  now: number = Date.now(),
): string | null {
  if (!ep.lastRejectedAt || !ep.lastRejectedReason) return null;
  const rejected = Date.parse(ep.lastRejectedAt);
  if (ep.deliveries.some((d) => Date.parse(d.receivedAt) >= rejected)) return null;
  return `Last rejected ${relativeTime(ep.lastRejectedAt, now)}: ${REJECTION[ep.lastRejectedReason]}`;
}

export interface DeliveryView {
  label: "Accepted" | "Duplicate" | "Not run";
  tone: ResultTone;
  text: string;
  href: string | null;
}

/** The board's name from the target label (`orders board · Intake` → `orders`). */
function boardName(label: string): string {
  return label.replace(/ board · .*$/, "");
}

/** One row of Recent deliveries: its result, its line and where the item was posted. */
export function deliveryView(
  d: WebhookDelivery,
  ctx: { prefix: string | null; namingRule: string | null; automation: Automation },
): DeliveryView {
  const a = ctx.automation;
  if (d.result === "duplicate") {
    return { label: "Duplicate", tone: "muted", text: "Already received; nothing new", href: null };
  }
  if (d.result === "not_run") {
    const reason = AutomationRunReason.safeParse(d.reason);
    const text =
      d.reason === "paused"
        ? "Received while paused; not run"
        : reason.success
          ? runReasonSentence(reason.data, {
              bot: a.agent.displayName,
              conversation: a.target.label,
              maxRunsPerDay: a.maxRunsPerDay,
            })
          : "Not run.";
    return { label: "Not run", tone: "muted", text, href: linkOf(d, a) };
  }
  const link = d.link;
  let text = "Received";
  if (link?.cardNumber) {
    const n = Number(link.cardNumber);
    const label = Number.isFinite(n)
      ? cardNumberLabel({ prefix: ctx.prefix, namingRule: ctx.namingRule }, n)
      : null;
    text = `Created card ${label ?? link.cardNumber} in ${boardName(a.target.label)}`;
  } else if (link) {
    text = `Posted in ${a.target.kind === "dm" ? "your DM" : a.target.label}`;
  }
  return { label: "Accepted", tone: "done", text, href: linkOf(d, a) };
}

function linkOf(d: WebhookDelivery, a: Automation): string | null {
  const l = d.link;
  if (!l) return null;
  if (a.target.kind === "dm") return permalinkPath({ id: l.conversationId, kind: "dm" }, l.messageId);
  const c = encodeURIComponent(l.conversationId);
  if (l.cardNumber !== null) return `/chat/${c}?thread=${encodeURIComponent(l.messageId)}`;
  return permalinkPath({ id: l.conversationId, kind: "channel" }, l.messageId, l.threadRootId ?? l.messageId);
}

/** `Set Oct 8 · shown once`. */
export function secretSetText(iso: string): string {
  const date = new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Set ${date} · shown once`;
}

/** `Previous secret also valid until Oct 9, 2:05 PM.` */
export function graceText(iso: string): string {
  const at = new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Previous secret also valid until ${at}.`;
}

/** The How to send events example (Standard Webhooks headers; placeholders, never a secret). */
export function curlExample(url: string): string {
  return [
    `curl -X POST ${url} \\`,
    `  -H "content-type: application/json" \\`,
    `  -H "webhook-id: msg_2LxJ8k" \\`,
    `  -H "webhook-timestamp: $(date +%s)" \\`,
    `  -H "webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>" \\`,
    `  -d '{"order":{"name":"#1001"}}'`,
  ].join("\n");
}

// ---------------------------------------------------------------- mailbox (R8)

export interface MailboxValue {
  vaultItemId: string;
  host: string;
  port: string;
  folder: string;
  pollIntervalMinutes: MailboxPollMinutes;
}

export const EMPTY_MAILBOX: MailboxValue = {
  vaultItemId: "",
  host: "",
  port: "993",
  folder: "INBOX",
  pollIntervalMinutes: 10,
};

export const POLL_MINUTES: ReadonlyArray<{ value: MailboxPollMinutes; label: string }> = [
  { value: 5, label: "5 minutes" },
  { value: 10, label: "10 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
];

export function mailboxValueOf(m: Mailbox | null | undefined): MailboxValue {
  if (!m) return EMPTY_MAILBOX;
  return {
    vaultItemId: m.vaultItemId ?? "",
    host: m.host,
    port: String(m.port),
    folder: m.folder,
    pollIntervalMinutes: m.pollIntervalMinutes,
  };
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export type MailboxErrors = Partial<Record<"vaultItemId" | "host" | "port" | "folder", string>>;

export function mailboxErrors(v: MailboxValue): MailboxErrors {
  const e: MailboxErrors = {};
  if (!v.vaultItemId) e.vaultItemId = "Pick a key";
  if (!HOST_RE.test(v.host.trim().toLowerCase())) e.host = "Enter the server, like imap.example.com";
  const port = Number(v.port.trim());
  if (!/^\d+$/.test(v.port.trim()) || port < 1 || port > 65_535) e.port = "Use a port from 1 to 65535";
  if (!v.folder.trim()) e.folder = "Enter a folder";
  return e;
}

/** The mailbox as the API takes it (a Keychain item id, never a credential), or null while incomplete. */
export function mailboxConfigOf(v: MailboxValue): MailboxConfigInput | null {
  if (Object.keys(mailboxErrors(v)).length > 0) return null;
  return {
    vaultItemId: v.vaultItemId,
    host: v.host.trim().toLowerCase(),
    port: Number(v.port.trim()),
    folder: v.folder.trim(),
    pollIntervalMinutes: v.pollIntervalMinutes,
  };
}

/** The API's rule (07.6-11 `mailHostAllowed`): the exact host or a `*.` subdomain, on the pattern's port or 993. */
export function mailHostAllowed(patterns: readonly string[], host: string, port: number): boolean {
  const h = host.trim().toLowerCase();
  return patterns.some((raw) => {
    const m = /^(\*\.)?([a-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(raw.trim().toLowerCase());
    if (!m?.[2]) return false;
    if ((m[3] ? Number(m[3]) : 993) !== port) return false;
    return m[1] ? h.endsWith(`.${m[2]}`) : h === m[2];
  });
}

export function hostNotAllowedText(host: string, key: string): string {
  return `Add ${host} to the allowed hosts of “${key}” in Keychain.`;
}

/** A connection test's result in words (UI-SPEC § Copy › Mailbox). */
export function mailboxTestText(
  r: MailboxTestResult,
  ctx: { folder: string; host: string; port: number; key: string },
): string {
  if (r.ok) return `Connected. ${ctx.folder} has ${r.messages.toLocaleString("en-US")} messages.`;
  switch (r.code) {
    case "auth_failed":
      return "Sign-in failed. Check the username and app password in Keychain.";
    case "unreachable":
      return `Couldn't reach ${ctx.host}:${ctx.port}.`;
    case "host_not_allowed":
      return `${ctx.host} isn't an allowed host for “${ctx.key}”.`;
    case "folder_missing":
      return `The folder “${ctx.folder}” doesn't exist.`;
    case "certificate":
      return `The server's certificate isn't valid for ${ctx.host}.`;
    default:
      return "Couldn't connect. Try again.";
  }
}

/** The saved mailbox's status line. */
export function mailboxStatusLine(
  m: Mailbox,
  now: number = Date.now(),
): { tone: ResultTone | "warning"; text: string } {
  const when = m.lastPolledAt ? relativeTime(m.lastPolledAt, now) : null;
  switch (m.status) {
    case "paused":
      return { tone: "muted", text: "Paused with the automation." };
    case "auth_failed":
      return {
        tone: "failed",
        text: `Sign-in failed${when ? ` ${when}` : ""}. Update the password in Keychain.`,
      };
    case "unreachable":
      return {
        tone: "warning",
        text: `Couldn't reach ${m.host}${when ? ` ${when}` : ""}. OCW keeps trying.`,
      };
    default: {
      if (!when) return { tone: "muted", text: "Not checked yet." };
      const n = m.lastNewCount;
      const tail = n === 0 ? "no new mail" : n === 1 ? "1 new message" : `${n} new messages`;
      return { tone: "done", text: `Checked ${when} · ${tail}` };
    }
  }
}
