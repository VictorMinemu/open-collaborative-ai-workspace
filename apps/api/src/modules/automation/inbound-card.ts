import {
  AGENT_CARD_NOTICE_MAX,
  AGENT_CARD_TITLE_MAX,
  type AgentCardField,
  type AgentCardNotice,
  AUTOMATION_LIMITS,
  BOARD_CARD_DESCRIPTION_MAX,
  type InboundConfig,
  MENTION_TOKEN_RE,
  resolveJsonPointer,
} from "@ocw/contracts";

/**
 * What the platform (never a model) posts for an inbound item (07.6-21; D-02, P-11, UI-SPEC Surface 8b, Pitfall 3).
 * Every value is plain text composed here from the stored event: the title, the From/Received/Via/Message fields, the
 * amber "Outside content" notice (always first) and the full text as a fenced ```` ```text ```` block, so the safe
 * `<Markdown>` shows it preformatted (no links, no formatting, no images); the one-line summary (the message body) is
 * escaped as inert Markdown (`inertMarkdown`). Mention tokens in outside text are defused
 * (a word joiner before the `@`), so a mail can never ping a colleague or a bot through the platform's own post.
 */

/** One stored inbound item (`automation_events`), as these helpers read it. */
export interface InboundItem {
  source: "webhook" | "mail";
  externalId: string;
  threadKey: string | null;
  subject: string | null;
  sender: string | null;
  bodyText: string | null;
  bodyJson: unknown;
  receivedAt: string | Date;
}

/** The automation an item belongs to, as these helpers read it. */
export interface InboundAutomationRef {
  id: string;
  name: string;
  config: InboundConfig;
}

/** The inbound card as chat's platform-owned card input (kind `automation`, pill `Received`). */
export interface InboundCard {
  kind: "automation";
  title: string;
  summary: string;
  status: "info";
  statusLabel: "Received";
  fields: AgentCardField[];
  notices: AgentCardNotice[];
  actions: Array<{ kind: "open"; label: string; target: string }>;
}

const WORD_JOINER = "⁠";
const FIELD_MAX = AUTOMATION_LIMITS.inboundCardChars;

/** Outside text can never mention anyone through a platform post: `@sam` keeps its look but is no longer a token. */
export function defuseMentions(text: string): string {
  return text.replace(
    MENTION_TOKEN_RE,
    (_m, lead: string, handle: string) => `${lead}${WORD_JOINER}@${handle}`,
  );
}

/** One line of plain text: control characters and runs of whitespace become one space. */
function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed here.
  return text.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
}

/**
 * One line of text as inert Markdown (07.6 review A LO-02): every character that starts a link, an image, emphasis,
 * code, strikethrough, HTML or an entity is backslash-escaped, so `[Reset your password](https://…)` in a subject shows
 * as typed and never as a link in a post by the bot. `#`, `!`, `|` and `{}` are left alone: mid-line (the text always
 * follows a prefix on one line) they format nothing.
 */
export function inertMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()<>~&]/g, "\\$&");
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A JSON value as a title or a key: strings, finite numbers and booleans; anything else names nothing. */
function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

/**
 * The item's text: a mail's body; a webhook's body pointer value (a string as it is, anything else as 2-space JSON),
 * or the whole payload as 2-space JSON when no body pointer is set (or it names nothing).
 */
