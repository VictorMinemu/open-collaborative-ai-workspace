---
phase: 04-chat
plan: 06
subsystem: search
status: complete
tags: [search, full-text, tsvector, pg_trgm, permissions, readable-set, palette, rate-limit, e2e]
requirements: [CHAT-11]
dependency_graph:
  requires:
    - "04-01 (search contracts, migration objects search_tsv / messages_search_gin / ocw_* configs / trigram indexes, createConversationAccess)"
    - "04-03 (permalinkPath, highlighted permalink windows)"
  provides:
    - "Search module: createSearchModule; GET /api/v1/search, /search/messages, /search/people, /search/channels (30/min/user shared)"
    - "service.ts: searchMessages, searchPeople, searchChannels, conversationRefs (ConversationRef labels for any list)"
    - "contracts: SearchTextQuery, SearchPeopleResult, SearchChannelsResult"
    - "web: SearchPaletteProvider, SearchPalette, useSearchPalette (⌘K / Ctrl+K, rail + mobile top-bar buttons), Snippet, SearchFilterBar, SearchResults, /search page"
    - "lib/search-queries.ts: useSearchOverview, useSearchMessages (infinite), useSearchPeople, useSearchChannels, useDebounced, recent searches"
  affects: [04-07 (profile card "Message" action; group DM labels already handled by conversationRefs), 04-13 (ADR-0016 from this summary)]
tech-stack:
  added: []
  patterns:
    - "Readable ids from access.readableIds (resolver) → SQL `conversation_id = any(uuid[])`; the route marks the request decided"
    - "One @fastify/rate-limit handler (app.rateLimit) shared by every search route = one per-user budget"
    - "Three ts_headline candidates (simple/es/en), the most-marked wins; short bodies HighlightAll"
key-files:
  created:
    - apps/api/src/modules/search/index.ts
    - apps/api/src/modules/search/service.ts
    - apps/api/src/modules/search/search.int.test.ts
    - apps/web/lib/search-queries.ts
    - apps/web/components/search/search-palette.tsx
    - apps/web/components/search/snippet.tsx
    - apps/web/components/search/search-results.tsx
    - apps/web/components/search/search-filters.tsx
    - apps/web/app/(app)/search/page.tsx
    - e2e/tests/search.spec.ts
  modified:
    - packages/contracts/src/search.ts
    - apps/api/src/app.ts
    - apps/api/src/config/env.ts
    - apps/web/components/shell/{app-shell,app-rail,mobile-nav}.tsx
    - scripts/e2e-isolated.sh
decisions:
  - "Search budget is OCW_SEARCH_RATE_LIMIT_PER_MINUTE (default 30, P-11) shared across all four routes; the isolated e2e harness raises it to 600"
  - "after/before are inclusive UTC days (after = day start, before = next day start, exclusive)"
  - "People visibility is the resolver's: members need member.read (the /members permission), bots bot.read per bot (as GET /agents); SQL only narrows to active members and team-or-own bots"
  - "Messages under 200 characters are returned whole with every match marked; longer ones as one 18-word fragment; snippet ≤ 400 chars"
  - "Private-use markers typed by users are stripped before ts_headline, so only the server can mark text"
  - "No new migration: the 04-01 search DDL was sufficient"
metrics:
  duration: "~95 min"
  completed: 2026-10-06
  tasks: 2
  files: 25
estimate:
  tokens: 160000
actuals:
  tokens: 30900
  tasks: 2
  commits: 3
---

# Phase 4 Plan 06: Permission-aware full-text search (messages, people, channels), ⌘K palette and results page Summary

⌘K (or the rail / top-bar button) → type "migracion" → the accented message appears with `<mark>` around "migración" → Enter (or tap) lands on it highlighted through its permalink; everything is computed on stock PostgreSQL over the resolver's readable set, so a non-member admin, another user's bot DM and org B never contribute a hit.

