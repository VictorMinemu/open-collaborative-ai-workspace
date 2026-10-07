import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
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
  },
  (t) => [
    index("org_units_parent_idx").on(t.organizationId, t.parentId),
    index("org_units_path_gin").using("gin", t.path),
    // NULLS NOT DISTINCT (top-level siblings collide too) is hand-added in the identity_org migration:
    // drizzle 1.0.0-rc.4 has no builder for it.
    uniqueIndex("org_units_sibling_name_uq").on(t.organizationId, t.parentId, sql`lower(${t.name})`),
    check("org_units_kind_check", sql`${t.kind} in ('department','team','project')`),
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
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("permission_rules_org_idx").on(t.organizationId),
    check("permission_rules_subject_kind_check", sql`${t.subjectKind} in ('everyone','role','user','agent')`),
    check("permission_rules_effect_check", sql`${t.effect} in ('allow','deny')`),
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
  },
  (t) => [
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
    mentions: jsonb("mentions").$type<Array<{ kind: "user" | "agent"; id: string }>>().notNull().default([]),
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
    mentions: jsonb("mentions").$type<Array<{ kind: "user" | "agent"; id: string }>>().notNull().default([]),
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
  },
  (t) => [
    uniqueIndex("notifications_user_message_uq").on(t.userId, t.messageId),
    index("notifications_org_user_created_idx").on(t.organizationId, t.userId, t.createdAt),
    index("notifications_unread_idx")
      .on(t.organizationId, t.userId, t.conversationId)
      .where(sql`read_at is null`),
    check(
      "notifications_kind_check",
      sql`${t.kind} in ('mention','channel','here','dm','group_dm','thread_reply','ai_chat_shared','card_updated')`,
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
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
    deletedAt: ts("deleted_at"),
    purgedAt: ts("purged_at"),
  },
  (t) => [
    index("attachments_org_conv_idx").on(t.organizationId, t.conversationId),
    index("attachments_org_message_idx").on(t.organizationId, t.messageId),
    index("attachments_org_work_prompt_idx").on(t.organizationId, t.workPromptId),
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
  ],
);

// ---------------------------------------------------------------- bot capabilities (Phase 3.1, D-05 … D-14)

/** Organization bot policy (D-06): one row per org; an absent row means the defaults (allow everything). */
export const botPolicies = appSchema.table("bot_policies", {
  organizationId: orgId().primaryKey(),
  /** Per built-in capability `{ orgWide, personal }` (partial; defaults in code). */
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
  searchProvider: text("search_provider").notNull().default("duckduckgo"),
  maxPersonalBotsPerUser: integer("max_personal_bots_per_user").notNull().default(3),
  personalDailyLimitMax: integer("personal_daily_limit_max").notNull().default(100),
  /** Empty = every allowed model of the organization. Entries are `provider/modelId`. */
  personalAllowedModels: text("personal_allowed_models").array().notNull().default(sql`'{}'::text[]`),
  updatedBy: uuid("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

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
  },
  (t) => [index("agent_turns_org_agent_time_idx").on(t.organizationId, t.agentId, t.createdAt)],
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
    sourceKind: text("source_kind", { enum: ["builtin", "mcp", "plugin"] }).notNull(),
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
  },
  (t) => [
    index("agent_tool_calls_org_event_idx").on(t.organizationId, t.eventId),
    check("agent_tool_calls_source_kind_check", sql`${t.sourceKind} in ('builtin','mcp','plugin')`),
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

/** Admin MCP server registry (D-13). Header values live in `secrets` (kind `mcp_credential`). */
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
  },
  (t) => [
    uniqueIndex("mcp_servers_org_safe_name_uq").on(t.organizationId, t.safeName),
    check("mcp_servers_transport_check", sql`${t.transport} in ('streamable-http','sse','sandboxed-stdio')`),
    check("mcp_servers_status_check", sql`${t.status} in ('pending','probing','ready','error')`),
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
  },
  (t) => [primaryKey({ columns: [t.serverId, t.name] })],
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
     */
    kind: text("kind", { enum: ["provider_api_key", "mcp_credential", "user_model_credential"] }).notNull(),
    provider: text("provider"),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("secrets_org_idx").on(t.organizationId)],
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
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("devices_org_idx").on(t.organizationId),
    modeCheck("devices_share_max_mode_ck", t.shareMaxMode),
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
export const workZonePolicies = appSchema.table("work_zone_policies", {
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
  updatedBy: uuid("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

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
  (t) => [uniqueIndex("projects_device_local_uq").on(t.deviceId, t.localId)],
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
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("work_sessions_org_idx").on(t.organizationId, t.projectId),
    // 06.1: attachment routes find the session of a `work_session` conversation on every preview.
    index("work_sessions_conversation_idx").on(t.organizationId, t.conversationId),
    modeCheck("work_sessions_permission_mode_ck", t.permissionMode),
    check("work_sessions_title_source_ck", sql`${t.titleSource} in ('user','heuristic','auto')`),
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
  },
  (t) => [
    index("work_prompts_session_idx").on(t.organizationId, t.workSessionId, t.position),
    modeCheck("work_prompts_permission_mode_ck", t.permissionMode),
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
    generationId: uuid("generation_id").notNull(),
    kind: text("kind", { enum: ["chat", "title"] }).notNull(),
    requesterUserId: uuid("requester_user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
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
  },
  (t) => [
    uniqueIndex("ai_usage_records_generation_kind_uq").on(t.generationId, t.kind),
    index("ai_usage_records_org_time_idx").on(t.organizationId, t.createdAt),
    index("ai_usage_records_requester_time_idx").on(t.organizationId, t.requesterUserId, t.createdAt),
    check("ai_usage_records_kind_check", sql`${t.kind} in ('chat','title')`),
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
    kind: text("kind", {
      enum: ["work_zone", "approval", "report", "artifact", "automation", "deployment", "pr", "generic"],
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
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("message_cards_conv_idx").on(t.organizationId, t.conversationId),
    check(
      "message_cards_kind_check",
      sql`${t.kind} in ('work_zone','approval','report','artifact','automation','deployment','pr','generic')`,
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
