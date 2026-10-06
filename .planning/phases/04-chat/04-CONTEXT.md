# Phase 4: Chat - Context

**Gathered:** 2026-10-06 (owner delegated decisions; research recommendations adopted)
**Status:** Ready for planning

<domain>
## Phase Boundary

Daily team conversation in the workspace: grouped sidebar with views, human/mixed DMs and group DMs, one shared
Markdown renderer, edit/delete with audit history, reactions, @channel/@here, notifications with preferences,
pins, saves, permalinks, full-text search, file and image attachments on self-hosted S3-compatible storage.
Out of scope: closed-tab Web Push and mobile push (MVP 7), compliance export / DM moderation, antivirus scanning.

</domain>

<decisions>
## Implementation Decisions

- **D-01 (admin moderation vs DM privacy):** admins delete any message **only in conversations they can read**; DMs and group DMs have no admin moderation path in Phase 4 (consistent with Phase 3.1 DM privacy: non-participant admins get 404).
- **D-02 (notifications):** notify only while the web app or desktop app is running (in-app + Web Notifications API / Electron). Closed-tab Web Push is deferred (optional, off by default, next to mobile push) because it routes through browser vendors' push services (principle 10).
- **D-03 (object storage):** Garage v2.x (AGPL, single-node) as the S3-compatible store in the compose stack; ADR-0015 supersedes ADR-0003's MinIO clause. Browser uploads via presigned PUT with signed Content-Type, server-side content sniffing, sharp thumbnails, 25 MiB per file, tenant-scoped object keys, audit; credentials via SecretReference. AWS SDK `requestChecksumCalculation: "WHEN_REQUIRED"`.
- **D-04 (search):** PostgreSQL 18 only — generated tsvector (simple + spanish + english, unaccented) + GIN; pg_trgm for people/channels; results filtered to conversations the resolver allows (never a hand-rolled SQL filter). ADR-0016.
- **D-05 (renderer):** one shared Markdown renderer for chat, AI chats, agent output and Work Zone (streamdown, no raw HTML, shiki highlighting, mention chips); if the latest streamdown doesn't fit its code plugin, pin a compatible pair.
- **D-06 (DMs):** extend the 3.1 `dm_key` model to sorted participant ids, fixed membership, max 9 participants; personal bots cannot join group DMs; bot memory off when ≥ 2 humans.
- **D-07 (unread):** count messages (not raw stream seq) for unread/mention badges; add mark-as-unread.
- **D-08 (visual):** Slack/T3 Code quality, responsive, verified at 1440 and 390 in light and dark; reuse the Work Zone layout language from Phase 3.2.

### Claude's Discretion
Plan/wave split (research suggests 13 plans / 4 waves, tracer-first), exact table shapes, view contents.

</decisions>

<canonical_refs>
- `.planning/phases/04-chat/04-RESEARCH.md` (incl. Validation Architecture and Security Domain)
- `.planning/ROADMAP.md` Phase 4, `.planning/REQUIREMENTS.md` CHAT-02, CHAT-04..CHAT-14
- `docs/adr/0003-infrastructure-baseline.md` (to be superseded for object storage), ADR-0007/0008/0009/0010
- Phase 3.1 DM model (summaries 03.1-01/02), Phase 3 realtime (presence, seq, read markers), 03.2-11 realtime-client resync fix
- `AGENTS.md`, `CLAUDE.md`

</canonical_refs>

<deferred>
- Closed-tab Web Push / mobile push (MVP 7)
- Admin moderation of DMs / compliance export
- Antivirus scanning of uploads (ClamAV needs 3–4 GiB RAM)

</deferred>

---
*Phase: 04-chat · Context gathered: 2026-10-06*
