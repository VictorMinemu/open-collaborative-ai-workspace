import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

/**
 * Domain plane. EVERY table here that has `organization_id` gets ENABLE + FORCE RLS and the
 * `tenant_isolation` policy automatically from `sql/post-migrate.sql` (run by `migrate` every time), and
 * is covered by the cross-tenant enumerator test. Add new tables here; never bypass `withTenant()`.
 */
export const appSchema = pgSchema("app");

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const orgId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ---------------------------------------------------------------- organization

/** Projection of auth.member + auth.user maintained by identity in the same transaction. */
export const orgMembers = appSchema.table(
  "org_members",
  {
    /** Surrogate id (better-auth's adapter requires an `id` on every model it writes). */
    id: uuid("id").notNull().unique().default(sql`uuidv7()`),
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    /** The four PRD roles (D-06); the single source of truth for a member's organization role. */
    role: text("role", { enum: ["standard", "developer", "lead", "admin"] }).notNull(),
    /** Profile status (ORG-06): optional emoji + short text, clearable. */
    statusEmoji: text("status_emoji"),
    statusText: text("status_text"),
    /** Set when an admin deactivates the member: no sign-in, every permission denied. */
    deactivatedAt: ts("deactivated_at"),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    check("org_members_role_check", sql`${t.role} in ('standard','developer','lead','admin')`),
  ],
);

/**
 * Organization hierarchy (D-07): departments, teams and hierarchy projects. `app.projects` keeps meaning
 * "a repository registered on a device"; hierarchy projects are `kind = 'project'` rows here.
 */
export const orgUnits = appSchema.table(
  "org_units",
  {
    id: id(),
    organizationId: orgId(),
    /** null = top level (child of the organization root). */
    parentId: uuid("parent_id").references((): AnyPgColumn => orgUnits.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["department", "team", "project"] }).notNull(),
    name: text("name").notNull(),
    /** Ancestor ids root→self (self last). Maintained only by organization/units.ts under the org lock. */
    path: uuid("path").array().notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /**
     * Phase 07.17 (D-14, PD-12): the unit's `@handle`, generated ONCE from its name (`unitHandle`, then "-2", "-3", …
     * with the base trimmed so the handle stays at most 40 characters, until it differs from every other unit handle and
     * every live bot username of the organization) and never changed by a rename or a move. An insert that omits it
     * (N-1 code, raw inserts) gets it from the `org_units_fill_handle` trigger, the same SQL allocator the migration's
     * backfill ran (`app.org_unit_handle`), so the column is NOT NULL for every writer.
     */
    handle: text("handle")
      .notNull()
      .$defaultFn(() => sql`null`),
  },
  (t) => [
    index("org_units_parent_idx").on(t.organizationId, t.parentId),
    index("org_units_path_gin").using("gin", t.path),
    // NULLS NOT DISTINCT (top-level siblings collide too) is hand-added in the identity_org migration:
    // drizzle 1.0.0-rc.4 has no builder for it.
    uniqueIndex("org_units_sibling_name_uq").on(t.organizationId, t.parentId, sql`lower(${t.name})`),
    check("org_units_kind_check", sql`${t.kind} in ('department','team','project')`),
    /** Phase 07.5: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("org_units_org_id_uq").on(t.organizationId, t.id),
    /** Phase 07.17 (D-14): one unit per handle in an organization, in the `UNIT_HANDLE_RE` grammar. */
    uniqueIndex("org_units_handle_uq").on(t.organizationId, t.handle),
    check("org_units_handle_check", sql`${t.handle} ~ '^[a-z0-9]([a-z0-9._-]{0,46}[a-z0-9])?$'`),
  ],
);

/** Unit membership (D-06): `lead` grants unit.members.manage on the unit subtree. */
export const unitMemberships = appSchema.table(
  "unit_memberships",
  {
    organizationId: orgId(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => orgUnits.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["member", "lead"] })
      .notNull()
      .default("member"),
    addedBy: uuid("added_by"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.unitId, t.userId] }),
    index("unit_memberships_user_idx").on(t.organizationId, t.userId),
    check("unit_memberships_role_check", sql`${t.role} in ('member','lead')`),
  ],
);

/** Explicit allow/deny rules (D-02). Deny beats allow; allow never grants a non-delegable permission. */
export const permissionRules = appSchema.table(
  "permission_rules",
  {
    id: id(),
    organizationId: orgId(),
    /** null = the whole organization; otherwise the unit subtree. */
    scopeUnitId: uuid("scope_unit_id").references(() => orgUnits.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind", { enum: ["everyone", "role", "user", "agent"] }).notNull(),
    /** Role name, user id or agent id; null for `everyone`. */
    subjectId: text("subject_id"),
    /** Exact permission or `prefix.*`. */
    permission: text("permission").notNull(),
    /** Tool layer: restricts the rule to one tool (e.g. a Work Zone tool name); null = any. */
    tool: text("tool"),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
    /**
     * Phase 07.2 (D-04): restricts a `memory.*` rule to one folder of a scope, in folder form (`hr/`, always ending
     * with `/`, matched on segment boundaries by the resolver); null = every path.
     */
    pathPrefix: text("path_prefix"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("permission_rules_org_idx").on(t.organizationId),
    check("permission_rules_subject_kind_check", sql`${t.subjectKind} in ('everyone','role','user','agent')`),
    check("permission_rules_effect_check", sql`${t.effect} in ('allow','deny')`),
    check(
      "permission_rules_path_prefix_check",
      sql`${t.pathPrefix} is null or (${t.permission} like 'memory.%' and ${t.pathPrefix} like '%/')`,
    ),
  ],
);

// ---------------------------------------------------------------- audit

/** Append-only (no UPDATE/DELETE grants). PRD field list maps 1:1. */
export const auditEvents = appSchema.table(
  "audit_events",
  {
    id: id(),
    organizationId: orgId(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    actorKind: text("actor_kind", { enum: ["user", "agent", "system", "device"] }).notNull(),
    actorId: uuid("actor_id"),
    agentId: uuid("agent_id"),
    userId: uuid("user_id"),
    deviceId: uuid("device_id"),
    sessionId: text("session_id"),
    clientKind: text("client_kind"),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    action: text("action").notNull(),
    result: text("result", { enum: ["success", "denied", "error"] }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    traceId: text("trace_id"),
  },
  (t) => [index("audit_events_org_time_idx").on(t.organizationId, t.occurredAt)],
);

// ---------------------------------------------------------------- realtime

export const streams = appSchema.table(
  "streams",
  {
    id: text("id").primaryKey(), // 'conv:<id>' | 'user:<id>' | 'org:<id>' | 'ws:<id>'
    organizationId: orgId(),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("streams_org_idx").on(t.organizationId)],
);

export const streamEvents = appSchema.table(
  "stream_events",
  {
    streamId: text("stream_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    organizationId: orgId(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    actorUserId: uuid("actor_user_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.streamId, t.seq] }), index("stream_events_org_idx").on(t.organizationId)],
);

// ---------------------------------------------------------------- chat

export const conversations = appSchema.table(
  "conversations",
  {
    id: id(),
    organizationId: orgId(),
    kind: text("kind", { enum: ["channel", "dm", "group", "ai_chat", "thread", "work_session"] }).notNull(),
    name: text("name"),
    slug: text("slug"),
    topic: text("topic"),
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    parentConversationId: uuid("parent_conversation_id"),
    rootMessageId: uuid("root_message_id"),
    createdBy: uuid("created_by"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    /**
     * Direct conversations only (P-06, `dmKeyOf`): every member's `<kind>:<id>` sorted and joined by `|`, ids
     * only. A bot DM keeps the 3.1 form `agent:<botId>|user:<userId>`; a human pair is `user:<a>|user:<b>`; a
     * group lists every member. Unique per organization and kind (`dm` and `group` separately).
     */
    dmKey: text("dm_key"),
    /** Channels only: the department, team or project the sidebar groups it under (CHAT-02); null = org. */
    unitId: uuid("unit_id").references(() => orgUnits.id, { onDelete: "set null" }),
    /**
     * Phase 07.1 (D-01): `board` turns a channel into a board of cards (`boards`, `board_columns`, `board_cards`);
     * every other conversation, and every channel created before, is `text`. Only a `channel` can be a board.
     */
    layout: text("layout", { enum: ["text", "board"] })
      .notNull()
      .default("text"),
  },
  (t) => [
    check("conversations_layout_check", sql`${t.layout} in ('text','board')`),
    check("conversations_layout_kind_check", sql`${t.layout} = 'text' or ${t.kind} = 'channel'`),
    index("conversations_org_kind_idx").on(t.organizationId, t.kind),
    index("conversations_org_unit_idx").on(t.organizationId, t.unitId),
    uniqueIndex("conversations_org_dm_key_uq").on(t.organizationId, t.dmKey).where(sql`kind = 'dm'`),
    uniqueIndex("conversations_org_group_key_uq").on(t.organizationId, t.dmKey).where(sql`kind = 'group'`),
    uniqueIndex("conversations_org_slug_uq")
      .on(t.organizationId, t.slug)
      .where(sql`kind = 'channel' and slug is not null`),
    uniqueIndex("conversations_thread_root_uq")
      .on(t.organizationId, t.rootMessageId)
      .where(sql`root_message_id is not null`),
    /** Phase 07.8: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("conversations_org_id_uq").on(t.organizationId, t.id),
  ],
);

export const conversationMembers = appSchema.table(
  "conversation_members",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    organizationId: orgId(),
    memberKind: text("member_kind", { enum: ["user", "agent"] }).notNull(),
    memberId: uuid("member_id").notNull(),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("member"),
    joinedAt: createdAt(),
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
    /** Per-conversation notification level (CHAT-10); `default` follows the user's prefs and the kind. */
    notifyLevel: text("notify_level", { enum: ["default", "all", "mentions", "nothing"] })
      .notNull()
      .default("default"),
    muted: boolean("muted").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.memberKind, t.memberId] }),
    index("conversation_members_member_idx").on(t.organizationId, t.memberKind, t.memberId),
    check(
      "conversation_members_notify_level_check",
      sql`${t.notifyLevel} in ('default','all','mentions','nothing')`,
    ),
  ],
);

/**
 * Messages. `search_tsv` (a STORED generated tsvector over `body`, three unaccented text search configurations)
 * is hand-written in the chat_workspace migration and deliberately kept OUT of this schema: drizzle has no
 * builder for it, and only the search module reads it, with raw SQL (D-04, ADR-0016).
 */
