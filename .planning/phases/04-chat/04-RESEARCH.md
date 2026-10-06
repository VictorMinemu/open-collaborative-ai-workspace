# Phase 4: Chat - Research

**Researched:** 2026-10-05
**Domain:** Slack-model team chat on the Phase 1 conversation model (DMs, notifications, search, attachments, edit/delete, reactions, pins, permalinks, shared Markdown renderer) plus S3-compatible object storage in the compose stack
**Confidence:** MEDIUM-HIGH. The object storage and PostgreSQL search recommendations were probed live on the real targets this session (Garage v2.4.1 and postgres:18.6 containers, both removed afterwards). The renderer and notification items rest on docs and code reading.

<user_constraints>
## User Constraints

No `04-CONTEXT.md` exists, because discuss-phase has not run. The binding constraints come from the orchestrator prompt, AGENTS.md (the 12 principles) and ROADMAP Phase 4:

- **Scope:** CHAT-02, CHAT-04 to CHAT-14 (Phase 4 success criteria 1 to 5, ROADMAP lines 234-250).
- **Shared renderer:** one Markdown renderer for chat, AI chats, agent output and the Work Zone.
- **DM reuse:** the 3.1 DM model (`dm_key`, personal-bot DMs, reply mode, memory) is reused for human DMs and group DMs.
- **DM privacy:** only participants can read a DM, admins included.
- **Object storage:** open source, self-hostable, no paid services. MinIO was dropped from Phase 1.
- **Search:** PostgreSQL only (ADR-0003). No extra infrastructure.
- **UI quality:** design-conscious, T3 Code / Slack-like quality, verified at 1440 and 390, light and dark.
- **Out of bounds for research and plans:** the demo (ports 4000/3000, `ocw-demo-*`, the `ocw` DB), the docker compose lifecycle and the OpenClaw containers.
- **Owner profile:** full autonomy. Only genuinely owner-level decisions go back to Víctor (see Open Questions).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Status today (REQUIREMENTS.md:360-372) | Description | Research support |
|----|------|-------------|------------------|
| CHAT-02 | Partial: flat list + unread dot | Sidebar groups channels by department/team; All / Mentions / Threads / AI Chats views | §5: `conversations.unit_id` with a unit path on the channel resource; views are defined |
| CHAT-04 | Pending | DMs and group DMs (human↔human, human↔agent, mixed) | §7: extends `dm_key`; `kind='group'` already exists in the enum |
| CHAT-05 | Partial: two renderers | One shared Markdown renderer (subset, highlighted code) | §6: streamdown (no raw HTML), harden, mention plugin, shiki |
| CHAT-06 | Pending | Edit and delete; edited marker; prior versions kept for audit; admins delete any | §4: `message_versions` (append-only), tombstone delete |
| CHAT-07 | Pending | Emoji reactions on messages, thread replies and AI messages | §4: `message_reactions` and the `reaction.updated` event |
| CHAT-08 | Partial: people + bots; no @channel/@here or notifications | @channel/@here with autocomplete; mentions notify and trigger agents | §3: reserved handles, an org online set for @here, the `notifications` table |
| CHAT-09 | Partial: unread dot only | Unread and mention badges, mark read/unread | §3: count **messages**, not `last_seq - last_read_seq` (see Pitfall 1) |
| CHAT-10 | Pending | Mute, DND, mention-only, desktop/web toggle; the inbox honours them | §3: prefs tables; server decides `popup`; Notification API (web and Electron) |
| CHAT-11 | Pending | Full-text search for messages, people and channels, with filters | §2: tsvector (unaccent es/en/simple) + GIN; pg_trgm for people and channels; resolver-derived readable set |
| CHAT-12 | Pending | Attachments by drag-and-drop or paste, with preview and download, through the upload pipeline on S3 | §1: Garage, presigned PUT/GET, sniffing, sharp thumbnails, audit |
| CHAT-13 | Pending | Pins, personal saves, permalinks | §4: tables plus URL scheme |
| CHAT-14 | Partial: cursor pagination | Jump to permalink | §4: an `around` cursor and a detached list mode |
</phase_requirements>

## Summary

Phase 4 is mostly conventional Slack-model chat on top of a model that already supports it. `app.conversations.kind` already includes `dm`, `group`, `ai_chat` and `thread`. Messages carry a per-stream `seq`. `conversation_members.last_read_seq` exists. `message.updated` is already a reserved event type. The resolver already treats DMs as fixed-membership private conversations. The real work is twelve vertical slices that share one schema migration. The two genuinely new infrastructure choices are object storage and full-text search, and both were proven on the real targets this session.

**Object storage.** MinIO's community edition is gone as a compose default. The GitHub repo `minio/minio` is archived and `hub.docker.com/v2/repositories/minio/minio/` returns 404 (both checked this session). The recommendation is **Garage v2.4.1** (AGPL-3.0, Rust, single binary). Since v2.3 its `server --single-node --default-bucket` mode bootstraps the layout, key and bucket from three env vars, so no init container is needed. On a live probe it:
- accepted presigned PUT and GET;
- enforced the signed `Content-Type` and `Content-Length` (403 on tampering);
- served CORS preflight;
- accepted lifecycle expiration rules;
- idled at **3.5 MiB RSS**.

One sharp edge was found: AWS SDK v3 presigned PUTs fail with `InvalidDigest` unless the client sets `requestChecksumCalculation: "WHEN_REQUIRED"`.

**Search.** Stay on stock PostgreSQL 18:
- one STORED generated `tsvector` built from three custom text-search configurations (`simple`, `spanish` and `english`, each with `unaccent`);
- a GIN index;
- `websearch_to_tsquery` OR-ed across the three configs;
- `pg_trgm` for people and channel names.

The probe ran 1M bilingual messages with 10% of conversations readable. A rare term took 10 ms, common terms 21-83 ms and accent-insensitive Spanish stemming worked. `pg_search` (ParadeDB), `rum`, `pgroonga` and `pgvector` are **not in the stock image** (verified from `pg_available_extension_versions`).

**Primary recommendation:** Build the phase as the following slices, in order:
1. One schema/contracts foundation, with all new tables in one migration.
2. In parallel with it, the shared renderer and the Garage storage library.
3. Vertical slices: edit/delete is the tracer, then reactions/pins/saves, DMs/group DMs, sidebar/views and permalinks.
4. Notifications, preferences, attachments and search on top.
5. A gate plan with e2e specs and 1440/390 light/dark screenshots.

Every read path goes through the existing resolver (`perms.filter` / `assertCan(..., "channel.read")`), and search is restricted to the resolver-derived readable conversation ids.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Message edit/delete, versions, reactions, pins, saves | API (`chat` module) | DB (append-only `message_versions`) | Authorization, audit and realtime fan-out must be server-side (principles 6 and 12) |
| DMs / group DMs (create, list, fixed membership) | API | DB (`dm_key` unique) | Membership is the read ACL; the resolver precondition `dm` already blocks add/remove/archive |
| Unread/mention counts | API (snapshot) | Browser (live increments from `conv:` events) | The snapshot is authoritative; the client only applies deltas and resyncs |
| Notification creation and preference evaluation | API (in the message transaction) | Redis (org online set for @here) | One decision for every client (web, desktop, later mobile push) |
| Showing OS notifications | Browser (Web Notifications API; Electron renderer uses the same API) | Electron main (dock badge via preload IPC) | Electron already allows the `notifications` permission for the web origin |
| Search (messages, people, channels) | API + DB (FTS/GIN, pg_trgm) | — | The readable set comes from the resolver; the DB executes |
| Attachment upload | Browser → object storage (presigned PUT) | API (presign, verify, sniff, thumbnail, audit) | Large bodies stay off the API; the API stays the authority |
| Attachment download/preview | API (authorize + audit + 302 to short-lived presigned GET) | Object storage | ACL = `channel.read` on the owning conversation, decided per request |
| Markdown rendering | Browser (one component in `apps/web`) | — | Desktop loads the web origin (`win.loadURL`), so one web component covers both |
| Sidebar grouping by unit | API (`unit_id` + unit path in the list DTO) | Browser (grouping and collapse state) | Units already live in `org_units`; grouping is presentation |
| Permalink resolution | API (`around` page + thread lookup) | Browser (detached list mode, highlight) | Cursor math must match the server's seq ordering |

## Standard Stack

### Core (already in the repo, verified in package.json this session)
| Library | Version | Purpose | Note |
|---------|---------|---------|------|
| fastify / drizzle-orm / zod | 5.12.5 / 1.0.0-rc.4 / 4.6.5 | API, DB, contracts | [VERIFIED: apps/api/package.json] |
| react-markdown / remark-gfm / rehype-highlight | 10.1.0 / 4.0.1 / 7.0.2 | Current chat + Work Zone renderers (two copies) | [VERIFIED: apps/web/package.json]. To be replaced by one component |
| sharp | 0.35.4 (already in pnpm-lock via Next) | Thumbnails, EXIF stripping | [VERIFIED: pnpm-lock.yaml:4309; `allowBuilds: sharp: true` in pnpm-workspace.yaml] |

