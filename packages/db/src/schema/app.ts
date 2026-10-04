import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
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
  },
  (t) => [
    index("conversations_org_kind_idx").on(t.organizationId, t.kind),
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
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.memberKind, t.memberId] }),
    index("conversation_members_member_idx").on(t.organizationId, t.memberKind, t.memberId),
  ],
);

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
  },
  (t) => [
    uniqueIndex("agents_org_username_uq").on(t.organizationId, t.username).where(sql`deleted_at is null`),
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
    kind: text("kind", { enum: ["provider_api_key"] }).notNull(),
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
    secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
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
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("devices_org_idx").on(t.organizationId)],
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
    permissionMode: text("permission_mode", { enum: ["default", "acceptEdits", "plan"] })
      .notNull()
      .default("default"),
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
    createdBy: uuid("created_by").notNull(),
    runtimeSessionId: text("runtime_session_id"),
    worktree: boolean("worktree").notNull().default(false),
    branch: text("branch"),
    /** Highest device localSeq stored for this session (Device Link replay de-duplication). */
    lastLocalSeq: bigint("last_local_seq", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("work_sessions_org_idx").on(t.organizationId, t.projectId)],
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
    createdAt: createdAt(),
    dispatchedAt: ts("dispatched_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [index("work_prompts_session_idx").on(t.organizationId, t.workSessionId, t.position)],
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
      enum: ["session.start", "prompt", "interrupt", "approval.resolve", "session.stop", "diff.request"],
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