export const messages = appSchema.table(
  "messages",
  {
    id: id(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** seq of the `message.created` event on the conversation stream. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    authorKind: text("author_kind", { enum: ["user", "agent", "system"] }).notNull(),
    authorId: uuid("author_id"),
    body: text("body").notNull(),
    mentions: jsonb("mentions")
      .$type<Array<{ kind: "user" | "agent" | "unit"; id: string }>>()
      .notNull()
      .default([]),
    status: text("status", { enum: ["sent", "streaming", "completed", "failed"] })
      .notNull()
      .default("sent"),
    /** Root message id when this is a thread reply. */
    threadId: uuid("thread_id"),
    replyCount: integer("reply_count").notNull().default(0),
    lastReplyAt: ts("last_reply_at"),
    clientKind: text("client_kind"),
    sessionId: text("session_id"),
    clientMessageId: text("client_message_id"),
    createdAt: createdAt(),
    editedAt: ts("edited_at"),
    /** Tombstone (P-05): body '' and mentions [] once set; the prior body lives in message_versions. */
    deletedAt: ts("deleted_at"),
    deletedBy: uuid("deleted_by"),
  },
  (t) => [
    index("messages_conv_seq_idx").on(t.organizationId, t.conversationId, t.seq),
    /** Target of `board_cards_message_fk` (Phase 07.1): a card's root message lives in the card's board channel. */
    unique("messages_id_conversation_uq").on(t.id, t.conversationId),
    /** Target of composite keys that carry the organization (FKs bypass RLS), e.g. `agent_chain_hops_question_fk`. */
    unique("messages_org_id_uq").on(t.organizationId, t.id),
    index("messages_thread_idx").on(t.organizationId, t.threadId),
    /** Idempotent posts: the same author + client key (agent idempotencyKey, web clientMessageId) never duplicates. */
    uniqueIndex("messages_author_client_msg_uq")
      .on(t.organizationId, t.authorKind, t.authorId, t.clientMessageId)
      .where(sql`client_message_id is not null`),
  ],
);

// ---------------------------------------------------------------- chat workspace (Phase 4)

/**
 * Append-only history of message edits and deletes (CHAT-06): the body BEFORE each change. `post-migrate.sql`
 * revokes UPDATE, DELETE and TRUNCATE from the app role, so history can only grow.
 */
export const messageVersions = appSchema.table(
  "message_versions",
  {
    id: id(),
    organizationId: orgId(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** `regenerate` (Phase 5): the assistant answer replaced by a regeneration, kept append-only. */
    kind: text("kind", { enum: ["edit", "delete", "regenerate"] }).notNull(),
    body: text("body").notNull(),
    mentions: jsonb("mentions")
      .$type<Array<{ kind: "user" | "agent" | "unit"; id: string }>>()
      .notNull()
      .default([]),
    editedByKind: text("edited_by_kind", { enum: ["user", "agent", "system"] }).notNull(),
    editedBy: uuid("edited_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("message_versions_message_version_uq").on(t.messageId, t.version),
    index("message_versions_org_message_idx").on(t.organizationId, t.messageId),
    check("message_versions_kind_check", sql`${t.kind} in ('edit','delete','regenerate')`),
    check("message_versions_edited_by_kind_check", sql`${t.editedByKind} in ('user','agent','system')`),
  ],
);

/** One row per (message, emoji, reactor) (CHAT-07). */
export const messageReactions = appSchema.table(
  "message_reactions",
  {
    organizationId: orgId(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    emoji: text("emoji").notNull(),
    memberKind: text("member_kind", { enum: ["user", "agent"] }).notNull(),
    memberId: uuid("member_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.emoji, t.memberKind, t.memberId] }),
    index("message_reactions_org_conv_idx").on(t.organizationId, t.conversationId),
    check("message_reactions_emoji_len_check", sql`char_length(${t.emoji}) <= 32`),
    check("message_reactions_member_kind_check", sql`${t.memberKind} in ('user','agent')`),
  ],
);

/** Pinned messages of a conversation (CHAT-13). */
export const messagePins = appSchema.table(
  "message_pins",
  {
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    pinnedBy: uuid("pinned_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.messageId] })],
);

/** Personal saved messages (CHAT-13). */
export const messageSaves = appSchema.table(
  "message_saves",
  {
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    index("message_saves_org_user_idx").on(t.organizationId, t.userId, t.createdAt),
  ],
);

/**
 * In-app notifications (CHAT-08/09/10). Ids and the actor only, never a body or snippet (Pitfall 9): the inbox
 * re-checks access and computes snippets at read time. One per (user, message): the strongest kind wins.
 */
export const notifications = appSchema.table(
  "notifications",
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    kind: text("kind", {
      enum: [
        "mention",
        "channel",
        "here",
        "dm",
        "group_dm",
        "thread_reply",
        "ai_chat_shared",
        "card_updated",
        "team_mention",
      ],
    }).notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    threadRootId: uuid("thread_root_id"),
    actorKind: text("actor_kind", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: uuid("actor_id"),
    createdAt: createdAt(),
    readAt: ts("read_at"),
    /**
     * Phase 07.17 (D-07): the team a `team_mention` names (an id, never its name). Deleting the unit only unlinks it
     * (`ON DELETE SET NULL ("unit_id")`, hand-narrowed in the migration so `organization_id` is never cleared).
     */
    unitId: uuid("unit_id"),
  },
  (t) => [
    foreignKey({
      name: "notifications_unit_fk",
      columns: [t.organizationId, t.unitId],
      foreignColumns: [orgUnits.organizationId, orgUnits.id],
    }).onDelete("set null"),
    uniqueIndex("notifications_user_message_uq").on(t.userId, t.messageId),
    index("notifications_org_user_created_idx").on(t.organizationId, t.userId, t.createdAt),
    index("notifications_unread_idx")
      .on(t.organizationId, t.userId, t.conversationId)
      .where(sql`read_at is null`),
    check(
      "notifications_kind_check",
      sql`${t.kind} in ('mention','channel','here','dm','group_dm','thread_reply','ai_chat_shared','card_updated','team_mention')`,
    ),
    check("notifications_actor_kind_check", sql`${t.actorKind} in ('user','agent','system')`),
  ],
);

/** A user's notification preferences in one organization (CHAT-10); no row = DEFAULT_NOTIFICATION_PREFS. */
export const notificationPrefs = appSchema.table(
  "notification_prefs",
  {
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    dndUntil: ts("dnd_until"),
    desktopEnabled: boolean("desktop_enabled").notNull().default(true),
    webEnabled: boolean("web_enabled").notNull().default(true),
    defaultLevel: text("default_level", { enum: ["all", "mentions", "nothing"] })
      .notNull()
      .default("mentions"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    check("notification_prefs_default_level_check", sql`${t.defaultLevel} in ('all','mentions','nothing')`),
  ],
);

/** Per-user read cursor of a thread (Threads view, CHAT-02). */
export const threadReads = appSchema.table(
  "thread_reads",
  {
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    rootMessageId: uuid("root_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.rootMessageId] })],
);

/**
 * Message attachments (CHAT-12, D-03). Object keys derive from ids only (`org/<org>/conv/<conv>/att/<id>/…`);
 * `filename` is sanitized display text. `pending` until the API verified the upload; swept when abandoned.
 */
export const attachments = appSchema.table(
  "attachments",
  {
    id: id(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Phase 06.1 (P-05): the Work Zone prompt the image was sent with; never set together with `messageId`. */
    workPromptId: uuid("work_prompt_id").references((): AnyPgColumn => workPrompts.id, {
      onDelete: "set null",
    }),
    /** 06.1-02: the image's place in its prompt's request order (0-based); what the device receives and lists show. */
    workPromptPosition: smallint("work_prompt_position"),
    uploaderId: uuid("uploader_id").notNull(),
    filename: text("filename").notNull(),
    /** What the browser declared (and the presigned PUT signed). */
    declaredType: text("declared_type").notNull(),
    /** What the API sniffed from the bytes. */
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    status: text("status", { enum: ["pending", "ready", "rejected", "deleted"] })
      .notNull()
      .default("pending"),
    /** Antivirus scanning is deferred (CONTEXT); the column keeps room for it. */
    scanStatus: text("scan_status", { enum: ["not_scanned"] })
      .notNull()
      .default("not_scanned"),
    width: integer("width"),
    height: integer("height"),
    hasRenditions: boolean("has_renditions").notNull().default(false),
    /** Byte size of the stored `large.webp` rendition, recorded by `complete` (06.1: the prompt budget, no storage call). */
    largeBytes: integer("large_bytes"),
    /**
     * Phase 07.8 (07.8-10, SBX-02): the bot turn (`agent_turns.event_id`) whose `ocw_sandbox_share` stored this file.
     * The row stays `pending` (uploader = the bot) until that turn's reply links it, and is swept like any abandoned
     * upload when no reply comes. Null for every upload made by a person.
     */
    eventId: uuid("event_id"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
    deletedAt: ts("deleted_at"),
    purgedAt: ts("purged_at"),
  },
  (t) => [
    index("attachments_org_conv_idx").on(t.organizationId, t.conversationId),
    index("attachments_org_message_idx").on(t.organizationId, t.messageId),
    index("attachments_org_work_prompt_idx").on(t.organizationId, t.workPromptId),
    index("attachments_org_event_idx").on(t.organizationId, t.eventId).where(sql`event_id is not null`),
    index("attachments_sweep_idx")
      .on(t.status, t.createdAt)
      .where(sql`purged_at is null and status in ('pending','rejected','deleted')`),
    check("attachments_status_check", sql`${t.status} in ('pending','ready','rejected','deleted')`),
    check("attachments_scan_status_check", sql`${t.scanStatus} in ('not_scanned')`),
    check("attachments_one_link_check", sql`${t.messageId} is null or ${t.workPromptId} is null`),
  ],
);

// ---------------------------------------------------------------- agents & models

export const agents = appSchema.table(
  "agents",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    username: text("username").notNull(),
    avatarUrl: text("avatar_url"),
    description: text("description"),
    instructions: text("instructions").notNull(),
    modelProvider: text("model_provider", {
      enum: ["anthropic", "openai", "openrouter", "openai-compatible", "openai-codex", "mock"],
    }).notNull(),
    modelId: text("model_id").notNull(),
    runtime: text("runtime", { enum: ["openclaw"] })
      .notNull()
      .default("openclaw"),
    status: text("status", { enum: ["provisioning", "ready", "error", "disabled"] })
      .notNull()
      .default("provisioning"),
    statusMessage: text("status_message"),
    runtimeRef: jsonb("runtime_ref").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** Soft delete: authored messages keep resolving the agent's name; the username becomes reusable. */
    deletedAt: ts("deleted_at"),
    /** D-01: `team` bots belong to the organization; `personal` bots to `owner_user_id` only. */
    scope: text("scope", { enum: ["team", "personal"] })
      .notNull()
      .default("team"),
    ownerUserId: uuid("owner_user_id"),
    /** D-06 per-bot capability toggles (partial; defaults are filled in code by the capability model). */
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Phase 6 (AGENT-01): the department, team or project a shared bot belongs to; null = the organization.
     * RESTRICT: a unit with bots cannot be deleted, so a unit bot never silently widens to the whole organization.
     */
    unitId: uuid("unit_id").references(() => orgUnits.id, { onDelete: "restrict" }),
    /**
     * Phase 07.4 (D-05, CONN-06): the template and version a personal bot was started from (a fork, never a live link:
     * the owner applies a newer version explicitly). Null for bots not made from a template; a deleted template only
     * unlinks its bots.
     */
    templateId: uuid("template_id").references((): AnyPgColumn => agentTemplates.id, {
      onDelete: "set null",
    }),
    templateVersion: integer("template_version"),
  },
  (t) => [
    uniqueIndex("agents_org_username_uq").on(t.organizationId, t.username).where(sql`deleted_at is null`),
    index("agents_owner_idx")
      .on(t.organizationId, t.ownerUserId)
      .where(sql`scope = 'personal' and deleted_at is null`),
    index("agents_unit_idx").on(t.organizationId, t.unitId).where(sql`deleted_at is null`),
    check("agents_scope_check", sql`${t.scope} in ('team','personal')`),
    // Phase 6 (AGENT-01): a personal bot must have an owner; a shared bot may have one (its accountable owner).
    check("agents_owner_scope_check", sql`(${t.scope} <> 'personal' or ${t.ownerUserId} is not null)`),
    index("agents_template_idx").on(t.organizationId, t.templateId).where(sql`template_id is not null`),
    check("agents_template_version_check", sql`${t.templateVersion} is null or ${t.templateVersion} >= 1`),
    /** Phase 07.5: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("agents_org_id_uq").on(t.organizationId, t.id),
  ],
);

// ---------------------------------------------------------------- bot capabilities (Phase 3.1, D-05 … D-14)

/** Organization bot policy (D-06): one row per org; an absent row means the defaults (allow everything). */
export const botPolicies = appSchema.table(
  "bot_policies",
  {
    organizationId: orgId().primaryKey(),
    /** Per built-in capability `{ orgWide, personal }` (partial; defaults in code). */
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    searchProvider: text("search_provider").notNull().default("duckduckgo"),
    maxPersonalBotsPerUser: integer("max_personal_bots_per_user").notNull().default(3),
    personalDailyLimitMax: integer("personal_daily_limit_max").notNull().default(100),
    /** Empty = every allowed model of the organization. Entries are `provider/modelId`. */
    personalAllowedModels: text("personal_allowed_models").array().notNull().default(sql`'{}'::text[]`),
    /**
     * Phase 07.4 (D-07): private / LAN hosts (`host` or `host:port`) the admin lets keychain requests reach (e.g. an
     * on-premise ERP). Empty = none; personal keys never widen it; platform hosts stay refused by the egress guard.
     */
    egressPrivateHosts: text("egress_private_hosts").array().notNull().default(sql`'{}'::text[]`),
    updatedBy: uuid("updated_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /**
     * Phase 07.6 (Pitfall 1, D-07): the organization's automation caps. How many automations one person may own, the
     * shortest schedule interval, how many inbound items (webhook or mail) one automation may run per hour, and the
     * ceiling of every automation's own `max_runs_per_day`. Phase 07.17 (D-01, D-11, PD-04): every 5 minutes and 288
     * runs a day by default (the migration moved rows still holding the 07.6 defaults 15 / 96; other values stay).
     */
    maxAutomationsPerUser: integer("max_automations_per_user").notNull().default(10),
    minScheduleMinutes: integer("min_schedule_minutes").notNull().default(5),
    maxInboundPerHour: integer("max_inbound_per_hour").notNull().default(30),
    maxRunsPerDayCap: integer("max_runs_per_day_cap").notNull().default(288),
  },
  (t) => [
    check("bot_policies_egress_private_hosts_check", sql`cardinality(${t.egressPrivateHosts}) <= 64`),
    check("bot_policies_max_automations_per_user_check", sql`${t.maxAutomationsPerUser} between 0 and 1000`),
    check("bot_policies_min_schedule_minutes_check", sql`${t.minScheduleMinutes} between 1 and 1440`),
    check("bot_policies_max_inbound_per_hour_check", sql`${t.maxInboundPerHour} between 1 and 3600`),
    check("bot_policies_max_runs_per_day_cap_check", sql`${t.maxRunsPerDayCap} between 1 and 288`),
  ],
);

/** One row per delivered bot turn (D-07): the effective tool set the API shipped in `agent.mention.v1`. */
export const agentTurns = appSchema.table(
  "agent_turns",
  {
    eventId: uuid("event_id").primaryKey(),
    organizationId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    conversationKind: text("conversation_kind").notNull(),
    messageId: uuid("message_id").notNull(),
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    toolFlags: jsonb("tool_flags").$type<Record<string, unknown>>().notNull().default({}),
    toolCalls: integer("tool_calls").notNull().default(0),
    webCalls: integer("web_calls").notNull().default(0),
    tainted: boolean("tainted").notNull().default(false),
    createdAt: createdAt(),
    /**
     * Phase 07.8 (P-06): confined sandbox and browser tool calls of this turn, counted against their own per-turn
     * budget (`SANDBOX_LIMITS.callsPerTurn`), separately from `tool_calls`.
     */
    sandboxCalls: integer("sandbox_calls").notNull().default(0),
    /**
     * Phase 07.15 (D-17): the `ocw_attachment_read` reads of this turn and the UTF-16 characters they returned, counted
     * by the read route against `ATTACHMENT_READ_LIMITS` under a conditional update, separately from `tool_calls` and
     * `sandbox_calls` (attachment reads never consume the confined-tool cap).
     */
    attachmentReads: integer("attachment_reads").notNull().default(0),
    attachmentChars: integer("attachment_chars").notNull().default(0),
    /**
     * Phase 07.8 (P-11, P-18, D-13): a member's sealed browser session was loaded in this turn. From then on the turn's
     * cross-site opens and navigations and its egress-capable execs need the requester's approval, and a team bot's
     * workspace writes are refused.
     */
    memberData: boolean("member_data").notNull().default(false),
    /**
     * Phase 07.7 (A2A-01, D-04, D-14, ADR-0027): the turn's place in an agent-to-agent chain. Plain ledger ids like
     * `message_id` (no foreign key: the ledger outlives a cancelled or deleted chain row). `chain_depth` is 0 for a turn
     * outside any chain and for the root's own turns (its first turn and its return turns), 1 or 2 for a consulted bot's
     * turns. `answering_hop_id` is the hop this turn answers (the target's question turn and its return turns);
     * `returning_hop_id` the hop whose answer, failure or timeout this turn receives; `reply_message_id` this turn's first
     * post (the hop's answer when the turn answers one).
     */
    chainId: uuid("chain_id"),
    chainDepth: smallint("chain_depth").notNull().default(0),
    answeringHopId: uuid("answering_hop_id"),
    returningHopId: uuid("returning_hop_id"),
    replyMessageId: uuid("reply_message_id"),
    /**
     * Phase 07.7 (CR-A-07): when the cell reported this chain turn done (`POST /turns/:eventId/done`, first report
     * only). A chain completes only once no hop is pending and none of its turns still runs (no `done_at`, younger than
     * the hop timeout: an older one is taken as lost). Null for every turn outside a chain.
     */
    doneAt: ts("done_at"),
    /**
     * Phase 07.16 (D-20): this turn read a Work Zone session's output (`ocw_work_session_read`), so what it does next
     * may carry outside content into a session.
     */
    sessionOutputRead: boolean("session_output_read").notNull().default(false),
  },
  (t) => [
    index("agent_turns_org_agent_time_idx").on(t.organizationId, t.agentId, t.createdAt),
    /** The turns of one chain (07.7 completion rule). */
    index("agent_turns_chain_idx").on(t.chainId).where(sql`chain_id is not null`),
    check("agent_turns_sandbox_calls_check", sql`${t.sandboxCalls} >= 0`),
    check("agent_turns_attachment_reads_check", sql`${t.attachmentReads} >= 0`),
    check("agent_turns_attachment_chars_check", sql`${t.attachmentChars} >= 0`),
    check("agent_turns_chain_depth_check", sql`${t.chainDepth} between 0 and 2`),
  ],
);

/**
 * Phase 07.7 (A2A-01, A2A-03, D-03, D-04, D-14, ADR-0027): an agent-to-agent chain, opened by the first consult of a
 * root turn (`root_event_id`, unique) in a channel thread. `human_user_id` is the root turn's human (the run-as person
 * for an automation root): every hop runs and pays as that person. The hop budget is consumed only by the conditional
 * `UPDATE … SET hops_used = hops_used + 1 WHERE status = 'active' AND hops_used < hop_budget`, and the check keeps it
 * from ever going over. `(organization_id, id, root_agent_id)` is the target of the hops' chain key, so a hop's
 * not-root check compares against the chain's real root.
 */
export const agentChains = appSchema.table(
  "agent_chains",
  {
    id: id(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id").notNull(),
    threadRootId: uuid("thread_root_id").notNull(),
    rootEventId: uuid("root_event_id").notNull(),
    rootAgentId: uuid("root_agent_id").notNull(),
    humanUserId: uuid("human_user_id").notNull(),
    status: text("status", { enum: ["active", "completed", "cancelled"] })
      .notNull()
      .default("active"),
    hopBudget: smallint("hop_budget").notNull().default(3),
    hopsUsed: smallint("hops_used").notNull().default(0),
    cancelReason: text("cancel_reason", { enum: ["user", "auto"] }),
    cancelledByUserId: uuid("cancelled_by_user_id"),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("agent_chains_root_event_uq").on(t.rootEventId),
    unique("agent_chains_org_id_root_uq").on(t.organizationId, t.id, t.rootAgentId),
    foreignKey({
      name: "agent_chains_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_chains_root_agent_fk",
      columns: [t.organizationId, t.rootAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    index("agent_chains_conversation_idx").on(t.organizationId, t.conversationId, t.threadRootId),
    /** The `consult.tick` idle sweep (CR-A-06): active chains, least recently touched first. */
    index("agent_chains_active_idx").on(t.updatedAt).where(sql`status = 'active'`),
    check("agent_chains_status_check", sql`${t.status} in ('active','completed','cancelled')`),
    check(
      "agent_chains_cancel_reason_check",
      sql`${t.cancelReason} is null or ${t.cancelReason} in ('user','auto')`,
    ),
    check(
      "agent_chains_budget_check",
      sql`${t.hopBudget} between 1 and 10 and ${t.hopsUsed} between 0 and ${t.hopBudget}`,
    ),
  ],
);

/**
 * Phase 07.7 (A2A-01, A2A-03, D-03, D-04, D-14, ADR-0027): one consult (or handoff) from `source_agent_id` to
 * `target_agent_id`, posted as `question_message_id` in the chain's thread. The loop guards are constraints, never
 * read-then-write: an agent is a target at most once per chain and never the chain's root or itself; depth is 1 (asked
 * by the root, no parent) or 2 (asked by the target of its parent hop, in the same chain); one pending consult per source
 * per chain; one hop per (source, idempotency key). `pending` hops past `deadline_at` are timed out by the one-minute
 * `consult.tick` (`app.expired_agent_chain_hops`, D-11).
 */
export const agentChainHops = appSchema.table(
  "agent_chain_hops",
  {
    id: id(),
    organizationId: orgId(),
    chainId: uuid("chain_id").notNull(),
    rootAgentId: uuid("root_agent_id").notNull(),
    parentHopId: uuid("parent_hop_id"),
    sourceAgentId: uuid("source_agent_id").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    depth: smallint("depth").notNull(),
    mode: text("mode", { enum: ["consult", "handoff"] }).notNull(),
    status: text("status", { enum: ["pending", "answered", "failed", "timed_out", "cancelled", "refused"] })
      .notNull()
      .default("pending"),
    refusalReason: text("refusal_reason"),
    sourceEventId: uuid("source_event_id").notNull(),
    targetEventId: uuid("target_event_id"),
    /** The question message, in the hop's organization (`agent_chain_hops_question_fk`, CR-B-04). */
    questionMessageId: uuid("question_message_id").notNull(),
    answerMessageId: uuid("answer_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    /**
     * CR-A-08: how many times the `consult.tick` failed to time this hop out. Each failure pushes `deadline_at` out
     * (backoff, so newer expired hops are reached first); after the last attempt the hop ends `failed` (`tick_error`).
     */
    tickAttempts: smallint("tick_attempts").notNull().default(0),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("agent_chain_hops_question_uq").on(t.questionMessageId),
    /**
     * Target of `agent_chain_hops_parent_fk`: a depth-2 hop's parent is in its chain, targeted its source, and was asked
     * by the chain's root, so the parent is at depth 1 (`agent_chain_hops_source_depth_check`) and depth ≤ 2 holds in
     * the database (CR-B-01).
     */
    unique("agent_chain_hops_parent_root_key_uq").on(
      t.organizationId,
      t.chainId,
      t.id,
      t.targetAgentId,
      t.sourceAgentId,
    ),
    foreignKey({
      name: "agent_chain_hops_chain_fk",
      columns: [t.organizationId, t.chainId, t.rootAgentId],
      foreignColumns: [agentChains.organizationId, agentChains.id, agentChains.rootAgentId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_chain_hops_parent_fk",
      columns: [t.organizationId, t.chainId, t.parentHopId, t.sourceAgentId, t.rootAgentId],
      foreignColumns: [t.organizationId, t.chainId, t.id, t.targetAgentId, t.sourceAgentId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_chain_hops_question_fk",
      columns: [t.organizationId, t.questionMessageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_chain_hops_source_fk",
      columns: [t.organizationId, t.sourceAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_chain_hops_target_fk",
      columns: [t.organizationId, t.targetAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    unique("agent_chain_hops_target_once").on(t.chainId, t.targetAgentId),
    uniqueIndex("agent_chain_hops_one_pending").on(t.chainId, t.sourceAgentId).where(sql`status = 'pending'`),
    unique("agent_chain_hops_idempotency").on(t.sourceAgentId, t.idempotencyKey),
    index("agent_chain_hops_pending_deadline_idx").on(t.deadlineAt).where(sql`status = 'pending'`),
    index("agent_chain_hops_answer_idx").on(t.answerMessageId).where(sql`answer_message_id is not null`),
    check("agent_chain_hops_not_self", sql`${t.targetAgentId} <> ${t.sourceAgentId}`),
    check("agent_chain_hops_not_root", sql`${t.targetAgentId} <> ${t.rootAgentId}`),
    check("agent_chain_hops_depth_check", sql`${t.depth} between 1 and 2`),
    check("agent_chain_hops_parent_depth_check", sql`(${t.depth} = 1) = (${t.parentHopId} is null)`),
    check(
      "agent_chain_hops_source_depth_check",
      sql`(${t.depth} = 1) = (${t.sourceAgentId} = ${t.rootAgentId})`,
    ),
    check("agent_chain_hops_mode_check", sql`${t.mode} in ('consult','handoff')`),
    check(
      "agent_chain_hops_status_check",
      sql`${t.status} in ('pending','answered','failed','timed_out','cancelled','refused')`,
    ),
    check(
      "agent_chain_hops_refusal_reason_len_check",
      sql`${t.refusalReason} is null or char_length(${t.refusalReason}) <= 64`,
    ),
    check("agent_chain_hops_idempotency_len_check", sql`char_length(${t.idempotencyKey}) between 1 and 200`),
  ],
);

/**
 * Phase 07.8 (07.8-28, WINDOWS #292, ADR-0029): member data is sticky per (bot, conversation). Once a member's sealed
 * browser session was loaded in a turn of this bot in this conversation, the bot's history there (its OpenClaw
 * transcript, its replies in the chat window) may hold what it read signed in, so every later turn of that bot in that
 * conversation starts with `agent_turns.member_data` (the D-11/D-13 floors, download routing, import refusal, P-11).
 * One row per pair; `sites` are the site keys (hosts only) whose sessions were loaded there: the hosts a later turn may
 * open without the requester's cross-site approval. The row goes with the bot or the conversation (the bot's history
 * goes with them); no route reads or lists it.
 */
export const agentMemberData = appSchema.table(
  "agent_member_data",
  {
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    sites: text("sites").array().notNull().default(sql`'{}'::text[]`),
    /** The turn that first loaded a member's session here (`agent_turns.event_id`). */
    firstEventId: uuid("first_event_id").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.agentId, t.conversationId] }),
    // Composite with the organization (FKs bypass RLS, 07.4 #169).
    foreignKey({
      name: "agent_member_data_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_member_data_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    check("agent_member_data_sites_check", sql`cardinality(${t.sites}) <= 64`),
  ],
);

/** Every gated tool call the cell asked about (D-08): decision + outcome, never arguments or results. */
export const agentToolCalls = appSchema.table(
  "agent_tool_calls",
  {
    id: id(),
    organizationId: orgId(),
    eventId: uuid("event_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    userId: uuid("user_id").notNull(),
    tool: text("tool").notNull(),
    /** `vault` (Phase 07.4, D-04): an `ocw_http_request` made with a keychain item; `source_id` = the item. */
    sourceKind: text("source_kind", { enum: ["builtin", "mcp", "plugin", "vault"] }).notNull(),
    sourceId: uuid("source_id"),
    /** Domain (web) or MCP server safe name; never a full URL with query. */
    target: text("target"),
    decision: text("decision", { enum: ["allowed", "denied"] }).notNull(),
    reason: text("reason"),
    status: text("status", { enum: ["ok", "error", "blocked"] }),
    resultCount: integer("result_count"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
    /**
     * Phase 07.5 (D-02, APPROVE-02): the `tool.call` approval whose one-use grant this call consumed (the call ran with
     * the human's approval, taint lifted for it alone). No foreign key: the ledger outlives requests, like its other ids.
     */
    approvalId: uuid("approval_id"),
  },
  (t) => [
    index("agent_tool_calls_org_event_idx").on(t.organizationId, t.eventId),
    check("agent_tool_calls_source_kind_check", sql`${t.sourceKind} in ('builtin','mcp','plugin','vault')`),
    check("agent_tool_calls_decision_check", sql`${t.decision} in ('allowed','denied')`),
    check(
      "agent_tool_calls_status_check",
      sql`${t.status} is null or ${t.status} in ('ok','error','blocked')`,
    ),
  ],
);

/** Daily turn counter per bot (D-11, UTC day), incremented atomically at delivery. */
export const agentUsageDaily = appSchema.table(
  "agent_usage_daily",
  {
    organizationId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    turns: integer("turns").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.agentId, t.day] })],
);

/** Channel limit notices already posted today (D-11: once per conversation per day). */
export const agentLimitNotices = appSchema.table(
  "agent_limit_notices",
  {
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.conversationId, t.day] })],
);

/** Per-(bot, human) memory (D-10), read and written only in that human's DM with the bot. */
export const agentMemories = appSchema.table(
  "agent_memories",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    text: text("text").notNull(),
    sourceEventId: uuid("source_event_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_memories_owner_idx").on(t.organizationId, t.agentId, t.userId, t.createdAt),
    check("agent_memories_text_len_check", sql`char_length(${t.text}) <= 500`),
  ],
);

/** Whose credential an MCP server call uses (`mcp_servers_auth_mode_check`; `ConnectorAuthMode` in contracts). */
const MCP_AUTH_MODES = [
  "org_secret",
  "per_member_oauth",
  "per_member_secret",
  "org_oauth",
  "org_client_credentials",
] as const;

/** 07.14 D-10: the closed organization sign-in failure codes (`ConnectorAuthFailure` in contracts, same order). */
const MCP_AUTH_FAILURES = [
  "https_required",
  "discovery_failed",
  "issuer_mismatch",
  "token_endpoint_untrusted",
  "pkce_unsupported",
  "client_registration_unavailable",
  "scope_rejected",
  "token_exchange_failed",
] as const;

/** A fixed literal list declared in this file as SQL (`'a','b'`), for the checks over its `const` enums. */
const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

/**
 * Admin MCP server registry (D-13). Header values live in `secrets` (kind `mcp_credential`).
 * Phase 07.4 (D-01): `auth_mode` says whose credential a call uses. `org_secret` = the admin-registered headers (every
 * server before 07.4); `per_member_oauth` / `per_member_secret` = each member's own connection
 * (`connector_connections`), called only through the API's connector proxy and never rendered into the cell, so the
 * stdio sandbox (which only gets org headers) can never be per-member.
 * Phase 07.14 (D-01): `org_oauth` / `org_client_credentials` = one account the organization connects
 * (`connector_org_connections`), also called only through the proxy, so the stdio sandbox refuses them too.
 */
export const mcpServers = appSchema.table(
  "mcp_servers",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    /** Immutable OpenClaw server name `m` + 8 hex chars (tool names are `<safe>__<tool>`). */
    safeName: text("safe_name").notNull(),
    transport: text("transport", { enum: ["streamable-http", "sse", "sandboxed-stdio"] }).notNull(),
    url: text("url"),
    sandboxServer: text("sandbox_server"),
    /** `[{ name, secretId }]`: header names with SecretReferences, never values. */
    headers: jsonb("headers").$type<Array<{ name: string; secretId: string }>>().notNull().default([]),
    orgEnabled: boolean("org_enabled").notNull().default(true),
    personalAllowed: boolean("personal_allowed").notNull().default(false),
    trustedChaining: boolean("trusted_chaining").notNull().default(false),
    status: text("status", { enum: ["pending", "probing", "ready", "error"] })
      .notNull()
      .default("pending"),
    statusDetail: text("status_detail"),
    probedAt: ts("probed_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    authMode: text("auth_mode", { enum: MCP_AUTH_MODES }).notNull().default("org_secret"),
    /** `per_member_secret`: the header each member's own key is sent in, and an optional value prefix (`Bearer `). */
    memberHeaderName: text("member_header_name"),
    memberHeaderPrefix: text("member_header_prefix"),
    /** `per_member_oauth`: admin override of the scopes to request; null = the server's challenge / metadata. */
    oauthScopes: text("oauth_scopes").array(),
    /** `per_member_oauth`: whether members can connect (`needs_client` / `https_required` explain why not). */
    oauthStatus: text("oauth_status", { enum: ["ready", "needs_client", "https_required", "error"] }),
    /**
     * `per_member_oauth`: whether OCW identifies itself with its client ID metadata document (an https instance and a
     * supporting authorization server). An admin turns it off when that server cannot read the instance's URL (a
     * private CA, WINDOWS #179); a pre-registered client or dynamic registration is used instead.
     */
    oauthUseCimd: boolean("oauth_use_cimd").notNull().default(true),
    /**
     * 07.14 D-15: the last organization sign-in failure, a closed code, never provider text; cleared on success.
     * Null = no failure recorded (every server before 07.14).
     */
    authFailure: text("auth_failure", { enum: MCP_AUTH_FAILURES }),
  },
  (t) => [
    uniqueIndex("mcp_servers_org_safe_name_uq").on(t.organizationId, t.safeName),
    /** Phase 07.6: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("mcp_servers_org_id_uq").on(t.organizationId, t.id),
    check("mcp_servers_transport_check", sql`${t.transport} in ('streamable-http','sse','sandboxed-stdio')`),
    check("mcp_servers_status_check", sql`${t.status} in ('pending','probing','ready','error')`),
    check("mcp_servers_auth_mode_check", sql`${t.authMode} in (${sqlList(MCP_AUTH_MODES)})`),
    check(
      "mcp_servers_auth_mode_transport_check",
      sql`${t.authMode} = 'org_secret' or ${t.transport} <> 'sandboxed-stdio'`,
    ),
    check(
      "mcp_servers_oauth_status_check",
      sql`${t.oauthStatus} is null or ${t.oauthStatus} in ('ready','needs_client','https_required','error')`,
    ),
    check(
      "mcp_servers_auth_failure_check",
      sql`${t.authFailure} is null or ${t.authFailure} in (${sqlList(MCP_AUTH_FAILURES)})`,
    ),
  ],
);

/** Tools discovered on an MCP server by the cell probe. */
export const mcpServerTools = appSchema.table(
  "mcp_server_tools",
  {
    organizationId: orgId(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    openclawName: text("openclaw_name").notNull(),
    title: text("title"),
    description: text("description"),
    readOnly: boolean("read_only").notNull().default(false),
    destructive: boolean("destructive").notNull().default(false),
    /** Phase 07.4: the tool's JSON input schema from the API-side probe, for `ocw_connector_list` (capped at 16 KB). */
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.name] }),
    check(
      "mcp_server_tools_input_schema_size_check",
      sql`${t.inputSchema} is null or octet_length(${t.inputSchema}::text) <= 16384`,
    ),
  ],
);

/** Marketplace plugins approved for (and installed in) the org's OpenClaw cell (D-14). */
export const cellPlugins = appSchema.table(
  "cell_plugins",
  {
    id: id(),
    organizationId: orgId(),
    packageName: text("package_name").notNull(),
    pluginId: text("plugin_id"),
    version: text("version").notNull(),
    channel: text("channel", { enum: ["official", "community"] }).notNull(),
    publisher: text("publisher"),
    artifactSha256: text("artifact_sha256").notNull(),
    npmIntegrity: text("npm_integrity"),
    artifactUrl: text("artifact_url"),
    risk: text("risk", { enum: ["low", "medium", "high", "refuse"] }).notNull(),
    riskReasons: jsonb("risk_reasons").$type<unknown[]>().notNull().default([]),
    declared: jsonb("declared").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", {
      enum: ["approved", "installing", "installed", "failed", "uninstalling", "uninstalled"],
    }).notNull(),
    statusDetail: text("status_detail"),
    orgEnabled: boolean("org_enabled").notNull().default(true),
    personalAllowed: boolean("personal_allowed").notNull().default(false),
    trustedChaining: boolean("trusted_chaining").notNull().default(false),
    flowId: uuid("flow_id"),
    approvedBy: uuid("approved_by"),
    approvedAt: ts("approved_at"),
    installedAt: ts("installed_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cell_plugins_org_package_uq")
      .on(t.organizationId, t.packageName)
      .where(sql`status <> 'uninstalled'`),
    check("cell_plugins_channel_check", sql`${t.channel} in ('official','community')`),
    check("cell_plugins_risk_check", sql`${t.risk} in ('low','medium','high','refuse')`),
    check(
      "cell_plugins_status_check",
      sql`${t.status} in ('approved','installing','installed','failed','uninstalling','uninstalled')`,
    ),
  ],
);

/** Tools an installed plugin declared. */
export const cellPluginTools = appSchema.table(
  "cell_plugin_tools",
  {
    organizationId: orgId(),
    pluginRowId: uuid("plugin_row_id")
      .notNull()
      .references(() => cellPlugins.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sideEffecting: boolean("side_effecting").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.pluginRowId, t.name] })],
);

/** MCP / plugin tools a bot manager enabled on one bot (BOT-10). */
export const botToolGrants = appSchema.table(
  "bot_tool_grants",
  {
    organizationId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind", { enum: ["mcp", "plugin"] }).notNull(),
    sourceId: uuid("source_id").notNull(),
    toolName: text("tool_name").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.sourceKind, t.sourceId, t.toolName] }),
    check("bot_tool_grants_source_kind_check", sql`${t.sourceKind} in ('mcp','plugin')`),
  ],
);

/** Agent Channel API service tokens (sha256 only). */
export const agentCredentials = appSchema.table(
  "agent_credentials",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["channel_plugin"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("agent_credentials_org_idx").on(t.organizationId)],
);

/** What a sealed `app.secrets` row holds (the `secrets_kind_check` list). */
const SECRET_KINDS = [
  "provider_api_key",
  "mcp_credential",
  "user_model_credential",
  "connector_credential",
  "vault_item",
  "browser_session",
  "webhook_secret",
] as const;

/** Encrypted (AES-256-GCM, OCW_ENCRYPTION_KEY) secrets. Never selected into API responses. */
export const secrets = appSchema.table(
  "secrets",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    /**
     * `user_model_credential` (Phase 5): a member's ChatGPT plan token bundle, sealed with AAD
     * `<orgId>:<userId>:chatgpt_plan` and referenced by `user_model_credentials.secret_id` (never pooled, D-01).
     * `connector_credential` (Phase 07.4, D-01): a member's connector token bundle or key, sealed with AAD
     * `<orgId>:<userId>:connector:<serverId>` and referenced by `connector_connections.secret_id`. Phase 07.14 (D-06):
     * also the organization's own connector account, sealed with AAD `<orgId>:org:connector:<serverId>` and referenced
     * by `connector_org_connections.secret_id` (a member AAD's second segment is a user UUID, never the literal `org`).
     * `vault_item` (Phase 07.4, D-04): a keychain item's value, sealed with AAD `<orgId>:vault:<itemId>` and referenced
     * by `vault_items.secret_ref`.
     * `browser_session` (Phase 07.8, D-08, P-09): a member's browser storage state for one site and bot, sealed with AAD
     * `<orgId>:<userId>:browser:<agentId>:<siteKey>` and referenced by `browser_sessions.secret_id` (owner-only).
     * `webhook_secret` (Phase 07.6, D-02, D-07): an inbound webhook endpoint's Standard Webhooks signing secret,
     * referenced by `webhook_endpoints.secret_id` / `previous_secret_id` (never returned after creation or rotation).
     */
    kind: text("kind", { enum: SECRET_KINDS }).notNull(),
    provider: text("provider"),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("secrets_org_idx").on(t.organizationId),
    /** Phase 07.8: the kinds are a database check too (until then only this enum held them). */
    check("secrets_kind_check", sql`${t.kind} in (${sql.raw(SECRET_KINDS.map((k) => `'${k}'`).join(","))})`),
    /** Phase 07.8: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("secrets_org_id_uq").on(t.organizationId, t.id),
  ],
);

export const modelProviders = appSchema.table(
  "model_providers",
  {
    id: id(),
    organizationId: orgId(),
    provider: text("provider", {
      enum: ["anthropic", "openai", "openrouter", "openai-compatible", "openai-codex", "mock"],
    }).notNull(),
    /**
     * Legacy pointer to the sealed key. Kept through Phase 5 so the `provider_secret_refs` backfill can be rolled
     * back; dropped by the follow-up in .planning/todos/pending/2026-10-06-drop-model-providers-secret-id.md.
     */
    secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
    /**
     * Where the provider key lives (D-07, AGENTS principle 8): a `SecretReference`. UI-entered keys are
     * `{provider: "db", secretId, organizationId}` (the sealed row in app.secrets); operators may point at `env`
     * or `file`. Keys are resolved only through the secrets module. Null = no key.
     */
    secretRef: jsonb("secret_ref").$type<
      | { provider: "env"; key: string }
      | { provider: "file"; path: string }
      | { provider: "db"; secretId: string; organizationId: string }
    >(),
    /** Last 4 chars of the API key, for display only. */
    keyHint: text("key_hint"),
    /** Required for openai-compatible; optional override otherwise. */
    baseUrl: text("base_url"),
    allowedModels: text("allowed_models").array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Subscription providers (`openai-codex`) only: who is signed in, as reported by the OpenClaw cell.
     * Identity metadata, never tokens (those stay in the cell's own auth store). Null for API-key rows.
     */
    account: jsonb("account").$type<{
      email: string | null;
      planType: string | null;
      connectedAt: string;
      needsReconnect: boolean;
    }>(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("model_providers_org_provider_uq").on(t.organizationId, t.provider)],
);

// ---------------------------------------------------------------- devices & projects

/** The permission mode ladder (P-03); every mode column carries this check. */
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "fullAccess"] as const;
const modeCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} in ('default','acceptEdits','plan','auto','fullAccess')`);

export const devices = appSchema.table(
  "devices",
  {
    id: id(),
    organizationId: orgId(),
    ownerUserId: uuid("owner_user_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status", { enum: ["online", "offline"] })
      .notNull()
      .default("offline"),
    lastSeenAt: ts("last_seen_at"),
    runtimeInfo: jsonb("runtime_info").$type<unknown[]>().notNull().default([]),
    daemonVersion: text("daemon_version"),
    /** The owner lets other org members start sessions on this device. */
    shared: boolean("shared").notNull().default(false),
    /** The owner's LOCAL full-access opt-in, written only from the device's own hello/capabilities (ADR-0012). */
    fullAccessOptIn: boolean("full_access_opt_in").notNull().default(false),
    /** Cap for everyone when `shared`, and the controller floor bound (P-06, P-07). */
    shareMaxMode: text("share_max_mode", { enum: PERMISSION_MODES }).notNull().default("acceptEdits"),
    /** `RuntimeCatalog[]` from the device's last `capabilities` frame (P-05). */
    runtimeCatalog: jsonb("runtime_catalog").$type<unknown[]>().notNull().default([]),
    /**
     * The device's last `runtime.maintenance` snapshot, written only from the device socket (07.11 PD-04); null =
     * never reported.
     */
    runtimeMaintenance: jsonb("runtime_maintenance").$type<unknown>(),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
    /**
     * Phase 07.16 (D-03, D-19, PD-18): how the daemon runs, `desktop` (beside the desktop app) or `service` (a headless
     * systemd/launchd service); null = an older daemon that never said. Written only from the device's own
     * hello/capabilities frames, never from a web route (as `full_access_opt_in`).
     */
    hostKind: text("host_kind", { enum: ["desktop", "service"] }),
    /**
     * Phase 07.16 (D-08, D-19, PD-18): the owner marked this host as an isolated server on the device itself. Written
     * only from the device's own frames; honoured only when `host_kind = 'service'`.
     */
    isolatedServer: boolean("isolated_server").notNull().default(false),
  },
  (t) => [
    index("devices_org_idx").on(t.organizationId),
    modeCheck("devices_share_max_mode_ck", t.shareMaxMode),
    check("devices_host_kind_ck", sql`${t.hostKind} in ('desktop','service')`),
    /** Phase 07.5: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("devices_org_id_uq").on(t.organizationId, t.id),
  ],
);

/**
 * Who a device is shared with, each with a max permission mode (P-06, ADR-0012). Removing a grant sets
 * `revoked_at` (soft revocation) so a revoked principal can be told apart from one never listed (P-07).
 */
export const deviceGrants = appSchema.table(
  "device_grants",
  {
    organizationId: orgId(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    principalKind: text("principal_kind", { enum: ["user", "unit"] }).notNull(),
    principalId: uuid("principal_id").notNull(),
    maxMode: text("max_mode", { enum: PERMISSION_MODES }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.principalKind, t.principalId] }),
    index("device_grants_principal_idx").on(t.organizationId, t.principalKind, t.principalId),
    check("device_grants_principal_kind_ck", sql`${t.principalKind} in ('user','unit')`),
    modeCheck("device_grants_max_mode_ck", t.maxMode),
  ],
);

/** Organization Work Zone policy (D-02, D-11): one row per org; an absent row means the defaults. */
export const workZonePolicies = appSchema.table(
  "work_zone_policies",
  {
    organizationId: orgId().primaryKey(),
    allowedPermissionModes: text("allowed_permission_modes")
      .array()
      .notNull()
      .default(sql`'{plan,default,acceptEdits,auto}'::text[]`),
    allowFullAccess: boolean("allow_full_access").notNull().default(false),
    /** `{ "claude-code": string[], codex: string[] }` (partial; `[]` = every reported model). */
    allowedModels: jsonb("allowed_models").$type<Record<string, unknown>>().notNull().default({}),
    /** `{ "claude-code": effort | null, codex: effort | null }` (partial; absent = no cap). */
    maxEffort: jsonb("max_effort").$type<Record<string, unknown>>().notNull().default({}),
    allowFastMode: boolean("allow_fast_mode").notNull().default(false),
    /** Phase 07.11 (D-02): the devices' runtime CLI updates level; a device can only lower it. */
    runtimeUpdates: text("runtime_updates", { enum: ["automatic", "notify", "off"] })
      .notNull()
      .default("automatic"),
    updatedBy: uuid("updated_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /**
     * Phase 07.16 (D-15, PD-22): the most bot-started sessions active at once in the organization; 0 = bots never start
     * sessions (the admin's kill switch).
     */
    botSessionsMax: integer("bot_sessions_max").notNull().default(10),
  },
  (t) => [
    check("work_zone_policies_runtime_updates_ck", sql`${t.runtimeUpdates} in ('automatic','notify','off')`),
    check("work_zone_policies_bot_sessions_max_ck", sql`${t.botSessionsMax} between 0 and 1000`),
  ],
);

export const deviceEnrollments = appSchema.table(
  "device_enrollments",
  {
    codeHash: text("code_hash").primaryKey(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("device_enrollments_org_idx").on(t.organizationId)],
);

/** NO absolute path column, ever (AGENTS principle 7). `local_id` is the daemon's opaque id. */
export const projects = appSchema.table(
  "projects",
  {
    id: id(),
    organizationId: orgId(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    localId: text("local_id").notNull(),
    name: text("name").notNull(),
    gitRemote: text("git_remote"),
    defaultBranch: text("default_branch"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    /** Set when the device stops announcing the project; sessions keep their history. */
    removedAt: ts("removed_at"),
  },
  (t) => [
    uniqueIndex("projects_device_local_uq").on(t.deviceId, t.localId),
    /** Phase 07.5: target of composite foreign keys that carry the organization and the project's device. */
    unique("projects_org_id_device_uq").on(t.organizationId, t.id, t.deviceId),
  ],
);

// ---------------------------------------------------------------- work sessions

export const workSessions = appSchema.table(
  "work_sessions",
  {
    id: id(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    runtime: text("runtime", { enum: ["claude-code", "codex"] })
      .notNull()
      .default("claude-code"),
    model: text("model"),
    /** Requested (authorized) session mode (P-04). */
    permissionMode: text("permission_mode", { enum: PERMISSION_MODES }).notNull().default("default"),
    status: text("status", {
      enum: [
        "provisioning",
        "idle",
        "running",
        "waiting_approval",
        "host_offline",
        "completed",
        "failed",
        "archived",
      ],
    })
      .notNull()
      .default("provisioning"),
    title: text("title").notNull(),
    /**
     * Where the title came from (D-19, P-14): `user` typed it (never replaced), `heuristic` is the prompt's first
     * line (an automatic title may replace it once), `auto` was generated on the device. The default is the
     * protected value, so rows created before this column are never retitled.
     */
    titleSource: text("title_source", { enum: ["user", "heuristic", "auto"] })
      .notNull()
      .default("user"),
    createdBy: uuid("created_by").notNull(),
    runtimeSessionId: text("runtime_session_id"),
    worktree: boolean("worktree").notNull().default(false),
    branch: text("branch"),
    /** Highest device localSeq stored for this session (Device Link replay de-duplication). */
    lastLocalSeq: bigint("last_local_seq", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    /** Other requested settings: `{ effort?, contextWindow?, fastMode? }` (P-04). */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    /** What the device last reported (`EffectiveSessionSettings`). */
    effectiveSettings: jsonb("effective_settings").$type<Record<string, unknown>>(),
    /** A change was accepted and the device has not reported it yet (D-14). */
    settingsPending: boolean("settings_pending").notNull().default(false),
    /** `DiffStat` of the last `diff.result`. */
    diffStat: jsonb("diff_stat").$type<{ files: number; additions: number; deletions: number }>(),
    /**
     * Phase 07.9 (D-04): who sees and follows the session, always within project access. `owner` = its creator only;
     * `project` = everyone with access to its project; `teams` / `people` = the active `work_session_grants` rows (plus
     * the creator). The rule lives only in `app.work_session_access` (post-migrate.sql), never in a copy.
     */
    visibility: text("visibility", { enum: ["owner", "project", "teams", "people"] })
      .notNull()
      .default("project"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /**
     * Phase 07.16 (D-06): the bot that started this session for its sponsor (`created_by`); null for every session a
     * person started. A bot controls only the sessions it started; a deleted bot only unlinks.
     */
    startedByAgentId: uuid("started_by_agent_id"),
    /**
     * Phase 07.16 (D-08): when outside content first entered the runtime's context. Sticky (never cleared), so later
     * Full access turns need an isolated server.
     */
    taintedAt: ts("tainted_at"),
  },
  (t) => [
    index("work_sessions_org_idx").on(t.organizationId, t.projectId),
    // 06.1: attachment routes find the session of a `work_session` conversation on every preview.
    index("work_sessions_conversation_idx").on(t.organizationId, t.conversationId),
    modeCheck("work_sessions_permission_mode_ck", t.permissionMode),
    check("work_sessions_title_source_ck", sql`${t.titleSource} in ('user','heuristic','auto')`),
    check("work_sessions_visibility_ck", sql`${t.visibility} in ('owner','project','teams','people')`),
    /** Phase 07.5: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("work_sessions_org_id_uq").on(t.organizationId, t.id),
    // Phase 07.16: composite with the organization (FKs bypass RLS). The migration narrows the action to
    // `SET NULL ("started_by_agent_id")` (no drizzle builder for the column list), so a deleted bot never nulls
    // `organization_id`.
    foreignKey({
      name: "work_sessions_started_by_agent_fk",
      columns: [t.organizationId, t.startedByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("set null"),
    index("work_sessions_started_by_agent_idx")
      .on(t.organizationId, t.startedByAgentId)
      .where(sql`started_by_agent_id is not null`),
  ],
);

// ---------------------------------------------------------------- team projects and session audiences (Phase 07.9)
//
// A team project is an `org_units` row of kind `project` (D-01): its direct members are `unit_memberships`, its
// assigned teams are `work_project_teams`, and device repos (`projects`) link to it through `work_project_repos`. A repo
// with no link stays a personal project of its device. Every reference is composite with the organization (FKs bypass
// RLS, 07.4 #169); tenant isolation comes from post-migrate. Who may see what is decided only by the SQL functions in
// post-migrate.sql (`app.work_project_access`, `app.work_session_access`, …), never by reading these rows directly.

/** D-03: the project's default audience for new sessions. An absent row means `project` (on). */
export const workProjectSettings = appSchema.table(
  "work_project_settings",
  {
    organizationId: orgId(),
    unitId: uuid("unit_id").primaryKey(),
    defaultVisibility: text("default_visibility", { enum: ["project", "owner"] })
      .notNull()
      .default("project"),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "work_project_settings_unit_fk",
      columns: [t.organizationId, t.unitId],
      foreignColumns: [orgUnits.organizationId, orgUnits.id],
    }).onDelete("cascade"),
    check("work_project_settings_default_ck", sql`${t.defaultVisibility} in ('project','owner')`),
  ],
);

/**
 * D-01, D-02: the teams (or departments, and so their subtrees) assigned to a team project; their members have project
 * access. Unassigning deletes the row (audited by the API); `teams` grants of a team no longer assigned grant nothing.
 */
export const workProjectTeams = appSchema.table(
  "work_project_teams",
  {
    organizationId: orgId(),
    projectUnitId: uuid("project_unit_id").notNull(),
    teamUnitId: uuid("team_unit_id").notNull(),
    assignedBy: uuid("assigned_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectUnitId, t.teamUnitId] }),
    foreignKey({
      name: "work_project_teams_project_fk",
      columns: [t.organizationId, t.projectUnitId],
      foreignColumns: [orgUnits.organizationId, orgUnits.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_project_teams_team_fk",
      columns: [t.organizationId, t.teamUnitId],
      foreignColumns: [orgUnits.organizationId, orgUnits.id],
    }).onDelete("cascade"),
    index("work_project_teams_team_idx").on(t.organizationId, t.teamUnitId),
    check("work_project_teams_not_self_ck", sql`${t.projectUnitId} <> ${t.teamUnitId}`),
  ],
);

/**
 * D-01: a device repo linked to a team project (one team project per repo). The link is the Control Plane's, the repo
 * row stays the device's (`syncProjects`): a removed device or repo takes its link with it, while a project unit with a
 * linked repo cannot be deleted (RESTRICT; the API answers `unit_has_repositories`).
 */
export const workProjectRepos = appSchema.table(
  "work_project_repos",
  {
    organizationId: orgId(),
    projectId: uuid("project_id").primaryKey(),
    deviceId: uuid("device_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    linkedBy: uuid("linked_by").notNull(),
    linkedAt: ts("linked_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "work_project_repos_project_fk",
      columns: [t.organizationId, t.projectId, t.deviceId],
      foreignColumns: [projects.organizationId, projects.id, projects.deviceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_project_repos_unit_fk",
      columns: [t.organizationId, t.unitId],
      foreignColumns: [orgUnits.organizationId, orgUnits.id],
    }).onDelete("restrict"),
    index("work_project_repos_unit_idx").on(t.organizationId, t.unitId),
  ],
);

/**
 * D-04: the selected teams (`unit`) or people (`user`) of a `teams` / `people` audience, stored like `ai_chat_grants`:
 * at most one active row per (session, subject); a revoked row keeps the history and frees the slot. Rows grant
 * nothing outside project access (a person who left, a team no longer assigned), although they stay.
 */
export const workSessionGrants = appSchema.table(
  "work_session_grants",
  {
    id: id(),
    organizationId: orgId(),
    workSessionId: uuid("work_session_id").notNull(),
    subjectKind: text("subject_kind", { enum: ["user", "unit"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    grantedBy: uuid("granted_by").notNull(),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    foreignKey({
      name: "work_session_grants_session_fk",
      columns: [t.organizationId, t.workSessionId],
      foreignColumns: [workSessions.organizationId, workSessions.id],
    }).onDelete("cascade"),
    uniqueIndex("work_session_grants_active_uq")
      .on(t.workSessionId, t.subjectKind, t.subjectId)
      .where(sql`revoked_at is null`),
    index("work_session_grants_session_idx")
      .on(t.organizationId, t.workSessionId)
      .where(sql`revoked_at is null`),
    index("work_session_grants_subject_idx")
      .on(t.organizationId, t.subjectKind, t.subjectId)
      .where(sql`revoked_at is null`),
    check("work_session_grants_subject_kind_ck", sql`${t.subjectKind} in ('user','unit')`),
  ],
);

export const workPrompts = appSchema.table(
  "work_prompts",
  {
    id: id(),
    organizationId: orgId(),
    workSessionId: uuid("work_session_id")
      .notNull()
      .references(() => workSessions.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").notNull(),
    originDeviceId: uuid("origin_device_id"),
    body: text("body").notNull(),
    status: text("status", { enum: ["queued", "dispatched", "running", "completed", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    position: integer("position").notNull(),
    /** The authorized mode this turn was dispatched with (P-04, P-07); null before dispatch. */
    permissionMode: text("permission_mode", { enum: PERMISSION_MODES }),
    createdAt: createdAt(),
    dispatchedAt: ts("dispatched_at"),
    completedAt: ts("completed_at"),
    /**
     * Phase 07.5 (D-03, APPROVE-03): the bot whose Work Zone proposal this prompt started ("Ana · proposed by @bot");
     * `author_user_id` is the person who started it. Null for every prompt a person wrote; a deleted bot only unlinks.
     */
    proposedByAgentId: uuid("proposed_by_agent_id"),
    /**
     * Phase 07.16 (D-06): the bot that wrote this prompt itself ("@bot for Ana"); `author_user_id` stays its sponsor.
     * Null for every prompt a person wrote; never set together with `proposed_by_agent_id`; a deleted bot only unlinks.
     */
    authorAgentId: uuid("author_agent_id"),
    /** Phase 07.16 (D-08): the prompt carried outside content into the session (shown to people in its history). */
    tainted: boolean("tainted").notNull().default(false),
  },
  (t) => [
    index("work_prompts_session_idx").on(t.organizationId, t.workSessionId, t.position),
    modeCheck("work_prompts_permission_mode_ck", t.permissionMode),
    // Composite with the organization (FKs bypass RLS). The migration narrows the action to
    // `SET NULL ("proposed_by_agent_id")` (PostgreSQL 15+; drizzle 1.0.0-rc.4 has no builder for the column list), so a
    // deleted bot never nulls `organization_id`.
    foreignKey({
      name: "work_prompts_proposed_by_agent_fk",
      columns: [t.organizationId, t.proposedByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("set null"),
    index("work_prompts_proposed_by_idx")
      .on(t.organizationId, t.proposedByAgentId)
      .where(sql`proposed_by_agent_id is not null`),
    // Phase 07.16: narrowed to `SET NULL ("author_agent_id")` in the migration, as the proposer key above.
    foreignKey({
      name: "work_prompts_author_agent_fk",
      columns: [t.organizationId, t.authorAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("set null"),
    index("work_prompts_author_agent_idx")
      .on(t.organizationId, t.authorAgentId)
      .where(sql`author_agent_id is not null`),
    check("work_prompts_agent_author_ck", sql`${t.authorAgentId} is null or ${t.proposedByAgentId} is null`),
  ],
);

export const workApprovals = appSchema.table(
  "work_approvals",
  {
    id: id(),
    organizationId: orgId(),
    workSessionId: uuid("work_session_id")
      .notNull()
      .references(() => workSessions.id, { onDelete: "cascade" }),
    request: jsonb("request").$type<{ tool: string; summary: string; paths: string[] }>().notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "expired"] })
      .notNull()
      .default("pending"),
    decidedBy: uuid("decided_by"),
    decision: text("decision", { enum: ["once", "session", "deny", "expired"] }),
    comment: text("comment"),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("work_approvals_session_idx").on(t.organizationId, t.workSessionId)],
);

// ---------------------------------------------------------------- bot Work Zone orchestration (Phase 07.16)
//
// A bot with a Work Zone profile starts and drives sessions for its sponsor on one consented device. Bots without a
// profile behave exactly as before (D-16). Every reference is composite with the organization (FKs bypass RLS, 07.4
// #169); tenant isolation comes from post-migrate, `bot_work_sessions` also follows its session's audience there. No
// column holds prompt text, output, a title or a path (ids, flags, limits and counters only).

/**
 * D-01, D-02, D-15, PD-22: a bot's Work Zone profile, at most one per bot. The sponsor is the member the bot works for
 * (`work_sessions.created_by` of what it starts); the device is the one machine it may use. Allowed lists empty = every
 * value the runtime reports within the member's own controls. The limits are per bot; the org cap is
 * `work_zone_policies.bot_sessions_max`. `act_on_outside_content` is the sponsor's explicit opt-in (D-07), with who set it.
 */
export const botWorkZoneProfiles = appSchema.table(
  "bot_work_zone_profiles",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    sponsorUserId: uuid("sponsor_user_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    runtime: text("runtime", { enum: ["claude-code", "codex"] }).notNull(),
    defaultModel: text("default_model"),
    allowedModels: text("allowed_models").array().notNull().default(sql`'{}'::text[]`),
    defaultEffort: text("default_effort"),
    allowedEfforts: text("allowed_efforts").array().notNull().default(sql`'{}'::text[]`),
    defaultContextWindow: text("default_context_window"),
    allowedContextWindows: text("allowed_context_windows").array().notNull().default(sql`'{}'::text[]`),
    fastMode: text("fast_mode", { enum: ["off", "allowed", "on"] })
      .notNull()
      .default("off"),
    defaultMode: text("default_mode", { enum: PERMISSION_MODES }).notNull().default("default"),
    maxMode: text("max_mode", { enum: PERMISSION_MODES }).notNull().default("default"),
    worktree: boolean("worktree").notNull().default(true),
    maxConcurrent: smallint("max_concurrent").notNull().default(2),
    promptsPerHour: smallint("prompts_per_hour").notNull().default(30),
    wakesPerSessionDay: smallint("wakes_per_session_day").notNull().default(20),
    actOnOutsideContent: boolean("act_on_outside_content").notNull().default(false),
    actOnOutsideContentBy: uuid("act_on_outside_content_by"),
    actOnOutsideContentAt: ts("act_on_outside_content_at"),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: uuid("updated_by").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("bot_work_zone_profiles_agent_uq").on(t.organizationId, t.agentId),
    /** Target of the bot session's profile key. */
    unique("bot_work_zone_profiles_org_id_uq").on(t.organizationId, t.id),
    /** Target of the profile projects' key: pins every allowed project to the profile's device. */
    unique("bot_work_zone_profiles_org_id_device_uq").on(t.organizationId, t.id, t.deviceId),
    foreignKey({
      name: "bot_work_zone_profiles_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bot_work_zone_profiles_device_fk",
      columns: [t.organizationId, t.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }).onDelete("cascade"),
    index("bot_work_zone_profiles_device_idx").on(t.organizationId, t.deviceId),
    check("bot_work_zone_profiles_runtime_ck", sql`${t.runtime} in ('claude-code','codex')`),
    check("bot_work_zone_profiles_fast_mode_ck", sql`${t.fastMode} in ('off','allowed','on')`),
    modeCheck("bot_work_zone_profiles_default_mode_ck", t.defaultMode),
    modeCheck("bot_work_zone_profiles_max_mode_ck", t.maxMode),
    check("bot_work_zone_profiles_max_concurrent_ck", sql`${t.maxConcurrent} between 1 and 10`),
    check("bot_work_zone_profiles_prompts_per_hour_ck", sql`${t.promptsPerHour} between 1 and 120`),
    check("bot_work_zone_profiles_wakes_per_session_day_ck", sql`${t.wakesPerSessionDay} between 0 and 100`),
  ],
);

/**
 * D-01: the projects (device repos) a profile may open. Both keys carry the profile's device, so a repo of another
 * device is unrepresentable; a removed repo, device or profile takes its rows with it. At most 50 per profile (API).
 */
export const botWorkZoneProfileProjects = appSchema.table(
  "bot_work_zone_profile_projects",
  {
    organizationId: orgId(),
    profileId: uuid("profile_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    projectId: uuid("project_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.projectId] }),
    foreignKey({
      name: "bot_work_zone_profile_projects_profile_fk",
      columns: [t.organizationId, t.profileId, t.deviceId],
      foreignColumns: [
        botWorkZoneProfiles.organizationId,
        botWorkZoneProfiles.id,
        botWorkZoneProfiles.deviceId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "bot_work_zone_profile_projects_project_fk",
      columns: [t.organizationId, t.projectId, t.deviceId],
      foreignColumns: [projects.organizationId, projects.id, projects.deviceId],
    }).onDelete("cascade"),
    index("bot_work_zone_profile_projects_project_idx").on(t.organizationId, t.projectId),
  ],
);

/**
 * D-03, D-04: the device owner's consent that a bot may run sessions on the device, and whether it may use Full access
 * there. Soft revocation like `device_grants`: revoking sets `revoked_at`, so at most one live consent per (device, bot)
 * and the history stays.
 */
export const deviceBotConsents = appSchema.table(
  "device_bot_consents",
  {
    id: id(),
    organizationId: orgId(),
    deviceId: uuid("device_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    allowFullAccess: boolean("allow_full_access").notNull().default(false),
    grantedBy: uuid("granted_by").notNull(),
    grantedAt: ts("granted_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    foreignKey({
      name: "device_bot_consents_device_fk",
      columns: [t.organizationId, t.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "device_bot_consents_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    uniqueIndex("device_bot_consents_live_uq")
      .on(t.organizationId, t.deviceId, t.agentId)
      .where(sql`revoked_at is null`),
    index("device_bot_consents_agent_idx").on(t.organizationId, t.agentId).where(sql`revoked_at is null`),
  ],
);

/**
 * D-05, D-09, D-10, D-17: the bot side of a bot-started session, kept off the hot `work_sessions` row and its DTO. Where
 * it was asked for (the origin conversation, thread, message and turn: the card and the back link), who asked
 * (`requester_user_id`) and for whom it runs (`sponsor_user_id`), the live card, and the wake state (pending flag, the
 * day's budget, the last status and prompt a wake was sent for). Follows its session's audience (post-migrate backstop).
 * A deleted profile only unlinks; a deleted bot, session or origin conversation removes the row.
 */
export const botWorkSessions = appSchema.table(
  "bot_work_sessions",
  {
    workSessionId: uuid("work_session_id").primaryKey(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    profileId: uuid("profile_id"),
    sponsorUserId: uuid("sponsor_user_id").notNull(),
    requesterUserId: uuid("requester_user_id").notNull(),
    originConversationId: uuid("origin_conversation_id").notNull(),
    originThreadRootId: uuid("origin_thread_root_id"),
    originMessageId: uuid("origin_message_id").notNull(),
    originEventId: uuid("origin_event_id").notNull(),
    cardMessageId: uuid("card_message_id"),
    wakePending: boolean("wake_pending").notNull().default(false),
    wakesDay: date("wakes_day", { mode: "string" }),
    wakesUsed: smallint("wakes_used").notNull().default(0),
    lastWokenStatus: text("last_woken_status"),
    lastWokenPromptId: uuid("last_woken_prompt_id"),
    stoppedByAgent: boolean("stopped_by_agent").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "bot_work_sessions_session_fk",
      columns: [t.organizationId, t.workSessionId],
      foreignColumns: [workSessions.organizationId, workSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bot_work_sessions_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    // Narrowed to `SET NULL ("profile_id")` in the migration (no drizzle builder for the column list).
    foreignKey({
      name: "bot_work_sessions_profile_fk",
      columns: [t.organizationId, t.profileId],
      foreignColumns: [botWorkZoneProfiles.organizationId, botWorkZoneProfiles.id],
    }).onDelete("set null"),
    foreignKey({
      name: "bot_work_sessions_origin_conversation_fk",
      columns: [t.organizationId, t.originConversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    index("bot_work_sessions_agent_idx").on(t.organizationId, t.agentId),
    check("bot_work_sessions_wakes_used_ck", sql`${t.wakesUsed} >= 0`),
  ],
);

/**
 * Server → device command queue (Device Link). At-least-once: every command not yet acked is redelivered,
 * in order, when the device reconnects; the daemon treats a repeated id as done.
 */
export const deviceCommands = appSchema.table(
  "device_commands",
  {
    id: id(),
    organizationId: orgId(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    workSessionId: uuid("work_session_id").references(() => workSessions.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "session.start",
        "prompt",
        "interrupt",
        "approval.resolve",
        "session.stop",
        "diff.request",
        "session.configure",
        "session.title",
        "runtime.update",
      ],
    }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["pending", "sent", "acked", "failed"] })
      .notNull()
      .default("pending"),
    error: text("error"),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
    ackedAt: ts("acked_at"),
  },
  (t) => [index("device_commands_device_status_idx").on(t.organizationId, t.deviceId, t.status, t.createdAt)],
);

/**
 * Runtime CLI update history (Phase 07.11, D-06, PD-04): one row per "Update now" request and per run a device
 * reports. "Update now" inserts a `requested` row (`command_id`, `requested_by`); the device's `started` frame carrying
 * that command id adopts it (`run_id`); runs without a command id insert their own row; replays are idempotent by
 * `run_id`. Rows are written only by the device module. No column ever holds a host path (principle 7).
 */
export const deviceRuntimeUpdates = appSchema.table(
  "device_runtime_updates",
  {
    id: id(),
    organizationId: orgId(),
    deviceId: uuid("device_id").notNull(),
    runtime: text("runtime", { enum: ["claude-code", "codex"] }).notNull(),
    /** Device-generated run id; null while only requested. */
    runId: uuid("run_id"),
    /** The `runtime.update` command of an "Update now" request. */
    commandId: uuid("command_id"),
    trigger: text("trigger", { enum: ["automatic", "manual", "local"] }).notNull(),
    requestedBy: uuid("requested_by"),
    state: text("state", {
      enum: [
        "requested",
        "started",
        "succeeded",
        "unchanged",
        "failed",
        "skipped_broken",
        "refused",
        "expired",
      ],
    }).notNull(),
    fromVersion: text("from_version"),
    toVersion: text("to_version"),
    candidate: text("candidate"),
    method: text("method"),
    output: text("output"),
    error: text("error"),
    requestedAt: ts("requested_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "device_runtime_updates_device_fk",
      columns: [t.organizationId, t.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }).onDelete("cascade"),
    unique("device_runtime_updates_run_uq").on(t.organizationId, t.deviceId, t.runId),
    /** One pending "Update now" per device and runtime (T-07.11-02-03). */
    uniqueIndex("device_runtime_updates_requested_uq")
      .on(t.organizationId, t.deviceId, t.runtime)
      .where(sql`state = 'requested'`),
    index("device_runtime_updates_device_idx").on(t.organizationId, t.deviceId, t.createdAt),
    check("device_runtime_updates_runtime_ck", sql`${t.runtime} in ('claude-code','codex')`),
    check("device_runtime_updates_trigger_ck", sql`${t.trigger} in ('automatic','manual','local')`),
    check(
      "device_runtime_updates_state_ck",
      sql`${t.state} in ('requested','started','succeeded','unchanged','failed','skipped_broken','refused','expired')`,
    ),
    check(
      "device_runtime_updates_output_len_ck",
      sql`${t.output} is null or char_length(${t.output}) <= 4096`,
    ),
    check("device_runtime_updates_error_len_ck", sql`${t.error} is null or char_length(${t.error}) <= 500`),
  ],
);

// ---------------------------------------------------------------- direct AI chat (Phase 5)

/**
 * One row per AI chat (1:1 with an `ai_chat` conversation: private, exactly one `conversation_members` row with
 * role `owner`). Title and archive state live on the conversation (`name`, `archived_at`).
 */
export const aiChats = appSchema.table(
  "ai_chats",
  {
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    organizationId: orgId(),
    ownerUserId: uuid("owner_user_id").notNull(),
    /** ADR-0014 semantics: `user` (renamed), `heuristic` (first words), `auto` (model-generated). */
    titleSource: text("title_source", { enum: ["user", "heuristic", "auto"] })
      .notNull()
      .default("heuristic"),
    instructions: text("instructions").notNull().default(""),
    usePersonalInstructions: boolean("use_personal_instructions").notNull().default(true),
    tools: jsonb("tools").$type<{ web: boolean }>().notNull().default({ web: false }),
    /** The `ModelRef` of the last turn. */
    lastModel: jsonb("last_model").$type<{ backend: string; provider: string; modelId: string }>(),
    lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_chats_owner_activity_idx").on(t.organizationId, t.ownerUserId, t.lastActivityAt),
    check("ai_chats_title_source_check", sql`${t.titleSource} in ('user','heuristic','auto')`),
    check("ai_chats_instructions_len_check", sql`char_length(${t.instructions}) <= 8000`),
  ],
);

/** A member's personal AI chat preferences (instructions, default model, web search default). */
export const aiUserPreferences = appSchema.table(
  "ai_user_preferences",
  {
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    instructions: text("instructions").notNull().default(""),
    defaultModel: jsonb("default_model").$type<{ backend: string; provider: string; modelId: string }>(),
    webDefault: boolean("web_default").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    check("ai_user_preferences_instructions_len_check", sql`char_length(${t.instructions}) <= 8000`),
  ],
);

/**
 * One row per assistant answer attempt (P-07). At most one `running` generation per conversation
 * (`ai_generations_one_running_uq`, inserted in the send transaction → 409). Partial text is flushed here, never
 * to `messages.body`; `instance_id` names the API process holding the AbortController.
 */
export const aiGenerations = appSchema.table(
  "ai_generations",
  {
    id: id(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userMessageId: uuid("user_message_id"),
    assistantMessageId: uuid("assistant_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    requesterUserId: uuid("requester_user_id").notNull(),
    backend: text("backend", { enum: ["chatgpt_plan", "org_key", "mock"] }).notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status", { enum: ["running", "completed", "stopped", "failed", "interrupted"] })
      .notNull()
      .default("running"),
    errorCode: text("error_code"),
    errorParam: text("error_param"),
    finishReason: text("finish_reason"),
    partialText: text("partial_text").notNull().default(""),
    instanceId: text("instance_id").notNull(),
    heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
    webUsed: boolean("web_used").notNull().default(false),
    sourceDomains: text("source_domains").array().notNull().default(sql`'{}'::text[]`),
    truncated: boolean("truncated").notNull().default(false),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("ai_generations_one_running_uq").on(t.conversationId).where(sql`status = 'running'`),
    index("ai_generations_requester_started_idx").on(t.organizationId, t.requesterUserId, t.startedAt),
    index("ai_generations_assistant_message_idx").on(t.organizationId, t.assistantMessageId),
    index("ai_generations_heartbeat_idx").on(t.heartbeatAt).where(sql`status = 'running'`),
    check("ai_generations_backend_check", sql`${t.backend} in ('chatgpt_plan','org_key','mock')`),
    check(
      "ai_generations_status_check",
      sql`${t.status} in ('running','completed','stopped','failed','interrupted')`,
    ),
  ],
);

/**
 * Append-only usage store (D-06, AICHAT-07): one immutable record per generation and kind. Ids only, like
 * audit_events (no foreign key but the organization), so usage survives deleted chats. `post-migrate.sql` revokes
 * UPDATE, DELETE and TRUNCATE from the app role. Never holds prompt or answer text.
 */
export const aiUsageRecords = appSchema.table(
  "ai_usage_records",
  {
    id: id(),
    organizationId: orgId(),
    /** Set for `chat` and `title` (one record per generation and kind); null for the Phase 07.6 kinds. */
    generationId: uuid("generation_id"),
    /**
     * Phase 07.6 (D-05, D-06, P-16): `digest` (a digest's optional summary, paid by its person) and `session_summary`
     * (a Work Zone session's memory summary, paid by the session's owner) are not chat generations: they carry the
     * `subject_id` they were made for (the automation run, the work session) instead of a generation and conversation.
     */
    kind: text("kind", { enum: ["chat", "title", "digest", "session_summary"] }).notNull(),
    requesterUserId: uuid("requester_user_id").notNull(),
    /** Set for `chat` and `title`; null for the Phase 07.6 kinds. */
    conversationId: uuid("conversation_id"),
    messageId: uuid("message_id"),
    backend: text("backend").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    estimated: boolean("estimated").notNull().default(false),
    costMicrosUsd: bigint("cost_micros_usd", { mode: "number" }),
    priceRef: text("price_ref"),
    createdAt: createdAt(),
    /** Phase 07.6: what a `digest` / `session_summary` record was made for (an automation run, a work session). */
    subjectId: uuid("subject_id"),
  },
  (t) => [
    uniqueIndex("ai_usage_records_generation_kind_uq").on(t.generationId, t.kind),
    /** Phase 07.6: one record per subject and kind, so a retried job never double-counts. */
    uniqueIndex("ai_usage_records_subject_kind_uq")
      .on(t.subjectId, t.kind)
      .where(sql`subject_id is not null`),
    index("ai_usage_records_org_time_idx").on(t.organizationId, t.createdAt),
    index("ai_usage_records_requester_time_idx").on(t.organizationId, t.requesterUserId, t.createdAt),
    /**
     * Phase 07.6 (P-16): two shapes. Chat and title records keep their generation and conversation (unchanged); the
     * new kinds carry a subject and no generation.
     */
    check(
      "ai_usage_records_kind_check",
      sql`(${t.kind} in ('chat','title') and ${t.generationId} is not null and ${t.conversationId} is not null)
        or (${t.kind} in ('digest','session_summary') and ${t.subjectId} is not null and ${t.generationId} is null)`,
    ),
  ],
);

/** Per member, UTC day and backend class: the counters daily caps are enforced on (Phase 3.1 pattern). */
export const aiUsageDaily = appSchema.table(
  "ai_usage_daily",
  {
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    backendClass: text("backend_class", { enum: ["org_key", "chatgpt_plan"] }).notNull(),
    generations: integer("generations").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costMicrosUsd: bigint("cost_micros_usd", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.day, t.backendClass] }),
    check("ai_usage_daily_backend_class_check", sql`${t.backendClass} in ('org_key','chatgpt_plan')`),
  ],
);

/** One row per organization (absent = `DEFAULT_AI_CHAT_POLICY`); columns mirror `AiChatPolicy`. */
export const aiChatPolicies = appSchema.table("ai_chat_policies", {
  organizationId: orgId().primaryKey(),
  chatgptPlanEnabled: boolean("chatgpt_plan_enabled").notNull().default(true),
  orgKeysEnabled: boolean("org_keys_enabled").notNull().default(true),
  /** Empty = every model the plan offers. */
  planAllowedModels: text("plan_allowed_models").array().notNull().default(sql`'{}'::text[]`),
  orgKeyDailyGenerations: integer("org_key_daily_generations").default(200),
  orgKeyDailyCostMicros: bigint("org_key_daily_cost_micros", { mode: "number" }),
  planDailyGenerations: integer("plan_daily_generations"),
  concurrentGenerationsPerUser: integer("concurrent_generations_per_user").notNull().default(3),
  maxContextTokens: integer("max_context_tokens").notNull().default(64_000),
  webEnabled: boolean("web_enabled").notNull().default(true),
  titleModels: jsonb("title_models").$type<Record<string, string>>().notNull().default({}),
  /** The opaque `ext_agent_host_id` sent with ChatGPT plan requests, generated once (05-05). */
  chatgptHostId: text("chatgpt_host_id"),
  updatedBy: uuid("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * A member's own model sign-in (D-01: never pooled). Tokens live sealed in app.secrets (kind
 * `user_model_credential`); this row holds identity metadata and status only.
 */
export const userModelCredentials = appSchema.table(
  "user_model_credentials",
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    provider: text("provider", { enum: ["chatgpt_plan"] }).notNull(),
    secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
    issuedClientId: text("issued_client_id"),
    subject: text("subject"),
    email: text("email"),
    planType: text("plan_type"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    accessExpiresAt: ts("access_expires_at"),
    status: text("status", {
      enum: ["connected", "needs_reconnect", "not_eligible", "plan_usage_disabled"],
    }).notNull(),
    lastError: text("last_error"),
    welcomeSeenAt: ts("welcome_seen_at"),
    connectedAt: ts("connected_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_model_credentials_org_user_provider_uq").on(t.organizationId, t.userId, t.provider),
    check("user_model_credentials_provider_check", sql`${t.provider} in ('chatgpt_plan')`),
    check(
      "user_model_credentials_status_check",
      sql`${t.status} in ('connected','needs_reconnect','not_eligible','plan_usage_disabled')`,
    ),
  ],
);

/** Read-only snapshot share links of an AI chat (AICHAT-09): the snapshot is frozen at creation. */
export const aiChatShares = appSchema.table(
  "ai_chat_shares",
  {
    id: id(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").notNull(),
    title: text("title").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    attachmentIds: uuid("attachment_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("ai_chat_shares_conversation_idx").on(t.organizationId, t.conversationId)],
);

// ---------------------------------------------------------------- multiplayer AI chat (Phase 6)

/**
 * Sharing an AI chat in place (D-03, MULTI-01): one row per subject (a user, a unit and so its subtree, or the
 * whole organization). Grants decide access; `conversation_members` rows are participation only (P-03). Nothing is
 * copied: the chat's messages, files and settings stay where they are. At most one active grant per (chat, subject);
 * a revoked row keeps the history and frees the slot.
 */
export const aiChatGrants = appSchema.table(
  "ai_chat_grants",
  {
    id: id(),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind", { enum: ["user", "unit", "org"] }).notNull(),
    /** The user or unit id; null exactly when `subject_kind = 'org'`. */
    subjectId: uuid("subject_id"),
    level: text("level", { enum: ["chat", "view"] }).notNull(),
    grantedBy: uuid("granted_by").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    uniqueIndex("ai_chat_grants_active_uq")
      .on(
        t.conversationId,
        t.subjectKind,
        sql`coalesce(${t.subjectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`revoked_at is null`),
    index("ai_chat_grants_subject_idx")
      .on(t.organizationId, t.subjectKind, t.subjectId)
      .where(sql`revoked_at is null`),
    index("ai_chat_grants_conv_idx").on(t.organizationId, t.conversationId).where(sql`revoked_at is null`),
    check("ai_chat_grants_subject_kind_check", sql`${t.subjectKind} in ('user','unit','org')`),
    check("ai_chat_grants_subject_check", sql`(${t.subjectKind} = 'org') = (${t.subjectId} is null)`),
    check("ai_chat_grants_level_check", sql`${t.level} in ('chat','view')`),
  ],
);

/**
 * Per-message record of a human or persona message in an AI chat (MULTI-02, P-07, P-08): how its author had access,
 * whether it asks the model, the author's own model (who pays), and which generation answered it. The queue is
 * derived from these rows (addressed, unanswered, not skipped), never a separate store.
 */
export const aiMessageContext = appSchema.table(
  "ai_message_context",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", { enum: ["user", "agent"] }).notNull(),
    access: text("access", { enum: ["owner", "grant", "agent_member"] }).notNull(),
    grantId: uuid("grant_id").references(() => aiChatGrants.id, { onDelete: "set null" }),
    level: text("level", { enum: ["owner", "chat"] }),
    addressed: boolean("addressed").notNull().default(false),
    answeredByGenerationId: uuid("answered_by_generation_id").references(() => aiGenerations.id, {
      onDelete: "set null",
    }),
    skipReason: text("skip_reason"),
    /** The author's `ModelRef` for this message (P-07: the requester's own model). */
    model: jsonb("model").$type<{ backend: string; provider: string; modelId: string }>(),
    tools: jsonb("tools").$type<Record<string, unknown>>().notNull().default({}),
    shared: boolean("shared").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_message_context_queue_idx")
      .on(t.organizationId, t.conversationId, t.createdAt)
      .where(sql`addressed and answered_by_generation_id is null and skip_reason is null`),
    index("ai_message_context_answered_idx").on(t.answeredByGenerationId),
    check("ai_message_context_author_kind_check", sql`${t.authorKind} in ('user','agent')`),
    check("ai_message_context_access_check", sql`${t.access} in ('owner','grant','agent_member')`),
    check("ai_message_context_level_check", sql`${t.level} is null or ${t.level} in ('owner','chat')`),
  ],
);

/**
 * Agent Cards (AGENT-04, P-11), keyed by their message: the message body is the plain-text summary (search and
 * notifications keep working; card JSON never enters `search_tsv`). Only the posting agent updates a card, with
 * optimistic `version`; one decision per card.
 */
export const messageCards = appSchema.table(
  "message_cards",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    organizationId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    /** Phase 07.8 (UI-SPEC R1): `browser` is the platform-owned sign-in card (never an agent's own post). */
    kind: text("kind", {
      enum: [
        "work_zone",
        "approval",
        "report",
        "artifact",
        "automation",
        "deployment",
        "pr",
        "generic",
        "browser",
      ],
    }).notNull(),
    title: text("title").notNull(),
    fields: jsonb("fields").$type<Array<{ label: string; value: string }>>().notNull().default([]),
    status: text("status", {
      enum: ["info", "pending", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    actions: jsonb("actions").$type<Array<Record<string, unknown>>>().notNull().default([]),
    version: integer("version").notNull().default(1),
    decision: text("decision", { enum: ["approved", "denied"] }),
    decidedBy: uuid("decided_by"),
    decidedAt: ts("decided_at"),
    /** Phase 07.2 (UI-SPEC R4): the decider's optional note, shown on the decision line (≤ 280). */
    decisionNote: text("decision_note"),
    /**
     * Phase 07.2 (D-08): composed and updated by the server (approval proposal cards); the posting agent may not
     * PATCH it.
     */
    platformOwned: boolean("platform_owned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /**
     * Phase 07.6 (UI-SPEC R1, P-12): a short label shown instead of the status word ("Received") and up to three
     * notices (`{ tone: "warning" | "neutral", text }`), honoured by the API only on platform-owned cards.
     */
    statusLabel: text("status_label"),
    notices: jsonb("notices")
      .$type<Array<{ tone: "warning" | "neutral"; text: string }>>()
      .notNull()
      .default([]),
  },
  (t) => [
    index("message_cards_conv_idx").on(t.organizationId, t.conversationId),
    check(
      "message_cards_status_label_len_check",
      sql`${t.statusLabel} is null or char_length(${t.statusLabel}) between 1 and 24`,
    ),
    check(
      "message_cards_notices_check",
      sql`jsonb_typeof(${t.notices}) = 'array' and jsonb_array_length(${t.notices}) <= 3`,
    ),
    check(
      "message_cards_decision_note_len_check",
      sql`${t.decisionNote} is null or char_length(${t.decisionNote}) <= 280`,
    ),
    check(
      "message_cards_kind_check",
      sql`${t.kind} in ('work_zone','approval','report','artifact','automation','deployment','pr','generic','browser')`,
    ),
    check(
      "message_cards_status_check",
      sql`${t.status} in ('info','pending','running','succeeded','failed','cancelled')`,
    ),
    check("message_cards_title_len_check", sql`char_length(${t.title}) <= 200`),
    check(
      "message_cards_decision_check",
      sql`${t.decision} is null or ${t.decision} in ('approved','denied')`,
    ),
  ],
);

/** Who follows a card (P-11): followers get a `card_updated` notification when its status changes. */
export const messageCardFollows = appSchema.table(
  "message_card_follows",
  {
    organizationId: orgId(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messageCards.messageId, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index("message_card_follows_user_idx").on(t.organizationId, t.userId),
  ],
);

// ---------------------------------------------------------------- board channels (Phase 07.1)

/** Board column categories (D-02): what a column means, whatever its name. */
const BOARD_COLUMN_CATEGORIES = sql`('backlog','started','done','cancelled')`;
/** Who a card is waiting on (D-02). */
const WAITING_ON = sql`('none','us','customer','both')`;

/**
 * Record templates (D-06, BOARD-06): typed fields, default columns and a naming rule for the boards created from them.
 * `unit_id` null = organization-wide. Names are unique per (organization, unit), case-insensitively; the index is
 * NULLS NOT DISTINCT (hand-added in the board_channels migration, drizzle 1.0.0-rc.4 has no builder for it), so two
 * organization-wide templates collide too. Template edits affect new boards only (`boards` keeps a snapshot).
 */
export const recordTemplates = appSchema.table(
  "record_templates",
  {
    id: id(),
    organizationId: orgId(),
    unitId: uuid("unit_id").references(() => orgUnits.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    prefix: text("prefix"),
    namingRule: text("naming_rule"),
    fields: jsonb("fields").$type<Array<Record<string, unknown>>>().notNull().default([]),
    columns: jsonb("columns").$type<Array<Record<string, unknown>>>().notNull().default([]),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("record_templates_unit_idx").on(t.organizationId, t.unitId),
    uniqueIndex("record_templates_name_uq").on(t.organizationId, t.unitId, sql`lower(${t.name})`),
    check("record_templates_name_len_check", sql`char_length(${t.name}) between 1 and 80`),
    check("record_templates_prefix_check", sql`${t.prefix} is null or ${t.prefix} ~ '^[A-Z0-9]{1,8}$'`),
    check(
      "record_templates_naming_rule_len_check",
      sql`${t.namingRule} is null or char_length(${t.namingRule}) <= 120`,
    ),
  ],
);

/**
 * Board settings, one row per board channel (D-02, D-06, P-07): a SNAPSHOT of the template it was created from
 * (prefix, naming rule, fields), and the per-board card counter `last_number`, incremented by the card-create path.
 */
export const boards = appSchema.table(
  "boards",
  {
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    organizationId: orgId(),
    templateId: uuid("template_id").references(() => recordTemplates.id, { onDelete: "set null" }),
    /** null = cards are not numbered with a prefix. */
    prefix: text("prefix"),
    /** null = titles are typed, or the description's first line. */
    namingRule: text("naming_rule"),
    fields: jsonb("fields").$type<Array<Record<string, unknown>>>().notNull().default([]),
    lastNumber: integer("last_number").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("boards_prefix_check", sql`${t.prefix} is null or ${t.prefix} ~ '^[A-Z0-9]{1,8}$'`),
    check(
      "boards_naming_rule_len_check",
      sql`${t.namingRule} is null or char_length(${t.namingRule}) <= 120`,
    ),
    check("boards_last_number_check", sql`${t.lastNumber} >= 0`),
  ],
);

/**
 * Board columns (D-02, BOARD-01). `rank` is a fractional-indexing key and is `COLLATE "C"` (hand-added in the
 * board_channels migration: drizzle 1.0.0-rc.4 has no collation builder), so SQL orders keys exactly as JavaScript's
 * default sort does (D-05). `default_waiting_on` applies when a card ENTERS the column; null keeps the card's state.
 * `external_state_id` is reserved for external sync (OPS-BL-04) and never written in 07.1.
 */
export const boardColumns = appSchema.table(
  "board_columns",
  {
    id: id(),
    organizationId: orgId(),
    /** The board channel; a column exists only on a board (`board_columns_board_fk` → `boards`). */
    conversationId: uuid("conversation_id").notNull(),
    name: text("name").notNull(),
    rank: text("rank").notNull(),
    category: text("category", { enum: ["backlog", "started", "done", "cancelled"] }).notNull(),
    defaultWaitingOn: text("default_waiting_on", { enum: ["none", "us", "customer", "both"] }),
    externalStateId: text("external_state_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "board_columns_board_fk",
      columns: [t.conversationId],
      foreignColumns: [boards.conversationId],
    }).onDelete("cascade"),
    /** Target of `board_cards_column_fk`: a card's column belongs to the card's board. */
    unique("board_columns_id_conversation_uq").on(t.id, t.conversationId),
    index("board_columns_conv_idx").on(t.organizationId, t.conversationId),
    uniqueIndex("board_columns_conv_name_uq").on(t.conversationId, sql`lower(${t.name})`),
    check("board_columns_category_check", sql`${t.category} in ${BOARD_COLUMN_CATEGORIES}`),
    check(
      "board_columns_default_waiting_on_check",
      sql`${t.defaultWaitingOn} is null or ${t.defaultWaitingOn} in ${WAITING_ON}`,
    ),
    check("board_columns_name_len_check", sql`char_length(${t.name}) between 1 and 60`),
    check("board_columns_rank_len_check", sql`char_length(${t.rank}) between 1 and 128`),
  ],
);

/**
 * Board cards (D-02, BOARD-02), keyed by their root message: a card IS the root of a normal thread and dies with it.
 * The message body is the plain-text summary, so search works unchanged. `rank` is `COLLATE "C"` (hand-added, see
 * `board_columns`), and so is the column order index. A column with cards cannot be deleted (restrict): its cards
 * move first (P-09). `number` comes from `boards.last_number` and is unique per board. `external_ref` is reserved.
 */
export const boardCards = appSchema.table(
  "board_cards",
  {
    messageId: uuid("message_id").primaryKey(),
    organizationId: orgId(),
    /** The board channel. Its root message, its column and its board all share it (composite FKs below). */
    conversationId: uuid("conversation_id").notNull(),
    columnId: uuid("column_id").notNull(),
    rank: text("rank").notNull(),
    waitingOn: text("waiting_on", { enum: ["none", "us", "customer", "both"] })
      .notNull()
      .default("none"),
    title: text("title").notNull(),
    titleSource: text("title_source", { enum: ["user", "heuristic", "auto"] })
      .notNull()
      .default("heuristic"),
    description: text("description").notNull().default(""),
    number: integer("number"),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    externalRef: text("external_ref"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    movedAt: ts("moved_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "board_cards_message_fk",
      columns: [t.messageId, t.conversationId],
      foreignColumns: [messages.id, messages.conversationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "board_cards_column_fk",
      columns: [t.columnId, t.conversationId],
      foreignColumns: [boardColumns.id, boardColumns.conversationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "board_cards_board_fk",
      columns: [t.conversationId],
      foreignColumns: [boards.conversationId],
    }).onDelete("cascade"),
    index("board_cards_column_rank_idx").on(
      t.organizationId,
      t.conversationId,
      t.columnId,
      sql`${t.rank} COLLATE "C"`,
    ),
    uniqueIndex("board_cards_number_uq").on(t.conversationId, t.number).where(sql`number is not null`),
    /** Phase 07.6: target of `watched_records_card_fk` (a watched card belongs to the record's board channel). */
    unique("board_cards_message_conversation_uq").on(t.messageId, t.conversationId),
    check("board_cards_waiting_on_check", sql`${t.waitingOn} in ${WAITING_ON}`),
    check("board_cards_title_source_check", sql`${t.titleSource} in ('user','heuristic','auto')`),
    check("board_cards_title_len_check", sql`char_length(${t.title}) between 1 and 200`),
    check("board_cards_rank_len_check", sql`char_length(${t.rank}) between 1 and 128`),
    check("board_cards_number_check", sql`${t.number} is null or ${t.number} > 0`),
  ],
);

// ---------------------------------------------------------------- memory and approvals (Phase 07.2)

/** Who wrote a memory file or revision (D-01). */
const MEMORY_AUTHOR_KINDS = sql`('user','agent','system')`;
/** File size limit (D-01, research A1): 256 KiB of UTF-8. */
const MEMORY_FILE_MAX_BYTES = 262_144;

/**
 * Memory scopes (D-01, D-08, MEM-01): `personal` = one (bot, human) pair, `agent` = a bot's notebook, `unit` = a
 * department, team or project, `org` = the organization; one scope per anchor (partial unique indexes).
 * `personal_owner_user_id` is set by a SECURITY DEFINER trigger in `sql/post-migrate.sql` (never by the application:
 * personal → `owner_user_id`; a personal bot's notebook → the bot's owner; otherwise NULL) and the RESTRICTIVE
 * `personal_owner_only` policy there hides the row from every session whose `app.user_id` is not that owner, admins
 * included (ADR-0010). A scope's identity (kind and anchors) is immutable. A unit with memory is not deleted by the API
 * (`unit_has_memory`); the FK cascades for the database's own consistency. `origin = legacy_notes` marks the scopes
 * the `memory_notes_backfill` migration created from `agent_memories`.
 */
export const memoryScopes = appSchema.table(
  "memory_scopes",
  {
    id: id(),
    organizationId: orgId(),
    kind: text("kind", { enum: ["personal", "agent", "unit", "org"] }).notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id"),
    unitId: uuid("unit_id").references(() => orgUnits.id, { onDelete: "cascade" }),
    personalOwnerUserId: uuid("personal_owner_user_id"),
    origin: text("origin", { enum: ["app", "legacy_notes"] })
      .notNull()
      .default("app"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("memory_scopes_personal_uq")
      .on(t.organizationId, t.agentId, t.ownerUserId)
      .where(sql`kind = 'personal'`),
    uniqueIndex("memory_scopes_agent_uq").on(t.organizationId, t.agentId).where(sql`kind = 'agent'`),
    uniqueIndex("memory_scopes_unit_uq").on(t.organizationId, t.unitId).where(sql`kind = 'unit'`),
    uniqueIndex("memory_scopes_org_uq").on(t.organizationId).where(sql`kind = 'org'`),
    check("memory_scopes_kind_check", sql`${t.kind} in ('personal','agent','unit','org')`),
    check(
      "memory_scopes_shape_check",
      sql`(${t.kind} = 'personal' and ${t.agentId} is not null and ${t.ownerUserId} is not null and ${t.unitId} is null)
        or (${t.kind} = 'agent' and ${t.agentId} is not null and ${t.ownerUserId} is null and ${t.unitId} is null)
        or (${t.kind} = 'unit' and ${t.unitId} is not null and ${t.agentId} is null and ${t.ownerUserId} is null)
        or (${t.kind} = 'org' and ${t.agentId} is null and ${t.ownerUserId} is null and ${t.unitId} is null)`,
    ),
    check("memory_scopes_origin_check", sql`${t.origin} in ('app','legacy_notes')`),
  ],
);

/**
 * Memory files (D-01, MEM-01): virtual Markdown files with repo-style relative paths (the grammar lives in contracts,
 * `parseMemoryPath`); folders derive from paths. One LIVE file per case-insensitive path per scope; deletes are soft.
 * `version` is the optimistic-concurrency counter, matching the latest revision. `personal_owner_user_id` is copied
 * from the scope by the post-migrate trigger. `search_tsv` (a STORED generated tsvector over the path words and the
 * content, the three ADR-0016 configurations) is hand-written in the memory_files migration and kept OUT of this
 * schema like `messages.search_tsv`.
 */
export const memoryFiles = appSchema.table(
  "memory_files",
  {
    id: id(),
    organizationId: orgId(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => memoryScopes.id, { onDelete: "cascade" }),
    personalOwnerUserId: uuid("personal_owner_user_id"),
    path: text("path").notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull().default(1),
    bytes: integer("bytes").notNull(),
    deletedAt: ts("deleted_at"),
    updatedByKind: text("updated_by_kind", { enum: ["user", "agent", "system"] }).notNull(),
    updatedById: uuid("updated_by_id"),
    onBehalfOfUserId: uuid("on_behalf_of_user_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memory_files_scope_path_uq")
      .on(t.scopeId, sql`lower(${t.path})`)
      .where(sql`deleted_at is null`),
    index("memory_files_scope_idx").on(t.organizationId, t.scopeId).where(sql`deleted_at is null`),
    check(
      "memory_files_content_size_check",
      sql`octet_length(${t.content}) <= ${sql.raw(String(MEMORY_FILE_MAX_BYTES))}`,
    ),
    check("memory_files_path_len_check", sql`char_length(${t.path}) <= 255`),
    check("memory_files_updated_by_kind_check", sql`${t.updatedByKind} in ${MEMORY_AUTHOR_KINDS}`),
  ],
);

/**
 * Approval requests (D-05, D-08, MEM-06): the generic approve-and-apply primitive. `server_apply` = the server applies
 * the approved action itself (memory proposals); `grant` = a one-use grant consumed later (07.5). `action_hash` is the
 * SHA-256 of the exact action the approver saw; the decision must present it. Kinds are dotted ids registered by the
 * approval module (`memory.write`). One approval per card message.
 */
export const approvalRequests = appSchema.table(
  "approval_requests",
  {
    id: id(),
    organizationId: orgId(),
    kind: text("kind").notNull(),
    mode: text("mode", { enum: ["server_apply", "grant"] }).notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    actionHash: text("action_hash").notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "applied", "failed", "expired"] })
      .notNull()
      .default("pending"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedForUserId: uuid("requested_for_user_id"),
    eventId: uuid("event_id"),
    cardMessageId: uuid("card_message_id").references(() => messages.id, { onDelete: "set null" }),
    decidedBy: uuid("decided_by"),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    cardWarnings: text("card_warnings").array().notNull().default(sql`'{}'::text[]`),
    consumedAt: ts("consumed_at"),
    appliedAt: ts("applied_at"),
    resultCode: text("result_code"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.organizationId, t.status, t.expiresAt),
    index("approval_requests_resource_idx").on(t.organizationId, t.kind, t.resourceId),
    uniqueIndex("approval_requests_card_message_uq")
      .on(t.cardMessageId)
      .where(sql`card_message_id is not null`),
    check("approval_requests_mode_check", sql`${t.mode} in ('server_apply','grant')`),
    check(
      "approval_requests_status_check",
      sql`${t.status} in ('pending','approved','denied','applied','failed','expired')`,
    ),
    check("approval_requests_action_hash_check", sql`${t.actionHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "approval_requests_decision_note_len_check",
      sql`${t.decisionNote} is null or char_length(${t.decisionNote}) <= 280`,
    ),
    check("approval_requests_card_warnings_check", sql`cardinality(${t.cardWarnings}) <= 3`),
  ],
);

/**
 * Memory file revisions (D-01, MEM-01): append-only history, one row per change (UPDATE and TRUNCATE revoked from the
 * app role in post-migrate; DELETE stays for cascades and a personal "forget"). `personal_owner_user_id` is copied
 * from the file by the post-migrate trigger, which also refuses a `scope_id` other than the file's.
 */
export const memoryFileRevisions = appSchema.table(
  "memory_file_revisions",
  {
    id: id(),
    organizationId: orgId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => memoryFiles.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").notNull(),
    personalOwnerUserId: uuid("personal_owner_user_id"),
    version: integer("version").notNull(),
    op: text("op", { enum: ["create", "update", "append", "rename", "delete", "restore"] }).notNull(),
    path: text("path").notNull(),
    content: text("content").notNull(),
    linesAdded: integer("lines_added").notNull().default(0),
    linesRemoved: integer("lines_removed").notNull().default(0),
    authorKind: text("author_kind", { enum: ["user", "agent", "system"] }).notNull(),
    authorId: uuid("author_id"),
    onBehalfOfUserId: uuid("on_behalf_of_user_id"),
    approvalRequestId: uuid("approval_request_id"),
    createdAt: createdAt(),
  },
  (t) => [
    // Named by hand: drizzle's generated name for this pair exceeds 63 bytes and gets a hash.
    foreignKey({
      name: "memory_file_revisions_approval_fk",
      columns: [t.approvalRequestId],
      foreignColumns: [approvalRequests.id],
    }).onDelete("set null"),
    unique("memory_file_revisions_file_version_uq").on(t.fileId, t.version),
    index("memory_file_revisions_scope_idx").on(t.organizationId, t.scopeId),
    check(
      "memory_file_revisions_op_check",
      sql`${t.op} in ('create','update','append','rename','delete','restore')`,
    ),
    check("memory_file_revisions_author_kind_check", sql`${t.authorKind} in ${MEMORY_AUTHOR_KINDS}`),
  ],
);

/**
 * Memory proposals (D-08, MEM-05/06): what an agent asked to write into a shared scope, immutable once stored (UPDATE
 * and TRUNCATE revoked); its approval request points at it (`resource_id`). `findings` are the detector's masked
 * findings; `reader_count` is how many people could read the change; `tainted` = the turn read untrusted content.
 */
export const memoryProposals = appSchema.table(
  "memory_proposals",
  {
    id: id(),
    organizationId: orgId(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => memoryScopes.id, { onDelete: "cascade" }),
    personalOwnerUserId: uuid("personal_owner_user_id"),
    fileId: uuid("file_id").references(() => memoryFiles.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    op: text("op", { enum: ["create", "replace", "append"] }).notNull(),
    baseVersion: integer("base_version"),
    content: text("content").notNull(),
    contentSha256: text("content_sha256").notNull(),
    findings: jsonb("findings").$type<Array<Record<string, unknown>>>().notNull().default([]),
    readerCount: integer("reader_count").notNull(),
    tainted: boolean("tainted").notNull(),
    reason: text("reason"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    requestedForUserId: uuid("requested_for_user_id"),
    eventId: uuid("event_id"),
    conversationId: uuid("conversation_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("memory_proposals_scope_idx").on(t.organizationId, t.scopeId),
    check("memory_proposals_op_check", sql`${t.op} in ('create','replace','append')`),
    check(
      "memory_proposals_content_size_check",
      sql`octet_length(${t.content}) <= ${sql.raw(String(MEMORY_FILE_MAX_BYTES))}`,
    ),
    check("memory_proposals_reason_len_check", sql`${t.reason} is null or char_length(${t.reason}) <= 280`),
  ],
);

// ---------------------------------------------------------------- per-member connectors, keychain, templates (07.4)

/**
 * The OAuth client OCW uses towards one authorization server of a `per_member_oauth` connector (D-02), keyed by the
 * AS `issuer` as the MCP authorization spec requires. `client_id` is public; a confidential client's secret is the
 * sealed `client_secret_id` row (kind `mcp_credential`), never a value here. `method` = how the client was obtained.
 * Deleting the connector cascades here; its secret row stays for the API to delete (it does, in the same tx).
 */
export const connectorOAuthClients = appSchema.table(
  "connector_oauth_clients",
  {
    id: id(),
    organizationId: orgId(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretId: uuid("client_secret_id").references(() => secrets.id, { onDelete: "set null" }),
    method: text("method", { enum: ["pre_registered", "cimd", "dcr"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("connector_oauth_clients_server_issuer_uq").on(t.serverId, t.issuer),
    index("connector_oauth_clients_org_idx").on(t.organizationId),
    check("connector_oauth_clients_method_check", sql`${t.method} in ('pre_registered','cimd','dcr')`),
  ],
);

/**
 * A member's own connection to a per-member connector (D-01, CONN-01/02): one per (organization, member, connector).
 * The token bundle or key is the sealed `secret_id` row (kind `connector_credential`); this row holds only state and
 * display metadata. `account_label` is display only (an ID token's email / preferred_username, UI-SPEC R1);
 * `last_error` is a short error code (never provider text) that drives `reconnectReason` (UI-SPEC R2).
 */
export const connectorConnections = appSchema.table(
  "connector_connections",
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["connected", "needs_reconnect"] }).notNull(),
    secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
    issuer: text("issuer"),
    clientId: text("client_id"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    accountLabel: text("account_label"),
    accessExpiresAt: ts("access_expires_at"),
    lastError: text("last_error"),
    connectedAt: ts("connected_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [
    unique("connector_connections_org_user_server_uq").on(t.organizationId, t.userId, t.serverId),
    index("connector_connections_server_idx").on(t.serverId),
    check("connector_connections_status_check", sql`${t.status} in ('connected','needs_reconnect')`),
    check(
      "connector_connections_account_label_len_check",
      sql`${t.accountLabel} is null or char_length(${t.accountLabel}) <= 200`,
    ),
    check(
      "connector_connections_last_error_len_check",
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 64`,
    ),
  ],
);

/**
 * Phase 07.14 (D-06): the one account an organization connects for an `org_oauth` / `org_client_credentials` server, at
 * most one per (organization, server). Unlike `connector_connections` it belongs to the organization, not to a member:
 * it is read inside the tenant (tenant RLS from post-migrate.sql, no owner-only policy, no SECURITY DEFINER function).
 * The token bundle (or the client-credentials secret and token) is the sealed `secret_id` row in `app.secrets` (kind
 * `connector_credential`, AAD `<orgId>:org:connector:<serverId>`); this row holds only state and display metadata.
 * `method` = how it was connected; `token_endpoint` = the client-credentials token URL (discovered or entered);
 * `connected_by` = the admin who connected it (no FK, like `connector_connections.user_id`); `last_error` = a short
 * code, never provider text. The composite FK carries the organization (FKs bypass RLS, the 07.6 precedent).
 */
export const connectorOrgConnections = appSchema.table(
  "connector_org_connections",
  {
    id: id(),
    organizationId: orgId(),
    serverId: uuid("server_id").notNull(),
    method: text("method", { enum: ["oauth", "client_credentials"] }).notNull(),
    status: text("status", { enum: ["connected", "needs_reconnect"] }).notNull(),
    secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
    issuer: text("issuer"),
    clientId: text("client_id"),
    tokenEndpoint: text("token_endpoint"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    accountLabel: text("account_label"),
    accessExpiresAt: ts("access_expires_at"),
    lastError: text("last_error"),
    connectedBy: uuid("connected_by"),
    connectedAt: ts("connected_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [
    unique("connector_org_connections_org_server_uq").on(t.organizationId, t.serverId),
    foreignKey({
      name: "connector_org_connections_mcp_server_fk",
      columns: [t.organizationId, t.serverId],
      foreignColumns: [mcpServers.organizationId, mcpServers.id],
    }).onDelete("cascade"),
    check("connector_org_connections_status_check", sql`${t.status} in ('connected','needs_reconnect')`),
    check("connector_org_connections_method_check", sql`${t.method} in ('oauth','client_credentials')`),
    check(
      "connector_org_connections_account_label_len_check",
      sql`${t.accountLabel} is null or char_length(${t.accountLabel}) <= 200`,
    ),
    check(
      "connector_org_connections_last_error_len_check",
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 64`,
    ),
    check(
      "connector_org_connections_client_id_len_check",
      sql`${t.clientId} is null or char_length(${t.clientId}) <= 256`,
    ),
    check(
      "connector_org_connections_token_endpoint_len_check",
      sql`${t.tokenEndpoint} is null or char_length(${t.tokenEndpoint}) <= 2000`,
    ),
  ],
);

/**
 * A member's explicit, audited choice to let a bot use their account (a connector or a personal key) in one shared
 * conversation (D-03, CONN-03). `readers_at_grant` = how many people could read the results when they chose. One
 * ACTIVE share per (member, conversation, resource); a revoke frees the slot. `resource_id` is an `mcp_servers` or
 * `vault_items` id per `resource_kind` (checked by the API; deleting the resource leaves an inert row).
 */
export const memberAccountShares = appSchema.table(
  "member_account_shares",
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    resourceKind: text("resource_kind", { enum: ["connector", "vault_item"] }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    readersAtGrant: integer("readers_at_grant").notNull(),
    grantedAt: ts("granted_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("member_account_shares_active_uq")
      .on(t.userId, t.conversationId, t.resourceKind, t.resourceId)
      .where(sql`revoked_at is null`),
    index("member_account_shares_conversation_idx").on(t.organizationId, t.conversationId),
    check("member_account_shares_resource_kind_check", sql`${t.resourceKind} in ('connector','vault_item')`),
    check("member_account_shares_readers_check", sql`${t.readersAtGrant} >= 0`),
  ],
);

/** Where a keychain value lives (AGENTS principle 8): the same shape as `model_providers.secret_ref`. */
export type VaultSecretRef =
  | { provider: "db"; secretId: string; organizationId: string }
  | { provider: "env"; key: string }
  | { provider: "file"; path: string }
  | { provider: "openbao"; mount: string; path: string; field: string };

/**
 * Keychain items (D-04, CONN-05): a credential an agent uses BY HANDLE through `ocw_http_request`; the API injects it
 * only towards `allowed_hosts`. `personal` = one member's (`owner_user_id`, no unit); `unit` = a department, team or
 * project (`unit_id`, null = the organization; no owner). The value is never here: `secret_ref` is a SecretReference
 * (this phase: `db`, a sealed `app.secrets` row of kind `vault_item`). `value_updated_at` changes only when the value
 * is replaced (UI-SPEC R3). Handles (`k_` + 10 base32) are stable and unique per organization.
 */
export const vaultItems = appSchema.table(
  "vault_items",
  {
    id: id(),
    organizationId: orgId(),
    scope: text("scope", { enum: ["personal", "unit"] }).notNull(),
    ownerUserId: uuid("owner_user_id"),
    unitId: uuid("unit_id").references(() => orgUnits.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    handle: text("handle").notNull(),
    kind: text("kind", { enum: ["api_key", "basic", "oauth"] }).notNull(),
    /** `{ header, scheme: "bearer" | "basic" | "raw" }`: how the value is sent; never the value. */
    injection: jsonb("injection").$type<{ header: string; scheme: "bearer" | "basic" | "raw" }>().notNull(),
    allowedHosts: text("allowed_hosts").array().notNull(),
    allowedPathPrefix: text("allowed_path_prefix"),
    /** Kind `oauth` (client credentials): the token endpoint; its host must be in `allowed_hosts`. */
    tokenUrl: text("token_url"),
    secretRef: jsonb("secret_ref").$type<VaultSecretRef>().notNull(),
    valueUpdatedAt: ts("value_updated_at").notNull().defaultNow(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [
    unique("vault_items_org_handle_uq").on(t.organizationId, t.handle),
    /** Phase 07.6: target of composite foreign keys that carry the organization (FKs bypass RLS). */
    unique("vault_items_org_id_uq").on(t.organizationId, t.id),
    index("vault_items_owner_idx").on(t.organizationId, t.ownerUserId).where(sql`scope = 'personal'`),
    index("vault_items_unit_idx").on(t.organizationId, t.unitId).where(sql`scope = 'unit'`),
    check("vault_items_scope_check", sql`${t.scope} in ('personal','unit')`),
    check(
      "vault_items_scope_owner_check",
      sql`(${t.scope} = 'personal' and ${t.ownerUserId} is not null and ${t.unitId} is null)
        or (${t.scope} = 'unit' and ${t.ownerUserId} is null)`,
    ),
    check("vault_items_kind_check", sql`${t.kind} in ('api_key','basic','oauth')`),
    check("vault_items_handle_check", sql`${t.handle} ~ '^k_[a-z2-7]{10}$'`),
    check("vault_items_name_len_check", sql`char_length(${t.name}) between 1 and 80`),
    check("vault_items_allowed_hosts_check", sql`cardinality(${t.allowedHosts}) between 1 and 16`),
    check("vault_items_injection_check", sql`jsonb_typeof(${t.injection}) = 'object'`),
    // A reference, never a value: an object naming one of the SecretStore providers.
    check(
      "vault_items_secret_ref_check",
      sql`jsonb_typeof(${t.secretRef}) = 'object'
        and coalesce(${t.secretRef} ->> 'provider', '') in ('db','env','file','openbao')`,
    ),
  ],
);

/** Which keychain items a bot may use (D-04): the agent sees only their handles. */
export const agentVaultGrants = appSchema.table(
  "agent_vault_grants",
  {
    organizationId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    vaultItemId: uuid("vault_item_id")
      .notNull()
      .references(() => vaultItems.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.vaultItemId] }),
    index("agent_vault_grants_item_idx").on(t.organizationId, t.vaultItemId),
  ],
);

/**
 * Agent templates (D-05, CONN-06): unit-scoped (`unit_id` null = the organization), versioned. Members start a
 * personal bot from `current_version` (a fork: `agents.template_id` / `template_version`). RESTRICT: a unit with
 * templates cannot be deleted.
 */
export const agentTemplates = appSchema.table(
  "agent_templates",
  {
    id: id(),
    organizationId: orgId(),
    unitId: uuid("unit_id").references(() => orgUnits.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    currentVersion: integer("current_version").notNull(),
    archivedAt: ts("archived_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("agent_templates_unit_idx").on(t.organizationId, t.unitId),
    check("agent_templates_current_version_check", sql`${t.currentVersion} >= 1`),
    check("agent_templates_name_len_check", sql`char_length(${t.name}) between 1 and 80`),
    check("agent_templates_description_len_check", sql`char_length(${t.description}) <= 500`),
  ],
);

/**
 * One published version of a template (D-05): what a started bot copies. Written once by the API, never edited.
 * `tool_grants` = `[{ sourceKind, sourceId, toolName }]`; `unit_vault_item_ids` = unit keys granted on start.
 */
export const agentTemplateVersions = appSchema.table(
  "agent_template_versions",
  {
    organizationId: orgId(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => agentTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    instructions: text("instructions").notNull(),
    modelProvider: text("model_provider", {
      enum: ["anthropic", "openai", "openrouter", "openai-compatible", "openai-codex", "mock"],
    }).notNull(),
    modelId: text("model_id").notNull(),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull(),
    toolGrants: jsonb("tool_grants")
      .$type<Array<{ sourceKind: "mcp" | "plugin"; sourceId: string; toolName: string }>>()
      .notNull()
      .default([]),
    requiredConnectorIds: uuid("required_connector_ids").array().notNull().default(sql`'{}'::uuid[]`),
    unitVaultItemIds: uuid("unit_vault_item_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.version] }),
    index("agent_template_versions_org_idx").on(t.organizationId),
    check("agent_template_versions_version_check", sql`${t.version} >= 1`),
    check(
      "agent_template_versions_tool_grants_check",
      sql`jsonb_typeof(${t.toolGrants}) = 'array' and jsonb_array_length(${t.toolGrants}) <= 64`,
    ),
    check(
      "agent_template_versions_ids_check",
      sql`cardinality(${t.requiredConnectorIds}) <= 16 and cardinality(${t.unitVaultItemIds}) <= 16`,
    ),
  ],
);

// ---------------------------------------------------------------- per-tool approvals, Work Zone proposals (07.5)

/** A lowercase hex SHA-256 (64 characters). */
const SHA256_HEX = sql.raw(`'^[0-9a-f]{64}$'`);
/** Stored tool arguments (D-04, `TOOL_APPROVAL_LIMITS.argumentsBytes`): bytes of the canonical JSON in UTF-8. */
const TOOL_ARGUMENTS_MAX_BYTES = 32_768;
/** Approvers a `users` rule may name (`TOOL_APPROVAL_LIMITS.approverUsersMax`). */
const APPROVER_USERS_MAX = 20;
/** A proposed Work Zone prompt (`WORK_ZONE_PROPOSAL_LIMITS.promptChars`). */
const PROPOSAL_PROMPT_MAX_CHARS = 50_000;

/**
 * Per-tool approval policies (D-01, APPROVE-01, P-04): which agent tool calls need a person first. `scope_unit_id`
 * null = the organization, otherwise the unit subtree (as `permission_rules`). `tool_pattern` is an exact approvable
 * tool name or `<safe>__*` (every tool of one connector); the grammar lives in contracts (`ToolPattern`). `mode`:
 * `never` (stated default), `always`, `when_tainted` (only when the turn read untrusted content); the strictest
 * applicable rule wins. `approver_kind`: `requester` (the person the bot acts for), `users` (the 1–20 people in
 * `approver_user_ids`), `unit_leads` (leads of the rule's unit, so a unit rule only) or `admins` (live org admins).
 * One rule per (organization, scope, pattern), the organization scope included (NULLS NOT DISTINCT). `version` is the
 * optimistic-concurrency counter of the policy routes. Never holds tool arguments.
 */
export const toolApprovalPolicies = appSchema.table(
  "tool_approval_policies",
  {
    id: id(),
    organizationId: orgId(),
    scopeUnitId: uuid("scope_unit_id"),
    toolPattern: text("tool_pattern").notNull(),
    mode: text("mode", { enum: ["never", "always", "when_tainted"] }).notNull(),
    approverKind: text("approver_kind", { enum: ["requester", "users", "unit_leads", "admins"] })
      .notNull()
      .default("requester"),
    approverUserIds: uuid("approver_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedBy: uuid("updated_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Composite with the organization (FKs bypass RLS): a rule never names another organization's unit.
    foreignKey({
      name: "tool_approval_policies_unit_fk",
      columns: [t.organizationId, t.scopeUnitId],
      foreignColumns: [orgUnits.organizationId, orgUnits.id],
    }).onDelete("cascade"),
    unique("tool_approval_policies_scope_pattern_uq")
      .on(t.organizationId, t.scopeUnitId, t.toolPattern)
      .nullsNotDistinct(),
    /** Target of `tool_call_approvals_policy_fk`. */
    unique("tool_approval_policies_org_id_uq").on(t.organizationId, t.id),
    check("tool_approval_policies_mode_check", sql`${t.mode} in ('never','always','when_tainted')`),
    check(
      "tool_approval_policies_approver_kind_check",
      sql`${t.approverKind} in ('requester','users','unit_leads','admins')`,
    ),
    check(
      "tool_approval_policies_approvers_check",
      sql`array_position(${t.approverUserIds}, null) is null and case when ${t.approverKind} = 'users'
        then cardinality(${t.approverUserIds}) between 1 and ${sql.raw(String(APPROVER_USERS_MAX))}
        else cardinality(${t.approverUserIds}) = 0 end`,
    ),
    check(
      "tool_approval_policies_unit_leads_scope_check",
      sql`${t.approverKind} <> 'unit_leads' or ${t.scopeUnitId} is not null`,
    ),
    check(
      "tool_approval_policies_never_requester_check",
      sql`${t.mode} <> 'never' or ${t.approverKind} = 'requester'`,
    ),
    check("tool_approval_policies_version_check", sql`${t.version} >= 1`),
    check(
      "tool_approval_policies_tool_pattern_len_check",
      sql`char_length(${t.toolPattern}) between 1 and 200`,
    ),
  ],
);

/**
 * The stored action behind a `tool.call` approval (D-02, D-04, APPROVE-02, P-05, P-09): the resource of the 07.2
 * `approval_requests` row (`resource_id`). `arguments_canonical` is the RFC 8785 canonical JSON of the call's arguments
 * and the ONLY place tool arguments are ever stored (never in audit rows, logs, `agent_tool_calls`, realtime events or
 * summary cards); `arguments_sha256` is its hash and `action_hash` the 07.2 hash over (agent, requester, conversation,
 * tool, arguments_sha256), recomputed from this row at every decision and grant use. `tainted` = the requesting turn
 * had read untrusted content (its re-run starts tainted). A client retry with the same (event, tool call id) finds the
 * same row. Immutable once stored (trigger in the migration): only `policy_id` may be cleared, by the policy's
 * deletion. Readable by the deciders and the requester through the approval view (tenant RLS here).
 */
export const toolCallApprovals = appSchema.table(
  "tool_call_approvals",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    requestedForUserId: uuid("requested_for_user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    threadRootMessageId: uuid("thread_root_message_id"),
    /** The requesting turn (`agent_turns.event_id`). */
    eventId: uuid("event_id").notNull(),
    toolCallId: text("tool_call_id"),
    tool: text("tool").notNull(),
    sourceKind: text("source_kind", { enum: ["builtin", "mcp", "plugin", "vault"] }).notNull(),
    sourceId: uuid("source_id"),
    /** Domain or connector safe name, as in `agent_tool_calls.target`; never a full URL with query. */
    target: text("target"),
    argumentsCanonical: text("arguments_canonical").notNull(),
    argumentsSha256: text("arguments_sha256").notNull(),
    actionHash: text("action_hash").notNull(),
    tainted: boolean("tainted").notNull(),
    /** The rule that required the approval; a deleted rule only unlinks. */
    policyId: uuid("policy_id"),
    /**
     * 07.8 (D-11, D-13, ADR-0029): the action runs with the requester's own signed-in session (the member-session
     * floor), so the requester alone decides it, whatever rule applies; part of the action hash when true.
     */
    requesterDecides: boolean("requester_decides").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // Composite with the organization (FKs bypass RLS). The migration narrows the policy action to
    // `SET NULL ("policy_id")` (PostgreSQL 15+; no drizzle builder), so a deleted rule never nulls `organization_id`.
    foreignKey({
      name: "tool_call_approvals_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "tool_call_approvals_policy_fk",
      columns: [t.organizationId, t.policyId],
      foreignColumns: [toolApprovalPolicies.organizationId, toolApprovalPolicies.id],
    }).onDelete("set null"),
    index("tool_call_approvals_hash_idx").on(t.organizationId, t.actionHash),
    index("tool_call_approvals_requester_idx").on(
      t.organizationId,
      t.agentId,
      t.requestedForUserId,
      t.createdAt,
    ),
    index("tool_call_approvals_policy_idx")
      .on(t.organizationId, t.policyId)
      .where(sql`policy_id is not null`),
    uniqueIndex("tool_call_approvals_event_call_uq")
      .on(t.organizationId, t.eventId, t.toolCallId)
      .where(sql`tool_call_id is not null`),
    check(
      "tool_call_approvals_source_kind_check",
      sql`${t.sourceKind} in ('builtin','mcp','plugin','vault')`,
    ),
    check(
      "tool_call_approvals_arguments_size_check",
      sql`octet_length(${t.argumentsCanonical}) <= ${sql.raw(String(TOOL_ARGUMENTS_MAX_BYTES))}`,
    ),
    check("tool_call_approvals_arguments_sha256_check", sql`${t.argumentsSha256} ~ ${SHA256_HEX}`),
    check("tool_call_approvals_action_hash_check", sql`${t.actionHash} ~ ${SHA256_HEX}`),
    check("tool_call_approvals_tool_len_check", sql`char_length(${t.tool}) between 1 and 200`),
    check(
      "tool_call_approvals_tool_call_id_len_check",
      sql`${t.toolCallId} is null or char_length(${t.toolCallId}) between 1 and 200`,
    ),
    check(
      "tool_call_approvals_target_len_check",
      sql`${t.target} is null or char_length(${t.target}) <= 255`,
    ),
  ],
);

/**
 * Work Zone proposals (D-03, APPROVE-03, P-08): a bot asked to start a Work Zone session on a project and device for
 * the person it acts for, who alone may start it (kind `work_zone.start`, the resource of its `approval_requests`
 * row). No permission mode is stored: a proposed session always starts at `default`. `prompt_sha256` is the hash of
 * `prompt`; a retry of the same (event, project, device, prompt) finds the same row. The project is on its device
 * (composite FK). `work_session_id` is set when the person starts it (Phase 12 turns the same card into the live
 * session card) and cleared when that session is deleted. Immutable otherwise (trigger in the migration).
 */
export const workZoneProposals = appSchema.table(
  "work_zone_proposals",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    requestedForUserId: uuid("requested_for_user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    threadRootMessageId: uuid("thread_root_message_id"),
    /** The proposing turn (`agent_turns.event_id`). */
    eventId: uuid("event_id").notNull(),
    projectId: uuid("project_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    runtime: text("runtime", { enum: ["claude-code", "codex"] }).notNull(),
    prompt: text("prompt").notNull(),
    promptSha256: text("prompt_sha256").notNull(),
    workSessionId: uuid("work_session_id"),
    createdAt: createdAt(),
    /** Phase 07.16 (D-18): the proposing turn had read outside content (its card says so). Set once, at insert. */
    tainted: boolean("tainted").notNull().default(false),
  },
  (t) => [
    // Composite with the organization (FKs bypass RLS). The migration narrows the session action to
    // `SET NULL ("work_session_id")` (PostgreSQL 15+; no drizzle builder), so a deleted session keeps the proposal.
    foreignKey({
      name: "work_zone_proposals_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_zone_proposals_project_fk",
      columns: [t.organizationId, t.projectId, t.deviceId],
      foreignColumns: [projects.organizationId, projects.id, projects.deviceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_zone_proposals_device_fk",
      columns: [t.organizationId, t.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_zone_proposals_session_fk",
      columns: [t.organizationId, t.workSessionId],
      foreignColumns: [workSessions.organizationId, workSessions.id],
    }).onDelete("set null"),
    uniqueIndex("work_zone_proposals_request_uq").on(
      t.organizationId,
      t.eventId,
      t.projectId,
      t.deviceId,
      t.promptSha256,
    ),
    index("work_zone_proposals_requester_idx").on(
      t.organizationId,
      t.agentId,
      t.requestedForUserId,
      t.createdAt,
    ),
    index("work_zone_proposals_session_idx")
      .on(t.organizationId, t.workSessionId)
      .where(sql`work_session_id is not null`),
    check("work_zone_proposals_runtime_check", sql`${t.runtime} in ('claude-code','codex')`),
    check(
      "work_zone_proposals_prompt_len_check",
      sql`char_length(${t.prompt}) between 1 and ${sql.raw(String(PROPOSAL_PROMPT_MAX_CHARS))}`,
    ),
    check("work_zone_proposals_prompt_sha256_check", sql`${t.promptSha256} ~ ${SHA256_HEX}`),
  ],
);

// ---------------------------------------------------------------- bot sandboxes, packages, live browser (07.8)

/** Shell and browser egress modes (`SandboxEgressMode`). */
const SANDBOX_EGRESS_MODES = sql.raw(`('off','allowlist','public')`);
/** Hosts an organization's allow list may name (`SANDBOX_LIMITS.allowHostsMax`). */
const SANDBOX_ALLOW_HOSTS_MAX = 64;
/** Steps one turn's activity keeps (`SANDBOX_LIMITS.activityStepsMax`); older ones are counted in `more`. */
const ACTIVITY_STEPS_MAX = 50;
/** Entries of a pinned package's dependency tree (`SANDBOX_LIMITS.packageTreeMaxEntries`). */
const PACKAGE_TREE_MAX_ENTRIES = 5_000;
/** A pinned package's lockfile or requirement set (`SANDBOX_LIMITS.packageLockfileMaxBytes`), in UTF-8 bytes. */
const PACKAGE_LOCKFILE_MAX_BYTES = 2_097_152;
/** Why a browser context ended (`BrowserEndReason`). */
const BROWSER_END_REASONS = sql.raw(
  `('closed_by_bot','idle','kill_switch','module_off','crashed','access_lost','takeover_abandoned')`,
);
/**
 * A host as the API stores it (a browser context's, a sign-in request's or a session's site key): the URL's lower-case
 * host with `:port` when not the default, never a scheme, a path or credentials. 253 characters of name + a port.
 */
const browserHostCheck = (name: string, column: AnyPgColumn) =>
  check(
    name,
    sql`${column} = lower(${column}) and char_length(${column}) between 1 and 260
      and position('/' in ${column}) = 0 and position('@' in ${column}) = 0`,
  );

/**
 * The organization's Sandbox & Browser settings (D-01, D-09, D-12, SBX-01): one row per organization; an absent row
 * means these defaults. Off until an admin turns it on (`enabled`); `killed_at` is the kill switch, which stops every
 * sandbox and browser of the organization until resumed. Shell (`sandbox_egress_mode`) and browser
 * (`browser_egress_mode`) egress are `off`, `allowlist` (only `egress_allow_hosts`) or `public` (no private or platform
 * address, ever). Limits: running sandboxes and browsers, CPU minutes per day for the organization, disk per bot and in
 * total (MB), and the longest a sealed browser session is kept (days). `version` is the optimistic-concurrency counter of
 * the settings route.
 */
export const sandboxPolicies = appSchema.table(
  "sandbox_policies",
  {
    organizationId: orgId().primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    sandboxEgressMode: text("sandbox_egress_mode", { enum: ["off", "allowlist", "public"] })
      .notNull()
      .default("allowlist"),
    browserEgressMode: text("browser_egress_mode", { enum: ["off", "allowlist", "public"] })
      .notNull()
      .default("public"),
    egressAllowHosts: text("egress_allow_hosts").array().notNull().default(sql`'{}'::text[]`),
    maxSandboxes: integer("max_sandboxes").notNull().default(10),
    maxBrowsers: integer("max_browsers").notNull().default(3),
    cpuMinutesPerDay: integer("cpu_minutes_per_day").notNull().default(600),
    diskPerBotMb: integer("disk_per_bot_mb").notNull().default(2048),
    diskTotalMb: integer("disk_total_mb").notNull().default(51_200),
    browserSessionMaxDays: integer("browser_session_max_days").notNull().default(30),
    killedAt: ts("killed_at"),
    killedBy: uuid("killed_by"),
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "sandbox_policies_egress_mode_check",
      sql`${t.sandboxEgressMode} in ${SANDBOX_EGRESS_MODES} and ${t.browserEgressMode} in ${SANDBOX_EGRESS_MODES}`,
    ),
    check(
      "sandbox_policies_allow_hosts_check",
      sql`cardinality(${t.egressAllowHosts}) <= ${sql.raw(String(SANDBOX_ALLOW_HOSTS_MAX))}
        and array_position(${t.egressAllowHosts}, null) is null`,
    ),
    check(
      "sandbox_policies_limits_check",
      sql`${t.maxSandboxes} between 0 and 100 and ${t.maxBrowsers} between 0 and 50
        and ${t.cpuMinutesPerDay} between 1 and 100000 and ${t.diskPerBotMb} between 64 and 102400
        and ${t.diskTotalMb} between 64 and 1048576`,
    ),
    check("sandbox_policies_session_days_check", sql`${t.browserSessionMaxDays} between 1 and 90`),
    check("sandbox_policies_version_check", sql`${t.version} >= 1`),
  ],
);

/**
 * A bot's sandbox containers (D-01, D-11, SBX-01/02): at most one shell (`sbx`) and one browser (`brw`) per bot, as
 * `sandboxd` last reported them. `state` is a `SandboxState`; `runtime` the isolation it runs under; `disk_bytes` the
 * last measured workspace size (soft quota, F-9); `stop_reason` why it last stopped. The workspace itself lives in the
 * bot's Docker volume, never here.
 */
export const botSandboxes = appSchema.table(
  "bot_sandboxes",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    kind: text("kind", { enum: ["sbx", "brw"] }).notNull(),
    state: text("state", {
      enum: ["absent", "starting", "running", "stopping", "stopped", "disk_full", "killed", "unavailable"],
    }).notNull(),
    runtime: text("runtime", { enum: ["gvisor", "hardened-runc"] }),
    diskBytes: bigint("disk_bytes", { mode: "number" }).notNull().default(0),
    lastActiveAt: ts("last_active_at"),
    stopReason: text("stop_reason", { enum: ["kill_switch", "disk_full", "idle", "user", "service_down"] }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Composite with the organization (FKs bypass RLS); deleting the bot removes its sandbox rows.
    foreignKey({
      name: "bot_sandboxes_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    unique("bot_sandboxes_agent_kind_uq").on(t.organizationId, t.agentId, t.kind),
    check("bot_sandboxes_kind_check", sql`${t.kind} in ('sbx','brw')`),
    check(
      "bot_sandboxes_state_check",
      sql`${t.state} in ('absent','starting','running','stopping','stopped','disk_full','killed','unavailable')`,
    ),
    check(
      "bot_sandboxes_runtime_check",
      sql`${t.runtime} is null or ${t.runtime} in ('gvisor','hardened-runc')`,
    ),
    check(
      "bot_sandboxes_stop_reason_check",
      sql`${t.stopReason} is null or ${t.stopReason} in ('kill_switch','disk_full','idle','user','service_down')`,
    ),
    check("bot_sandboxes_disk_check", sql`${t.diskBytes} >= 0`),
  ],
);

/** CPU used by a bot's sandbox containers per UTC day (SBX-01), summed against the organization's daily minutes. */
export const sandboxUsageDaily = appSchema.table(
  "sandbox_usage_daily",
  {
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    cpuMs: bigint("cpu_ms", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.agentId, t.day] }),
    foreignKey({
      name: "sandbox_usage_daily_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    check("sandbox_usage_daily_cpu_check", sql`${t.cpuMs} >= 0`),
  ],
);

/**
 * The durable position of the API's `sandboxd` event consumer, per organization (11): an event `(boot_id, seq)` is
 * applied to the organization only if `boot_id` differs from the stored one or `seq` is greater than the stored `seq`,
 * in the same transaction that applies it, so a replay after an API restart never double-counts usage.
 */
export const sandboxEventCursor = appSchema.table(
  "sandbox_event_cursor",
  {
    organizationId: orgId().primaryKey(),
    bootId: uuid("boot_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("sandbox_event_cursor_seq_check", sql`${t.seq} >= 0`)],
);

/**
 * A member's sealed browser sign-in for one site with one bot (D-08, F-10, P-09, BRW-04): one per (member, bot, site
 * key). The storage state itself is never here: it is the sealed `secret_id` row (kind `browser_session`), deleted with
 * it. `site_key` is the exact lower-case host of the sign-in card (`:port` when not the default). The row is its
 * owner's ALONE: a RESTRICTIVE `personal_owner_only` policy in post-migrate.sql hides it from every session whose
 * `app.user_id` is not `user_id` (another member, an admin, a cell route without a user). `expires_at` = the earliest
 * of the kept cookies' expiries and the organization's `browser_session_max_days`.
 */
export const browserSessions = appSchema.table(
  "browser_sessions",
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    siteKey: text("site_key").notNull(),
    secretId: uuid("secret_id").notNull(),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "browser_sessions_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "browser_sessions_secret_fk",
      columns: [t.organizationId, t.secretId],
      foreignColumns: [secrets.organizationId, secrets.id],
    }).onDelete("cascade"),
    unique("browser_sessions_owner_site_uq").on(t.organizationId, t.userId, t.agentId, t.siteKey),
    /** Target of the contexts' and sign-in requests' `session_id` foreign keys. */
    unique("browser_sessions_org_id_uq").on(t.organizationId, t.id),
    index("browser_sessions_secret_idx").on(t.organizationId, t.secretId),
    index("browser_sessions_agent_idx").on(t.organizationId, t.agentId),
    browserHostCheck("browser_sessions_site_key_check", t.siteKey),
  ],
);

/**
 * A bot's live browser context in one conversation (D-06, D-07, BRW-01/02): opened by a turn (`event_id`) for the person
 * the bot acts for (`requested_for_user_id`). `host` is the current page's host (never a path or query). `state` is
 * the server-side `BrowserContextState` (`live`, `idle`, `paused`, `ended`); `paused_for` says why a page is held
 * (`held_until`). `controller_user_id` + `lease_expires_at` are a person's takeover lease (both or neither).
 * `session_id` = the member session loaded into it, if any (a revoked session only unlinks).
 */
export const browserContexts = appSchema.table(
  "browser_contexts",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    threadRootMessageId: uuid("thread_root_message_id"),
    requestedForUserId: uuid("requested_for_user_id").notNull(),
    /** The opening turn (`agent_turns.event_id`). */
    eventId: uuid("event_id").notNull(),
    /** The page's CURRENT host (it follows navigation). */
    host: text("host").notNull(),
    /**
     * The host the page was opened on, never updated (07.8-27, WINDOWS #286): the Browser tab's "Opened {host}". Null only
     * for a row written by code older than this column; readers fall back to `host`.
     */
    openedHost: text("opened_host"),
    secure: boolean("secure").notNull(),
    state: text("state", { enum: ["live", "idle", "paused", "ended"] }).notNull(),
    sessionId: uuid("session_id"),
    controllerUserId: uuid("controller_user_id"),
    leaseExpiresAt: ts("lease_expires_at"),
    /**
     * The lease holder sent input (typed, clicked, pasted) during the CURRENT lease, recorded before the input reaches the
     * page. A lease that ends without a hand back then closes the page (`takeover_abandoned`), on whichever instance or
     * sweep ends it. Reset when a lease starts or ends.
     */
    leaseInput: boolean("lease_input").notNull().default(false),
    pausedFor: text("paused_for", { enum: ["approval", "signin"] }),
    heldUntil: ts("held_until"),
    openedAt: ts("opened_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    endReason: text("end_reason", {
      enum: [
        "closed_by_bot",
        "idle",
        "kill_switch",
        "module_off",
        "crashed",
        "access_lost",
        "takeover_abandoned",
      ],
    }),
  },
  (t) => [
    // Composite with the organization (FKs bypass RLS). The migration narrows the session action to
    // `SET NULL ("session_id")` (PostgreSQL 15+; no drizzle builder), so a revoked session never nulls `organization_id`.
    foreignKey({
      name: "browser_contexts_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "browser_contexts_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "browser_contexts_session_fk",
      columns: [t.organizationId, t.sessionId],
      foreignColumns: [browserSessions.organizationId, browserSessions.id],
    }).onDelete("set null"),
    /** Target of `browser_signin_requests_context_fk`. */
    unique("browser_contexts_org_id_uq").on(t.organizationId, t.id),
    index("browser_contexts_open_idx").on(t.organizationId, t.conversationId).where(sql`closed_at is null`),
    index("browser_contexts_agent_idx").on(t.organizationId, t.agentId, t.openedAt),
    index("browser_contexts_session_idx")
      .on(t.organizationId, t.sessionId)
      .where(sql`session_id is not null`),
    browserHostCheck("browser_contexts_host_check", t.host),
    browserHostCheck("browser_contexts_opened_host_check", t.openedHost),
    check("browser_contexts_state_check", sql`${t.state} in ('live','idle','paused','ended')`),
    check(
      "browser_contexts_paused_for_check",
      sql`${t.pausedFor} is null or ${t.pausedFor} in ('approval','signin')`,
    ),
    check(
      "browser_contexts_end_reason_check",
      sql`${t.endReason} is null or ${t.endReason} in ${BROWSER_END_REASONS}`,
    ),
    check(
      "browser_contexts_lease_check",
      sql`(${t.controllerUserId} is null) = (${t.leaseExpiresAt} is null)`,
    ),
  ],
);

/**
 * A bot's request that the person it acts for sign in to a site in its browser (D-08, BRW-03): the sign-in card
 * (`card_message_id`) for one context and turn. `reason` is the bot's short, shown-as-is reason. `status` is a
 * `BrowserSignInStatus`; `stop_reason` a `BrowserEndReason` when the context ended first; `session_id` the session it
 * sealed (a revoked session only unlinks).
 */
export const browserSigninRequests = appSchema.table(
  "browser_signin_requests",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    contextId: uuid("context_id").notNull(),
    requesterUserId: uuid("requester_user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    /** The asking turn (`agent_turns.event_id`). */
    eventId: uuid("event_id").notNull(),
    cardMessageId: uuid("card_message_id"),
    host: text("host").notNull(),
    reason: text("reason").notNull(),
    status: text("status", {
      enum: ["waiting", "signing_in", "signed_in", "skipped", "expired", "stopped"],
    })
      .notNull()
      .default("waiting"),
    stopReason: text("stop_reason", {
      enum: [
        "closed_by_bot",
        "idle",
        "kill_switch",
        "module_off",
        "crashed",
        "access_lost",
        "takeover_abandoned",
      ],
    }),
    sessionId: uuid("session_id"),
    /**
     * 07.8-21: until when the session this sign-in sealed lasts (the card's "Signed in until {date}"), copied at the
     * seal so every reader of the card sees it without reading the owner-only session row. Null until signed in.
     */
    sessionExpiresAt: ts("session_expires_at"),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    // Composite with the organization (FKs bypass RLS); the session action is narrowed to `SET NULL ("session_id")`
    // in the migration, as on browser_contexts.
    foreignKey({
      name: "browser_signin_requests_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "browser_signin_requests_context_fk",
      columns: [t.organizationId, t.contextId],
      foreignColumns: [browserContexts.organizationId, browserContexts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "browser_signin_requests_session_fk",
      columns: [t.organizationId, t.sessionId],
      foreignColumns: [browserSessions.organizationId, browserSessions.id],
    }).onDelete("set null"),
    unique("browser_signin_requests_event_uq").on(t.organizationId, t.eventId, t.contextId),
    index("browser_signin_requests_context_idx").on(t.organizationId, t.contextId),
    index("browser_signin_requests_session_idx")
      .on(t.organizationId, t.sessionId)
      .where(sql`session_id is not null`),
    browserHostCheck("browser_signin_requests_host_check", t.host),
    check("browser_signin_requests_reason_check", sql`char_length(${t.reason}) between 1 and 200`),
    check(
      "browser_signin_requests_status_check",
      sql`${t.status} in ('waiting','signing_in','signed_in','skipped','expired','stopped')`,
    ),
    check(
      "browser_signin_requests_stop_reason_check",
      sql`${t.stopReason} is null or ${t.stopReason} in ${BROWSER_END_REASONS}`,
    ),
  ],
);

/**
 * What a bot did in one turn (SBX-02, `BotTurnActivity`), composed by the server and shown under its reply to the
 * conversation's readers. `steps` holds at most 50 masked `ActivityStep`s (never argv in clear, output, page text or
 * typed input; WINDOWS #168); older ones are only counted in `more`. `running` until the turn ends.
 */
export const botTurnActivity = appSchema.table(
  "bot_turn_activity",
  {
    /** The turn (`agent_turns.event_id`). */
    eventId: uuid("event_id").primaryKey(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    threadRootMessageId: uuid("thread_root_message_id"),
    replyMessageId: uuid("reply_message_id"),
    steps: jsonb("steps").$type<unknown[]>().notNull().default([]),
    more: integer("more").notNull().default(0),
    running: boolean("running").notNull().default(true),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "bot_turn_activity_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    check(
      "bot_turn_activity_steps_check",
      sql`jsonb_typeof(${t.steps}) = 'array' and jsonb_array_length(${t.steps}) <= ${sql.raw(String(ACTIVITY_STEPS_MAX))}
        and ${t.more} >= 0`,
    ),
    index("bot_turn_activity_reply_idx")
      .on(t.organizationId, t.replyMessageId)
      .where(sql`reply_message_id is not null`),
    index("bot_turn_activity_agent_idx").on(t.organizationId, t.agentId),
  ],
);

/**
 * A package an admin approved for the organization's sandboxes (D-03 as refined by D-11, P-12, SBX-05): ADR-0011's
 * pinned approval, mirrored from `cell_plugins`, with the WHOLE dependency tree pinned. `sha256` is the top-level
 * artifact; `lockfile` is the exact set every install uses (npm `package-lock.json`, the PyPI requirement set with
 * hashes, the Debian closure or the single ClawHub entry), `dependency_count` its entries and `tree_sha256` the hash of
 * their canonical form, bound by `review_token`. `changed_upstream` = a later resolution no longer matches. One live
 * (not `removed`) package per (source, name).
 */
export const sandboxPackages = appSchema.table(
  "sandbox_packages",
  {
    id: id(),
    organizationId: orgId(),
    source: text("source", { enum: ["npm", "pypi", "debian", "clawhub"] }).notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    license: text("license"),
    publisher: text("publisher"),
    hasInstallScript: boolean("has_install_script").notNull(),
    risk: text("risk", { enum: ["low", "medium", "high", "refuse"] }).notNull(),
    riskReasons: jsonb("risk_reasons").$type<string[]>().notNull().default([]),
    reviewToken: text("review_token").notNull(),
    treeSha256: text("tree_sha256").notNull(),
    dependencyCount: integer("dependency_count").notNull(),
    lockfile: text("lockfile").notNull(),
    changedUpstream: boolean("changed_upstream").notNull().default(false),
    status: text("status", { enum: ["approved", "removed"] }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    personalAllowed: boolean("personal_allowed").notNull().default(false),
    approvedBy: uuid("approved_by"),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sandbox_packages_org_source_name_uq")
      .on(t.organizationId, t.source, t.name)
      .where(sql`status <> 'removed'`),
    /** Target of `sandbox_package_installs_package_fk`. */
    unique("sandbox_packages_org_id_uq").on(t.organizationId, t.id),
    check("sandbox_packages_source_check", sql`${t.source} in ('npm','pypi','debian','clawhub')`),
    check("sandbox_packages_name_check", sql`char_length(${t.name}) between 1 and 214`),
    check("sandbox_packages_version_check", sql`char_length(${t.version}) between 1 and 128`),
    check("sandbox_packages_sha256_check", sql`${t.sha256} ~ ${SHA256_HEX}`),
    check("sandbox_packages_size_check", sql`${t.sizeBytes} >= 0`),
    check("sandbox_packages_risk_check", sql`${t.risk} in ('low','medium','high','refuse')`),
    check(
      "sandbox_packages_risk_reasons_check",
      sql`jsonb_typeof(${t.riskReasons}) = 'array' and jsonb_array_length(${t.riskReasons}) <= 10`,
    ),
    check(
      "sandbox_packages_tree_check",
      sql`${t.treeSha256} ~ ${SHA256_HEX}
        and ${t.dependencyCount} between 0 and ${sql.raw(String(PACKAGE_TREE_MAX_ENTRIES))}`,
    ),
    check(
      "sandbox_packages_lockfile_check",
      sql`octet_length(${t.lockfile}) <= ${sql.raw(String(PACKAGE_LOCKFILE_MAX_BYTES))}`,
    ),
    check("sandbox_packages_status_check", sql`${t.status} in ('approved','removed')`),
  ],
);

/** Where an approved package is installed (SBX-05): one row per (bot, package), as `sandboxd` last reported it. */
export const sandboxPackageInstalls = appSchema.table(
  "sandbox_package_installs",
  {
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    packageId: uuid("package_id").notNull(),
    status: text("status", { enum: ["pending", "installing", "installed", "failed", "removing"] }).notNull(),
    /** A short error code or summary, never installer output. */
    detail: text("detail"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.agentId, t.packageId] }),
    foreignKey({
      name: "sandbox_package_installs_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "sandbox_package_installs_package_fk",
      columns: [t.organizationId, t.packageId],
      foreignColumns: [sandboxPackages.organizationId, sandboxPackages.id],
    }).onDelete("cascade"),
    index("sandbox_package_installs_package_idx").on(t.organizationId, t.packageId),
    check(
      "sandbox_package_installs_status_check",
      sql`${t.status} in ('pending','installing','installed','failed','removing')`,
    ),
    check(
      "sandbox_package_installs_detail_check",
      sql`${t.detail} is null or char_length(${t.detail}) <= 200`,
    ),
  ],
);

// ---------------------------------------------------------------- automations and watched records (Phase 07.6)
//
// ADR-0028 (D-01, D-02, D-04, D-06, D-07, D-10). The schedule of record lives here, under RLS; pg-boss jobs carry ids
// only and their handlers re-open withTenant(). The job ticks and the public webhook route find their rows through the
// ids-only SECURITY DEFINER functions of post-migrate.sql (`due_automations`, `stale_automation_runs`, `due_mailboxes`,
// `due_watched_records`, `lookup_webhook_endpoint`, `expired_automation_events`). Every reference to a table that has
// an `(organization_id, id)` key is composite with the organization (FKs bypass RLS, 07.4 #169); the migration narrows
// each `set null` of those to `SET NULL (<column>)` (PostgreSQL 15+; no drizzle builder), so organization_id is never
// nulled. Message references (run cards, posted items) stay single-column. No repository → unit table: a Work Zone
// session's team project is 07.9's `work_project_repos` (D-10).

const AUTOMATION_TRIGGER_KINDS = sql.raw(`('schedule','webhook','mail')`);
const WATCHED_CHECK_SOURCES = sql.raw(`('access','schedule','write','manual')`);

/**
 * A standing order (D-01, D-07; PRD §73-75): a bot, the instructions, a trigger, a delivery target by stable ids, the
 * person it runs as (always its creator: `automations_run_as_creator_check`) and its budget. `digest` is the personal
 * digest (D-05): one per person, scheduled, to their DM with the bot. Target shapes: `dm` = the run-as person's DM with
 * the bot (resolved per run); `channel` = a conversation; `thread` = a conversation and its root message; `board` = a
 * board channel and one of its columns (each run or inbound item becomes a card there, UI-SPEC R2). A board column an
 * automation targets cannot be deleted until the automation is moved or removed (NO ACTION: the API answers first).
 */
export const automations = appSchema.table(
  "automations",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    agentId: uuid("agent_id").notNull(),
    runAsUserId: uuid("run_as_user_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    actionKind: text("action_kind", { enum: ["agent_turn", "digest"] })
      .notNull()
      .default("agent_turn"),
    instructions: text("instructions").notNull().default(""),
    triggerKind: text("trigger_kind", { enum: ["schedule", "webhook", "mail"] }).notNull(),
    /** Five-field cron in `time_zone` (an IANA zone); both set exactly for `schedule`. */
    scheduleCron: text("schedule_cron"),
    timeZone: text("time_zone"),
    targetKind: text("target_kind", { enum: ["channel", "thread", "dm", "board"] }).notNull(),
    conversationId: uuid("conversation_id"),
    threadRootMessageId: uuid("thread_root_message_id"),
    boardColumnId: uuid("board_column_id"),
    /** Webhook and mail only: post the item (thread root / DM / reply) or file it as a board card. */
    inboundAction: text("inbound_action", { enum: ["post", "board_card"] }),
    /** Webhook and mail only: whether the bot is asked to act on the item (a read-only, tainted turn). */
    inboundAskBot: boolean("inbound_ask_bot").notNull().default(true),
    inboundConfig: jsonb("inbound_config").$type<Record<string, unknown>>().notNull().default({}),
    /** Action settings (digest sections and days, the optional summary model). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    maxRunsPerDay: integer("max_runs_per_day").notNull().default(24),
    /** The breaker (Pitfall 1): three failed or unanswered runs in a row → `needs_attention`. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    status: text("status", { enum: ["active", "paused", "needs_attention"] })
      .notNull()
      .default("active"),
    pausedBy: uuid("paused_by"),
    pausedAt: ts("paused_at"),
    pausedReason: text("paused_reason"),
    nextRunAt: ts("next_run_at"),
    lastRunAt: ts("last_run_at"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /**
     * Phase 07.17 (D-02, D-16, PD-05): whether the run turn may open one conversation per new item
     * (`ocw_conversation_open`), and how many per run and per local day. Only agent-turn schedules (Run now included)
     * to a channel or a board (the fan-out check below); webhook and mail keep one item per event. Turning it off
     * keeps the opened rows (the dedupe history) and the run log root.
     */
    fanOutEnabled: boolean("fan_out_enabled").notNull().default(false),
    fanOutPerRun: smallint("fan_out_per_run").notNull().default(10),
    fanOutPerDay: integer("fan_out_per_day").notNull().default(100),
    /** Phase 07.17 (D-08): up to five people or teams the item turns may name when stuck (stable ids only). */
    escalationTargets: jsonb("escalation_targets")
      .$type<Array<{ kind: "user" | "unit"; id: string }>>()
      .notNull()
      .default([]),
    /**
     * Phase 07.17 (D-10, PD-06): the root of the fan-out automation's run log thread in its target conversation. A
     * deleted root only unlinks (`ON DELETE SET NULL ("run_log_message_id")`, hand-narrowed in the migration so the
     * target `conversation_id` is never cleared); the next run posts a new one.
     */
    runLogMessageId: uuid("run_log_message_id"),
  },
  (t) => [
    unique("automations_org_id_uq").on(t.organizationId, t.id),
    /** Phase 07.17 (D-10): the run log root is a message of the target conversation. */
    foreignKey({
      name: "automations_run_log_fk",
      columns: [t.runLogMessageId, t.conversationId],
      foreignColumns: [messages.id, messages.conversationId],
    }).onDelete("set null"),
    foreignKey({
      name: "automations_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "automations_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    /** The thread root is a message of the target conversation. */
    foreignKey({
      name: "automations_thread_root_fk",
      columns: [t.threadRootMessageId, t.conversationId],
      foreignColumns: [messages.id, messages.conversationId],
    }).onDelete("cascade"),
    /** The column is a column of the target board. */
    foreignKey({
      name: "automations_board_column_fk",
      columns: [t.boardColumnId, t.conversationId],
      foreignColumns: [boardColumns.id, boardColumns.conversationId],
    }).onDelete("no action"),
    // D-07, P-04: an automation always runs as its creator (admins may pause or delete it, never run as someone).
    check("automations_run_as_creator_check", sql`${t.runAsUserId} = ${t.createdBy}`),
    check("automations_name_len_check", sql`char_length(${t.name}) between 1 and 120`),
    check("automations_instructions_len_check", sql`char_length(${t.instructions}) <= 4000`),
    check("automations_action_kind_check", sql`${t.actionKind} in ('agent_turn','digest')`),
    check("automations_trigger_kind_check", sql`${t.triggerKind} in ${AUTOMATION_TRIGGER_KINDS}`),
    check("automations_target_kind_check", sql`${t.targetKind} in ('channel','thread','dm','board')`),
    check("automations_status_check", sql`${t.status} in ('active','paused','needs_attention')`),
    check(
      "automations_schedule_check",
      sql`(${t.triggerKind} = 'schedule' and ${t.scheduleCron} is not null and ${t.timeZone} is not null
          and char_length(${t.scheduleCron}) between 9 and 120 and char_length(${t.timeZone}) between 1 and 64)
        or (${t.triggerKind} <> 'schedule' and ${t.scheduleCron} is null and ${t.timeZone} is null)`,
    ),
    check(
      "automations_target_check",
      sql`(${t.targetKind} = 'dm' and ${t.conversationId} is null and ${t.threadRootMessageId} is null
          and ${t.boardColumnId} is null)
        or (${t.targetKind} = 'channel' and ${t.conversationId} is not null and ${t.threadRootMessageId} is null
          and ${t.boardColumnId} is null)
        or (${t.targetKind} = 'thread' and ${t.conversationId} is not null and ${t.threadRootMessageId} is not null
          and ${t.boardColumnId} is null)
        or (${t.targetKind} = 'board' and ${t.conversationId} is not null and ${t.boardColumnId} is not null
          and ${t.threadRootMessageId} is null)`,
    ),
    check(
      "automations_inbound_check",
      sql`(${t.inboundAction} is not null) = (${t.triggerKind} in ('webhook','mail'))
        and (${t.inboundAction} is null or ${t.inboundAction} in ('post','board_card'))
        and (${t.inboundAction} is distinct from 'board_card' or ${t.targetKind} = 'board')`,
    ),
    check(
      "automations_digest_check",
      sql`${t.actionKind} <> 'digest' or (${t.triggerKind} = 'schedule' and ${t.targetKind} = 'dm')`,
    ),
    check("automations_max_runs_per_day_check", sql`${t.maxRunsPerDay} between 1 and 288`),
    // Phase 07.17 (D-02, D-16, PD-05): fan-out only where no outside content arrives with the trigger.
    check(
      "automations_fan_out_check",
      sql`not ${t.fanOutEnabled} or (${t.actionKind} = 'agent_turn' and ${t.triggerKind} = 'schedule'
          and ${t.targetKind} in ('channel','board'))`,
    ),
    check("automations_fan_out_per_run_check", sql`${t.fanOutPerRun} between 1 and 25`),
    check(
      "automations_fan_out_per_day_check",
      sql`${t.fanOutPerDay} between 1 and 500 and ${t.fanOutPerDay} >= ${t.fanOutPerRun}`,
    ),
    check(
      "automations_escalation_targets_check",
      sql`jsonb_typeof(${t.escalationTargets}) = 'array' and jsonb_array_length(${t.escalationTargets}) <= 5`,
    ),
    check("automations_consecutive_failures_check", sql`${t.consecutiveFailures} >= 0`),
    check("automations_version_check", sql`${t.version} >= 1`),
    check(
      "automations_paused_reason_len_check",
      sql`${t.pausedReason} is null or char_length(${t.pausedReason}) <= 200`,
    ),
    check(
      "automations_config_check",
      sql`jsonb_typeof(${t.inboundConfig}) = 'object' and jsonb_typeof(${t.config}) = 'object'`,
    ),
    /** One digest per person (D-05). */
    uniqueIndex("automations_digest_uq")
      .on(t.organizationId, t.runAsUserId)
      .where(sql`action_kind = 'digest'`),
    index("automations_due_idx").on(t.nextRunAt).where(sql`status = 'active' and trigger_kind = 'schedule'`),
    index("automations_run_as_idx").on(t.organizationId, t.runAsUserId),
    index("automations_agent_idx").on(t.organizationId, t.agentId),
    index("automations_conversation_idx")
      .on(t.organizationId, t.conversationId)
      .where(sql`conversation_id is not null`),
    index("automations_board_column_idx").on(t.boardColumnId).where(sql`board_column_id is not null`),
  ],
);

/**
 * An inbound webhook URL (D-02, D-07, Pitfall 4). `public_id` is the unguessable path segment (26 Crockford base32
 * characters, unique across organizations: the public route finds the organization by it). Secrets are sealed
 * `webhook_secret` rows; the previous one stays valid until `previous_valid_until` (rotation grace). Deleting the
 * automation unlinks the endpoint and `deleted_at` tombstones it, so the route answers 410 rather than 404.
 */
export const webhookEndpoints = appSchema.table(
  "webhook_endpoints",
  {
    id: id(),
    organizationId: orgId(),
    automationId: uuid("automation_id"),
    publicId: text("public_id").notNull(),
    secretId: uuid("secret_id"),
    previousSecretId: uuid("previous_secret_id"),
    previousValidUntil: ts("previous_valid_until"),
    secretSetAt: ts("secret_set_at").notNull().defaultNow(),
    lastRejectedAt: ts("last_rejected_at"),
    lastRejectedReason: text("last_rejected_reason", {
      enum: ["signature", "timestamp", "too_large", "rate_limited"],
    }),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("webhook_endpoints_org_id_uq").on(t.organizationId, t.id),
    unique("webhook_endpoints_public_id_uq").on(t.publicId),
    foreignKey({
      name: "webhook_endpoints_automation_fk",
      columns: [t.organizationId, t.automationId],
      foreignColumns: [automations.organizationId, automations.id],
    }).onDelete("set null"),
    uniqueIndex("webhook_endpoints_automation_uq").on(t.automationId).where(sql`automation_id is not null`),
    check("webhook_endpoints_public_id_check", sql`${t.publicId} ~* '^[0-9a-hjkmnp-tv-z]{26}$'`),
    check(
      "webhook_endpoints_rejected_reason_check",
      sql`${t.lastRejectedReason} is null
        or ${t.lastRejectedReason} in ('signature','timestamp','too_large','rate_limited')`,
    ),
  ],
);

/**
 * An IMAP mailbox an automation polls (D-02): its owner's keychain item holds the sign-in (a deleted item unlinks it and
 * the poll answers `auth_failed`). `uid_validity` / `last_uid` are the IMAP cursor; a changed UIDVALIDITY restarts it.
 */
export const mailboxes = appSchema.table(
  "mailboxes",
  {
    id: id(),
    organizationId: orgId(),
    automationId: uuid("automation_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    vaultItemId: uuid("vault_item_id"),
    host: text("host").notNull(),
    port: integer("port").notNull().default(993),
    folder: text("folder").notNull().default("INBOX"),
    pollIntervalMinutes: integer("poll_interval_minutes").notNull().default(5),
    uidValidity: bigint("uid_validity", { mode: "number" }),
    lastUid: bigint("last_uid", { mode: "number" }),
    nextPollAt: ts("next_poll_at").notNull().defaultNow(),
    lastPolledAt: ts("last_polled_at"),
    lastNewCount: integer("last_new_count").notNull().default(0),
    status: text("status", { enum: ["active", "auth_failed", "unreachable", "paused"] })
      .notNull()
      .default("active"),
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("mailboxes_org_id_uq").on(t.organizationId, t.id),
    unique("mailboxes_automation_uq").on(t.automationId),
    foreignKey({
      name: "mailboxes_automation_fk",
      columns: [t.organizationId, t.automationId],
      foreignColumns: [automations.organizationId, automations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "mailboxes_vault_item_fk",
      columns: [t.organizationId, t.vaultItemId],
      foreignColumns: [vaultItems.organizationId, vaultItems.id],
    }).onDelete("set null"),
    index("mailboxes_vault_item_idx")
      .on(t.organizationId, t.vaultItemId)
      .where(sql`vault_item_id is not null`),
    index("mailboxes_due_idx").on(t.nextPollAt).where(sql`status in ('active','unreachable')`),
    check("mailboxes_host_len_check", sql`char_length(${t.host}) between 1 and 253`),
    check("mailboxes_port_check", sql`${t.port} between 1 and 65535`),
    check("mailboxes_folder_len_check", sql`char_length(${t.folder}) between 1 and 200`),
    check("mailboxes_poll_interval_check", sql`${t.pollIntervalMinutes} in (5,10,15,30,60)`),
    check("mailboxes_status_check", sql`${t.status} in ('active','auth_failed','unreachable','paused')`),
    check("mailboxes_last_new_count_check", sql`${t.lastNewCount} >= 0`),
    check(
      "mailboxes_last_error_code_len_check",
      sql`${t.lastErrorCode} is null or char_length(${t.lastErrorCode}) <= 64`,
    ),
  ],
);

/**
 * One inbound item (D-02, D-07): a webhook delivery or a mail message, exactly one source. Idempotent per source by
 * `external_id` (`webhook-id`, `Message-ID`; Pitfall 6): a repeat only bumps `duplicate_count`. Untrusted, text-only
 * content with caps (Pitfall 3); `content_purged_at` (the 30-day retention) requires every content column cleared.
 */
export const automationEvents = appSchema.table(
  "automation_events",
  {
    id: id(),
    organizationId: orgId(),
    source: text("source", { enum: ["webhook", "mail"] }).notNull(),
    webhookEndpointId: uuid("webhook_endpoint_id"),
    mailboxId: uuid("mailbox_id"),
    externalId: text("external_id").notNull(),
    /** Groups a conversation of inbound items (the mail thread root, a configured JSON pointer). */
    threadKey: text("thread_key"),
    subject: text("subject"),
    sender: text("sender"),
    bodyText: text("body_text"),
    bodyJson: jsonb("body_json").$type<unknown>(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    result: text("result", { enum: ["accepted", "not_run"] }).notNull(),
    reason: text("reason"),
    /** The message the platform posted for it (a deleted message only unlinks). */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    boardCardMessageId: uuid("board_card_message_id"),
    /** The full-text reply posted after the card when the card's field cut the text (outside content too, LO-05). */
    fullMessageId: uuid("full_message_id").references(() => messages.id, { onDelete: "set null" }),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    lastDuplicateAt: ts("last_duplicate_at"),
    contentPurgedAt: ts("content_purged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("automation_events_org_id_uq").on(t.organizationId, t.id),
    foreignKey({
      name: "automation_events_webhook_endpoint_fk",
      columns: [t.organizationId, t.webhookEndpointId],
      foreignColumns: [webhookEndpoints.organizationId, webhookEndpoints.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "automation_events_mailbox_fk",
      columns: [t.organizationId, t.mailboxId],
      foreignColumns: [mailboxes.organizationId, mailboxes.id],
    }).onDelete("cascade"),
    unique("automation_events_webhook_external_uq").on(t.webhookEndpointId, t.externalId),
    unique("automation_events_mailbox_external_uq").on(t.mailboxId, t.externalId),
    index("automation_events_thread_idx").on(t.organizationId, t.threadKey),
    index("automation_events_message_idx").on(t.messageId).where(sql`message_id is not null`),
    // The other half of the mention path's `message_id OR board_card_message_id` lookup (07.6 review A MD-07).
    index("automation_events_board_card_idx")
      .on(t.boardCardMessageId)
      .where(sql`board_card_message_id is not null`),
    index("automation_events_full_message_idx").on(t.fullMessageId).where(sql`full_message_id is not null`),
    index("automation_events_retention_idx").on(t.receivedAt).where(sql`content_purged_at is null`),
    check(
      "automation_events_source_check",
      sql`(${t.source} = 'webhook' and ${t.webhookEndpointId} is not null and ${t.mailboxId} is null)
        or (${t.source} = 'mail' and ${t.mailboxId} is not null and ${t.webhookEndpointId} is null)`,
    ),
    check("automation_events_external_id_len_check", sql`char_length(${t.externalId}) between 1 and 998`),
    check(
      "automation_events_thread_key_len_check",
      sql`${t.threadKey} is null or char_length(${t.threadKey}) <= 998`,
    ),
    check(
      "automation_events_subject_len_check",
      sql`${t.subject} is null or char_length(${t.subject}) <= 500`,
    ),
    check("automation_events_sender_len_check", sql`${t.sender} is null or char_length(${t.sender}) <= 320`),
    check(
      "automation_events_body_text_len_check",
      sql`${t.bodyText} is null or char_length(${t.bodyText}) <= 32768`,
    ),
    check(
      "automation_events_body_json_size_check",
      sql`${t.bodyJson} is null or octet_length(${t.bodyJson}::text) <= 131072`,
    ),
    check("automation_events_result_check", sql`${t.result} in ('accepted','not_run')`),
    check("automation_events_reason_len_check", sql`${t.reason} is null or char_length(${t.reason}) <= 64`),
    check("automation_events_duplicate_count_check", sql`${t.duplicateCount} >= 0`),
    check(
      "automation_events_purged_check",
      sql`${t.contentPurgedAt} is null or (${t.subject} is null and ${t.sender} is null and ${t.bodyText} is null
        and ${t.bodyJson} is null and ${t.threadKey} is null)`,
    ),
  ],
);

/**
 * One run of an automation (D-07, Pitfall 6): unique per scheduled instant and per inbound item, so a retried job never
 * runs twice. `queued → delivered` (the run card posted and the turn handed to the cell) → `answered` / `no_reply`;
 * `skipped` (a cap, a missed instant) and `failed` carry a `reason` code. Webhook and mail runs start `tainted`.
 */
export const automationRuns = appSchema.table(
  "automation_runs",
  {
    id: id(),
    organizationId: orgId(),
    automationId: uuid("automation_id").notNull(),
    trigger: text("trigger", { enum: ["schedule", "webhook", "mail", "manual"] }).notNull(),
    scheduledFor: ts("scheduled_for"),
    inboundEventId: uuid("inbound_event_id"),
    status: text("status", { enum: ["queued", "delivered", "answered", "skipped", "failed", "no_reply"] })
      .notNull()
      .default("queued"),
    reason: text("reason"),
    /** The platform-owned run card (a deleted message only unlinks). */
    anchorMessageId: uuid("anchor_message_id").references(() => messages.id, { onDelete: "set null" }),
    boardCardMessageId: uuid("board_card_message_id"),
    /** The `agent.automation_run.v1` event id handed to the cell. */
    agentEventId: uuid("agent_event_id"),
    tainted: boolean("tainted").notNull().default(false),
    deliveredAt: ts("delivered_at"),
    answeredAt: ts("answered_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    /** Phase 07.17: target of the composite key of `automation_conversations.run_id` (FKs bypass RLS). */
    unique("automation_runs_org_id_uq").on(t.organizationId, t.id),
    foreignKey({
      name: "automation_runs_automation_fk",
      columns: [t.organizationId, t.automationId],
      foreignColumns: [automations.organizationId, automations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "automation_runs_inbound_event_fk",
      columns: [t.organizationId, t.inboundEventId],
      foreignColumns: [automationEvents.organizationId, automationEvents.id],
    }).onDelete("set null"),
    uniqueIndex("automation_runs_scheduled_uq")
      .on(t.automationId, t.scheduledFor)
      .where(sql`scheduled_for is not null`),
    uniqueIndex("automation_runs_inbound_uq")
      .on(t.automationId, t.inboundEventId)
      .where(sql`inbound_event_id is not null`),
    index("automation_runs_delivered_idx").on(t.status, t.deliveredAt).where(sql`status = 'delivered'`),
    index("automation_runs_automation_idx").on(t.automationId, t.createdAt.desc()),
    index("automation_runs_anchor_idx").on(t.anchorMessageId).where(sql`anchor_message_id is not null`),
    index("automation_runs_inbound_event_idx").on(t.inboundEventId).where(sql`inbound_event_id is not null`),
    check("automation_runs_trigger_check", sql`${t.trigger} in ('schedule','webhook','mail','manual')`),
    check(
      "automation_runs_status_check",
      sql`${t.status} in ('queued','delivered','answered','skipped','failed','no_reply')`,
    ),
    check(
      "automation_runs_scheduled_check",
      sql`(${t.trigger} = 'schedule') = (${t.scheduledFor} is not null)`,
    ),
    check(
      "automation_runs_inbound_check",
      sql`${t.inboundEventId} is null or ${t.trigger} in ('webhook','mail')`,
    ),
    check("automation_runs_reason_len_check", sql`${t.reason} is null or char_length(${t.reason}) <= 64`),
  ],
);

/**
 * Phase 07.17 (D-03, P1, ADR-0028 §12): one conversation a fan-out run opened for one external item. The dedupe key is
 * (automation, sha256 hex of the item's external key): a key opened once is never opened again by that automation, even
 * after its root is deleted (`root_message_id` then reads NULL and the row stays). Ids and the key hash only: never the
 * key in clear, a title or a body. `status` follows the item's own bot turn (`agent_event_id`): `queued` (posted, job
 * sent) → `delivered`, or `skipped` / `failed` with an `AutomationRunReason` code.
 */
export const automationConversations = appSchema.table(
  "automation_conversations",
  {
    id: id(),
    organizationId: orgId(),
    automationId: uuid("automation_id").notNull(),
    /** The run whose turn opened it. */
    runId: uuid("run_id").notNull(),
    externalKeyHash: text("external_key_hash").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    /**
     * The opened root (a board card or a top-level message). A deleted root only unlinks (`ON DELETE SET NULL
     * ("root_message_id")`, hand-narrowed in the migration so `conversation_id` is never cleared).
     */
    rootMessageId: uuid("root_message_id"),
    status: text("status", { enum: ["queued", "delivered", "skipped", "failed"] })
      .notNull()
      .default("queued"),
    reason: text("reason"),
    /** The `agent.automation_item.v1` event id of the item's own turn. */
    agentEventId: uuid("agent_event_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("automation_conversations_key_uq").on(t.automationId, t.externalKeyHash),
    unique("automation_conversations_org_id_uq").on(t.organizationId, t.id),
    foreignKey({
      name: "automation_conversations_automation_fk",
      columns: [t.organizationId, t.automationId],
      foreignColumns: [automations.organizationId, automations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "automation_conversations_run_fk",
      columns: [t.organizationId, t.runId],
      foreignColumns: [automationRuns.organizationId, automationRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "automation_conversations_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    /** The root is a message of the opened conversation. */
    foreignKey({
      name: "automation_conversations_root_fk",
      columns: [t.rootMessageId, t.conversationId],
      foreignColumns: [messages.id, messages.conversationId],
    }).onDelete("set null"),
    check("automation_conversations_hash_check", sql`${t.externalKeyHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "automation_conversations_status_check",
      sql`${t.status} in ('queued','delivered','skipped','failed')`,
    ),
    check(
      "automation_conversations_reason_len_check",
      sql`${t.reason} is null or char_length(${t.reason}) <= 64`,
    ),
    /** The per-day cap counts an automation's rows since the local day start. */
    index("automation_conversations_day_idx").on(t.automationId, t.createdAt),
    index("automation_conversations_run_idx").on(t.runId),
    /** Inbound replies and the board exemption find an opened root by its message id. */
    index("automation_conversations_root_idx").on(t.rootMessageId).where(sql`root_message_id is not null`),
  ],
);

/**
 * A bot's proposal of a scheduled automation (D-03, R5): the stored action of its `automation.create` approval, which
 * only the run-as person decides. Applying it creates the automation (`automation_id`); `edited` records that the person
 * changed it before applying.
 */
export const automationDrafts = appSchema.table(
  "automation_drafts",
  {
    id: id(),
    organizationId: orgId(),
    agentId: uuid("agent_id").notNull(),
    runAsUserId: uuid("run_as_user_id").notNull(),
    /** The proposing turn (`agent_turns.event_id`). */
    eventId: uuid("event_id").notNull(),
    name: text("name").notNull(),
    instructions: text("instructions").notNull(),
    scheduleCron: text("schedule_cron").notNull(),
    timeZone: text("time_zone").notNull(),
    targetKind: text("target_kind", { enum: ["channel", "thread", "dm"] }).notNull(),
    conversationId: uuid("conversation_id"),
    threadRootMessageId: uuid("thread_root_message_id"),
    maxRunsPerDay: integer("max_runs_per_day").notNull().default(24),
    status: text("status", { enum: ["pending", "applied", "discarded", "expired"] })
      .notNull()
      .default("pending"),
    automationId: uuid("automation_id"),
    edited: boolean("edited").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "automation_drafts_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "automation_drafts_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "automation_drafts_thread_root_fk",
      columns: [t.threadRootMessageId, t.conversationId],
      foreignColumns: [messages.id, messages.conversationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "automation_drafts_automation_fk",
      columns: [t.organizationId, t.automationId],
      foreignColumns: [automations.organizationId, automations.id],
    }).onDelete("set null"),
    index("automation_drafts_run_as_idx").on(t.organizationId, t.runAsUserId, t.status),
    index("automation_drafts_event_idx").on(t.organizationId, t.eventId),
    index("automation_drafts_agent_idx").on(t.organizationId, t.agentId),
    index("automation_drafts_conversation_idx")
      .on(t.organizationId, t.conversationId)
      .where(sql`conversation_id is not null`),
    index("automation_drafts_automation_idx").on(t.automationId).where(sql`automation_id is not null`),
    check("automation_drafts_name_len_check", sql`char_length(${t.name}) between 1 and 120`),
    check("automation_drafts_instructions_len_check", sql`char_length(${t.instructions}) between 1 and 4000`),
    check(
      "automation_drafts_schedule_len_check",
      sql`char_length(${t.scheduleCron}) between 9 and 120 and char_length(${t.timeZone}) between 1 and 64`,
    ),
    check(
      "automation_drafts_target_check",
      sql`(${t.targetKind} = 'dm' and ${t.conversationId} is null and ${t.threadRootMessageId} is null)
        or (${t.targetKind} = 'channel' and ${t.conversationId} is not null and ${t.threadRootMessageId} is null)
        or (${t.targetKind} = 'thread' and ${t.conversationId} is not null and ${t.threadRootMessageId} is not null)`,
    ),
    check("automation_drafts_max_runs_per_day_check", sql`${t.maxRunsPerDay} between 1 and 288`),
    check("automation_drafts_status_check", sql`${t.status} in ('pending','applied','discarded','expired')`),
  ],
);

/**
 * A board card linked to an external record (D-04, D-09): the fields a template watches, read through a 07.4 connector
 * (`read_tool` with `{ [id_arg]: external_ref }`) as `check_as_user_id`. `snapshot_hash` is sha256 over the canonical
 * JSON of the projected fields (07.5 `canonicalJson`); `last_written_hash` is the compare-and-set base of the last
 * `ocw_record_update` write. One watch per card.
 */
export const watchedRecords = appSchema.table(
  "watched_records",
  {
    id: id(),
    organizationId: orgId(),
    cardMessageId: uuid("card_message_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    mcpServerId: uuid("mcp_server_id").notNull(),
    externalRef: text("external_ref").notNull(),
    readTool: text("read_tool").notNull(),
    writeTool: text("write_tool"),
    noteTool: text("note_tool"),
    idArg: text("id_arg").notNull(),
    /** The watched fields (`WatchedField[]`: a JSON pointer and a label each). */
    fields: jsonb("fields").$type<Array<Record<string, unknown>>>().notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    snapshotHash: text("snapshot_hash"),
    lastWrittenHash: text("last_written_hash"),
    /**
     * A write in flight (07.6 review HI-01): set atomically by the compare-and-set's `begin` only while no other lease
     * is live, cleared when the write ends. Bounded, so a crashed API never blocks the record for long.
     */
    writeLeaseUntil: ts("write_lease_until"),
    checkAsUserId: uuid("check_as_user_id").notNull(),
    checkIntervalMinutes: integer("check_interval_minutes").notNull().default(60),
    nextCheckAt: ts("next_check_at").notNull().defaultNow(),
    checkedAt: ts("checked_at"),
    lastChangedAt: ts("last_changed_at"),
    lastStatus: text("last_status", { enum: ["ok", "changed", "not_connected", "unreachable", "error"] })
      .notNull()
      .default("ok"),
    createdBy: uuid("created_by").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("watched_records_org_id_uq").on(t.organizationId, t.id),
    unique("watched_records_card_uq").on(t.cardMessageId),
    /** The card is a card of the record's board channel. */
    foreignKey({
      name: "watched_records_card_fk",
      columns: [t.cardMessageId, t.conversationId],
      foreignColumns: [boardCards.messageId, boardCards.conversationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "watched_records_conversation_fk",
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "watched_records_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "watched_records_mcp_server_fk",
      columns: [t.organizationId, t.mcpServerId],
      foreignColumns: [mcpServers.organizationId, mcpServers.id],
    }).onDelete("cascade"),
    index("watched_records_due_idx").on(t.nextCheckAt),
    index("watched_records_conversation_idx").on(t.organizationId, t.conversationId),
    index("watched_records_agent_idx").on(t.organizationId, t.agentId),
    index("watched_records_mcp_server_idx").on(t.organizationId, t.mcpServerId),
    check("watched_records_external_ref_len_check", sql`char_length(${t.externalRef}) between 1 and 200`),
    check(
      "watched_records_tools_len_check",
      sql`char_length(${t.readTool}) between 1 and 200
        and (${t.writeTool} is null or char_length(${t.writeTool}) between 1 and 200)
        and (${t.noteTool} is null or char_length(${t.noteTool}) between 1 and 200)`,
    ),
    check("watched_records_id_arg_len_check", sql`char_length(${t.idArg}) between 1 and 100`),
    check("watched_records_fields_check", sql`jsonb_typeof(${t.fields}) = 'array'`),
    check(
      "watched_records_snapshot_hash_check",
      sql`${t.snapshotHash} is null or ${t.snapshotHash} ~ ${SHA256_HEX}`,
    ),
    check(
      "watched_records_last_written_hash_check",
      sql`${t.lastWrittenHash} is null or ${t.lastWrittenHash} ~ ${SHA256_HEX}`,
    ),
    check("watched_records_interval_check", sql`${t.checkIntervalMinutes} in (15,30,60,240,1440)`),
    check(
      "watched_records_last_status_check",
      sql`${t.lastStatus} in ('ok','changed','not_connected','unreachable','error')`,
    ),
    check("watched_records_version_check", sql`${t.version} >= 1`),
  ],
);

/**
 * The before → after history of a watched record (D-04). Append-only for the app role (UPDATE and DELETE revoked in
 * post-migrate); it still goes with its watched record (FK cascades are not subject to the grant).
 */
export const watchedRecordChanges = appSchema.table(
  "watched_record_changes",
  {
    id: id(),
    organizationId: orgId(),
    watchedRecordId: uuid("watched_record_id").notNull(),
    detectedAt: ts("detected_at").notNull().defaultNow(),
    source: text("source", { enum: ["access", "schedule", "write", "manual"] }).notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash").notNull(),
    /** The thread reply that reported it (a deleted message only unlinks). */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  },
  (t) => [
    foreignKey({
      name: "watched_record_changes_record_fk",
      columns: [t.organizationId, t.watchedRecordId],
      foreignColumns: [watchedRecords.organizationId, watchedRecords.id],
    }).onDelete("cascade"),
    index("watched_record_changes_record_idx").on(t.organizationId, t.watchedRecordId, t.detectedAt),
    index("watched_record_changes_message_idx").on(t.messageId).where(sql`message_id is not null`),
    check("watched_record_changes_source_check", sql`${t.source} in ${WATCHED_CHECK_SOURCES}`),
    check(
      "watched_record_changes_before_hash_check",
      sql`${t.beforeHash} is null or ${t.beforeHash} ~ ${SHA256_HEX}`,
    ),
    check("watched_record_changes_after_hash_check", sql`${t.afterHash} ~ ${SHA256_HEX}`),
  ],
);

/**
 * A Work Zone session's memory summary state (D-06, D-10, D-11): `writing` → `proposed` (a 07.2 proposal,
 * `approval_id`) or `failed`. `unit_id` is the team project the proposal went to, resolved through 07.9's
 * `work_project_repos` at summary time (a deleted unit only unlinks). Behind the session's audience like `work_prompts`
 * (RESTRICTIVE `audience_backstop` in post-migrate).
 */
export const workSessionMemory = appSchema.table(
  "work_session_memory",
  {
    workSessionId: uuid("work_session_id").primaryKey(),
    organizationId: orgId(),
    unitId: uuid("unit_id"),
    status: text("status", { enum: ["writing", "proposed", "failed"] }).notNull(),
    approvalId: uuid("approval_id"),
    /** The session stream's last seq the summary covered. */
    summarizedSeq: bigint("summarized_seq", { mode: "number" }),
    /** Started by the owner's automatic preference, not the button. */
    auto: boolean("auto").notNull().default(false),
    errorCode: text("error_code"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "work_session_memory_session_fk",
      columns: [t.organizationId, t.workSessionId],
      foreignColumns: [workSessions.organizationId, workSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_session_memory_unit_fk",
      columns: [t.organizationId, t.unitId],
      foreignColumns: [orgUnits.organizationId, orgUnits.id],
    }).onDelete("set null"),
    index("work_session_memory_unit_idx").on(t.organizationId, t.unitId).where(sql`unit_id is not null`),
    check("work_session_memory_status_check", sql`${t.status} in ('writing','proposed','failed')`),
    check(
      "work_session_memory_error_code_len_check",
      sql`${t.errorCode} is null or char_length(${t.errorCode}) <= 64`,
    ),
  ],
);

/** A person's Work Zone memory preference (D-06): propose a summary automatically when a session ends; off by default. */
export const workMemoryPrefs = appSchema.table(
  "work_memory_prefs",
  {
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    autoPropose: boolean("auto_propose").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] })],
);