### New (respect `minimumReleaseAge: 10080`, i.e. 7 days; pins below are the newest versions ≥ 7 days old on 2026-10-05)
| Library | Pin | Purpose | Why |
|---------|-----|---------|-----|
| `@aws-sdk/client-s3` | 3.1141.0 | S3 client (server) | Works unchanged against Garage, SeaweedFS, S3 and R2 [VERIFIED: probe against Garage with 3.1146.0; same major API] |
| `@aws-sdk/s3-request-presigner` | 3.1141.0 | Presigned PUT/GET | Signed `content-type` via `signableHeaders` [VERIFIED: probe] |
| `file-type` | 22.1.1 | Magic-byte sniffing of the first 4100 bytes | Never trust the browser's declared MIME [ASSUMED: package choice from training; registry exists] |
| `streamdown` | 2.6.0 (2.7.0 becomes installable on 2026-10-07) | Shared streaming-safe Markdown renderer | STACK.md already chose it; it handles unterminated fences while tokens stream [CITED: streamdown.ai/llms.txt] |
| `@streamdown/code` | 1.1.1 (2.0.0 eligible 2026-10-07, pairs with 2.7.0) | Shiki highlighting plugin | Required for code highlighting in streamdown [CITED: streamdown.ai/llms.txt]. Pairing 2.6.0 + 1.1.1 needs a Wave 0 check |
| `frimousse` | 0.4.0 | Emoji picker (unstyled, small, shadcn-compatible) | [ASSUMED] Alternative `emoji-mart` 5.6.0 has had no release since 2024 |

**Not added:** `pg-boss` (STACK.md lists it for notifications and scans, but Phase 4 does not need a queue: notifications are written in the message transaction, thumbnails run in the `complete` request, and the sweeper is a `setInterval` guarded by `pg_try_advisory_lock`); `minio` client; `react-virtuoso` (the list is not virtualized today; not needed at Phase 4 volumes).

### Alternatives Considered
| Instead of | Could use | Trade-off |
|------------|-----------|-----------|
| Garage | SeaweedFS 4.48 (Apache-2.0, active weekly releases) | More features (versioning, IAM), but a heavier multi-component process model and a ~197 MB image tag (`dev`) vs ~27 MB for Garage. Pick it only if versioning or object lock become requirements |
| Garage | RustFS 1.0.1 (Apache-2.0) | MinIO-like feature set, but it went 1.0 days ago and had CVE-2025-68926 (CVSS 9.8, hardcoded gRPC token, fixed in 1.0.0-alpha.78). Too young for a default |
| Garage | Pigsty "Silo" MinIO fork | Keeps the MinIO console, but depends on one small maintainer after upstream archived |
| Presigned direct PUT | API-proxied streaming upload | One origin and no public storage URL, but all bytes cross the API, and Phase 12 (ART-01) needs presigned uploads from the daemon anyway |
| streamdown | Keep react-markdown + add `remend` (1.3.1) for streaming | Zero new renderer dependency, but it duplicates what streamdown packages (remend + harden + shiki + block memoisation) |

**Installation (pins honour the 7-day rule):**
```bash
pnpm --filter @ocw/api add @aws-sdk/client-s3@3.1141.0 @aws-sdk/s3-request-presigner@3.1141.0 file-type@22.1.1 sharp@0.35.4
pnpm --filter @ocw/web add streamdown@2.6.0 @streamdown/code@1.1.1 frimousse@0.4.0
pnpm --filter @ocw/web remove react-markdown rehype-highlight   # only after the shared renderer lands
```

## Package Legitimacy Audit

Seam: `gsd-tools query package-legitimacy check --ecosystem npm …`, run 2026-10-05. `npm view <pkg> scripts.postinstall` is empty for every row.

| Package | Registry | Age | Downloads/wk | Source repo | Verdict | Disposition |
|---------|----------|-----|--------------|-------------|---------|-------------|
| @aws-sdk/client-s3 | npm | ~6 yrs | 58.2M | github.com/aws/aws-sdk-js-v3 | SUS (too-new latest release) | Approved at pin 3.1141.0 (≥7 days); flag is about the 3.1146.0 release |
| @aws-sdk/s3-request-presigner | npm | ~6 yrs | 28.1M | same | SUS (too-new latest) | Approved at pin 3.1141.0 |
| file-type | npm | ~10 yrs | 69.4M | github.com/sindresorhus/file-type | SUS (too-new latest) | Approved at 22.1.1 |
| sharp | npm | ~10 yrs | 133.7M | github.com/lovell/sharp | SUS (too-new latest) | Reuse lockfile 0.35.4 (already installed) |
| streamdown | npm | ~1 yr | 8.1M | github.com/vercel/streamdown | SUS (too-new latest) | Flagged: pin 2.6.0; planner adds `checkpoint:human-verify` before install |
| @streamdown/code | npm | <1 yr | 2.6M | same | SUS (too-new latest) | Flagged: pin 1.1.1; same checkpoint |
| frimousse | npm | ~1 yr | 1.3M | github.com/liveblocks/frimousse [ASSUMED repo] | SUS (too-new latest) | Flagged: pin 0.4.0; same checkpoint |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** all, for the single reason `too-new` (the latest release is under 7 days old). Every pin above is ≥ 7 days old, and `pnpm-workspace.yaml` `minimumReleaseAge: 10080` enforces that at install time. The checkpoint can be one combined human-verify before the first install.

## Architecture Patterns

### System Architecture Diagram

```
 Browser / Electron renderer (same web origin)
   │ REST (cookie)                         │ WS /ws (one socket)                 │ presigned PUT/GET
   ▼                                       ▼                                     ▼
 Fastify API ── chat module ───────────► realtime.appendEvent(tx) ──after commit──► Redis pub/sub ─► subscribers
   │   │  post/edit/delete/react/pin       (conv:<id>  message.* reaction.* pin.*)         ▲
   │   │  ├─ resolver (channel.read/post, message.*)  (user:<id> notification.created,   │
   │   │  ├─ mentions → recipients ─► notifications rows + prefs eval ─┘ conversation.read)
   │   │  └─ bots: emitAgentMention (unchanged bridge, extended to group DMs)
   │   ├─ search: resolver → readable conv ids → FTS(GIN) ∩ ids → ts_headline top-N
   │   ├─ attachments: presign(PUT) → [browser uploads] → complete: HEAD + sniff + sha256 + sharp thumb → ready
   │   │                download: resolver → audit → 302 presigned GET (60 s, attachment disposition)
   │   └─ dms: ensureDm / ensureGroup (dm_key insert-or-get) → user:<id> list change
   ▼
 PostgreSQL 18 (RLS tenant_isolation on every org table; app role)      Garage (S3 API :3900, private bucket)
   conversations(+unit_id) messages(+deleted_at, search_tsv) message_versions(append-only)
   message_reactions message_pins message_saves notifications notification_prefs attachments thread_reads
```

### Recommended Project Structure (additions only)
```
packages/contracts/src/
  chat.ts                # + EditMessageRequest, Reaction*, Pin*, Save*, Dm/Group requests, AroundQuery, unread fields
  notifications.ts       # Notification, NotificationPrefs, ConversationNotifyLevel, events
  search.ts              # SearchRequest (structured filters), SearchResult
  attachments.ts         # PresignUploadRequest/Response, Attachment, limits
apps/api/src/modules/chat/
  messages-edit.ts  reactions.ts  pins.ts  dm.ts (extend)  unread.ts  permalink.ts
apps/api/src/modules/notification/   # new PRD module: index.ts (public), service.ts, prefs.ts, online.ts
apps/api/src/modules/search/         # new module (or chat/search.ts if kept small)
apps/api/src/modules/artifact/       # new PRD module "Artifact": storage.ts (S3), attachments.ts, sweeper.ts
apps/web/components/markdown/markdown.tsx      # THE shared renderer (chat + DM + thread + Work Zone + later AI chat)
apps/web/components/chat/  sidebar-*.tsx, message-actions.tsx, reactions.tsx, attachments/*.tsx, search/*.tsx, inbox.tsx
infra/garage/garage.toml   # rpc/admin secrets via GARAGE_*_FILE env, not inline
docs/adr/0015-object-storage-garage.md  (supersedes ADR-0003's "MinIO in self-hosted compose" clause)
docs/adr/0016-chat-search-and-renderer.md (FTS configs, readable-set rule, streamdown without raw HTML)
```

### Pattern 1: The readable set comes from the resolver (search, unread, inbox, Mentions/Threads views)
**What:** Never encode "who can read what" again in SQL. Compute the caller's readable conversation ids with the same calls the sidebar uses:
1. `listChannels(tx, userId)` then `perms.filter(..., "channel.read", channelResource)`;
2. plus `listDms` / `listGroups`, filtered the same way;
3. then pass `conversation_id = any($ids)` to the search, count or notification query.

**Why:** RLS isolates tenants only. Per-conversation privacy (private channels, DMs, admins included) is a resolver precondition [VERIFIED: apps/api/src/modules/organization/permissions/policy.ts:70-79, quoted: `if (p.kind === "agent") return notMember(p);` / `return r.state.has("private") ? { layer: "resource", reason: "private_channel" } : null;`]. A hand-written SQL membership filter would become a second authority and drift from deny rules.

