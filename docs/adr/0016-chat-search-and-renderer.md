# ADR-0016: Chat search is PostgreSQL full-text over the readable set; one streamdown renderer without raw HTML

## Status

Accepted (owner-delegated decisions D-04 and D-05 in `.planning/phases/04-chat/04-CONTEXT.md`).
**Date:** 2026-10-06. Builds on [ADR-0003](0003-infrastructure-baseline.md) (PostgreSQL is the only database) and
[ADR-0007](0007-roles-hierarchy-and-permission-resolver.md) (the permission resolver decides every read);
supersedes neither.

## Context

Phase 4 completes chat (CHAT-11 search, CHAT-05 Markdown everywhere). Two choices shape every later phase that
shows messages or agent output:

- **Search.** Members search messages, people and channels from a ⌘K palette and a results page. The content is
  mixed Spanish and English, often typed without accents ("migracion" must find "migración"). The stack is
  PostgreSQL only (ADR-0003), and principle 10 rules out a hosted search service. Search is also the easiest place to
  leak a private channel or someone else's DM, because one query spans many conversations.
- **Rendering.** Before Phase 4, chat used react-markdown with highlight.js, and the Work Zone had its own path.
  Agent output streams in token by token, so an unterminated code fence or table must render sensibly while it
  arrives. Every message body is untrusted input (AGENTS.md security rules): raw HTML, `javascript:` links and
  remote images are attack or tracking vectors.

## Decision

### Search

1. **Stock PostgreSQL 18, no extension beyond contrib.** `unaccent` and `pg_trgm` are created in the `app` schema.
2. **Three unaccented text search configurations:** `app.ocw_simple` (copy of `simple`), `app.ocw_es` (Spanish
   stemmer) and `app.ocw_en` (English stemmer), each mapping words through `app.unaccent` first.
3. **One STORED generated column** `messages.search_tsv` = `setweight(simple, 'A') || spanish || english` over the
   body, with a GIN index. It is not in the Drizzle schema; only the search module reads it, with raw SQL.
4. **Queries** use `websearch_to_tsquery` (quotes, `or`, `-word`) under all three configurations, ORed, with bound
   parameters only and a 1–200 character Zod bound. Keyset paging on `(created_at, id)`, at most 50 per page.
5. **People and channels** use word-prefix matching on unaccented names, then `pg_trgm` similarity
   ("enginering" finds #engineering). GIN trigram indexes on member names, conversation names and bot names.
6. **The readable-set rule.** Every search route first resolves `access.readableIds(...)` through the permission
   resolver, then restricts the query with `conversation_id = any($ids)`. A SQL membership join is never the
   authority: the resolver decides private channels, DMs, group DMs, unit-scoped denies and archived channels the
   same way the conversation routes do. An `in` filter outside the readable set returns an empty 200 (no oracle).
   People results are filtered per row by `member.read` / `bot.read`.
7. **Snippets are text.** `ts_headline` marks hits with private-use characters (U+E000/U+E001); user-typed
   copies of those characters are stripped first. The client renders the snippet as text plus `<mark>` only, never
   as HTML or Markdown.
8. **Rate limit:** one shared limiter of 30 searches per minute per user across the four routes
   (`OCW_SEARCH_RATE_LIMIT_PER_MINUTE`; the isolated e2e harness raises it).

### Renderer

1. **One `<Markdown>` component** (`apps/web/components/markdown/markdown.tsx`) renders channel messages, threads,
   DMs and group DMs, bot output and the Work Zone stream. It is the only file that imports the engine.
2. **Engine: streamdown 2.6.0 + @streamdown/code 1.1.1 (shiki)**, the pinned pair that shipped. GFM tables, lists,
   quotes and task lists; code blocks keep streamdown's language label and copy button, github-light/github-dark
   themes; blocks over 20,000 characters are shown unhighlighted (a 10,000-line block renders in about 200 ms).
3. **No raw HTML, ever.** The rehype list is explicit (images turned into links, streamdown's harden plugin with our
   policy, `rehypeMentions`); `rehype-raw` is never added.
4. **Link hardening.** `safeUrl` strips C0 controls and DEL, refuses protocol-relative URLs in any slash or
   backslash spelling, parses with `new URL()` and keeps only http, https, mailto and same-origin references. It runs
   after the engine's default URL transform. Refused links render as text.
5. **Images become links.** Markdown images are never fetched inline (no tracking pixels, no mixed content);
   attachments have their own authorized rendition path (ADR-0015).
6. **Mention chips** come from a `MentionContext` directory; `@channel`/`@here` get a special chip. A handle with no
   directory entry stays plain text.
7. **Streaming mode** for agent output: `mode="streaming"`, incomplete-Markdown parsing and block memoisation, so an
   open fence renders as a code block while the answer arrives.

## Consequences

- **Index size and timing.** Measured in 04-06 end to end over HTTP (readable-set resolution + query + labels) on
  an ephemeral PostgreSQL 18 with 300,000 messages in 1,000 channels, the caller reading 100: a rare term 68 ms cold /
  36 ms warm, "deploy" 41/40 ms, "migracion autenticacion" 36/41 ms, three words 36/34 ms, the palette overview
  (messages + people + channels) 41 ms. The GIN index was 16 MB for a 177 MB table. 04-RESEARCH measured the raw
  query on 1M rows at 10–83 ms.
- **Write cost.** Each insert or edit computes three tsvectors; edits re-index automatically because the column
  is generated.
- **Ranking is basic.** Results are newest first, not BM25. Languages beyond Spanish and English fall back to the
  `simple` configuration (exact words, unaccented).
- **The readable set grows with the member.** `readableIds` is one resolver pass per request; members who read
  tens of thousands of conversations would need a cached readable set.
- **When to revisit:** relevance ranking or fuzzy message search at scale would point to pg_search (ParadeDB, BM25).
  That needs a custom PostgreSQL image, which conflicts with stock compose and managed PostgreSQL, so it would need
  its own ADR. Attachment contents and bot memory are not indexed.
- **Renderer upgrades** move as a pinned pair (streamdown + @streamdown/code); a new major must pass the XSS and
  URL-bypass fixtures in `apps/web/components/markdown/{markdown.test.tsx,safe-url.test.ts}` before it ships.
- Agent output and human messages share one security policy; a future rich-content surface (cards, artifacts)
  extends this component instead of adding a second renderer.
