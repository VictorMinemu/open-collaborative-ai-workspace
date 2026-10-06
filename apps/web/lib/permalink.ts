import { Id } from "@ocw/contracts";

/**
 * Message permalinks (CHAT-13/14). Ids only, never names or slugs (P-06): a link survives renames and says
 * nothing about the conversation to someone who cannot open it.
 *   channel message → /chat/<convId>?m=<id>
 *   thread reply    → /chat/<convId>?thread=<rootId>&m=<id>
 *   DM / group DM   → /chat/dm/<convId>?m=<id>
 */
export function permalinkPath(
  conv: { id: string; kind: "channel" | "dm" | "group" },
  messageId: string,
  threadRootId?: string | null,
): string {
  const c = encodeURIComponent(conv.id);
  const m = encodeURIComponent(messageId);
  if (conv.kind !== "channel") return `/chat/dm/${c}?m=${m}`;
  if (threadRootId) return `/chat/${c}?thread=${encodeURIComponent(threadRootId)}&m=${m}`;
  return `/chat/${c}?m=${m}`;
}

/**
 * Reads `m` and `thread` from a chat URL. Values that are not ids are kept as given (the API answers 400/404 and
 * the view shows "This message isn't available"), so a mangled link never silently opens somewhere else.
 */
export function parsePermalink(search: Pick<URLSearchParams, "get">): {
  messageId: string | null;
  threadRootId: string | null;
} {
  const m = search.get("m")?.trim() || null;
  const thread = search.get("thread")?.trim() || null;
  return { messageId: m, threadRootId: thread };
}

/** True when `value` is a well-formed id (the only thing a permalink may carry). */
export const isPermalinkId = (value: string | null | undefined): value is string =>
  !!value && Id.safeParse(value).success;
