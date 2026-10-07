import { z } from "zod";
import { AiChatSummary } from "./ai-chat";
import { ConversationRef, MessageAuthor, Visibility } from "./chat";
import { Id, IsoDateTime, MemberKind } from "./common";

/**
 * Full-text search (CHAT-11, D-04): PostgreSQL tsvector over messages and trigram matching for people and
 * channels, always restricted to the conversations the resolver lets the caller read (P-03).
 */

/**
 * Snippet highlight markers: private-use code points U+E000 / U+E001 (never valid user text in practice). The
 * API returns plain text with these around matches; clients render marked runs as `<mark>`, never as HTML.
 */
export const SNIPPET_MARK_START = "";
export const SNIPPET_MARK_END = "";

/** Splits a snippet into plain and marked runs (unbalanced markers are dropped). */
export function splitSnippet(s: string): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = [];
  let mark = false;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, mark });
    buf = "";
  };
  for (const ch of s) {
    if (ch === SNIPPET_MARK_START) {
      flush();
      mark = true;
    } else if (ch === SNIPPET_MARK_END) {
      flush();
      mark = false;
    } else buf += ch;
  }
  flush();
  return out;
}

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  /** Only this conversation. */
  in: Id.optional(),
  /** Only messages by this user or bot. */
  from: Id.optional(),
  after: z.iso.date().optional(),
  before: z.iso.date().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchMessageHit = z.object({
  messageId: Id,
  conversation: ConversationRef,
  threadRootId: Id.nullable(),
  seq: z.number().int().nonnegative(),
  author: MessageAuthor,
  createdAt: IsoDateTime,
  /** Plain text with SNIPPET_MARK_START / SNIPPET_MARK_END around matches. */
  snippet: z.string().max(400),
});
export type SearchMessageHit = z.infer<typeof SearchMessageHit>;

export const SearchMessagesResult = z.object({
  hits: z.array(SearchMessageHit),
  nextCursor: z.string().nullable(),
});
export type SearchMessagesResult = z.infer<typeof SearchMessagesResult>;

export const SearchPerson = z.object({
  kind: MemberKind,
  id: Id,
  displayName: z.string(),
  handle: z.string(),
  avatarUrl: z.string().nullable(),
  subtitle: z.string().nullable(),
});
export type SearchPerson = z.infer<typeof SearchPerson>;

export const SearchChannel = z.object({
  id: Id,
  name: z.string(),
  topic: z.string().nullable(),
  visibility: Visibility,
  isMember: z.boolean(),
  archived: z.boolean(),
  memberCount: z.number().int().nonnegative(),
});
export type SearchChannel = z.infer<typeof SearchChannel>;

export const SearchOverview = z.object({
  messages: z.array(SearchMessageHit).max(8),
  people: z.array(SearchPerson).max(8),
  channels: z.array(SearchChannel).max(8),
  /** The caller's own AI chats whose title matches (05-10, AICHAT-04): owner only, archived ones flagged. */
  aiChats: z.array(AiChatSummary).max(8).optional(),
});
export type SearchOverview = z.infer<typeof SearchOverview>;

/** `?q=` of the overview, people and channels routes. */
export const SearchTextQuery = z.object({ q: SearchQuery.shape.q });
export type SearchTextQuery = z.infer<typeof SearchTextQuery>;

export const SearchPeopleResult = z.object({ people: z.array(SearchPerson) });
export type SearchPeopleResult = z.infer<typeof SearchPeopleResult>;

export const SearchChannelsResult = z.object({ channels: z.array(SearchChannel) });
export type SearchChannelsResult = z.infer<typeof SearchChannelsResult>;