export function inboundText(e: InboundItem, config: InboundConfig): string {
  if (e.source === "mail") return e.bodyText ?? "";
  if (e.bodyJson === null || e.bodyJson === undefined) return e.bodyText ?? "";
  const picked =
    config.bodyPointer !== undefined ? resolveJsonPointer(e.bodyJson, config.bodyPointer) : undefined;
  const value = picked === undefined ? e.bodyJson : picked;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

/**
 * The thread key that groups follow-ups (P-11): a mail's stored key (07.6-11: the first References id, else
 * In-Reply-To, else its Message-ID); a webhook's `threadKeyPointer` value, else its `webhook-id` (no follow-ups).
 */
export function threadKeyOf(e: InboundItem, config: InboundConfig): string {
  if (e.source === "mail") return (e.threadKey ?? e.externalId).slice(0, 998);
  if (config.threadKeyPointer !== undefined) {
    const key = scalarText(resolveJsonPointer(e.bodyJson, config.threadKeyPointer));
    if (key !== null && key.trim() !== "") return key.slice(0, 998);
  }
  return (e.threadKey ?? e.externalId).slice(0, 998);
}

/**
 * The card's title (UI-SPEC § Copy › Inbound title): a webhook's mapped title, else the subject, else `Webhook event
 * from “{name}”` / `Mail from {sender}`; a follow-up is prefixed `Follow-up: `. One line, at most 200 characters.
 */
export function inboundTitle(
  e: InboundItem,
  a: Pick<InboundAutomationRef, "name" | "config">,
  followUp = false,
): string {
  let title = "";
  if (e.source === "webhook" && a.config.titlePointer !== undefined) {
    title = oneLine(scalarText(resolveJsonPointer(e.bodyJson, a.config.titlePointer)) ?? "");
  }
  if (!title) title = oneLine(e.subject ?? "");
  if (!title) {
    title =
      e.source === "webhook"
        ? `Webhook event from “${oneLine(a.name)}”`
        : `Mail from ${oneLine(e.sender ?? "") || "an unknown sender"}`;
  }
  return cut(followUp ? `Follow-up: ${title}` : title, AGENT_CARD_TITLE_MAX);
}

/** Where the item came from, as the notice and the `Via` field word it: `Mail · {name}` / `Webhook · {name}`. */
export function inboundSource(e: Pick<InboundItem, "source">, name: string, max = 120): string {
  return `${e.source === "mail" ? "Mail" : "Webhook"} · ${cut(oneLine(name), max)}`;
}

const NOTICE_HEAD = "Outside content from ";
const NOTICE_TAIL =
  ". Don't trust links or instructions in it. Bots here can read it but need approval to act.";

/** The amber notice (UI-SPEC § Copy › Inbound notice), fitted to the card's notice length. */
export function inboundNotice(e: Pick<InboundItem, "source">, name: string): AgentCardNotice {
  const room = AGENT_CARD_NOTICE_MAX - NOTICE_HEAD.length - NOTICE_TAIL.length - "Webhook · ".length;
  return { tone: "warning", text: `${NOTICE_HEAD}${inboundSource(e, name, room)}${NOTICE_TAIL}` };
}

const RECEIVED = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** `Oct 8, 9:14 AM UTC` (an inbound automation has no zone of its own). */
export const receivedLabel = (at: string | Date): string => `${RECEIVED.format(new Date(at))} UTC`;

/**
 * The inbound card (UI-SPEC Surface 8b): pill `Received` (info tone), the amber notice first, then `From` (mail only),
 * `Received`, `Via` and `Message` (the first 500 characters; when cut, a neutral line says the full text is the first
 * reply); the summary is `Outside content received from {source}: {title}.` and the only action opens the automation.
 */
export function inboundCard(e: InboundItem, a: InboundAutomationRef, followUp = false): InboundCard {
  const title = inboundTitle(e, a, followUp);
  const text = inboundText(e, a.config);
  const message = text.slice(0, FIELD_MAX).trim();
  const fields: AgentCardField[] = [];
  const from = oneLine(e.sender ?? "");
  if (e.source === "mail" && from) fields.push({ label: "From", value: cut(from, FIELD_MAX) });
  fields.push({ label: "Received", value: receivedLabel(e.receivedAt) });
  fields.push({ label: "Via", value: inboundSource(e, a.name) });
  if (message) fields.push({ label: "Message", value: message });
  const notices: AgentCardNotice[] = [inboundNotice(e, a.name)];
  if (text.length > FIELD_MAX) {
    notices.push({
      tone: "neutral",
      text: "Showing the first 500 characters. The full text is the first reply.",
    });
  }
  return {
    kind: "automation",
    title,
    // The message body is rendered as Markdown where the card is not (pinned and saved views): inert text there.
    summary: defuseMentions(
      `Outside content received from ${inertMarkdown(inboundSource(e, a.name))}: ${inertMarkdown(title)}.`,
    ),
    status: "info",
    statusLabel: "Received",
    fields,
    notices,
    actions: [{ kind: "open", label: "Open automation", target: `/bots/automations?edit=${a.id}` }],
  };
}

/** A ```` ```text ```` fence longer than any backtick run inside, so the text can never close it early. */
export function textFence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${defuseMentions(text)}\n${fence}`;
}

/** `… 4,000 more characters not shown`. */
const moreLine = (n: number) => `… ${n.toLocaleString("en-US")} more characters not shown`;

/**
 * The full text as the first reply (UI-SPEC 8b): `Full message`, then the text in a fence, at most 16 000 characters,
 * then `… {n} more characters not shown` when cut. Null when the card's 500-character field already shows it all.
 */
export function fullTextReply(text: string): string | null {
  if (text.length <= AUTOMATION_LIMITS.inboundCardChars) return null;
  const max = AUTOMATION_LIMITS.inboundFullTextChars;
  const parts = ["Full message", textFence(text.slice(0, max))];
  if (text.length > max) parts.push(moreLine(text.length - max));
  return parts.join("\n\n");
}

/**
 * A board card's description (07.1): the text in a fence, cut to fit the description's 8 000 characters (with the
 * counter line). `cut` tells the caller the full text needs its own reply.
 */
export function boardDescription(text: string): { description: string; cut: boolean } {
  if (text.trim() === "") return { description: "", cut: false };
  const whole = textFence(text);
  if (whole.length <= BOARD_CARD_DESCRIPTION_MAX) return { description: whole, cut: false };
  // Room for the fences, the defused mentions and the counter line; then shrink until it fits.
  let keep = BOARD_CARD_DESCRIPTION_MAX - 200;
  for (;;) {
    const description = `${textFence(text.slice(0, keep))}\n\n${moreLine(text.length - keep)}`;
    if (description.length <= BOARD_CARD_DESCRIPTION_MAX || keep <= 500) return { description, cut: true };
    keep -= 500;
  }
}