## What was built

- **API (`modules/search`)**: every route runs `access.readableIds(tx, me, { includeArchived: true })` inside `withTenant` before any query and then marks the request decided (the resolver decided every id). `searchMessages` is one statement: OR of `websearch_to_tsquery` over `app.ocw_simple|ocw_es|ocw_en`, `conversation_id = any($ids::uuid[])`, `deleted_at is null`, optional `in`/`from`/`after`/`before`, keyset `(created_at, id) <` an opaque base64url cursor (exact `created_at::text`, so equal timestamps page without duplicates), `limit + 1`; headlines are computed after the limit. An `in` outside the readable set returns `{hits: [], nextCursor: null}` (no oracle). `conversationRefs` labels "#name", the bot/person for DMs, "A, B and C" for groups. `searchPeople`: active `org_members` + non-deleted bots (team or owned by the caller), word prefix on the unaccented name/email local part/username, else `app.similarity` / `app.word_similarity`; the resolver filter runs before the limit. `searchChannels`: readable channels only, unaccented substring on name or topic or trigram similarity ("enginering" → #engineering), live before archived, `isMember`, `memberCount`.
- **Web**: `SearchPalette` (Base UI dialog: top-centred at md+, full-screen sheet at 390, combobox + listbox with arrow keys and Enter, recent searches (5, localStorage), Messages/People/Channels sections, a member card, bots open their DM, "See all results"); ⌘K/Ctrl+K toggles from anywhere (`SearchHotkey` in AppShell); `Snippet` renders `splitSnippet` runs as text and `<mark>`; `/search` page with the query and filters in the URL (`In` and `From` pickers, `Date` presets and custom range), hits grouped by conversation, "Load more" on the cursor, empty/error states (429 has its own message).

## Verification

| Check | Result |
| --- | --- |
| `vitest --project integration search.int.test.ts` | 23/23 (RED first in both tasks: import failure, then 7 people/channels failures) |
| `pnpm verify` (task 1 / task 2) | 124 files, 1695 tests / 124 files, 1709 tests, exit 0 |
| `bash scripts/e2e-isolated.sh search permalinks` (final) | 15 passed (search 3×2, permalinks 4×2, setup), none flaky or skipped |
| Acceptance greps | websearch_to_tsquery, readableIds ×9, createSearchModule in app.ts, 2× open-search, searchPeople + searchChannels, page.tsx, `429` asserted |

**Latency (for ADR-0016)**, measured end to end over HTTP (readable-set resolution + query + labels) on an ephemeral PostgreSQL 18 with 300,000 seeded messages in 1,000 channels (the caller reads 100): rare term 68 ms cold / 36 ms warm; "deploy" 41 / 40 ms; "migracion autenticacion" (unaccented, stemmed) 36 / 41 ms; "useEffect" 39 / 47 ms; three words 36 / 34 ms; overview (messages + people + channels) 41 ms. GIN index 16 MB for a 177 MB table. Seeding took 9.3 s. 04-RESEARCH measured the raw query on 1M rows at 10–83 ms.

Screenshots reviewed (Read tool): `search-palette-{1440,390}[-dark]` (palette top-centred, full-screen sheet at 390, marks legible in dark), `search-results-{1440,390}[-dark]` (filter chips wrap at 390, stemmed "deployed" marked, grouped card).

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 3 - Blocking] `OCW_SEARCH_RATE_LIMIT_PER_MINUTE` env (default 30) + harness override 600** (env.ts and e2e-isolated.sh are not in the plan's file list). The e2e specs search many times a minute as one user and would hit 429. Production keeps 30/min/user. The integration test proves the default (31st → 429). Commit bbf038c.
2. **[Rule 2] One shared rate-limit handler instead of per-route `config.rateLimit`**: @fastify/rate-limit gives each route its own store, which would be 4×30/min. `app.rateLimit()` is created once and sits after `requireUser` on all four routes, so the key is the user.
3. **[Rule 3] `markDecided(req)` in the search module**: `readableIds` uses the request-less `filterFor`, so the strict authz coverage hook would 500 every search. Each id is still a resolver decision. (`access.ts` is unchanged, so this does not conflict with 04-05.)
4. **[Rule 2] People use the resolver per row** (`member.read` for members, `bot.read` per bot like GET /agents) on top of the SQL narrowing the plan describes.
5. **[Interface] `searchMessages` takes `viewerId`** (DM labels exclude the viewer). `searchPeople` takes an optional `visible` filter. `conversationRefs` is exported, so other lists can label DMs and groups the same way.
6. **[Rule 1] Snippet quality**: a stemmed match is only marked under its own config, and fragment mode dropped words. The fix computes three headlines and keeps the one with the most marks, shows short bodies whole, and strips user-typed U+E000/U+E001 before the headline runs. These rules are covered by int tests.
7. **[Contracts] Added `SearchTextQuery`, `SearchPeopleResult`, `SearchChannelsResult`.** `pnpm typecheck` was run through `pnpm verify`.
8. **[UI] `SearchPaletteProvider`** sits next to `SearchPalette`/`useSearchPalette` (the context the interface implies). Pickers are dialogs, not menus (they need a filter input, which suits 390). The member card has no "Message" action yet; Plan 07 adds it.
9. **[Process]** Task 2's filters, paging and 429 int cases passed on their first run, because Task 1's API already handles them. Only the people and channels cases were RED. The e2e specs were written with the UI, not run RED first.

### CLAUDE.md
- This work did not need plan mode: there is no migration and no change to permissions, policies, RLS or `access.ts`. Search only consumes the resolver.
- The branch `wt/04-06` is outside the executor's agent-branch allow-list. I committed there because the orchestrator said to.

## Known Stubs

None. Profile card without a "Message" button is by plan (Plan 07).

## Known limitations / open issues

- Date presets use the browser's local day, while the server bounds are UTC days, so results can shift by a few hours around midnight for non-UTC users.
- The rate-limit store is in-memory per API process, the same as the presign limit. With several API replicas the budget is per replica.
- People search still returns the email local part as a match source and as the subtitle. This matches the existing mention picker, which already shows emails to members.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file apps/api/src/config/env.ts --description "OCW_SEARCH_RATE_LIMIT_PER_MINUTE (default 30) added; e2e-isolated.sh raises it to 600 for specs"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/search/index.ts --description "Search routes call markDecided after access.readableIds (request-less filterFor) and share one app.rateLimit handler"
```

## Threat model coverage

T-04-06-01: hits come only from `access.readableIds`. Int tests cover a non-member admin and the private channel, Sam's bot DM, org B text, and service calls in org B's tenant with org A's ids (RLS returns nothing). T-04-06-02: an unreadable or unknown `in` returns an empty 200 (int test with 4 ids). T-04-06-03: `websearch_to_tsquery` with only bound parameters, Zod 1–200, and 9 syntax edge cases all return 200. T-04-06-04: `Snippet` renders text plus `<mark>` only, and server-side marker stripping is tested. The e2e asserts there is no element in a hit besides `<mark>`. T-04-06-05: 30/min/user across routes (429 test), GIN, `limit ≤ 50`, 250 ms debounce. T-04-06-06: deactivated members and others' personal bots are excluded (int tests). No new surface beyond the plan.

## Commits

- bbf038c feat(api): permission-aware full-text message search with a ⌘K palette that jumps to the hit (04-06 task 1)
- d3ca99b feat(web): search people and channels, results page with In/From/Date filters and paging (04-06 task 2)

## Self-Check: PASSED

All created files exist. Commits bbf038c and d3ca99b are on wt/04-06. The temporary latency probe and the `.env` symlink are removed. The permalink screenshots touched by the e2e run were restored to HEAD.