### Pattern 2: Everything durable goes through `appendEvent` in the domain transaction
**What:** Edits, deletes, reactions, pins and read-marker moves append to `conv:<id>`; notifications and `conversation.read` append to `user:<recipientId>`. All publish after commit, and all replay by seq on reconnect (`REPLAY_LIMIT = 500` [VERIFIED: packages/contracts/src/realtime.ts:127]). `message.updated` is already reserved [VERIFIED: packages/contracts/src/realtime.ts EventTypes, quoted `messageUpdated: "message.updated"`]. New types are only **added** (`message.deleted`, `reaction.updated`, `pin.updated`, `notification.created`, `notification.read`, `conversation.read`).

### Pattern 3: DM keys are ids only (principle 11) and insert-or-get is race-safe
Today `dmKey(agentId, userId)` returns `` `agent:${agentId}|user:${userId}` `` [VERIFIED: apps/api/src/modules/chat/dm.ts:14-16]. The unique index is `(organization_id, dm_key) WHERE kind = 'dm'` [VERIFIED: packages/db/src/schema/app.ts:223]. Extend it to:
- **human pair (`kind='dm'`):** `user:<min>|user:<max>`, the two user ids sorted.
- **group (`kind='group'`):** the sorted member list, `agent:<id>|…|user:<id>|…`, capped at 9 participants. A new unique index covers `WHERE kind = 'group'`.

Membership stays fixed: the existing `DM_FIXED` precondition covers `"channel.members.add", "channel.members.remove", "channel.archive"` [VERIFIED: policy.ts:55] when `ChannelFacts.kind === "dm"` [VERIFIED: policy.ts:163-169, quoted `kind?: "channel" | "dm";`]. Pass `kind: "dm"` for groups too, or add `"group"` to that union (only add). Adding someone to a group DM opens a new group (Slack semantics), which keeps history private to the original participants.

### Pattern 4: Presigned upload with server verification
```ts
// Source: probe against Garage v2.4.1 this session (2026-10-05); AWS SDK v3 presigner
const s3 = new S3Client({
  endpoint: env.OCW_S3_ENDPOINT,            // internal, e.g. http://garage:3900
  region: env.OCW_S3_REGION,                // "garage"
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey }, // resolved from SecretReference {provider:"env",key:"OCW_S3_SECRET_ACCESS_KEY"}
  requestChecksumCalculation: "WHEN_REQUIRED",   // REQUIRED: default WHEN_SUPPORTED → Garage 400 InvalidDigest
  responseChecksumValidation: "WHEN_REQUIRED",
});
// A second client with endpoint = OCW_S3_PUBLIC_URL is used ONLY for presigning (SigV4 signs the Host).
const url = await getSignedUrl(presignClient,
  new PutObjectCommand({ Bucket, Key, ContentType: declared, ContentLength: size }),
  { expiresIn: 300, signableHeaders: new Set(["content-type"]) }); // without this, content-type is NOT signed
```
Object key: `org/<orgId>/conv/<conversationId>/att/<attachmentId>/original` and `…/thumb.webp`. There is no filename in the key; the filename lives in the DB and reaches the browser only through `ResponseContentDisposition`.

### Pattern 5: Permalinks over the seq cursor
- **API:** `GET /conversations/:id/messages?around=<messageId>&limit=50` returns `{messages, nextBefore, nextAfter, lastSeq}`, where the anchor is the top-level message. For a thread reply the anchor is its root, and the response also carries `threadRootId`.
- **Detached mode:** the client leaves live-tail mode (it stops auto-appending live `message.created` at the bottom and shows "Jump to latest"), scrolls to and highlights the anchor, and loads newer pages with `after=<seq>`.
- **URL:** `/chat/<convId>?m=<messageId>` (existing `?thread=<rootId>` is kept [VERIFIED: apps/web/components/chat/channel-view.tsx:86-87]).

### Anti-Patterns to Avoid
- **Fan-out of every channel message to `user:` streams:** this creates O(members) durable rows per message in `stream_events`. Write `user:` events only for notifications (mentions, DMs, group DMs, @channel/@here); badge counts for ordinary messages come from the snapshot plus the existing per-conversation watchers.
- **Unread = `streams.last_seq - last_read_seq`:** `last_seq` counts every durable event on the stream (thread updates, member changes, and now edits and reactions). Count messages instead (Pitfall 1).
- **Rendering message HTML:** streamdown includes `rehype-raw` by default [CITED: streamdown.ai/docs/security]. Always pass an explicit `rehypePlugins` list without `raw`.
- **Trusting `Content-Type` from the browser:** sniff magic bytes after upload, and serve anything non-image as `attachment`.
- **Exposing message bodies in audit metadata:** audit rows carry ids and versions; bodies live only in `message_versions`.

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| SigV4 presigning | Own HMAC code | `@aws-sdk/s3-request-presigner` | Canonical-request edge cases; tested against Garage this session |
| MIME detection | Extension checks | `file-type` on the first 4100 bytes | Extensions and declared types are attacker-controlled |
| Image resize, EXIF strip, decompression-bomb guard | Canvas/ImageMagick shell | `sharp` with `limitInputPixels` (default 268M px) and `.rotate()` before resize | libvips is fast and memory-bounded |
| Query parsing | Custom boolean parser | `websearch_to_tsquery` | It never raises a syntax error on user input [CITED: postgresql.org/docs/18/textsearch-controls.html] |
| Accent folding | Manual `translate()` | `unaccent` dictionary inside custom TS configs | Immutable inside a two-argument `to_tsvector`, so it works in a generated column [VERIFIED: probe] |
| Fuzzy people/channel lookup | LIKE '%x%' scans | `pg_trgm` GIN (`gin_trgm_ops`) | Trusted extension in the stock image [VERIFIED: probe `trusted = t`] |
| Partial-markdown streaming | Regex fence fixing | streamdown (`remend` inside) | Unterminated fences, tables and emphasis during token streams |
| Emoji data and picker | Own emoji table | `frimousse` (+ its data) | Skin tones, search, keyboard navigation and accessibility |

**Key insight:** every "simple" piece of chat (unread counts, mentions, uploads) has a privacy edge. The cheap way to stay correct is to route each one through the existing resolver and `appendEvent`, not through new bespoke checks.

## Runtime State Inventory

Not a rename phase. Two items touch existing runtime state:

| Category | Items found | Action required |
|----------|-------------|-----------------|
| Stored data | Existing `conversations` rows have no `unit_id` (all become "Organization" group); existing `messages` have no `search_tsv` (the STORED generated column backfills on `ALTER TABLE … ADD COLUMN`, which rewrites the table; fine at current volumes) | Migration only; no data migration task |
| Live service config | None (Garage bucket/key created by `--default-bucket` from env at first boot) | — |
| OS-registered state | None | — |
| Secrets/env vars | New: `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` (optional), `GARAGE_DEFAULT_ACCESS_KEY` (`GK` + 24 hex), `GARAGE_DEFAULT_SECRET_KEY` (64 hex) → same values to the API as `OCW_S3_ACCESS_KEY_ID` / `OCW_S3_SECRET_ACCESS_KEY` (`_FILE` supported) | Add to `scripts/setup-env.mjs` + `.env.example`; existing `.env` files need a documented one-time `--add-missing` step, because `--force` rotates every secret |
| Build artifacts | `apps/web` drops `react-markdown`/`rehype-highlight` after the renderer lands | Lockfile update in the same plan |

## Common Pitfalls

### Pitfall 1: Unread counts from stream seq
**What goes wrong:** CHAT-09's wording "`last_seq - last_read_seq`" over-counts, because `streams.last_seq` advances on `thread.updated`, `conversation.member_added` and now edits and reactions.
**How to avoid:** `unread = count(*) FROM messages WHERE conversation_id = c AND thread_id IS NULL AND seq > last_read_seq AND deleted_at IS NULL AND NOT (author_kind='user' AND author_id = me)`, capped at 100 (UI shows "99+"). Run it with a LATERAL subquery on the existing index `messages_conv_seq_idx (organization_id, conversation_id, seq)` [VERIFIED: schema/app.ts:282]. Keep `last_read_seq` comparable by storing message seqs (it already does).
**Warning signs:** the badge increments when someone reacts.

### Pitfall 2: Mark-as-unread cannot move the cursor backwards
**What goes wrong:** both read routes set `last_read_seq = greatest(last_read_seq, $seq)` [VERIFIED: apps/api/src/modules/chat/index.ts:562-571, 750-759].
**How to avoid:** add a separate `POST /conversations/:id/unread {messageId}` that sets `last_read_seq = message.seq - 1`. Emit `conversation.read` on `user:<me>` for both directions, so other tabs and devices update (today `markRead` only patches the local cache).

### Pitfall 3: Presigned PUT fails against Garage with the default SDK config
**What goes wrong:** since the SDK's checksum change, a presigned `PutObject` includes `x-amz-checksum-crc32=AAAAAA==` (the CRC of an empty body). Garage validates it: `400 InvalidDigest … expected Crc32([0, 0, 0, 0])` [VERIFIED: probe output].
**How to avoid:** set `requestChecksumCalculation: "WHEN_REQUIRED"` on the client, and add an integration test that does a real presigned PUT against a Garage testcontainer.

### Pitfall 4: Content-Type silently not signed
**What goes wrong:** by default `X-Amz-SignedHeaders=content-length;host`, so a client can upload `text/html` to a URL issued for `image/png` [VERIFIED: probe query string].
**How to avoid:** pass `signableHeaders: new Set(["content-type"])`. The probe then returned 403 on a mismatch. Sniff anyway at `complete`.

### Pitfall 5: Public storage URL vs internal endpoint
**What goes wrong:** SigV4 signs the Host, so a URL presigned for `http://garage:3900` is unusable from the browser.
**How to avoid:**
- Use two endpoints: `OCW_S3_ENDPOINT` (internal) for server operations and `OCW_S3_PUBLIC_URL` (e.g. `http://localhost:3900`, later behind Caddy with Host preserved) for presigning only.
- Allow bucket CORS only for `OCW_PUBLIC_WEB_URL` + `OCW_TRUSTED_ORIGINS`, with `PUT`/`GET` methods.
- Never make the bucket public.

### Pitfall 6: Reserved handles collide with real users
**What goes wrong:** `userHandle()` derives the handle from the email local part [VERIFIED: packages/contracts/src/chat.ts:284-295], so `here@acme.com` gets `@here`.
**How to avoid:** reserve `channel`, `here` and `everyone`. `userHandle` appends a suffix (`here-1`) when the derived handle is reserved, and `resolveMentions` checks reserved tokens first. Include a unit test.

### Pitfall 7: Group DMs with bots leak memory and personal bots
**What goes wrong:**
- `agent_memories` is per (bot, human) and is read and written "only in that human's DM with the bot" [VERIFIED: schema/app.ts:436-455].
- A group DM with two humans and a team bot must not inject or save memory (PRD shared-context rule; MULTI-06 in Phase 6).
- Personal bots are owner-only (`personal_bot` precondition, policy.ts:96-105).
**How to avoid:**
- Group DMs refuse personal bots, both at creation and when posting.
- Bots in group DMs answer on @mention only (no every-message delivery). That is D-04 semantics for 1:1 only.
- The turn policy disables memory whenever the conversation has more than one human member. Add an integration test.
- `dispatchAgentMentions` calls `getChannel` [VERIFIED: chat/index.ts:169], so it needs generalising to `group`.

### Pitfall 8: Bots re-triggered by edits, and deleted content kept in bot context
**How to avoid:** edits never call `emitAgentMention` (to avoid cost and loops). Newly added human mentions on an edit notify only the users not mentioned before. `provideThreadContext` / `loadThread` skip `deleted_at IS NOT NULL` rows, so deleted text never reaches a model.

### Pitfall 9: Notification payloads outlive access
**What goes wrong:** a notification row stores a snippet. If the user later leaves the private channel, the inbox would still show it.
**How to avoid:** store only ids plus the actor in `notifications`. The inbox list query joins messages and re-filters through the readable set at read time; the snippet is computed then, truncated to 140 characters.

### Pitfall 10: Migration conflicts across parallel worktrees
**What goes wrong:** drizzle-kit snapshots chain. Two parallel plans that each generate a migration produce conflicting snapshots.
**How to avoid:** one foundation plan creates every Phase 4 table, column, index, extension and TS config. Later plans add no migrations unless they run serially.

### Pitfall 11: macOS notification clicks on an ad-hoc-signed desktop build
**What goes wrong:** Electron says "your application will need to be code-signed in order for notification events to emit correctly" on macOS [CITED: electronjs.org/docs/latest/tutorial/notifications]. The Phase 1 desktop is ad-hoc signed (deviation D-7).
**How to avoid:** treat click-to-focus in desktop as a manual verification item. Notifications still display.

### Pitfall 12: Duplicate OS notifications across tabs and windows
**How to avoid:** use `new Notification(title, { tag: notification.id })`, so the same browser replaces rather than stacks. Show one only when `document.visibilityState !== "visible"` or the conversation is not the focused one. A desktop window plus a browser tab may still both show it; this is accepted and documented.

### Pitfall 13: The sidebar opens one WS subscription per joined conversation
`ChannelWatcher`/`DmWatcher` subscribe to `conv:<id>` per row [VERIFIED: apps/web/components/chat/chat-sidebar.tsx:41-98]. That is fine for tens of channels. Do not add more per-row subscriptions (for example per thread) in Phase 4. The Threads view refreshes from `user:` notifications plus the snapshot.

## Code Examples

### Search schema (verified on postgres:18.6 this session)
```sql
-- migrator role has CREATE on the DB; pg_trgm/unaccent are trusted (probe: trusted = t)
create extension if not exists unaccent with schema app;
create extension if not exists pg_trgm  with schema app;
create text search configuration app.ocw_simple (copy = pg_catalog.simple);
alter  text search configuration app.ocw_simple alter mapping for hword, hword_part, word with app.unaccent, simple;
create text search configuration app.ocw_es (copy = pg_catalog.spanish);
alter  text search configuration app.ocw_es alter mapping for hword, hword_part, word with app.unaccent, spanish_stem;
create text search configuration app.ocw_en (copy = pg_catalog.english);
alter  text search configuration app.ocw_en alter mapping for hword, hword_part, word with app.unaccent, english_stem;

alter table app.messages add column search_tsv tsvector generated always as (
  setweight(to_tsvector('app.ocw_simple', body), 'A')
  || to_tsvector('app.ocw_es', body) || to_tsvector('app.ocw_en', body)) stored;
create index messages_search_gin on app.messages using gin (search_tsv);
create index org_members_name_trgm on app.org_members using gin (display_name app.gin_trgm_ops);
create index conversations_name_trgm on app.conversations using gin (name app.gin_trgm_ops);
```
Hand-write this SQL in the drizzle migration (drizzle has no builder for TS configs; the repo already hand-adds `NULLS NOT DISTINCT`, schema/app.ts:87-89). Check that `post-migrate.sql` is unaffected.

### Search query
```sql
-- $1 = user query, $2 = uuid[] readable conversation ids (from the resolver), optional filters
with q as (select websearch_to_tsquery('app.ocw_simple',$1) || websearch_to_tsquery('app.ocw_es',$1)
               || websearch_to_tsquery('app.ocw_en',$1) as q)
select m.id, m.conversation_id, m.thread_id, m.seq, m.author_kind, m.author_id, m.created_at,
       ts_headline('app.ocw_simple', m.body, q.q, 'MaxFragments=1,MaxWords=18,MinWords=6,StartSel=«,StopSel=»') as snippet
from app.messages m, q
where m.search_tsv @@ q.q and m.conversation_id = any($2) and m.deleted_at is null
  and ($3::uuid is null or m.conversation_id = $3) and ($4::uuid is null or m.author_id = $4)
  and ($5::timestamptz is null or m.created_at >= $5) and ($6::timestamptz is null or m.created_at < $6)
order by m.created_at desc limit 21;   -- keyset on (created_at, id) for "more"
```
Measured on 1M rows with 100 of 1,000 conversations readable: rare term 10 ms; "deploy" (12% of rows) 83 ms cold, 21 ms warm; "migraciones autenticacion" (unaccented query, stemmed match of `migración`/`autenticación`) 47 ms [VERIFIED: probe EXPLAIN ANALYZE]. Render the snippet as text and map `«»` to `<mark>` in React, never as HTML.

### Garage compose service (minimal profile; no init container)
```yaml
# Source: garagehq.deuxfleurs.fr quick-start + configuration reference; flags verified by probe (v2.4.1)
  garage:
    image: dxflrs/garage:v2.4.1
    restart: unless-stopped
    command: ["/garage", "server", "--single-node", "--default-bucket"]
    environment:
      GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET:?run pnpm setup:env}
      GARAGE_DEFAULT_ACCESS_KEY: ${OCW_S3_ACCESS_KEY_ID:?run pnpm setup:env}
      GARAGE_DEFAULT_SECRET_KEY: ${OCW_S3_SECRET_ACCESS_KEY:?run pnpm setup:env}
      GARAGE_DEFAULT_BUCKET: ocw-attachments
    volumes:
      - ./infra/garage/garage.toml:/etc/garage.toml:ro   # metadata/data dirs, replication_factor=1, s3_region, no secrets
      - garage-meta:/var/lib/garage/meta
      - garage-data:/var/lib/garage/data
    ports:
      - "127.0.0.1:${OCW_S3_PORT:-3900}:3900"   # browser presigned URLs; Caddy in Phase 7
```
The API gets `OCW_S3_ENDPOINT=http://garage:3900`, `OCW_S3_PUBLIC_URL`, `OCW_S3_BUCKET`, `OCW_S3_REGION=garage`, the key id and the secret (`_FILE` variants). The API puts bucket CORS idempotently at boot, because Garage implements `PutBucketCors` [VERIFIED: probe]. Garage has no healthcheck binary in the image [ASSUMED]; use `depends_on: service_started` plus API-side retry. **Attachments degrade gracefully:** when `OCW_S3_*` is unset (native `pnpm demo:up`, unit tests), the API reports `attachments: disabled` and the composer hides the paperclip.

## State of the Art

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| MinIO CE as the default self-hosted S3 | Garage / SeaweedFS / RustFS / forks | MinIO maintenance mode 2025-12-03 → archived 2026-04 [CITED: github.com/minio/minio/issues/21714; VERIFIED: GitHub API `archived: true`] | ADR-0003's "MinIO in self-hosted compose" must be superseded |
| Garage multi-step bootstrap (`layout assign/apply`, `key create`, `bucket allow`) | `server --single-node --default-bucket` + `GARAGE_DEFAULT_*` env | Garage v2.3.0 [CITED: garagehq quick-start; VERIFIED: probe logs "Creating default access key … Creating default bucket"] | One service, zero init scripts |
| AWS SDK presign without checksums | SDK adds `x-amz-checksum-*` by default | AWS SDK v3 (2025 checksum change) [VERIFIED: probe] | Set `WHEN_REQUIRED` for third-party S3 |
| react-markdown for streaming LLM output | streamdown (remend + harden + shiki, block memoisation) | 2025-2026 | One renderer for static chat and streaming agent output |

**Deprecated/outdated:** the `minio` npm client for new code; `rehype-highlight` (highlight.js) once shiki lands; ParadeDB `pg_search` for this repo (not in the stock image).

## Detailed answers to the eight research questions

### 1. Object storage + upload pipeline
- **Choice: Garage v2.4.1.**

  | Claim | Status | Evidence |
  |---|---|---|
  | AGPL-3.0, last push 2026-10-02 | CONFIRMED | GitHub API |
  | v2.4.1 published 2026-09-08 | CONFIRMED | Docker Hub tags |
  | Presigned URLs, POST object, CORS, multipart, SSE-C, lifecycle Expiration + AbortIncompleteMultipartUpload | CONFIRMED | [CITED: garagehq S3 compatibility page] |
  | No bucket policies/ACLs, no versioning, no object lock, no SSE-S3 ("encrypt your server partition or do client-side encryption") | CONFIRMED | same |
  | 3.5 MiB idle RSS | CONFIRMED | `docker stats` on the probe |
  | Memory under concurrent 25 MB uploads | NEEDS VALIDATION | — |

  The missing features are acceptable for Phase 4: the API is the ACL, keys are tenant-prefixed and objects are private. PRD "encrypted upload" can be met with SSE-C (Garage supports it) or a host-encrypted volume. **Defer encryption-at-rest to Phase 12 (ART-03 "encrypted only" policy)** and note it in ADR-0015.
- **MinIO:** CONFIRMED gone as a default (repo archived; Docker Hub repo 404). Feature removals in 2025 (console stripped to an object browser, binaries and images no longer published): [CITED: stormdevelopments.ca, vonng.com, issue #21714]. The exact dates of the console removal are NEEDS VALIDATION but do not change the decision.
- **SeaweedFS 4.48** (Apache-2.0, weekly releases): a viable fallback because the S3 API is the contract. Its footprint is NEEDS VALIDATION (not probed).
- **Pipeline:**
  1. `POST /conversations/:id/attachments` → resolver `channel.post` (+ new `attachment.upload`) → size ≤ `OCW_ATTACHMENT_MAX_BYTES` (default 25 MiB) and ≤ 10 files per message → row `pending` → presigned PUT (300 s, signed type and length).
  2. The browser PUTs with progress (XHR `upload.onprogress`). Paste (`clipboardData.files`) and drop (`dataTransfer.files`) feed the same queue.
  3. `POST /attachments/:id/complete`:
     - `HeadObject` checks the size;
     - ranged GET of the first 4100 bytes goes through `file-type`; a mismatch with an allowlisted image type → `rejected`;
     - the SHA-256 is computed by streaming the object;
     - images go through sharp (`rotate()`, resize ≤ 720 px webp, metadata stripped), the thumbnail is put to `…/thumb.webp` and the width and height are stored;
     - the row becomes `ready` and an audit `attachment.uploaded` row is written.
  4. Posting links `attachmentIds` (same uploader, same conversation, `ready`, unlinked) in the message transaction. The message DTO carries `attachments[]`.
  5. `GET /attachments/:id/(preview|download)` → resolver `channel.read` on the owning conversation → 302 to a presigned GET (60 s). The download uses `attachment; filename*=UTF-8''…`. Inline is allowed only for `image/png|jpeg|gif|webp` thumbnails, never SVG/HTML. An audit row is written for `download`; thumbnail previews are not audited (to avoid noise), and ADR-0015 records that.
  6. Retention: attachments live as long as their message. On message delete the row is marked `deleted`, and the sweeper deletes the objects after 30 days. `pending` rows older than 24 h are swept. The sweeper is a `setInterval` with `pg_try_advisory_lock`. Artifact retention policies (7/30/90) stay in Phase 12.
  7. Virus scanning: **not in Phase 4.** ClamAV needs "Minimum: 3 GiB, Preferred: 4 GiB" RAM [CITED: docs.clamav.net/manual/Installing/Docker.html], which breaks the small-VM target. Keep a `scan_status` column (`not_scanned`) so Phase 12 can add an optional `clamav` profile.
  8. Tenant isolation: a key prefix per org and conversation; the `attachments` table carries `organization_id` (automatic RLS); there is a cross-tenant test that tries another org's attachment id (404). EXIF/GPS is stripped in thumbnails; originals are served unchanged and documented as such.

### 2. Full-text search: CONFIRMED on postgres:18.6
- **Stock image:** `pg_trgm`, `unaccent` and `btree_gin` are available and trusted. `pg_search`, `vector`, `rum` and `pgroonga` are absent. This was verified by querying `pg_available_extension_versions` on `postgres:18`, so it is a positive observation, not an inference.
- **Rejected:** ParadeDB `pg_search`, because it would need a custom Postgres image; ADR-0003 says stock PostgreSQL only.
- **Multilingual:** three configs OR-ed. `simple` keeps exact tokens, code identifiers and names; `es`/`en` stem; `unaccent` makes "migracion" match "migración". The trade-off is a bigger index (three lexeme sets); at 1M synthetic rows the GIN index was 26 MB (real vocabularies will be larger: NEEDS VALIDATION on real data).
- **Permission-aware search:** Pattern 1, plus `deleted_at IS NULL`. Results include thread replies (same conversation). Archived channels are included and labelled.
- **People:** `org_members` (active only) + agents (non-deleted, non-personal unless owned) via `pg_trgm` similarity / ILIKE.
- **Channels:** readable channels only, fuzzy on name and topic.
- **Filters:** structured params from UI chips (`in`, `from`, `after`/`before`), not a server-side query language.
- **Performance at ~1M:** see Code Examples. Keyset pagination on `(created_at, id)`. Debounce the UI at 250 ms. Per-user rate limit through the existing `@fastify/rate-limit`.

### 3. Notifications
- **Model:** `notifications(id, organization_id, user_id, kind: mention|channel|here|dm|group_dm|thread_reply, conversation_id, message_id, thread_root_id, actor_kind, actor_id, created_at, read_at)`.
- **Recipients** are computed in the message transaction:
  - explicit user mentions that the resolver lets read the conversation;
  - **@channel** → all human members;
  - **@here** → human members currently online;
  - DM / group DM → every other human;
  - thread reply → the participants of the thread.

  The author is always excluded, and recipients are de-duplicated per message (the strongest kind wins).
- **@here online set:** presence today is per topic [VERIFIED: realtime/presence.ts:1-15]. Add an org-level Redis sorted set `ocw:online:<orgId>` maintained by the gateway on socket open, heartbeat and close (same TTL as presence, 45 s). This is NEEDS VALIDATION as a design choice, but it reuses the existing heartbeat.
- **@channel/@here gate:** a new permission `channel.mention_all` (chat surface, default allowed for every role, deny-able by rules). The composer warns above 20 members, like Slack. Rate-limit @channel to 1 per channel per minute.
- **Preferences:**
  - per user: `notification_prefs(user_id, dnd_until, desktop_enabled, web_enabled, default_level all|mentions|none)`;
  - per conversation: `conversation_members.notify_level (default|all|mentions|none)` and `muted boolean`.

  The server evaluates them per recipient and writes `notification.created` on `user:<id>` with `{notification, popup: boolean}`; DND and mute set `popup=false`, but the row still lands in the inbox. A muted channel shows no unread badge, but mentions still count. "Mention-only" means a channel's ordinary messages produce no badge count, only the dot.
- **Badges:** the snapshot in `GET /channels` and `GET /dms` adds `unreadCount` and `mentionCount`. Live: the existing `conv:` watchers increment `unreadCount`, and `notification.created` increments `mentionCount`. `conversation.read` events (other devices) and `resync` refetch the snapshot. This uses the 03.2-11 rule: "After a resync the realtime client adopts the next subscribed frame's lastSeq; setLastSeq after a snapshot refetch still wins" [VERIFIED: 03.2-11-SUMMARY.md decisions].
- **Web and desktop:**
  - The Web Notifications API is used while the app is open. Permission is requested on an explicit toggle (user gesture), never on load.
  - Electron already grants `notifications` to the web origin [VERIFIED: apps/desktop/src/main/security.ts:66, quoted `const allowedForWeb = new Set(["clipboard-sanitized-write", "fullscreen", "notifications"]);`], and Electron supports the web API in the renderer [CITED: electronjs.org notifications tutorial], so it is one code path.
  - Dock/taskbar badge: add `ocwDesktop.setBadgeCount(n)` to the preload API (the typed IPC list in `apps/desktop/src/shared/ipc.ts`, validated sender) → `app.setBadgeCount`.
  - Web title prefix: `(3) OCW`.
  - Closed-tab Web Push (service worker + VAPID) is **not** recommended for Phase 4 (see Open Questions).
- **Inbox:** `GET /notifications?cursor` lists them, re-filtered by readability; mark one or all read; the Mentions view is the inbox filtered to `mention|channel|here`.
- **Delivery semantics:** at-least-once through durable `user:` events (seq replay, `REPLAY_LIMIT` → resync → refetch). Exactly-once display comes from idempotency by `notification.id`.

### 4. Edit/delete, reactions, pins, saves, permalinks
- **Edit** (author only, users; agents later via the Agent Channel API):
  - in one transaction, insert the prior body into `message_versions(organization_id, message_id, version, body, mentions, edited_by, created_at)`;
  - update `body`, `mentions` and `edited_at` (the column exists [VERIFIED: schema/app.ts:279]);
  - write `message.updated` and audit `message.edited` (metadata `{messageId, version}`, no body).

  `message_versions` gets `REVOKE UPDATE, DELETE, TRUNCATE … FROM ocw_app` in `post-migrate.sql`, the same pattern as `audit_events` [VERIFIED: packages/db/sql/post-migrate.sql, quoted `REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_events FROM ocw_app;`]. Versions are not exposed in the Phase 4 UI.
- **Delete:** author, or `message.delete_any` (a new admin-surface permission) **only where the resolver allows `channel.read`**. It is a soft delete: `deleted_at` and `deleted_by` are set, the final body goes to `message_versions`, and `body` is set to `''`, which empties `search_tsv`. The tombstone "This message was deleted." keeps thread roots intact. It emits `message.deleted` and audits `message.deleted`.
- **Reactions:** `message_reactions(organization_id, message_id, conversation_id, emoji, member_kind, member_id, created_at)`, with the PK over the last four. Toggle via `PUT/DELETE /messages/:id/reactions/:emoji`. The event `reaction.updated {messageId, emoji, count, memberIds(≤20)}` lets clients compute "mine". This works on thread replies and on agent and AI messages, because they are all `messages`. Store emoji as Unicode (validated against frimousse data), capped at 50 distinct per message.
- **Pins:** `message_pins(organization_id, conversation_id, message_id, pinned_by, created_at)`. Pinning a message is allowed for anyone with `channel.post`. Unpin is allowed for the pinner, the channel owner or an admin; it is audited and emits `pin.updated`. A "Pinned" sheet in the conversation header shows them.
- **Saves:** `message_saves(organization_id, user_id, message_id, created_at)`. Saves are private and live in the "Saved" item of the views list. The list is re-filtered by readability.
- **Permalinks:** Pattern 5. "Copy link" lives in the hover toolbar and the mobile long-press sheet. A link to a message you cannot read shows the standard 404 view and never reveals that it exists.

### 5. Sidebar grouping and views
- Add a nullable `conversations.unit_id` (FK `org_units`, `on delete set null`). `ChannelSummary` gains `unit: {id, name, kind, path}`.
- Set the unit path on the channel resource (`channelResource` builds with `unitPath: []` today [VERIFIED: policy.ts:186-188]), so department-scoped allow/deny rules apply to that channel (principle 6). The role defaults do not change.
- **Creation:** the create dialog gains "Belongs to" (Organization, or a unit the creator is a member or lead of; admins pick any). An owner or admin can move a channel later.
- **Sidebar order:**
  1. Views: All, Mentions (badge), Threads, AI Chats, Saved.
  2. Organization channels.
  3. One collapsible section per department (the user's own departments first). Team channels nest under their department with a small team label, with at most two levels (PRD §13 "avoid infinite visual hierarchies").
  4. Direct messages: humans, groups and bots mixed by recent activity, with personal bots pinned first, as today.

  Collapse state is kept in `localStorage`.
- **Views:**
  - **All:** a unified, recent-first feed of unread conversations.
  - **Mentions:** the inbox filter.
  - **Threads:** threads the user authored or replied to, or was mentioned in, sorted by `last_reply_at`. Unread is tracked by `thread_reads(user_id, root_message_id, last_read_seq)`.
  - **AI Chats:** conversations with an AI counterpart, which in Phase 4 means the bot DMs. Phase 5 adds `kind='ai_chat'` rows to the same view.
- At 390 px the sidebar is the home screen (existing pattern) and views render as a segmented row at the top.

### 6. Shared Markdown renderer
- **Today:** two copies.
  - `apps/web/components/chat/markdown.tsx` uses react-markdown 10.1.0 + remark-gfm + rehype-highlight + a custom `rehypeMentions` plugin. It already avoids raw HTML, renders images as links (no tracking pixels) and has `rel="noopener noreferrer nofollow"`.
  - `apps/web/components/work-zone/markdown.tsx` is react-markdown + remark-gfm, with no highlighting; it is used for streaming deltas in `event-stream.tsx:392` [VERIFIED: files read this session].
- **Recommendation:** `apps/web/components/markdown/markdown.tsx` exporting `<Markdown text variant="chat"|"document" streaming? />`, built on streamdown:
  - `mode={streaming ? "streaming" : "static"}`;
  - `rehypePlugins={[harden({ allowedLinkPrefixes: ["https://","http://","mailto:"], allowedImagePrefixes: [], defaultOrigin: OCW_PUBLIC_WEB_URL }), rehypeMentions]}` with **no `rehype-raw`**;
  - `plugins={{ code }}` (shiki), with mermaid and math disabled;
  - `components` carrying the current chat styles (compact headings, mention chips, image-as-link).

  Tailwind v4 needs `@source "../node_modules/streamdown/dist/*.js";` [CITED: streamdown.ai/llms.txt].
- **Safety tests:** unit fixtures for `<script>`, `<img onerror>`, `javascript:`/`data:` links, raw `<iframe>`, a 10k-line code block and mention inside code (not chipped). The output must contain no `<script>`, no `on*` attributes and no non-allowlisted hrefs.
- **Risk:** visual regression of the chat. The plan must capture before/after screenshots of the existing chat, thread and Work Zone streams at 1440/390, light and dark. The streamdown 2.6.0 + @streamdown/code 1.1.1 pairing is NEEDS VALIDATION (Wave 0 spike); if it fails, wait for 2.7.0 + 2.0.0 (eligible 2026-10-07).

### 7. Group DMs and mixed DMs (privacy)
- Covered by Pattern 3 and Pitfall 7.
- **New route:** `POST /dms {participants: [{kind, id}]}`:
  - one human counterpart → `kind='dm'`;
  - one team bot → the existing `ensureDm`;
  - two or more → `kind='group'`, max 9.

  `GET /dms` lists all three shapes, and `DmCounterpart` becomes a discriminated union (`agent` | `user` | `group` with a members preview). Only add fields; the 3.1 web reads `counterpart.kind === "agent"`.
- **Privacy:** visibility `private`, so the existing precondition denies non-members, **admins included** [VERIFIED: policy.ts:72-79; no admin bypass in that branch]. Tests: an admin non-participant gets 404 on messages, thread, WS `sub` (authorizer), search hits, attachment download, pins, reactions, the permalink `around` and inbox entries.
- `MESSAGE_KINDS` grows from `["channel", "dm"]` [VERIFIED: chat/index.ts:77] to include `"group"`. Group DMs are flat like DMs (`dm_is_flat`, index.ts:684-686).

### 8. Plan breakdown, validation and security
See the Plan Breakdown section below, then the Validation Architecture and Security Domain sections.

## Suggested Plan Breakdown (tracer-first vertical slices)

| Wave | Plan | Content | Depends |
|------|------|---------|---------|
| 1 | 04-01 Foundation | One migration with every table and column (unit_id, deleted_*, search_tsv + TS configs + extensions + GIN/trgm, message_versions [append-only grants], reactions, pins, saves, notifications, notification_prefs, member notify_level/muted, thread_reads, attachments); contracts (DTOs, EventTypes additions, permissions `message.delete_any`, `channel.mention_all`, `attachment.upload` — add only); RLS enumerator passes; reserved handles | — |
| 1 | 04-02 Shared renderer | streamdown spike, one component, migrate chat + DM + thread + Work Zone stream, XSS fixtures, before/after screenshots | — (web only) |
| 1 | 04-03 Object storage infra | Garage compose service + `infra/garage/garage.toml`, setup-env keys, `storage.ts` (two clients, WHEN_REQUIRED, presign helpers, boot CORS), Garage testcontainer helper, graceful "disabled", ADR-0015 | — |
| 2 | 04-04 **Tracer: edit/delete** | API + versions + events + audit + hover toolbar/long-press sheet + edited marker + tombstone + bot context skips deleted; int + e2e | 01 |
| 2 | 04-05 Reactions, pins, saves | API + events + picker + pinned sheet + Saved view | 01, 04 (toolbar) |
| 2 | 04-06 Human DMs + group DMs | `POST /dms`, key extension, picker dialog, list union, group bot-on-mention, memory off, privacy suite | 01 |
| 2 | 04-07 Permalinks + jump | `around`/`after` pages, detached mode, highlight, copy link, thread anchors | 01 |
| 2 | 04-08 Sidebar grouping + views shell | unit_id in create/move, grouped sidebar, All/Threads/AI Chats/Saved views (Mentions wired in 09), thread_reads | 01, 06 |
| 3 | 04-09 Notifications core | recipients, @channel/@here (online set, permission, rate limit), notifications + `user:` events, unread/mention counts, mark read/unread, cross-device read sync, inbox + Mentions view | 01, 06, 07 |
| 3 | 04-10 Preferences + OS notifications | prefs API/UI (mute, DND, mention-only, desktop/web), Notification API, Electron badge IPC, title count | 09 |
| 3 | 04-11 Attachments | presign/complete/download, sniffing, sharp thumbnails, composer DnD/paste/progress, previews, lightbox, audit, sweeper | 01, 03 |
| 3 | 04-12 Search | API (messages/people/channels, filters), ⌘K palette + results page, jump via 07 | 01, 07 |
| 4 | 04-13 Phase gate | full e2e at 1440/390, light/dark screenshots, ADR-0016, AGENTS.md lines, REQUIREMENTS traceability, VERIFICATION | all |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | `file-type` is the right sniffing library (choice from training) | Stack | Low: swap for an equivalent |
| A2 | `frimousse` is a maintained shadcn-compatible emoji picker (repo liveblocks/frimousse) | Stack | Low: fall back to emoji-mart |
| A3 | streamdown 2.6.0 works with @streamdown/code 1.1.1 | Stack, §6 | Medium: wait 2 days for 2.7.0 + 2.0.0 |
| A4 | Garage memory stays small under concurrent 25 MB uploads (only idle measured) | §1 | Low on a 2 GB VM; measure in 04-03 |
| A5 | The Garage image has no CLI healthcheck suitable for compose | Code Examples | Low: use `service_started` + API retry |
| A6 | An org-level Redis online set is the right basis for @here | §3 | Medium: alternatively define @here as "present in this channel now" |
| A7 | A 25 MiB default attachment limit and 10 files per message | §1 | Low: env-configurable |
| A8 | SeaweedFS footprint and S3 presigned behaviour (not probed) | Alternatives | Low: only a fallback |
| A9 | Exact dates of MinIO's 2025 console/binary removals | State of the Art | None for the decision |

## Open Questions (owner decisions only) (RESOLVED — defaults adopted under delegated autonomy, see 04-CONTEXT.md D-01/D-02)

1. **Admin moderation vs DM privacy.** CHAT-06 says "admins can delete any message", while DM privacy says admins cannot read DMs.
   - What we know: the resolver hides private conversations from non-member admins.
   - Recommendation (default): admins delete any message **only in conversations they can read**. DMs and group DMs have no admin moderation path in Phase 4; compliance export is a later phase.
2. **Notifications when no OCW tab or app is open (Web Push).**
   - What we know: real closed-tab web push needs a service worker plus VAPID, and the messages go through the browser vendors' push services (FCM, Mozilla, Apple). That is free but a third-party hosted hop, and principle 10 requires that nothing core depends on it.
   - Recommendation (default): Phase 4 notifies only while the web app or desktop app is running. Web Push becomes an optional, off-by-default follow-up next to mobile push (MVP 7).

Everything else (Garage, FTS design, streamdown, limits, view contents) is a technical call made above, and ADRs 0015/0016 record it.

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Docker | testcontainers (PG, Redis, Garage), e2e | ✓ | 29.6.2 (8 CPU, 16 GB VM; heavily loaded with ~30 containers) | — |
| postgres:18 image | integration tests | ✓ | 18.6 | — |
| dxflrs/garage:v2.4.1 | storage tests, compose | ✓ (pulled this session) | v2.4.1 | SeaweedFS |
| Node | everything | ✓ | 24.21.0 | — |
| sharp native binary | thumbnails | ✓ (lockfile, `allowBuilds`) | 0.35.4 | — |

**Missing dependencies with no fallback:** none. **Note:** 03.1-VERIFICATION already records local `pnpm verify` flakiness from Docker VM load; CI is the gate of record.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 (projects `unit`, `integration` with testcontainers PG 18 + Redis 8, plus **Garage** GenericContainer for storage) ; Playwright 1.63.0 (`setup` → `desktop` 1440×900, `mobile` 390×844) |
| Config file | `vitest.config.ts`, `e2e/playwright.config.ts` |
| Quick run command | `pnpm exec vitest run --project unit <files>` · `pnpm exec vitest run --project integration <file>` |
| Full suite command | `pnpm verify` (+ `pnpm --filter @ocw/desktop test` for the badge IPC) |
| E2E | `bash scripts/e2e-isolated.sh chat dms notifications search attachments` with `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/04-chat/screenshots` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test type | Where (new unless noted) |
|--------|----------|-----------|--------------------------|
| CHAT-02 | unit_id on create/move; grouped list DTO; unit path drives a dept deny rule on `channel.read` | integration | `apps/api/src/modules/chat/sidebar.int.test.ts` |
| CHAT-02 | grouped sidebar, collapse, views switch, 390 segmented views | e2e + screenshots | `e2e/tests/chat-sidebar.spec.ts` |
| CHAT-04 | human DM insert-or-get race-safe; group key sorted; fixed membership; 9 max; personal bot refused in group | integration | `dm.int.test.ts` (extend) |
| CHAT-04 | admin non-participant 404 on messages/thread/WS sub/search/attachments/pins/permalink/inbox | integration | `dm-privacy.int.test.ts` |
| CHAT-04 | group bot answers on mention only; memory not read/written with ≥2 humans | integration | `bot-capabilities/memory.int.test.ts` (extend), `group-dm-bots.int.test.ts` |
| CHAT-04 | start DM / group from picker, live between two actors | e2e | `e2e/tests/dms.spec.ts` |
| CHAT-05 | one renderer; XSS fixtures (script, onerror, javascript:, iframe, data:), mention not chipped in code | unit | `apps/web` has no vitest today: put the pure plugin + sanitize assertions in `packages/contracts` or add a web unit project (Wave 0 gap) |
| CHAT-05 | chat, thread, DM, Work Zone render identically styled; streaming fence | e2e screenshots | `chat.spec.ts`, `work-zone.spec.ts` (extend) |
| CHAT-06 | edit writes version (append-only: UPDATE/DELETE as app role fails), event, audit w/o body; delete tombstone; admin delete only where readable; bots not re-triggered; deleted skipped in bot context | integration | `message-edit.int.test.ts` |
| CHAT-07 | reaction toggle idempotent, counts, event, cap, on thread replies and agent messages | integration + e2e | `reactions.int.test.ts`, `chat.spec.ts` |
| CHAT-08 | reserved handles; @channel/@here recipients; online set; `channel.mention_all` deny; rate limit | unit + integration | `mentions.test.ts` (extend), `notifications.int.test.ts` |
| CHAT-09 | unread = message count (reactions/thread updates don't count); mention count; mark unread backwards; cross-device `conversation.read` | integration + e2e | `unread.int.test.ts`, `notifications.spec.ts` |
| CHAT-10 | prefs evaluation (mute, DND, mention-only, toggles) → popup flag; inbox re-filters revoked access | unit + integration | `notification/prefs.test.ts`, `notifications.int.test.ts` |
| CHAT-10 | browser Notification shown when hidden (Playwright `context.grantPermissions(['notifications'])` + stub `window.Notification`) | e2e | `notifications.spec.ts` |
| CHAT-10 | desktop badge IPC validated sender | unit | `apps/desktop/src/shared/ipc.test.ts` (extend) |
| CHAT-11 | es/en/accents, filters, deleted excluded, private/DM never returned (cross-user + cross-tenant), people + channels | integration | `search.int.test.ts` |
| CHAT-11 | ⌘K search → result → jump to message | e2e | `search.spec.ts` |
| CHAT-12 | presign (signed type/len), wrong type 403, complete sniff reject, sha256, thumb, download 302 + disposition, cross-conversation/tenant 404, audit rows, disabled mode | integration (Garage container) | `artifact/attachments.int.test.ts` |
| CHAT-12 | drag-drop + paste upload with progress, image preview + lightbox, file download | e2e (compose has Garage) | `attachments.spec.ts` |
| CHAT-13 | pin/unpin perms + events; saves private; permalink copy | integration + e2e | `pins.int.test.ts`, `chat.spec.ts` |
| CHAT-14 | `around` page math (anchor at boundaries, thread reply anchor), detached mode, jump to latest | integration + e2e | `permalink.int.test.ts`, `permalinks.spec.ts` |
| all | cross-tenant: each new table covered automatically | integration | `packages/db/src/rls-isolation.int.test.ts` (existing enumerator) |

### Screenshots (owner review)
Use the `<name>-<1440|390>[-dark].png` convention in `.planning/phases/04-chat/screenshots/`. Required set: grouped sidebar; views (Mentions, Threads, Saved); human DM; group DM with bot; message hover toolbar plus reactions; edited and deleted states; pinned sheet; inbox; notification prefs; search palette and results; attachment upload progress, image grid and lightbox; permalink highlight; the shared renderer on a code-heavy message.

### Sampling Rate
- **Per task commit:** quick unit/integration file for the touched module.
- **Per wave merge:** `pnpm verify`.
- **Phase gate:** `pnpm verify` + isolated e2e (desktop and mobile) green + CI green before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] Garage testcontainer helper (`apps/api/src/testing-storage.ts`): GenericContainer `dxflrs/garage:v2.4.1`, `--single-node --default-bucket`, mounted toml.
- [ ] Web unit test home for the renderer's security fixtures (no vitest project in `apps/web` today).
- [ ] e2e helper to grant and stub `Notification`, plus a second actor (exists: `e2e/support/actors.ts`).
- [ ] streamdown 2.6.0 + @streamdown/code 1.1.1 compatibility spike.

## Security Domain

`security_enforcement` is enabled at ASVS level 1, and the gate blocks on high.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard control |
|---------------|---------|------------------|
| V2 Authentication | no (unchanged) | better-auth sessions / WS JWT (ADR-0008) |
| V3 Session Management | no (unchanged) | — |
| V4 Access Control | **yes** | One resolver (`channel.read/post`, new `message.delete_any`, `channel.mention_all`, `attachment.upload`); RLS tenant isolation; hide-as-404 |
| V5 Input Validation | **yes** | Zod at every route (bodies ≤ 20,000 chars already, emoji allowlist, filename sanitisation, structured search filters); `websearch_to_tsquery` |
| V6 Cryptography | partial | SigV4 presigning by the SDK; SHA-256 via `node:crypto`; secrets via `SecretReference` env/file |
| V12 Files and Resources | **yes** | Size limits, magic-byte sniffing, `attachment` disposition, no SVG/HTML inline, sharp pixel limit, private bucket |
| V13 API | yes | Rate limits on search, @channel and presign |

### Known Threat Patterns
| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| Cross-tenant read via new tables | Information disclosure | `organization_id` on every table → automatic FORCE RLS + enumerator test |
| Private channel / DM content via search, inbox, snippet, permalink, reaction or pin lists | Information disclosure | Readable set from the resolver for every list; snippets computed at read time; 404 for hidden |
| Admin reads DMs | Information disclosure | Private precondition without an admin bypass; admin-privacy integration suite |
| Stored XSS through markdown or link schemes | Tampering | streamdown without `rehype-raw`, rehype-harden link allowlist, images as links, fixtures |
| Malicious upload (HTML/SVG as image, polyglot) | Tampering / Elevation | Signed content-type, sniff at complete, `attachment` disposition, separate storage origin, inline only for raster thumbnails |
| Presigned URL leakage | Information disclosure | GET TTL 60 s, issued after the resolver check, `Cache-Control: private, no-store` on the 302, never logged (redact the query string in pino) |
| Decompression bomb | DoS | sharp `limitInputPixels`, max bytes, per-user presign rate limit |
| IDOR on attachment/message ids (uuidv7 is guessable-ish) | Elevation | Authorize every id via its conversation; tests with ids from another conversation and another org |
| @channel/@here spam | DoS | `channel.mention_all` (deny-able), rate limit, member-count warning |
| Edit to rewrite history | Repudiation | Append-only `message_versions` (no UPDATE/DELETE grant), audit `message.edited/deleted` |
| Confused deputy through bots in group DMs | Elevation | Existing on-behalf-of `channel.read` check in `providePostAgentMessage` (index.ts:305-322); personal bots refused; memory off with ≥2 humans |
| EXIF/GPS leak | Information disclosure | Stripped in thumbnails; originals documented as unchanged |
| Header injection via filename | Tampering | Sanitise filenames; `ResponseContentDisposition` built with RFC 6266 `filename*` |
| Desktop IPC abuse (new badge channel) | Elevation | Typed channel list, `isTrustedSender` check, integer clamp 0-9999 |

## Project Constraints (from AGENTS.md / CLAUDE.md)

- Principles 1-12, especially 6 (intersected permissions, deny wins), 8 (secrets via `SecretReference`, never plaintext), 10 (`docker compose up` self-hosted, nothing core needs the managed cloud), 11 (ids not names) and 12 (audit every sensitive action).
- Contracts first (Zod in `packages/contracts`, no duplicated DTOs); modules talk only through their public `index.ts` (new `notification`, `artifact`, and `search` modules).
- Integration tests use real PostgreSQL. Each org-scoped query path needs a cross-tenant test. The app role has no RLS bypass. Tenant context comes from `withTenant()`.
- Never weaken a permission check or RLS policy to pass a test. Treat chat content and uploads as untrusted.
- ADRs: never edit an accepted one; supersede it (ADR-0015 supersedes the MinIO clause of ADR-0003).
- Plan mode is required for permissions, policies, audit, tenant isolation and schema migration (CLAUDE.md): every plan here except 04-02 qualifies.
- `pnpm verify` must pass before every commit. Conventional Commits with app/package scope.
- Exact pins, `minimumReleaseAge` 7 days, lifecycle scripts only through `allowBuilds`.
- `apps/web/AGENTS.md`: read `node_modules/next/dist/docs/` before Next-specific code (Next 16.3.6).

## Sources

### Primary (HIGH: verified on the real target this session)
- Garage v2.4.1 probe (`docker run dxflrs/garage:v2.4.1 /garage server --single-node --default-bucket`): presigned PUT/GET, signed headers, CORS, lifecycle, `docker stats` 3.5 MiB. Container removed.
- postgres:18.6 probe: `pg_available_extension_versions`, trusted flags, custom TS configs in a generated column, 1M-row EXPLAIN ANALYZE. Container removed.
- GitHub API: `minio/minio` archived=true; `deuxfleurs-org/garage` AGPL-3.0; `seaweedfs/seaweedfs` Apache-2.0 (4.48); `rustfs/rustfs` Apache-2.0. Docker Hub: `minio/minio` 404; Garage tag dates.
- Code read this session: `packages/db/src/schema/app.ts`, `apps/api/src/modules/chat/{index,service,dm}.ts`, `organization/permissions/{policy,resolve}.ts`, `realtime/{service,presence}.ts`, `packages/contracts/src/{chat,realtime,permissions}.ts`, `packages/db/sql/{bootstrap,post-migrate}.sql`, `apps/web/components/{chat,work-zone}/markdown.tsx`, `apps/web/lib/chat-queries.ts`, `apps/web/components/chat/chat-sidebar.tsx`, `apps/desktop/src/main/{security,index}.ts`, `apps/api/src/lib/secret-store.ts`, compose files, `pnpm-workspace.yaml`.

### Secondary (MEDIUM: official docs)
- [Garage S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/), [Garage quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/), [Garage configuration](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/)
- [Streamdown security](https://streamdown.ai/docs/security), [Streamdown llms.txt](https://streamdown.ai/llms.txt)
- [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [ClamAV Docker requirements](https://docs.clamav.net/manual/Installing/Docker.html)
- [PostgreSQL 18 text search controls](https://www.postgresql.org/docs/18/textsearch-controls.html)
- [MinIO maintenance mode issue #21714](https://github.com/minio/minio/issues/21714)

### Tertiary (LOW: web reports, cross-checked where possible)
- [MinIO CE archived, what still runs in 2026](https://stormdevelopments.ca/blog/minio-s-community-edition-is-archived-what-still-runs-in-2026/), [Vonng: MinIO is dead, long live MinIO](https://blog.vonng.com/en/db/minio-resurrect/), [Pepitedata on MinIO CE](https://pepitedata.com/minio-community-edition-end-agpl/)
- [CVE-2025-68926 RustFS](https://github.com/Chocapikk/CVE-2025-68926), [SecAlerts entry](https://secalerts.co/vulnerability/CVE-2025-68926)
- [Garage vs RustFS single node (dev.to)](https://dev.to/ethan-carter/garage-vs-rustfs-running-s3-on-a-single-node-3d70)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for storage and search (probed); MEDIUM for streamdown (docs only, pairing unverified).
- Architecture: HIGH. It extends verified in-repo patterns (resolver, appendEvent, dm_key, RLS enumerator).
- Pitfalls: HIGH for 1-7 (code or probe evidence); MEDIUM for 11-12 (platform docs).

**Research date:** 2026-10-05
**Valid until:** 2026-11-04 (storage ecosystem moving fast; re-check Garage/streamdown versions at plan time)
