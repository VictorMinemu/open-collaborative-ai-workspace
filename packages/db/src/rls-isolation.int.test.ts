import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_AI_CHAT_POLICY } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantDb, type TenantDb } from "./tenant";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * FOUND-02/03: every org-scoped table in schema `app` has RLS + FORCE + a policy, cross-tenant reads return
 * 0 rows and cross-tenant writes fail when connected as ocw_app; ocw_app cannot touch schema `auth`.
 * A new table without a fixture below FAILS this test (new tables cannot dodge it).
 */

let tdb: TestDatabase;
let migrator: pg.Client;
let app: pg.Client;

const A = randomUUID();
const B = randomUUID();

async function seedOrg(c: pg.Client, org: string) {
  const user = randomUUID();
  const conv = randomUUID();
  const msg = randomUUID();
  const agent = randomUUID();
  const secret = randomUUID();
  const device = randomUUID();
  const project = randomUUID();
  const ws = randomUUID();
  const q = (text: string, values: unknown[]) => c.query(text, values);
  await q("insert into auth.organization (id, name, slug) values ($1, $2, $3)", [
    org,
    `Org ${org}`,
    `org-${org}`,
  ]);
  await q("insert into auth.user (id, name, email) values ($1, 'U', $2)", [user, `${user}@example.test`]);
  await q(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'U', 'admin')",
    [org, user],
  );
  const unit = randomUUID();
  await q(
    "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'department', 'Engineering', ARRAY[$1]::uuid[])",
    [unit, org],
  );
  await q("insert into app.unit_memberships (organization_id, unit_id, user_id) values ($1, $2, $3)", [
    org,
    unit,
    user,
  ]);
  await q(
    "insert into app.permission_rules (organization_id, subject_kind, permission, effect) values ($1, 'everyone', 'channel.create', 'deny')",
    [org],
  );
  await q(
    "insert into app.audit_events (organization_id, actor_kind, actor_id, resource_type, action, result) values ($1, 'user', $2, 'org', 'test.seed', 'success')",
    [org, user],
  );
  await q("insert into app.streams (id, organization_id, last_seq) values ($1, $2, 1)", [
    `conv:${conv}`,
    org,
  ]);
  await q(
    "insert into app.stream_events (stream_id, seq, organization_id, type, payload) values ($1, 1, $2, 'test', '{}')",
    [`conv:${conv}`, org],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug, created_by) values ($1, $2, 'channel', 'general', $3, $4)",
    [conv, org, `general-${conv}`, user],
  );
  await q(
    "insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role) values ($1, $2, 'user', $3, 'owner')",
    [conv, org, user],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, 'hi')",
    [msg, org, conv, user],
  );
  await q(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, 'Bot', $3, 'be nice', 'mock', 'mock-1')",
    [agent, org, `bot-${agent.slice(0, 8)}`],
  );
  await q(
    "insert into app.agent_credentials (organization_id, agent_id, kind, token_hash) values ($1, $2, 'channel_plugin', $3)",
    [org, agent, `hash-${agent}`],
  );
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'k', 'provider_api_key', 'c', 'i', 't')",
    [secret, org],
  );
  await q(
    "insert into app.model_providers (organization_id, provider, secret_id, allowed_models) values ($1, 'mock', $2, '{mock-1}')",
    [org, secret],
  );
  await q(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'laptop', 'darwin', $4)",
    [device, org, user, `dev-${device}`],
  );
  await q(
    "insert into app.device_enrollments (code_hash, organization_id, user_id, expires_at) values ($1, $2, $3, now() + interval '10 minutes')",
    [`code-${device}`, org, user],
  );
  await q(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'p1', 'repo')",
    [project, org, device],
  );
  const wsConv = randomUUID();
  await q(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [wsConv, org],
  );
  await q(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by) values ($1, $2, $3, $4, $5, 'T', $6)",
    [ws, org, wsConv, project, device, user],
  );
  await q(
    "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'do it', 1)",
    [org, ws, user],
  );
  await q(
    `insert into app.work_approvals (organization_id, work_session_id, request) values ($1, $2, '{"tool":"Edit","summary":"x","paths":["a.ts"]}')`,
    [org, ws],
  );
  await q(
    "insert into app.device_commands (organization_id, device_id, work_session_id, kind, payload) values ($1, $2, $3, 'prompt', '{}')",
    [org, device, ws],
  );

  // Phase 3.1 (personal bots and bot capabilities): one row per new table.
  const personal = randomUUID();
  const dm = randomUUID();
  const mcp = randomUUID();
  const plugin = randomUUID();
  await q(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, $2, 'Mine', $3, 'x', 'mock', 'mock-1', 'personal', $4)",
    [personal, org, `mine-${personal.slice(0, 8)}`, user],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, visibility, dm_key) values ($1, $2, 'dm', 'private', $3)",
    [dm, org, `agent:${personal}|user:${user}`],
  );
  await q("insert into app.bot_policies (organization_id) values ($1)", [org]);
  const eventId = randomUUID();
  await q(
    "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id) values ($1, $2, $3, $4, $5, 'dm', $6)",
    [eventId, org, personal, user, dm, randomUUID()],
  );
  await q(
    "insert into app.agent_tool_calls (organization_id, event_id, agent_id, user_id, tool, source_kind, decision) values ($1, $2, $3, $4, 'web_search', 'builtin', 'allowed')",
    [org, eventId, personal, user],
  );
  await q(
    "insert into app.agent_usage_daily (organization_id, agent_id, day, turns) values ($1, $2, current_date, 1)",
    [org, personal],
  );
  await q(
    "insert into app.agent_limit_notices (organization_id, agent_id, conversation_id, day) values ($1, $2, $3, current_date)",
    [org, personal, dm],
  );
  await q(
    "insert into app.agent_memories (organization_id, agent_id, user_id, text) values ($1, $2, $3, 'likes tea')",
    [org, personal, user],
  );
  await q(
    "insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url) values ($1, $2, 'Docs', $3, 'streamable-http', 'https://mcp.example.test')",
    [mcp, org, `m${mcp.replace(/-/g, "").slice(0, 8)}`],
  );
  await q(
    "insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name) values ($1, $2, 'search', 'mx__search')",
    [org, mcp],
  );
  await q(
    "insert into app.cell_plugins (id, organization_id, package_name, version, channel, artifact_sha256, risk, status) values ($1, $2, '@openclaw/duckduckgo-plugin', '2026.9.7', 'official', 'abc', 'low', 'approved')",
    [plugin, org],
  );
  await q(
    "insert into app.cell_plugin_tools (organization_id, plugin_row_id, name) values ($1, $2, 'web_search')",
    [org, plugin],
  );
  await q(
    "insert into app.bot_tool_grants (organization_id, agent_id, source_kind, source_id, tool_name) values ($1, $2, 'mcp', $3, 'search')",
    [org, personal, mcp],
  );

  // Phase 03.2 (Work Zone session controls): one row per new table.
  await q(
    "insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode, created_by) values ($1, $2, 'user', $3, 'acceptEdits', $3)",
    [org, device, user],
  );
  await q("insert into app.work_zone_policies (organization_id) values ($1)", [org]);

  // Phase 4 (chat workspace): one row per new table, on the seeded channel message.
  await q(
    "insert into app.message_versions (organization_id, message_id, version, kind, body, edited_by_kind, edited_by) values ($1, $2, 1, 'edit', 'hi there', 'user', $3)",
    [org, msg, user],
  );
  await q(
    "insert into app.message_reactions (organization_id, message_id, conversation_id, emoji, member_kind, member_id) values ($1, $2, $3, '👍', 'user', $4)",
    [org, msg, conv, user],
  );
  await q(
    "insert into app.message_pins (organization_id, conversation_id, message_id, pinned_by) values ($1, $2, $3, $4)",
    [org, conv, msg, user],
  );
  await q("insert into app.message_saves (organization_id, user_id, message_id) values ($1, $2, $3)", [
    org,
    user,
    msg,
  ]);
  await q(
    "insert into app.notifications (organization_id, user_id, kind, conversation_id, message_id, actor_kind, actor_id) values ($1, $2, 'mention', $3, $4, 'user', $2)",
    [org, user, conv, msg],
  );
  await q("insert into app.notification_prefs (organization_id, user_id) values ($1, $2)", [org, user]);
  await q(
    "insert into app.thread_reads (organization_id, user_id, root_message_id, last_read_seq) values ($1, $2, $3, 1)",
    [org, user, msg],
  );
  await q(
    "insert into app.attachments (organization_id, conversation_id, uploader_id, filename, declared_type, size_bytes) values ($1, $2, $3, 'plan.pdf', 'application/pdf', 1234)",
    [org, conv, user],
  );

  // Phase 5 (direct AI chat): one row per new table, on the seeded conversation and an assistant message.
  const assistant = randomUUID();
  const completedGen = randomUUID();
  const credentialSecret = randomUUID();
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, status) values ($1, $2, $3, 2, 'agent', null, '', 'streaming')",
    [assistant, org, conv],
  );
  await q("insert into app.ai_chats (conversation_id, organization_id, owner_user_id) values ($1, $2, $3)", [
    conv,
    org,
    user,
  ]);
  await q("insert into app.ai_user_preferences (organization_id, user_id) values ($1, $2)", [org, user]);
  await q(
    "insert into app.ai_generations (id, organization_id, conversation_id, assistant_message_id, requester_user_id, backend, provider, model_id, status, instance_id, finished_at) values ($1, $2, $3, $4, $5, 'org_key', 'anthropic', 'claude-sonnet-5-5', 'completed', 'api-1', now())",
    [completedGen, org, conv, assistant, user],
  );
  await q(
    "insert into app.ai_generations (organization_id, conversation_id, assistant_message_id, requester_user_id, backend, provider, model_id, attempt, instance_id) values ($1, $2, $3, $4, 'org_key', 'anthropic', 'claude-sonnet-5-5', 2, 'api-1')",
    [org, conv, assistant, user],
  );
  await q(
    "insert into app.ai_usage_records (organization_id, generation_id, kind, requester_user_id, conversation_id, message_id, backend, provider, model_id, input_tokens, output_tokens, cost_micros_usd, price_ref) values ($1, $2, 'chat', $3, $4, $5, 'org_key', 'anthropic', 'claude-sonnet-5-5', 10, 20, 220, '2026-10-06:anthropic/claude-sonnet-5-5')",
    [org, completedGen, user, conv, assistant],
  );
  await q(
    "insert into app.ai_usage_daily (organization_id, user_id, day, backend_class, generations, input_tokens, output_tokens, cost_micros_usd) values ($1, $2, current_date, 'org_key', 1, 10, 20, 220)",
    [org, user],
  );
  await q("insert into app.ai_chat_policies (organization_id) values ($1)", [org]);
  await q(
    "insert into app.secrets (id, organization_id, name, kind, provider, ciphertext, iv, tag) values ($1, $2, 'chatgpt', 'user_model_credential', 'chatgpt_plan', 'c', 'i', 't')",
    [credentialSecret, org],
  );
  await q(
    "insert into app.user_model_credentials (organization_id, user_id, provider, secret_id, status) values ($1, $2, 'chatgpt_plan', $3, 'connected')",
    [org, user, credentialSecret],
  );
  await q(
    `insert into app.ai_chat_shares (organization_id, conversation_id, created_by, title, snapshot) values ($1, $2, $3, 'Trip plan', '{"messages":[]}')`,
    [org, conv, user],
  );

  // Phase 6 (multiplayer AI chat): one row per new table. An `ai_chat` conversation shared with a second person and
  // with the whole organization, a context row on its user message answered by a generation, an Agent Card on an
  // agent message in the channel and a follow of that card.
  const aiConv = randomUUID();
  const aiAsk = randomUUID();
  const aiAnswer = randomUUID();
  const aiGen = randomUUID();
  const guest = randomUUID();
  const cardMsg = randomUUID();
  await q(
    "insert into app.conversations (id, organization_id, kind, visibility, name, created_by) values ($1, $2, 'ai_chat', 'private', 'Trip plan', $3)",
    [aiConv, org, user],
  );
  await q("insert into app.ai_chats (conversation_id, organization_id, owner_user_id) values ($1, $2, $3)", [
    aiConv,
    org,
    user,
  ]);
  await q(
    "insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role) values ($1, $2, 'user', $3, 'owner')",
    [aiConv, org, user],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, 'Plan the trip')",
    [aiAsk, org, aiConv, user],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, status) values ($1, $2, $3, 2, 'agent', null, 'Here is a plan', 'completed')",
    [aiAnswer, org, aiConv],
  );
  await q(
    "insert into app.ai_generations (id, organization_id, conversation_id, user_message_id, assistant_message_id, requester_user_id, backend, provider, model_id, status, instance_id, finished_at) values ($1, $2, $3, $4, $5, $6, 'mock', 'mock', 'mock-1', 'completed', 'api-1', now())",
    [aiGen, org, aiConv, aiAsk, aiAnswer, user],
  );
  await q(
    "insert into app.ai_chat_grants (organization_id, conversation_id, subject_kind, subject_id, level, granted_by) values ($1, $2, 'user', $3, 'chat', $4)",
    [org, aiConv, guest, user],
  );
  await q(
    "insert into app.ai_chat_grants (organization_id, conversation_id, subject_kind, subject_id, level, granted_by) values ($1, $2, 'org', null, 'view', $3)",
    [org, aiConv, user],
  );
  await q(
    `insert into app.ai_message_context (message_id, organization_id, conversation_id, author_kind, access, level, addressed, answered_by_generation_id, model) values ($1, $2, $3, 'user', 'owner', 'owner', true, $4, '{"backend":"mock","provider":"mock","modelId":"mock-1"}')`,
    [aiAsk, org, aiConv, aiGen],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 3, 'agent', $4, 'Deploy web to production: pending')",
    [cardMsg, org, conv, agent],
  );
  await q(
    `insert into app.message_cards (message_id, organization_id, conversation_id, agent_id, kind, title, fields, status, actions) values ($1, $2, $3, $4, 'approval', 'Deploy web to production', '[{"label":"Environment","value":"production"}]', 'pending', '[{"kind":"approve","label":"Approve"}]')`,
    [cardMsg, org, conv, agent],
  );
  await q("insert into app.message_card_follows (organization_id, message_id, user_id) values ($1, $2, $3)", [
    org,
    cardMsg,
    user,
  ]);

  // Phase 07.1 (board channels and record templates): one row per new table. An organization-wide template, a
  // board channel created from it with one column, and a card on the board's first top-level message.
  const template = randomUUID();
  const board = randomUUID();
  const column = randomUUID();
  const cardRoot = randomUUID();
  await q(
    `insert into app.record_templates (id, organization_id, unit_id, name, prefix, naming_rule, fields, columns, created_by) values ($1, $2, null, 'Case file', 'EXP', '{prefix}-{seq:0000} · {summary}', '[{"key":"customer","label":"Customer","type":"text"}]', '[{"name":"Backlog","category":"backlog"}]', $3)`,
    [template, org, user],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug, created_by, layout) values ($1, $2, 'channel', 'cases', $3, $4, 'board')",
    [board, org, `cases-${board}`, user],
  );
  await q(
    "insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role) values ($1, $2, 'user', $3, 'owner')",
    [board, org, user],
  );
  await q(
    `insert into app.boards (conversation_id, organization_id, template_id, prefix, naming_rule, fields, last_number) values ($1, $2, $3, 'EXP', '{prefix}-{seq:0000} · {summary}', '[{"key":"customer","label":"Customer","type":"text"}]', 1)`,
    [board, org, template],
  );
  await q(
    "insert into app.board_columns (id, organization_id, conversation_id, name, rank, category) values ($1, $2, $3, 'Backlog', 'a0', 'backlog')",
    [column, org, board],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, 'EXP-0001 · Broken pump')",
    [cardRoot, org, board, user],
  );
  await q(
    `insert into app.board_cards (message_id, organization_id, conversation_id, column_id, rank, title, title_source, description, number, fields) values ($1, $2, $3, $4, 'a0', 'EXP-0001 · Broken pump', 'auto', 'Broken pump', 1, '{"customer":"Acme"}')`,
    [cardRoot, org, board, column],
  );

  // Phase 07.2 (scoped memory files and approvals): one row per new table, all in the department's SHARED scope so the
  // generic enumerator below counts them without an `app.user_id`. Personal rows (owner-only on top of the tenant
  // policy) have their own suite: memory-privacy.int.test.ts.
  const memScope = randomUUID();
  const memFile = randomUUID();
  const approval = randomUUID();
  await q("insert into app.memory_scopes (id, organization_id, kind, unit_id) values ($1, $2, 'unit', $3)", [
    memScope,
    org,
    unit,
  ]);
  await q(
    "insert into app.memory_files (id, organization_id, scope_id, path, content, bytes, updated_by_kind, updated_by_id) values ($1, $2, $3, 'MEMORY.md', '# Memory\n', 9, 'user', $4)",
    [memFile, org, memScope, user],
  );
  await q(
    `insert into app.approval_requests (id, organization_id, kind, mode, resource_type, resource_id, action_hash, requested_by_agent_id, requested_for_user_id, card_message_id, expires_at) values ($1, $2, 'memory.write', 'server_apply', 'memory_proposal', $3, $4, $5, $6, $7, now() + interval '14 days')`,
    [approval, org, randomUUID(), "f".repeat(64), agent, user, cardMsg],
  );
  await q(
    "insert into app.memory_file_revisions (organization_id, file_id, scope_id, version, op, path, content, lines_added, author_kind, author_id, approval_request_id) values ($1, $2, $3, 1, 'create', 'MEMORY.md', '# Memory\n', 1, 'user', $4, $5)",
    [org, memFile, memScope, user, approval],
  );
  await q(
    `insert into app.memory_proposals (organization_id, scope_id, file_id, path, op, base_version, content, content_sha256, findings, reader_count, tainted, requested_by_agent_id, requested_for_user_id) values ($1, $2, $3, 'MEMORY.md', 'append', 1, '- uses pnpm', $4, '[]', 3, false, $5, $6)`,
    [org, memScope, memFile, "e".repeat(64), agent, user],
  );

  // Phase 07.4 (per-member connectors, keychain, templates): one row per new table. A per-member OAuth connector with
  // a pre-registered client, the member's sealed connection, a member-account share in the channel, a personal key
  // granted to the personal bot, and a unit template (v1) the personal bot was started from. Secret-bearing columns
  // hold only ids / SecretReferences; the values are the sealed `app.secrets` rows.
  const crm = randomUUID();
  const clientSecret = randomUUID();
  const connSecret = randomUUID();
  const vaultSecret = randomUUID();
  const vaultItem = randomUUID();
  const agentTemplate = randomUUID();
  await q(
    "insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, auth_mode, oauth_status) values ($1, $2, 'CRM', $3, 'streamable-http', 'https://crm.example.test/mcp', 'per_member_oauth', 'ready')",
    [crm, org, `m${crm.replace(/-/g, "").slice(0, 8)}`],
  );
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'client', 'mcp_credential', 'c', 'i', 't'), ($3, $2, 'conn', 'connector_credential', 'c', 'i', 't'), ($4, $2, 'key', 'vault_item', 'c', 'i', 't')",
    [clientSecret, org, connSecret, vaultSecret],
  );
  await q(
    "insert into app.connector_oauth_clients (organization_id, server_id, issuer, client_id, client_secret_id, method) values ($1, $2, 'https://auth.crm.example.test', 'ocw-client', $3, 'pre_registered')",
    [org, crm, clientSecret],
  );
  await q(
    "insert into app.connector_connections (organization_id, user_id, server_id, status, secret_id, issuer, client_id, scopes, account_label, access_expires_at) values ($1, $2, $3, 'connected', $4, 'https://auth.crm.example.test', 'ocw-client', '{crm.read}', 'ada@example.test', now() + interval '1 hour')",
    [org, user, crm, connSecret],
  );
  await q(
    "insert into app.member_account_shares (organization_id, user_id, conversation_id, resource_kind, resource_id, readers_at_grant) values ($1, $2, $3, 'connector', $4, 1)",
    [org, user, conv, crm],
  );
  // Phase 07.14 (D-06): the organization's own account on an `org_oauth` server; only state, the bundle is sealed.
  const ops = randomUUID();
  const orgConnSecret = randomUUID();
  await q(
    "insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, auth_mode) values ($1, $2, 'Ops', $3, 'streamable-http', 'https://ops.example.test/mcp', 'org_oauth')",
    [ops, org, `m${ops.replace(/-/g, "").slice(0, 8)}`],
  );
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'org conn', 'connector_credential', 'c', 'i', 't')",
    [orgConnSecret, org],
  );
  await q(
    "insert into app.connector_org_connections (organization_id, server_id, method, status, secret_id, issuer, client_id, scopes, account_label, connected_by, access_expires_at) values ($1, $2, 'oauth', 'connected', $3, 'https://auth.ops.example.test', 'ocw-client', '{ops.read}', 'ops@example.test', $4, now() + interval '1 hour')",
    [org, ops, orgConnSecret, user],
  );
  await q(
    `insert into app.vault_items (id, organization_id, scope, owner_user_id, name, handle, kind, injection, allowed_hosts, secret_ref, created_by) values ($1, $2, 'personal', $3, 'ERP key', 'k_abcdefghij', 'api_key', '{"header":"Authorization","scheme":"bearer"}', '{erp.example.test}', $4::jsonb, $3)`,
    [vaultItem, org, user, JSON.stringify({ provider: "db", secretId: vaultSecret, organizationId: org })],
  );
  await q(
    "insert into app.agent_vault_grants (organization_id, agent_id, vault_item_id, created_by) values ($1, $2, $3, $4)",
    [org, personal, vaultItem, user],
  );
  // 07.4-07: an organization key too. Personal keys sit behind the owner-only policy, so a session without that owner
  // (the enumerator's tenant-only context) sees this one.
  const orgVaultSecret = randomUUID();
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'org key', 'vault_item', 'c', 'i', 't')",
    [orgVaultSecret, org],
  );
  const orgVaultItem = randomUUID();
  await q(
    `insert into app.vault_items (id, organization_id, scope, name, handle, kind, injection, allowed_hosts, secret_ref, created_by) values ($4, $1, 'unit', 'Org ERP key', 'k_orgkeyaaaa', 'api_key', '{"header":"Authorization","scheme":"bearer"}', '{erp.example.test}', $2::jsonb, $3)`,
    [
      org,
      JSON.stringify({ provider: "db", secretId: orgVaultSecret, organizationId: org }),
      user,
      orgVaultItem,
    ],
  );
  // 07.4-14 (WINDOWS #182): grants on a personal key are owner-only too; a grant on the organization key stays visible
  // to the tenant-only context.
  await q(
    "insert into app.agent_vault_grants (organization_id, agent_id, vault_item_id, created_by) values ($1, $2, $3, $4)",
    [org, personal, orgVaultItem, user],
  );
  await q(
    "insert into app.agent_templates (id, organization_id, unit_id, name, description, current_version, created_by) values ($1, $2, $3, 'Sales assistant', 'Answers from the CRM', 1, $4)",
    [agentTemplate, org, unit, user],
  );
  await q(
    `insert into app.agent_template_versions (organization_id, template_id, version, instructions, model_provider, model_id, capabilities, required_connector_ids, created_by) values ($1, $2, 1, 'Help the sales team', 'mock', 'mock-1', '{"internet":false,"memory":true,"dailyLimit":null}', ARRAY[$3]::uuid[], $4)`,
    [org, agentTemplate, crm, user],
  );
  await q("update app.agents set template_id = $1, template_version = 1 where id = $2", [
    agentTemplate,
    personal,
  ]);

  // Phase 07.5 (per-tool approvals and Work Zone proposals): one row per new table, and the two new columns set. An
  // organization rule on every CRM tool and a unit rule naming its approvers; the stored action behind a `tool.call`
  // approval the personal bot asked for in the DM (synthetic arguments); a Work Zone proposal of the same turn, started
  // as the seeded session; a prompt that proposal wrote and the ledger row of the approved call.
  const crmSafe = `m${crm.replace(/-/g, "").slice(0, 8)}`;
  const toolPolicy = randomUUID();
  await q(
    "insert into app.tool_approval_policies (id, organization_id, scope_unit_id, tool_pattern, mode, approver_kind, created_by, updated_by) values ($1, $2, null, $3, 'always', 'admins', $4, $4)",
    [toolPolicy, org, `${crmSafe}__*`, user],
  );
  await q(
    "insert into app.tool_approval_policies (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by) values ($1, $2, 'ocw_http_request', 'when_tainted', 'users', ARRAY[$3]::uuid[], $3)",
    [org, unit, user],
  );
  const toolApproval = randomUUID();
  await q(
    `insert into app.tool_call_approvals (id, organization_id, agent_id, requested_for_user_id, conversation_id, event_id, tool_call_id, tool, source_kind, source_id, target, arguments_canonical, arguments_sha256, action_hash, tainted, policy_id)
     values ($1, $2, $3, $4, $5, $6, 'call-1', $7, 'mcp', $8, $9, '{"amount":10,"customer":"Acme"}', $10, $11, false, $12)`,
    [
      toolApproval,
      org,
      personal,
      user,
      dm,
      eventId,
      `${crmSafe}__create_invoice`,
      crm,
      crmSafe,
      "a".repeat(64),
      "b".repeat(64),
      toolPolicy,
    ],
  );
  await q(
    `insert into app.work_zone_proposals (organization_id, agent_id, requested_for_user_id, conversation_id, event_id, project_id, device_id, runtime, prompt, prompt_sha256, work_session_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'claude-code', 'Fix the failing test', $8, $9)`,
    [org, personal, user, dm, eventId, project, device, "c".repeat(64), ws],
  );
  await q(
    "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position, proposed_by_agent_id) values ($1, $2, $3, 'Fix the failing test', 2, $4)",
    [org, ws, user, personal],
  );
  await q(
    "insert into app.agent_tool_calls (organization_id, event_id, agent_id, user_id, tool, source_kind, source_id, target, decision, approval_id) values ($1, $2, $3, $4, $5, 'mcp', $6, $7, 'allowed', $8)",
    [org, randomUUID(), personal, user, `${crmSafe}__create_invoice`, crm, crmSafe, toolApproval],
  );

  // Phase 07.8 (bot sandboxes, packages and the live browser): one row per new table, and the two new turn columns
  // set. The organization's sandbox policy and event cursor; the personal bot's shell and browser sandboxes with
  // today's usage; a browser context in the DM on the member's sealed session for the site (the state itself is only
  // the `browser_session` secret) and the sign-in request that produced it; the turn's activity; an approved npm
  // package installed for the bot.
  await q(
    "insert into app.sandbox_policies (organization_id, enabled, egress_allow_hosts, updated_by) values ($1, true, '{registry.npmjs.org}', $2)",
    [org, user],
  );
  await q("insert into app.sandbox_event_cursor (organization_id, boot_id, seq) values ($1, $2, 7)", [
    org,
    randomUUID(),
  ]);
  await q(
    "insert into app.bot_sandboxes (organization_id, agent_id, kind, state, runtime, disk_bytes, last_active_at) values ($1, $2, 'sbx', 'running', 'gvisor', 4096, now()), ($1, $2, 'brw', 'stopped', 'gvisor', 0, null)",
    [org, personal],
  );
  await q(
    "insert into app.sandbox_usage_daily (organization_id, agent_id, day, cpu_ms) values ($1, $2, current_date, 1200)",
    [org, personal],
  );
  const browserSecret = randomUUID();
  const browserSession = randomUUID();
  const browserContext = randomUUID();
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'browser session', 'browser_session', 'c', 'i', 't')",
    [browserSecret, org],
  );
  await q(
    "insert into app.browser_sessions (id, organization_id, user_id, agent_id, site_key, secret_id, expires_at) values ($1, $2, $3, $4, 'panel.example.test', $5, now() + interval '30 days')",
    [browserSession, org, user, personal, browserSecret],
  );
  await q(
    "insert into app.browser_contexts (id, organization_id, agent_id, conversation_id, requested_for_user_id, event_id, host, secure, state, session_id) values ($1, $2, $3, $4, $5, $6, 'panel.example.test', true, 'live', $7)",
    [browserContext, org, personal, dm, user, eventId, browserSession],
  );
  await q(
    "insert into app.browser_signin_requests (organization_id, agent_id, context_id, requester_user_id, conversation_id, event_id, host, reason, status, session_id, expires_at, decided_at) values ($1, $2, $3, $4, $5, $6, 'panel.example.test', 'Read the open invoices', 'signed_in', $7, now() + interval '15 minutes', now())",
    [org, personal, browserContext, user, dm, eventId, browserSession],
  );
  await q(
    `insert into app.bot_turn_activity (event_id, organization_id, agent_id, conversation_id, steps, running) values ($1, $2, $3, $4, '[{"id":"s1","tool":"ocw_sandbox_exec","verb":"ran"}]', false)`,
    [eventId, org, personal, dm],
  );
  const sandboxPackage = randomUUID();
  await q(
    `insert into app.sandbox_packages (id, organization_id, source, name, version, sha256, size_bytes, has_install_script, risk, review_token, tree_sha256, dependency_count, lockfile, status, approved_by, approved_at)
     values ($1, $2, 'npm', 'left-pad', '1.3.0', $3, 1024, false, 'low', 'review-token', $4, 0, '{"lockfileVersion":3}', 'approved', $5, now())`,
    [sandboxPackage, org, "d".repeat(64), "e".repeat(64), user],
  );
  await q(
    "insert into app.sandbox_package_installs (organization_id, agent_id, package_id, status) values ($1, $2, $3, 'installed')",
    [org, personal, sandboxPackage],
  );
  await q("update app.agent_turns set sandbox_calls = 3, member_data = true where event_id = $1", [eventId]);
  // 07.8-28 (WINDOWS #292): the bot's member data in this DM is sticky.
  await q(
    "insert into app.agent_member_data (organization_id, agent_id, conversation_id, sites, first_event_id) values ($1, $2, $3, '{panel.example.test}', $4)",
    [org, personal, dm, eventId],
  );

  // Phase 07.9 (D-01, D-03, D-04): a team project under a team of the department, with its default, the team assigned,
  // the seeded repo linked, and a person and a team in the seeded session's audience.
  const team = randomUUID();
  const projectUnit = randomUUID();
  await q(
    "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'team', 'Platform', ARRAY[$3, $1]::uuid[])",
    [team, org, unit],
  );
  await q(
    "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'project', 'Atlas', ARRAY[$4, $3, $1]::uuid[])",
    [projectUnit, org, team, unit],
  );
  await q(
    "insert into app.work_project_settings (organization_id, unit_id, default_visibility, updated_by) values ($1, $2, 'owner', $3)",
    [org, projectUnit, user],
  );
  await q(
    "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
    [org, projectUnit, team, user],
  );
  await q(
    "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
    [org, project, device, projectUnit, user],
  );
  await q(
    "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'user', $3, $3), ($1, $2, 'unit', $4, $3)",
    [org, ws, user, team],
  );

  // Phase 07.11 (D-06, PD-04): one finished automatic run on the seeded device.
  await q(
    "insert into app.device_runtime_updates (organization_id, device_id, runtime, run_id, trigger, state, from_version, to_version, candidate, method, started_at, finished_at) values ($1, $2, 'claude-code', $3, 'automatic', 'succeeded', '2.1.289', '2.1.290', '2.1.290', 'native', now(), now())",
    [org, device, randomUUID()],
  );

  // Phase 07.6 (D-01, D-02, D-04, D-06, D-07): one row per new table. A scheduled automation posting to the channel, a
  // webhook automation filing board cards, a mail automation answering in a thread and the personal digest; the
  // endpoint (its sealed `webhook_secret`), the mailbox (the organization key), one inbound item per source, a scheduled
  // and an inbound run, a pending draft, a watched record on the board card with one change, the seeded session's memory
  // state (proposed to the team project) and a preference. The usage kinds are covered by automations-schema.int.test.ts.
  const scheduled = randomUUID();
  const hook = randomUUID();
  const mail = randomUUID();
  const digest = randomUUID();
  await q(
    "insert into app.automations (id, organization_id, name, agent_id, run_as_user_id, created_by, instructions, trigger_kind, schedule_cron, time_zone, target_kind, conversation_id, next_run_at) values ($1, $2, 'Weekly sales report', $3, $4, $4, 'Summarise the week', 'schedule', '0 17 * * 5', 'Europe/Madrid', 'channel', $5, now() + interval '1 day')",
    [scheduled, org, agent, user, conv],
  );
  await q(
    "insert into app.automations (id, organization_id, name, agent_id, run_as_user_id, created_by, trigger_kind, target_kind, conversation_id, board_column_id, inbound_action) values ($1, $2, 'Orders to cards', $3, $4, $4, 'webhook', 'board', $5, $6, 'board_card')",
    [hook, org, agent, user, board, column],
  );
  await q(
    "insert into app.automations (id, organization_id, name, agent_id, run_as_user_id, created_by, trigger_kind, target_kind, conversation_id, thread_root_message_id, inbound_action, inbound_ask_bot) values ($1, $2, 'Support inbox', $3, $4, $4, 'mail', 'thread', $5, $6, 'post', false)",
    [mail, org, agent, user, conv, msg],
  );
  await q(
    `insert into app.automations (id, organization_id, name, agent_id, run_as_user_id, created_by, action_kind, trigger_kind, schedule_cron, time_zone, target_kind, config) values ($1, $2, 'Daily digest', $3, $4, $4, 'digest', 'schedule', '0 8 * * 1-5', 'Europe/Madrid', 'dm', '{"sections":["mentions"]}')`,
    [digest, org, personal, user],
  );
  const hookSecret = randomUUID();
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'hook', 'webhook_secret', 'c', 'i', 't')",
    [hookSecret, org],
  );
  const endpoint = randomUUID();
  await q(
    "insert into app.webhook_endpoints (id, organization_id, automation_id, public_id, secret_id) values ($1, $2, $3, $4, $5)",
    // 26 hex characters are valid Crockford base32.
    [endpoint, org, hook, endpoint.replace(/-/g, "").slice(0, 26), hookSecret],
  );
  const mailbox = randomUUID();
  await q(
    "insert into app.mailboxes (id, organization_id, automation_id, owner_user_id, vault_item_id, host, port, folder, poll_interval_minutes) values ($1, $2, $3, $4, $5, 'imap.example.test', 993, 'INBOX', 5)",
    [mailbox, org, mail, user, orgVaultItem],
  );
  const hookEvent = randomUUID();
  await q(
    `insert into app.automation_events (id, organization_id, source, webhook_endpoint_id, external_id, body_json, result) values ($1, $2, 'webhook', $3, 'msg_2Lh9', '{"order":"SO-1001"}', 'accepted')`,
    [hookEvent, org, endpoint],
  );
  await q(
    "insert into app.automation_events (organization_id, source, mailbox_id, external_id, thread_key, subject, sender, body_text, result) values ($1, 'mail', $2, '<a1@example.test>', '<a1@example.test>', 'Broken pump', 'ana@example.test', 'The pump is broken', 'accepted')",
    [org, mailbox],
  );
  await q(
    "insert into app.automation_runs (organization_id, automation_id, trigger, scheduled_for, status, anchor_message_id, delivered_at) values ($1, $2, 'schedule', now() - interval '1 day', 'delivered', $3, now())",
    [org, scheduled, msg],
  );
  await q(
    "insert into app.automation_runs (organization_id, automation_id, trigger, inbound_event_id, status, board_card_message_id, tainted) values ($1, $2, 'webhook', $3, 'queued', $4, true)",
    [org, hook, hookEvent, cardRoot],
  );
  await q(
    "insert into app.automation_drafts (organization_id, agent_id, run_as_user_id, event_id, name, instructions, schedule_cron, time_zone, target_kind, conversation_id, max_runs_per_day) values ($1, $2, $3, $4, 'Monday standup', 'Ask for blockers', '0 9 * * 1', 'Europe/Madrid', 'channel', $5, 1)",
    [org, agent, user, eventId, conv],
  );
  const watched = randomUUID();
  await q(
    `insert into app.watched_records (id, organization_id, card_message_id, conversation_id, agent_id, mcp_server_id, external_ref, read_tool, id_arg, fields, snapshot, snapshot_hash, check_as_user_id, check_interval_minutes, created_by) values ($1, $2, $3, $4, $5, $6, 'SO-1001', 'get_order', 'id', '[{"pointer":"/status","label":"Status"}]', '{"/status":"open"}', $7, $8, 60, $8)`,
    [watched, org, cardRoot, board, agent, mcp, "b".repeat(64), user],
  );
  await q(
    `insert into app.watched_record_changes (organization_id, watched_record_id, source, before, after, before_hash, after_hash) values ($1, $2, 'schedule', '{"/status":"new"}', '{"/status":"open"}', $3, $4)`,
    [org, watched, "a".repeat(64), "b".repeat(64)],
  );
  await q(
    "insert into app.work_session_memory (work_session_id, organization_id, unit_id, status, approval_id, summarized_seq) values ($1, $2, $3, 'proposed', $4, 12)",
    [ws, org, projectUnit, randomUUID()],
  );
  await q(
    "insert into app.work_memory_prefs (organization_id, user_id, auto_propose) values ($1, $2, true)",
    [org, user],
  );
  // The platform-owned card labels (UI-SPEC R1) on the seeded card.
  await q(
    `update app.message_cards set status_label = 'Received', notices = '[{"tone":"warning","text":"From outside the workspace"}]' where message_id = $1`,
    [cardMsg],
  );

  // Phase 07.7 (A2A-01, D-14): one chain rooted at the team bot's turn in the channel, with one pending consult of the
  // personal bot (a schema fixture only: v1 never consults personal bots, which the API decides, not the table).
  const chain = randomUUID();
  await q(
    "insert into app.agent_chains (id, organization_id, conversation_id, thread_root_id, root_event_id, root_agent_id, human_user_id) values ($1, $2, $3, $4, $5, $6, $7)",
    [chain, org, conv, msg, randomUUID(), agent, user],
  );
  await q(
    "insert into app.agent_chain_hops (organization_id, chain_id, root_agent_id, source_agent_id, target_agent_id, depth, mode, source_event_id, question_message_id, idempotency_key, deadline_at) values ($1, $2, $3, $3, $4, 1, 'consult', $5, $6, $7, now() + interval '5 minutes')",
    [org, chain, agent, personal, randomUUID(), msg, `${randomUUID()}:consult:0`],
  );

  // Phase 07.16 (D-01, D-03, D-05): the team bot's Work Zone profile on the seeded device with the seeded project, the
  // device owner's consent for it, and the bot side of the seeded session (asked for in the channel's message).
  const bwzProfile = randomUUID();
  await q(
    "insert into app.bot_work_zone_profiles (id, organization_id, agent_id, sponsor_user_id, device_id, runtime, updated_by) values ($1, $2, $3, $4, $5, 'claude-code', $4)",
    [bwzProfile, org, agent, user, device],
  );
  await q(
    "insert into app.bot_work_zone_profile_projects (organization_id, profile_id, device_id, project_id) values ($1, $2, $3, $4)",
    [org, bwzProfile, device, project],
  );
  await q(
    "insert into app.device_bot_consents (organization_id, device_id, agent_id, granted_by) values ($1, $2, $3, $4)",
    [org, device, agent, user],
  );
  await q(
    `insert into app.bot_work_sessions (work_session_id, organization_id, agent_id, profile_id, sponsor_user_id, requester_user_id, origin_conversation_id, origin_message_id, origin_event_id)
     values ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
    [ws, org, agent, bwzProfile, user, conv, msg, randomUUID()],
  );
  // Phase 07.17.1.1 (D-05, D-06): one finished upload of the bot into the seeded bot session (ids, sizes, a digest and
  // a path length only; no path or file name exists in the ledger).
  await q(
    "insert into app.bot_work_session_files (id, organization_id, work_session_id, agent_id, event_id, device_id, conversation_id, direction, attachment_id, max_bytes, limit_source, size_bytes, sha256, path_length, status, expires_at, completed_at) values ($1, $2, $3, $4, $5, $6, $7, 'to_device', $8, 26214400, 'organization', 1536, $9, 14, 'done', now() + interval '10 minutes', now())",
    [randomUUID(), org, ws, agent, randomUUID(), device, conv, randomUUID(), "d".repeat(64)],
  );
  // Phase 07.17.1.1.2 (D-01, D-03): the team bot's running long task in the channel's thread and the background process
  // it waits for (ids, a status and numbers only).
  const botTask = randomUUID();
  const taskEvent = randomUUID();
  await q(
    "insert into app.bot_tasks (id, organization_id, agent_id, conversation_id, thread_root_id, requester_user_id, started_event_id, current_event_id, goal, max_turns, deadline_at) values ($1, $2, $3, $4, $5, $6, $7, $7, 'Read the knowledge pack', 40, now() + interval '8 hours')",
    [botTask, org, agent, conv, msg, user, taskEvent],
  );
  await q(
    "insert into app.bot_task_processes (organization_id, task_id, agent_id, process_id, event_id, deadline_at) values ($1, $2, $3, 'p-seed', $4, now() + interval '10 minutes')",
    [org, botTask, agent, taskEvent],
  );

  // Phase 07.17 (D-02, D-03): a fan-out automation posting to the channel, one Run now and the one item it opened, with
  // the channel's message as its root (the item's key is stored only as a sha256 hex).
  const fanOut = randomUUID();
  await q(
    "insert into app.automations (id, organization_id, name, agent_id, run_as_user_id, created_by, trigger_kind, schedule_cron, time_zone, target_kind, conversation_id, fan_out_enabled) values ($1, $2, 'Open new orders', $3, $4, $4, 'schedule', '*/10 * * * *', 'Europe/Madrid', 'channel', $5, true)",
    [fanOut, org, agent, user, conv],
  );
  const fanOutRun = randomUUID();
  await q(
    "insert into app.automation_runs (id, organization_id, automation_id, trigger) values ($1, $2, $3, 'manual')",
    [fanOutRun, org, fanOut],
  );
  await q(
    "insert into app.automation_conversations (organization_id, automation_id, run_id, external_key_hash, conversation_id, root_message_id) values ($1, $2, $3, $4, $5, $6)",
    [org, fanOut, fanOutRun, "c".repeat(64), conv, msg],
  );
}

/** Phase 07.16: the bot Work Zone profile, its projects, the device consents and the bot side of a session. */
const BOT_WORK_ZONE_TABLES = [
  "app.bot_work_zone_profiles",
  "app.bot_work_zone_profile_projects",
  "app.device_bot_consents",
  "app.bot_work_sessions",
] as const;

/** Phase 07.17.1.1: the transfer ledger of a bot's file moves with its Work Zone sessions. */
const BOT_FILE_TABLES = ["app.bot_work_session_files"] as const;

/** Phase 07.17.1.1.2: a bot's long tasks and the background processes they wait for. */
const BOT_TASK_TABLES = ["app.bot_tasks", "app.bot_task_processes"] as const;

/** Phase 07.7: the agent-to-agent ledger (chains and their hops). */
const AGENT_CHAIN_TABLES = ["app.agent_chains", "app.agent_chain_hops"] as const;

/** Phase 07.6: the ten automation, inbound, watched-record and Work Zone memory tables. */
const AUTOMATION_TABLES = [
  "app.automations",
  "app.automation_runs",
  "app.automation_drafts",
  "app.webhook_endpoints",
  "app.mailboxes",
  "app.automation_events",
  "app.watched_records",
  "app.watched_record_changes",
  "app.work_session_memory",
  "app.work_memory_prefs",
] as const;

const SANDBOX_TABLES = [
  "app.sandbox_policies",
  "app.bot_sandboxes",
  "app.sandbox_usage_daily",
  "app.sandbox_event_cursor",
  "app.browser_contexts",
  "app.browser_sessions",
  "app.browser_signin_requests",
  "app.bot_turn_activity",
  "app.sandbox_packages",
  "app.sandbox_package_installs",
  "app.agent_member_data",
] as const;

const TOOL_APPROVAL_TABLES = [
  "app.tool_approval_policies",
  "app.tool_call_approvals",
  "app.work_zone_proposals",
] as const;

const CONNECTOR_TABLES = [
  "app.connector_oauth_clients",
  "app.connector_connections",
  "app.member_account_shares",
  "app.vault_items",
  "app.agent_vault_grants",
  "app.agent_templates",
  "app.agent_template_versions",
] as const;

const WORK_ZONE_VISIBILITY_TABLES = [
  "app.work_project_settings",
  "app.work_project_teams",
  "app.work_project_repos",
  "app.work_session_grants",
] as const;

const AI_CHAT_TABLES = [
  "app.ai_chats",
  "app.ai_user_preferences",
  "app.ai_generations",
  "app.ai_usage_records",
  "app.ai_usage_daily",
  "app.ai_chat_policies",
  "app.user_model_credentials",
  "app.ai_chat_shares",
] as const;

const MULTIPLAYER_AI_TABLES = [
  "app.ai_chat_grants",
  "app.ai_message_context",
  "app.message_cards",
  "app.message_card_follows",
] as const;

const BOARD_TABLES = ["app.boards", "app.board_columns", "app.board_cards", "app.record_templates"] as const;

const MEMORY_TABLES = [
  "app.memory_scopes",
  "app.memory_files",
  "app.memory_file_revisions",
  "app.memory_proposals",
  "app.approval_requests",
] as const;

async function inTenant<T>(org: string, fn: () => Promise<T>, userId: string | null = null): Promise<T> {
  await app.query("begin");
  try {
    await app.query("select set_config('app.organization_id', $1, true)", [org]);
    if (userId) await app.query("select set_config('app.user_id', $1, true)", [userId]);
    return await fn();
  } finally {
    await app.query("rollback");
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  migrator = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await migrator.connect();
  await app.connect();
  await seedOrg(migrator, A);
  await seedOrg(migrator, B);
});

afterAll(async () => {
  await migrator?.end();
  await app?.end();
  await tdb?.stop();
});

async function orgScopedTables(): Promise<
  Array<{ tbl: string; rls: boolean; force: boolean; policies: number }>
> {
  const res = await migrator.query(`
    SELECT c.oid::regclass::text AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r','p') AND n.nspname = 'app' ORDER BY 1`);
  return res.rows;
}

describe("tenant isolation (RLS)", () => {
  it("Phase 3.1 schema constraints: personal bots need an owner, one DM per pair, bounded memory", async () => {
    const owner = randomUUID();
    await expect(
      migrator.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, scope) values ($1, 'X', $2, 'x', 'mock', 'mock-1', 'personal')",
        [A, `x-${owner.slice(0, 8)}`],
      ),
    ).rejects.toThrow(/agents_owner_scope_check/);
    // Phase 6 (AGENT-01) relaxed the rule: a team bot may now have an accountable owner (see the Phase 6 test).
    const key = (
      await migrator.query(
        "select dm_key from app.conversations where organization_id = $1 and kind = 'dm'",
        [A],
      )
    ).rows[0].dm_key;
    await expect(
      migrator.query(
        "insert into app.conversations (organization_id, kind, visibility, dm_key) values ($1, 'dm', 'private', $2)",
        [A, key],
      ),
    ).rejects.toThrow(/conversations_org_dm_key_uq/);
    const agent = (
      await migrator.query("select id from app.agents where organization_id = $1 and scope = 'personal'", [A])
    ).rows[0].id;
    await expect(
      migrator.query(
        "insert into app.agent_memories (organization_id, agent_id, user_id, text) values ($1, $2, $3, $4)",
        [A, agent, owner, "x".repeat(501)],
      ),
    ).rejects.toThrow(/agent_memories_text_len_check/);
  });

  it("Phase 03.2 schema constraints: modes are the platform ladder, grants name a user or a unit", async () => {
    const device = (await migrator.query("select id from app.devices where organization_id = $1", [A]))
      .rows[0].id;
    for (const bad of ["bypassPermissions", "dontAsk", "danger-full-access"]) {
      await expect(
        migrator.query("update app.work_sessions set permission_mode = $2 where organization_id = $1", [
          A,
          bad,
        ]),
      ).rejects.toThrow(/work_sessions_permission_mode_ck/);
      await expect(
        migrator.query("update app.devices set share_max_mode = $2 where organization_id = $1", [A, bad]),
      ).rejects.toThrow(/devices_share_max_mode_ck/);
    }
    await expect(
      migrator.query(
        "insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode) values ($1, $2, 'team', $3, 'plan')",
        [A, device, randomUUID()],
      ),
    ).rejects.toThrow(/device_grants_principal_kind_ck/);
    const policy = (
      await migrator.query(
        "select allowed_permission_modes, allow_full_access, allow_fast_mode from app.work_zone_policies where organization_id = $1",
        [A],
      )
    ).rows[0];
    expect(policy).toEqual({
      allowed_permission_modes: ["plan", "default", "acceptEdits", "auto"],
      allow_full_access: false,
      allow_fast_mode: false,
    });
  });

  it("app role is neither superuser nor BYPASSRLS", async () => {
    const r = await app.query("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("every app table is org-scoped with RLS + FORCE + policy", async () => {
    const all = await migrator.query(
      "select c.oid::regclass::text as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind in ('r','p')",
    );
    const scoped = await orgScopedTables();
    expect(scoped.map((t) => t.tbl).sort()).toEqual(all.rows.map((r) => r.tbl).sort());
    for (const t of scoped) {
      expect(t, t.tbl).toMatchObject({ rls: true, force: true });
      expect(t.policies, t.tbl).toBeGreaterThan(0);
    }
  });

  it("cross-tenant reads return 0 rows and writes fail, for every org-scoped table", async () => {
    const tables = await orgScopedTables();
    expect(tables.length).toBeGreaterThanOrEqual(20);
    for (const { tbl } of tables) {
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [A],
      );
      expect(seeded.rows[0].n, `${tbl} has no fixture row: add one to seedOrg()`).toBeGreaterThan(0);

      // Same tenant sees its rows (sanity), minus the personal keys (07.4-07), the member connector connections
      // (07.4-10) and the sealed browser sessions (07.8-02) only their owner's session sees …
      const ownerOnly =
        tbl === "app.vault_items"
          ? (
              await migrator.query(
                "select count(*)::int as n from app.vault_items where organization_id = $1 and scope = 'personal'",
                [A],
              )
            ).rows[0].n
          : tbl === "app.connector_connections" || tbl === "app.browser_sessions"
            ? seeded.rows[0].n
            : tbl === "app.agent_vault_grants"
              ? (
                  await migrator.query(
                    "select count(*)::int as n from app.agent_vault_grants g join app.vault_items v on v.id = g.vault_item_id where g.organization_id = $1 and v.scope = 'personal'",
                    [A],
                  )
                ).rows[0].n
              : 0;
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} own rows`).toBe(seeded.rows[0].n - ownerOnly);

      // … another tenant sees none of A's rows.
      const cross = await inTenant(B, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [A]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);

      // No context at all → zero rows, not an error (nullif on reused connections).
      const none = await app.query(`select count(*)::int as n from ${tbl}`);
      expect(none.rows[0].n, `${tbl} no-context select`).toBe(0);

      // UPDATE / DELETE of A's rows from B affect 0 rows (or are not even granted for append-only logs).
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const r = await inTenant(B, () =>
          app.query(stmt, [A]).then(
            (res) => res.rowCount,
            (err: Error) => (/permission denied/.test(err.message) ? 0 : Promise.reject(err)),
          ),
        );
        expect(r, `${tbl}: ${stmt}`).toBe(0);
      }

      // INSERT of a row belonging to A while in B's context → RLS violation. Generated columns (messages.
      // search_tsv) can never be written explicitly, so the copy lists the writable columns only.
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [A],
      );
      const cols = (
        await migrator.query(
          `select a.attname from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0
             and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
          [tbl],
        )
      ).rows.map((r) => `"${r.attname}"`);
      await expect(
        inTenant(B, () =>
          app.query(
            `insert into ${tbl} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_record(null::${tbl}, $1::json)`,
            [JSON.stringify(row.rows[0].j)],
          ),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("Phase 4: the eight chat workspace tables are org-scoped, forced and seeded", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of [
      "app.message_versions",
      "app.message_reactions",
      "app.message_pins",
      "app.message_saves",
      "app.notifications",
      "app.notification_prefs",
      "app.thread_reads",
      "app.attachments",
    ]) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true });
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded`).toBeGreaterThan(0);
      const cross = await inTenant(B, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [A]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant`).toBe(0);
    }
  });

  it("Phase 4: message versions are append-only for the app role", async () => {
    const msg = (
      await migrator.query("select message_id from app.message_versions where organization_id = $1", [A])
    ).rows[0].message_id;
    // Insert succeeds in the tenant…
    await inTenant(A, async () => {
      await app.query(
        "insert into app.message_versions (organization_id, message_id, version, kind, body, edited_by_kind) values ($1, $2, 2, 'delete', 'x', 'system')",
        [A, msg],
      );
    });
    // …but history can never be rewritten or erased, even in the owning tenant.
    for (const stmt of [
      "update app.message_versions set body = 'rewritten'",
      "delete from app.message_versions",
      "truncate app.message_versions",
    ]) {
      await expect(
        inTenant(A, () => app.query(stmt)),
        stmt,
      ).rejects.toThrow(/permission denied/);
    }
    // The audit and stream logs stay append-only too.
    await expect(inTenant(A, () => app.query("delete from app.audit_events"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("Phase 5: the eight AI chat tables are org-scoped, forced, seeded and invisible and unwritable across tenants", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of AI_CHAT_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true });
      expect(scoped.get(tbl)?.policies, tbl).toBeGreaterThan(0);
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded`).toBeGreaterThan(0);
      // As ocw_app in org A, nothing of org B is visible…
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant`).toBe(0);
      // …updatable or deletable (0 rows, or not even granted for the append-only usage store)…
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () =>
          app.query(stmt, [B]).then(
            (res) => res.rowCount,
            (err: Error) => (/permission denied/.test(err.message) ? 0 : Promise.reject(err)),
          ),
        );
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // …or insertable: a copy of B's row written from A's context is refused by the policy.
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      await expect(
        inTenant(A, () =>
          app.query(`insert into ${tbl} select * from json_populate_record(null::${tbl}, $1::json)`, [
            JSON.stringify(row.rows[0].j),
          ]),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("Phase 5: usage records are append-only for the app role", async () => {
    const seeded = (
      await migrator.query(
        "select requester_user_id, conversation_id from app.ai_usage_records where organization_id = $1",
        [A],
      )
    ).rows[0];
    const inserted = await inTenant(A, () =>
      app.query(
        "insert into app.ai_usage_records (organization_id, generation_id, kind, requester_user_id, conversation_id, backend, provider, model_id, input_tokens, output_tokens) values ($1, $2, 'title', $3, $4, 'mock', 'mock', 'mock-1', 1, 1)",
        [A, randomUUID(), seeded.requester_user_id, seeded.conversation_id],
      ),
    );
    expect(inserted.rowCount).toBe(1);
    for (const stmt of [
      "update app.ai_usage_records set output_tokens = 0",
      "delete from app.ai_usage_records",
      "truncate app.ai_usage_records",
    ]) {
      await expect(
        inTenant(A, () => app.query(stmt)),
        stmt,
      ).rejects.toThrow(/permission denied/);
    }
    // One record per generation and kind: a duplicate finalize can never double-count.
    const gen = (
      await migrator.query("select generation_id from app.ai_usage_records where organization_id = $1", [A])
    ).rows[0].generation_id;
    await expect(
      inTenant(A, () =>
        app.query(
          "insert into app.ai_usage_records (organization_id, generation_id, kind, requester_user_id, conversation_id, backend, provider, model_id, input_tokens, output_tokens) values ($1, $2, 'chat', $3, $4, 'org_key', 'anthropic', 'claude-sonnet-5-5', 1, 1)",
          [A, gen, seeded.requester_user_id, seeded.conversation_id],
        ),
      ),
    ).rejects.toThrow(/ai_usage_records_generation_kind_uq/);
  });

  it("Phase 5: at most one running generation per conversation", async () => {
    const running = (
      await migrator.query(
        "select conversation_id, assistant_message_id, requester_user_id from app.ai_generations where organization_id = $1 and status = 'running'",
        [A],
      )
    ).rows;
    expect(running).toHaveLength(1);
    const g = running[0];
    const insert = (conversationId: string, status: string) =>
      app.query(
        "insert into app.ai_generations (organization_id, conversation_id, assistant_message_id, requester_user_id, backend, provider, model_id, status, instance_id) values ($1, $2, $3, $4, 'mock', 'mock', 'mock-1', $5, 'api-2')",
        [A, conversationId, g.assistant_message_id, g.requester_user_id, status],
      );
    await expect(inTenant(A, () => insert(g.conversation_id, "running"))).rejects.toThrow(
      /ai_generations_one_running_uq/,
    );
    for (const status of ["completed", "stopped", "failed", "interrupted"]) {
      const r = await inTenant(A, () => insert(g.conversation_id, status));
      expect(r.rowCount, status).toBe(1);
    }
    // Another conversation may run its own generation at the same time.
    const other = (
      await migrator.query("select id from app.conversations where organization_id = $1 and kind = 'dm'", [A])
    ).rows[0].id;
    expect((await inTenant(A, () => insert(other, "running"))).rowCount).toBe(1);
    await expect(inTenant(A, () => insert(g.conversation_id, "paused"))).rejects.toThrow(
      /ai_generations_status_check/,
    );
  });

  it("Phase 5: regenerate versions, credential secrets and the policy defaults", async () => {
    const msg = (
      await migrator.query(
        "select assistant_message_id from app.ai_generations where organization_id = $1 limit 1",
        [A],
      )
    ).rows[0].assistant_message_id;
    const version = (kind: string) =>
      app.query(
        "insert into app.message_versions (organization_id, message_id, version, kind, body, edited_by_kind) values ($1, $2, 1, $3, 'old answer', 'system')",
        [A, msg, kind],
      );
    expect((await inTenant(A, () => version("regenerate"))).rowCount).toBe(1);
    await expect(inTenant(A, () => version("rewrite"))).rejects.toThrow(/message_versions_kind_check/);
    const cred = await inTenant(A, () =>
      app.query(
        "select s.kind from app.user_model_credentials c join app.secrets s on s.id = c.secret_id where c.provider = 'chatgpt_plan'",
      ),
    );
    expect(cred.rows).toEqual([{ kind: "user_model_credential" }]);
    const policy = (
      await migrator.query(
        `select chatgpt_plan_enabled, org_keys_enabled, plan_allowed_models, org_key_daily_generations,
                org_key_daily_cost_micros, plan_daily_generations, concurrent_generations_per_user,
                max_context_tokens, web_enabled, title_models
           from app.ai_chat_policies where organization_id = $1`,
        [A],
      )
    ).rows[0];
    expect({
      chatgptPlanEnabled: policy.chatgpt_plan_enabled,
      orgKeysEnabled: policy.org_keys_enabled,
      planAllowedModels: policy.plan_allowed_models,
      orgKeyDailyGenerations: policy.org_key_daily_generations,
      orgKeyDailyCostMicros: policy.org_key_daily_cost_micros,
      planDailyGenerations: policy.plan_daily_generations,
      concurrentGenerationsPerUser: policy.concurrent_generations_per_user,
      maxContextTokens: policy.max_context_tokens,
      webEnabled: policy.web_enabled,
      titleModels: policy.title_models,
    }).toEqual(DEFAULT_AI_CHAT_POLICY);
  });

  it("Phase 6: the four multiplayer AI chat tables are org-scoped, forced, seeded and invisible and unwritable across tenants", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of MULTIPLAYER_AI_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true });
      expect(scoped.get(tbl)?.policies, tbl).toBeGreaterThan(0);
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded`).toBeGreaterThan(0);
      // As ocw_app in org A, nothing of org B is visible…
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant`).toBe(0);
      // …updatable or deletable…
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () => app.query(stmt, [B]).then((res) => res.rowCount));
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // …or insertable: a copy of B's row written from A's context is refused by the policy.
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      await expect(
        inTenant(A, () =>
          app.query(`insert into ${tbl} select * from json_populate_record(null::${tbl}, $1::json)`, [
            JSON.stringify(row.rows[0].j),
          ]),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("Phase 6: one active grant per (chat, subject), org grants carry no subject id, a revoke frees the slot", async () => {
    const g = (
      await migrator.query(
        "select conversation_id, subject_id, granted_by from app.ai_chat_grants where organization_id = $1 and subject_kind = 'user'",
        [A],
      )
    ).rows[0];
    const grant = (kind: string, subject: string | null, level = "chat") =>
      app.query(
        "insert into app.ai_chat_grants (organization_id, conversation_id, subject_kind, subject_id, level, granted_by) values ($1, $2, $3, $4, $5, $6)",
        [A, g.conversation_id, kind, subject, level, g.granted_by],
      );
    // A second active grant for the same person, or a second organization grant, is refused.
    await expect(inTenant(A, () => grant("user", g.subject_id, "view"))).rejects.toThrow(
      /ai_chat_grants_active_uq/,
    );
    await expect(inTenant(A, () => grant("org", null))).rejects.toThrow(/ai_chat_grants_active_uq/);
    // Once revoked, the slot is free again (the revoked row stays as history).
    const regranted = await inTenant(A, async () => {
      const revoked = await app.query(
        "update app.ai_chat_grants set revoked_at = now(), revoked_by = granted_by where conversation_id = $1 and subject_kind = 'user' and subject_id = $2 and revoked_at is null",
        [g.conversation_id, g.subject_id],
      );
      expect(revoked.rowCount).toBe(1);
      const r = await grant("user", g.subject_id, "view");
      const n = await app.query(
        "select count(*)::int as n from app.ai_chat_grants where conversation_id = $1 and subject_id = $2",
        [g.conversation_id, g.subject_id],
      );
      return { inserted: r.rowCount, rows: n.rows[0].n };
    });
    expect(regranted).toEqual({ inserted: 1, rows: 2 });
    // Another subject coexists; subjects and levels are checked.
    expect((await inTenant(A, () => grant("unit", randomUUID()))).rowCount).toBe(1);
    await expect(inTenant(A, () => grant("org", randomUUID()))).rejects.toThrow(
      /ai_chat_grants_subject_check/,
    );
    await expect(inTenant(A, () => grant("user", null))).rejects.toThrow(/ai_chat_grants_subject_check/);
    await expect(inTenant(A, () => grant("team", randomUUID()))).rejects.toThrow(
      /ai_chat_grants_subject_kind_check/,
    );
    await expect(inTenant(A, () => grant("user", randomUUID(), "owner"))).rejects.toThrow(
      /ai_chat_grants_level_check/,
    );
  });

  it("Phase 6: shared bots may have an owner and a unit, personal bots need an owner, a unit with bots stays", async () => {
    const owner = (
      await migrator.query("select user_id from app.org_members where organization_id = $1", [A])
    ).rows[0].user_id;
    const bot = (scope: string, ownerId: string | null, unitId: string | null) =>
      app.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id, unit_id) values ($1, 'X', $2, 'x', 'mock', 'mock-1', $3, $4, $5)",
        [A, `p6-${randomUUID().slice(0, 8)}`, scope, ownerId, unitId],
      );
    expect((await inTenant(A, () => bot("team", owner, null))).rowCount).toBe(1);
    expect((await inTenant(A, () => bot("team", null, null))).rowCount).toBe(1);
    await expect(inTenant(A, () => bot("personal", null, null))).rejects.toThrow(/agents_owner_scope_check/);
    await expect(
      inTenant(A, async () => {
        const unit = randomUUID();
        await app.query(
          "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', 'Platform', ARRAY[$1]::uuid[])",
          [unit, A],
        );
        expect((await bot("team", owner, unit)).rowCount).toBe(1);
        await app.query("delete from app.org_units where id = $1", [unit]);
      }),
    ).rejects.toThrow(/agents_unit_id_org_units_id_fkey/);
    const fk = await migrator.query(
      "select confdeltype from pg_constraint where conname = 'agents_unit_id_org_units_id_fkey'",
    );
    expect(fk.rows).toEqual([{ confdeltype: "r" }]);
  });

  it("Phase 6: notification kinds, card checks, card follows cascade, a deleted generation unlinks its messages", async () => {
    const ctx = (
      await migrator.query(
        "select message_id, conversation_id, answered_by_generation_id from app.ai_message_context where organization_id = $1",
        [A],
      )
    ).rows[0];
    const card = (
      await migrator.query(
        "select message_id, conversation_id, agent_id from app.message_cards where organization_id = $1",
        [A],
      )
    ).rows[0];
    const user = (await migrator.query("select user_id from app.org_members where organization_id = $1", [A]))
      .rows[0].user_id;
    const notify = (kind: string, messageId: string, conversationId: string) =>
      app.query(
        "insert into app.notifications (organization_id, user_id, kind, conversation_id, message_id, actor_kind, actor_id) values ($1, $2, $3, $4, $5, 'user', $2)",
        [A, user, kind, conversationId, messageId],
      );
    const kinds = await inTenant(A, async () => [
      (await notify("ai_chat_shared", ctx.message_id, ctx.conversation_id)).rowCount,
      (await notify("card_updated", card.message_id, card.conversation_id)).rowCount,
    ]);
    expect(kinds).toEqual([1, 1]);
    await expect(inTenant(A, () => notify("poke", card.message_id, card.conversation_id))).rejects.toThrow(
      /notifications_kind_check/,
    );

    const cardWith = (kind: string, status: string, decision: string | null, title = "Report") =>
      inTenant(A, async () => {
        const m = (
          await app.query(
            "insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, 50, 'agent', $3, 'summary') returning id",
            [A, card.conversation_id, card.agent_id],
          )
        ).rows[0].id;
        return app.query(
          "insert into app.message_cards (message_id, organization_id, conversation_id, agent_id, kind, title, status, decision) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [m, A, card.conversation_id, card.agent_id, kind, title, status, decision],
        );
      });
    expect((await cardWith("report", "succeeded", "approved")).rowCount).toBe(1);
    await expect(cardWith("poll", "pending", null)).rejects.toThrow(/message_cards_kind_check/);
    await expect(cardWith("report", "done", null)).rejects.toThrow(/message_cards_status_check/);
    await expect(cardWith("report", "pending", "maybe")).rejects.toThrow(/message_cards_decision_check/);
    await expect(cardWith("report", "pending", null, "x".repeat(201))).rejects.toThrow(
      /message_cards_title_len_check/,
    );

    // Deleting a card removes its follows.
    const follows = await inTenant(A, async () => {
      await app.query("delete from app.message_cards where message_id = $1", [card.message_id]);
      return (
        await app.query("select count(*)::int as n from app.message_card_follows where message_id = $1", [
          card.message_id,
        ])
      ).rows[0].n;
    });
    expect(follows).toBe(0);

    // Deleting a generation keeps the message context and only unlinks it.
    expect(ctx.answered_by_generation_id).not.toBeNull();
    const after = await inTenant(A, async () => {
      await app.query("delete from app.ai_generations where id = $1", [ctx.answered_by_generation_id]);
      return (
        await app.query(
          "select answered_by_generation_id from app.ai_message_context where message_id = $1",
          [ctx.message_id],
        )
      ).rows;
    });
    expect(after).toEqual([{ answered_by_generation_id: null }]);
  });

  it("Phase 07.1: a board channel in org A has its column and card in rank order, every other conversation is text, org B sees none of it", async () => {
    const board = (
      await migrator.query("select conversation_id from app.boards where organization_id = $1", [A])
    ).rows[0].conversation_id as string;
    const read = (org: string) =>
      inTenant(org, async () => {
        const rows = (
          await app.query(
            `select c.kind, c.layout, b.prefix, b.last_number, col.name as column_name, col.category,
                    card.title, card.number, card.waiting_on, card.title_source, t.name as template
               from app.conversations c
               join app.boards b on b.conversation_id = c.id
               join app.board_columns col on col.conversation_id = c.id
               join app.board_cards card on card.column_id = col.id
               join app.messages m on m.id = card.message_id
               left join app.record_templates t on t.id = b.template_id
              where c.id = $1
              order by col.rank, card.rank`,
            [board],
          )
        ).rows;
        const layouts = (
          await app.query(
            "select layout, count(*)::int as n from app.conversations group by layout order by 1",
          )
        ).rows;
        return { rows, layouts };
      });
    const own = await read(A);
    expect(own.rows).toEqual([
      {
        kind: "channel",
        layout: "board",
        prefix: "EXP",
        last_number: 1,
        column_name: "Backlog",
        category: "backlog",
        title: "EXP-0001 · Broken pump",
        number: 1,
        waiting_on: "none",
        title_source: "auto",
        template: "Case file",
      },
    ]);
    // The seed's four pre-board conversations default to `text`; only the board channel is a board.
    expect(own.layouts).toEqual([
      { layout: "board", n: 1 },
      { layout: "text", n: 4 },
    ]);
    const cross = await read(B);
    expect(cross.rows).toEqual([]);
  });

  it("Phase 07.1: the four board tables are org-scoped, forced, seeded and invisible and unwritable across tenants", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of BOARD_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true });
      expect(scoped.get(tbl)?.policies, tbl).toBeGreaterThan(0);
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded`).toBeGreaterThan(0);
      // As ocw_app in org A, nothing of org B is visible…
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant`).toBe(0);
      // …updatable or deletable…
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () => app.query(stmt, [B]).then((res) => res.rowCount));
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // …or insertable: a copy of B's row written from A's context is refused by the policy.
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      await expect(
        inTenant(A, () =>
          app.query(`insert into ${tbl} select * from json_populate_record(null::${tbl}, $1::json)`, [
            JSON.stringify(row.rows[0].j),
          ]),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("Phase 07.1: board constraints hold for layouts, columns, cards, numbers, templates and deletes", async () => {
    const user = (await migrator.query("select user_id from app.org_members where organization_id = $1", [A]))
      .rows[0].user_id as string;
    const unit = (await migrator.query("select id from app.org_units where organization_id = $1", [A]))
      .rows[0].id as string;
    const seeded = (
      await migrator.query(
        "select c.message_id, c.column_id, c.conversation_id from app.board_cards c where c.organization_id = $1",
        [A],
      )
    ).rows[0] as { message_id: string; column_id: string; conversation_id: string };
    const board = seeded.conversation_id;
    const tx = <T>(fn: () => Promise<T>) => inTenant(A, fn);
    const q = (text: string, values: unknown[] = []) => app.query(text, values);

    // Only a channel can be a board, and a layout is `text` or `board`.
    const conv = (kind: string, layout: string) =>
      q("insert into app.conversations (organization_id, kind, layout) values ($1, $2, $3) returning id", [
        A,
        kind,
        layout,
      ]);
    expect((await tx(() => conv("channel", "board"))).rowCount).toBe(1);
    for (const kind of ["dm", "group", "ai_chat", "thread", "work_session"]) {
      await expect(
        tx(() => conv(kind, "board")),
        kind,
      ).rejects.toThrow(/conversations_layout_kind_check/);
      expect((await tx(() => conv(kind, "text"))).rowCount, kind).toBe(1);
    }
    await expect(tx(() => conv("channel", "grid"))).rejects.toThrow(/conversations_layout_check/);
    // An existing conversation keeps the rule too.
    await expect(
      tx(() =>
        q("update app.conversations set layout = 'board' where organization_id = $1 and kind = 'dm'", [A]),
      ),
    ).rejects.toThrow(/conversations_layout_kind_check/);

    // Columns: four categories, four waiting states (or null = keep), bounded names, unique per board ignoring case.
    const column = (name: string, category: string, waiting: string | null = null, onBoard = board) =>
      q(
        "insert into app.board_columns (organization_id, conversation_id, name, rank, category, default_waiting_on) values ($1, $2, $3, 'a5', $4, $5) returning id",
        [A, onBoard, name, category, waiting],
      );
    for (const category of ["backlog", "started", "done", "cancelled"]) {
      expect((await tx(() => column(`C ${category}`, category, "customer"))).rowCount, category).toBe(1);
    }
    await expect(tx(() => column("Waiting", "waiting"))).rejects.toThrow(/board_columns_category_check/);
    await expect(tx(() => column("Waiting", "started", "them"))).rejects.toThrow(
      /board_columns_default_waiting_on_check/,
    );
    await expect(tx(() => column("", "started"))).rejects.toThrow(/board_columns_name_len_check/);
    await expect(tx(() => column("x".repeat(61), "started"))).rejects.toThrow(/board_columns_name_len_check/);
    await expect(
      tx(async () => {
        await column("Done", "done");
        return column("done", "done");
      }),
    ).rejects.toThrow(/board_columns_conv_name_uq/);

    // Boards: prefixes are 1-8 upper-case letters or digits, naming rules at most 120 characters.
    const setBoard = (col: string, value: string) =>
      q(`update app.boards set ${col} = $2 where conversation_id = $1`, [board, value]);
    expect((await tx(() => setBoard("prefix", "EXP2"))).rowCount).toBe(1);
    for (const bad of ["exp", "TOOLONGPRE", "EX-P", ""]) {
      await expect(
        tx(() => setBoard("prefix", bad)),
        bad,
      ).rejects.toThrow(/boards_prefix_check/);
    }
    await expect(tx(() => setBoard("naming_rule", "x".repeat(121)))).rejects.toThrow(
      /boards_naming_rule_len_check/,
    );

    // Cards: waiting states, title sources and bounded titles; numbers unique per board, nulls unlimited.
    let seq = 100;
    const card = (
      onBoard: string,
      columnId: string,
      o: {
        number?: number | null;
        title?: string;
        titleSource?: string;
        waitingOn?: string;
        /** Conversation of the root message (default: the card's own board). */
        messageIn?: string;
      } = {},
    ) =>
      (async () => {
        seq += 1;
        const m = (
          await q(
            "insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 'user', $4, 'card') returning id",
            [A, o.messageIn ?? onBoard, seq, user],
          )
        ).rows[0].id;
        return q(
          "insert into app.board_cards (message_id, organization_id, conversation_id, column_id, rank, title, title_source, waiting_on, number) values ($1, $2, $3, $4, 'a1', $5, $6, $7, $8)",
          [
            m,
            A,
            onBoard,
            columnId,
            o.title ?? "Card",
            o.titleSource ?? "user",
            o.waitingOn ?? "none",
            o.number ?? null,
          ],
        );
      })();
    const col = seeded.column_id;
    for (const waitingOn of ["none", "us", "customer", "both"]) {
      expect((await tx(() => card(board, col, { waitingOn }))).rowCount, waitingOn).toBe(1);
    }
    await expect(tx(() => card(board, col, { waitingOn: "them" }))).rejects.toThrow(
      /board_cards_waiting_on_check/,
    );
    for (const titleSource of ["user", "heuristic", "auto"]) {
      expect((await tx(() => card(board, col, { titleSource }))).rowCount, titleSource).toBe(1);
    }
    await expect(tx(() => card(board, col, { titleSource: "model" }))).rejects.toThrow(
      /board_cards_title_source_check/,
    );
    expect((await tx(() => card(board, col, { title: "t".repeat(200) }))).rowCount).toBe(1);
    await expect(tx(() => card(board, col, { title: "t".repeat(201) }))).rejects.toThrow(
      /board_cards_title_len_check/,
    );
    await expect(tx(() => card(board, col, { title: "" }))).rejects.toThrow(/board_cards_title_len_check/);
    // The seed's card is number 1 on this board.
    await expect(tx(() => card(board, col, { number: 1 }))).rejects.toThrow(/board_cards_number_uq/);
    /** A second board channel with its `boards` row (columns and cards need one). */
    const newBoard = async () => {
      const id = (await conv("channel", "board")).rows[0].id as string;
      await q("insert into app.boards (conversation_id, organization_id) values ($1, $2)", [id, A]);
      return id;
    };
    const numbers = await tx(async () => {
      const other = await newBoard();
      const otherCol = (await column("Backlog", "backlog", null, other)).rows[0].id as string;
      return [
        (await card(other, otherCol, { number: 1 })).rowCount, // same number, another board
        (await card(board, col, { number: null })).rowCount, // unnumbered cards are unlimited
        (await card(board, col, { number: null })).rowCount,
        (await card(board, col, { number: 2 })).rowCount,
      ];
    });
    expect(numbers).toEqual([1, 1, 1, 1]);

    // Integrity: a card's column, root message and board all belong to the card's own board channel, and a column
    // exists only on a board.
    await expect(
      tx(async () => {
        const otherCol = (await column("Backlog", "backlog", null, await newBoard())).rows[0].id as string;
        return card(board, otherCol);
      }),
      "a card in another board's column",
    ).rejects.toThrow(/board_cards_column_fk/);
    const general = (
      await migrator.query(
        "select id from app.conversations where organization_id = $1 and kind = 'channel' and layout = 'text'",
        [A],
      )
    ).rows[0].id as string;
    await expect(
      tx(() => card(board, col, { messageIn: general })),
      "a root message from another conversation",
    ).rejects.toThrow(/board_cards_message_fk/);
    await expect(
      tx(() => column("Backlog", "backlog", null, general)),
      "a column without a board",
    ).rejects.toThrow(/board_columns_board_fk/);
    // A card on a conversation without a board: its column cannot exist there either, so either FK may fire first;
    // the catalog check below pins the card → board FK itself.
    await expect(
      tx(() => card(general, col, { messageIn: general })),
      "a card on a conversation without a board",
    ).rejects.toThrow(/board_cards_(board|column)_fk/);
    const fks = await migrator.query(
      `select conname, confrelid::regclass::text as ref, confdeltype as on_delete,
              (select array_agg(a.attname::text order by k.ord) from unnest(conkey) with ordinality k(n, ord)
                 join pg_attribute a on a.attrelid = conrelid and a.attnum = k.n) as cols
         from pg_constraint
        where contype = 'f' and conrelid in ('app.board_cards'::regclass, 'app.board_columns'::regclass)
          and confrelid <> 'auth.organization'::regclass
        order by conname`,
    );
    expect(fks.rows).toEqual([
      { conname: "board_cards_board_fk", ref: "app.boards", on_delete: "c", cols: ["conversation_id"] },
      {
        conname: "board_cards_column_fk",
        ref: "app.board_columns",
        on_delete: "r",
        cols: ["column_id", "conversation_id"],
      },
      {
        conname: "board_cards_message_fk",
        ref: "app.messages",
        on_delete: "c",
        cols: ["message_id", "conversation_id"],
      },
      { conname: "board_columns_board_fk", ref: "app.boards", on_delete: "c", cols: ["conversation_id"] },
    ]);

    // Templates: names unique per (organization, unit) ignoring case; organization-wide ones collide too.
    const template = (unitId: string | null, name: string, prefix: string | null = null) =>
      q("insert into app.record_templates (organization_id, unit_id, name, prefix) values ($1, $2, $3, $4)", [
        A,
        unitId,
        name,
        prefix,
      ]);
    await expect(tx(() => template(null, "case file"))).rejects.toThrow(/record_templates_name_uq/);
    await expect(
      tx(async () => {
        await template(unit, "Case file");
        return template(unit, "CASE FILE");
      }),
    ).rejects.toThrow(/record_templates_name_uq/);
    const perUnit = await tx(async () => {
      const other = randomUUID();
      await q(
        "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', 'Support', ARRAY[$1]::uuid[])",
        [other, A],
      );
      return [(await template(unit, "Case file")).rowCount, (await template(other, "Case file")).rowCount];
    });
    expect(perUnit).toEqual([1, 1]);
    await expect(tx(() => template(null, "Orders", "ord"))).rejects.toThrow(/record_templates_prefix_check/);
    await expect(tx(() => template(null, "x".repeat(81)))).rejects.toThrow(/record_templates_name_len_check/);

    // A card dies with its root message; a column that still has a card cannot be deleted.
    const afterDelete = await tx(async () => {
      await q("delete from app.messages where id = $1", [seeded.message_id]);
      return (
        await q("select count(*)::int as n from app.board_cards where message_id = $1", [seeded.message_id])
      ).rows[0].n;
    });
    expect(afterDelete).toBe(0);
    await expect(tx(() => q("delete from app.board_columns where id = $1", [col]))).rejects.toThrow(
      /RESTRICT setting of foreign key constraint "board_cards_column_fk"/,
    );
    // Deleting the board channel removes its board, columns and cards in one statement.
    const gone = await tx(async () => {
      await q("delete from app.conversations where id = $1", [board]);
      const n = async (tbl: string) =>
        (await q(`select count(*)::int as n from ${tbl} where conversation_id = $1`, [board])).rows[0].n;
      return [await n("app.boards"), await n("app.board_columns"), await n("app.board_cards")];
    });
    expect(gone).toEqual([0, 0, 0]);
  });

  it("Phase 07.1: ranks sort in SQL exactly as in JavaScript", async () => {
    const keys = ["a1", "Zz", "a0V", "A0", "a0", "b", "a0G"];
    const seeded = (
      await migrator.query(
        "select c.conversation_id, m.author_id from app.board_cards c join app.messages m on m.id = c.message_id where c.organization_id = $1",
        [A],
      )
    ).rows[0] as { conversation_id: string; author_id: string };
    const sql = await inTenant(A, async () => {
      const column = (
        await app.query(
          "insert into app.board_columns (organization_id, conversation_id, name, rank, category) values ($1, $2, 'Sorting', 'a1', 'started') returning id",
          [A, seeded.conversation_id],
        )
      ).rows[0].id;
      let seq = 200;
      for (const rank of keys) {
        seq += 1;
        const m = (
          await app.query(
            "insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 'user', $4, $5) returning id",
            [A, seeded.conversation_id, seq, seeded.author_id, rank],
          )
        ).rows[0].id;
        await app.query(
          "insert into app.board_cards (message_id, organization_id, conversation_id, column_id, rank, title) values ($1, $2, $3, $4, $5, $5)",
          [m, A, seeded.conversation_id, column, rank],
        );
      }
      return (
        await app.query("select rank from app.board_cards where column_id = $1 order by rank", [column])
      ).rows.map((r) => r.rank as string);
    });
    expect(sql).toEqual([...keys].sort());
    // The keys do tell byte order from a linguistic one, so the assertion above can fail.
    const linguistic = (
      await migrator.query('select k from unnest($1::text[]) k order by k collate "und-x-icu"', [keys])
    ).rows.map((r) => r.k as string);
    expect(linguistic).not.toEqual([...keys].sort());

    const collations = await migrator.query(
      "select table_name, collation_name from information_schema.columns where table_schema = 'app' and column_name = 'rank' order by table_name",
    );
    expect(collations.rows).toEqual([
      { table_name: "board_cards", collation_name: "C" },
      { table_name: "board_columns", collation_name: "C" },
    ]);
    // The card order index sorts `rank` by "C" too. Read from the catalog: `pg_indexes.indexdef` prints a key's
    // collation only when it differs from the column's, and the column itself is "C" now.
    const idx = await migrator.query(
      `select a.attname as col, co.collname as collation
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         cross join lateral unnest(i.indkey::int2[], i.indcollation::oid[]) with ordinality as k(attnum, coll, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         left join pg_collation co on co.oid = k.coll
        where c.relname = 'board_cards_column_rank_idx'
        order by k.ord`,
    );
    expect(idx.rows).toEqual([
      { col: "organization_id", collation: null },
      { col: "conversation_id", collation: null },
      { col: "column_id", collation: null },
      { col: "rank", collation: "C" },
    ]);
  });

  it("Phase 07.2: the five memory and approval tables are org-scoped, forced, seeded and invisible and unwritable across tenants", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of MEMORY_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true });
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded`).toBeGreaterThan(0);
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () =>
          app.query(stmt, [B]).then(
            (res) => res.rowCount,
            // Revisions and proposals are append-only: UPDATE is not even granted.
            (err: Error) => (/permission denied/.test(err.message) ? 0 : Promise.reject(err)),
          ),
        );
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // A copy of B's row written from A's context is refused by the tenant policy (generated columns excluded).
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      const cols = (
        await migrator.query(
          `select a.attname from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0
             and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
          [tbl],
        )
      ).rows.map((r) => `"${r.attname}"`);
      await expect(
        inTenant(A, () =>
          app.query(
            `insert into ${tbl} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_record(null::${tbl}, $1::json)`,
            [JSON.stringify(row.rows[0].j)],
          ),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
    }
    // The four memory tables (and, since 07.4-07, the keychain's personal keys, their grants since 07.4-14 and member
    // connections since 07.4-10, sealed browser sessions since 07.8-02) carry the restrictive owner-only policy on top
    // of the tenant policy.
    const restrictive = await migrator.query(
      "select tablename, cmd, permissive from pg_policies where schemaname = 'app' and policyname = 'personal_owner_only' order by tablename",
    );
    expect(restrictive.rows).toEqual(
      [
        "agent_vault_grants",
        "browser_sessions",
        "connector_connections",
        "memory_file_revisions",
        "memory_files",
        "memory_proposals",
        "memory_scopes",
        "vault_items",
      ].map((tablename) => ({
        tablename,
        cmd: "ALL",
        permissive: "RESTRICTIVE",
      })),
    );
    // The owner triggers run as the migrator with a fixed search_path; the app role cannot call them directly.
    const fns = await migrator.query(
      `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname like 'memory_%_owner' order by 1`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual([
      "memory_revision_owner",
      "memory_scope_owner",
      "memory_scoped_row_owner",
    ]);
    for (const f of fns.rows) {
      expect(f, f.proname).toMatchObject({
        prosecdef: true,
        owner: "ocw_migrator",
        proconfig: ["search_path=pg_catalog, pg_temp"],
      });
    }
  });

  it("Phase 07.2: memory scope shapes, approval and card columns, and memory-only folder rules", async () => {
    const { unit, agent, user, card } = (
      await migrator.query(
        `select (select id from app.org_units where organization_id = $1 and kind = 'department' limit 1) as unit,
                (select id from app.agents where organization_id = $1 and scope = 'team' limit 1) as agent,
                (select user_id from app.org_members where organization_id = $1 limit 1) as user,
                (select message_id from app.message_cards where organization_id = $1 limit 1) as card`,
        [A],
      )
    ).rows[0];
    const tx = <T>(fn: () => Promise<T>) =>
      (async () => {
        await migrator.query("begin");
        try {
          return await fn();
        } finally {
          await migrator.query("rollback");
        }
      })();
    const scope = (kind: string, agentId: string | null, owner: string | null, unitId: string | null) =>
      migrator.query(
        "insert into app.memory_scopes (organization_id, kind, agent_id, owner_user_id, unit_id) values ($1, $2, $3, $4, $5)",
        [A, kind, agentId, owner, unitId],
      );
    // Each kind names exactly its own anchors.
    expect((await tx(() => scope("personal", agent, user, null))).rowCount).toBe(1);
    expect((await tx(() => scope("agent", agent, null, null))).rowCount).toBe(1);
    for (const [kind, a, o, u] of [
      ["personal", agent, null, null],
      ["personal", null, user, null],
      ["personal", agent, user, unit],
      ["agent", agent, user, null],
      ["agent", null, null, null],
      ["unit", null, null, null],
      ["unit", agent, null, unit],
      ["org", agent, null, null],
      ["org", null, null, unit],
    ] as const) {
      await expect(
        tx(() => scope(kind, a, o, u)),
        `${kind} ${a} ${o} ${u}`,
      ).rejects.toThrow(/memory_scopes_(shape|kind)_check/);
    }
    await expect(tx(() => scope("team", null, null, unit))).rejects.toThrow(/memory_scopes_kind_check/);
    // One scope per anchor: the seeded unit scope is already there; one org scope; one personal scope per pair.
    await expect(tx(() => scope("unit", null, null, unit))).rejects.toThrow(/memory_scopes_unit_uq/);
    await expect(
      tx(async () => {
        await scope("org", null, null, null);
        return scope("org", null, null, null);
      }),
    ).rejects.toThrow(/memory_scopes_org_uq/);
    await expect(
      tx(async () => {
        await scope("personal", agent, user, null);
        return scope("personal", agent, user, null);
      }),
    ).rejects.toThrow(/memory_scopes_personal_uq/);
    await expect(
      tx(async () => {
        await scope("agent", agent, null, null);
        return scope("agent", agent, null, null);
      }),
    ).rejects.toThrow(/memory_scopes_agent_uq/);
    await expect(
      migrator.query(
        "insert into app.memory_scopes (organization_id, kind, origin) values ($1, 'org', 'import')",
        [A],
      ),
    ).rejects.toThrow(/memory_scopes_origin_check/);

    // Approvals: 64-hex action hashes, known modes and statuses, a short decision note and at most three warnings.
    const approval = (overrides: Record<string, unknown>) => {
      const v = {
        mode: "server_apply",
        status: "pending",
        action_hash: "a".repeat(64),
        decision_note: null,
        card_warnings: [],
        ...overrides,
      };
      return migrator.query(
        "insert into app.approval_requests (organization_id, kind, mode, resource_type, resource_id, action_hash, status, decision_note, card_warnings, expires_at) values ($1, 'memory.write', $2, 'memory_proposal', $3, $4, $5, $6, $7, now() + interval '1 day')",
        [A, v.mode, randomUUID(), v.action_hash, v.status, v.decision_note, v.card_warnings],
      );
    };
    expect((await tx(() => approval({ mode: "grant", decision_note: "n".repeat(280) }))).rowCount).toBe(1);
    for (const status of ["pending", "approved", "denied", "applied", "failed", "expired"]) {
      expect((await tx(() => approval({ status }))).rowCount, status).toBe(1);
    }
    await expect(tx(() => approval({ mode: "auto" }))).rejects.toThrow(/approval_requests_mode_check/);
    await expect(tx(() => approval({ status: "cancelled" }))).rejects.toThrow(
      /approval_requests_status_check/,
    );
    await expect(tx(() => approval({ action_hash: "A".repeat(64) }))).rejects.toThrow(
      /approval_requests_action_hash_check/,
    );
    await expect(tx(() => approval({ action_hash: "a".repeat(63) }))).rejects.toThrow(
      /approval_requests_action_hash_check/,
    );
    await expect(tx(() => approval({ decision_note: "n".repeat(281) }))).rejects.toThrow(
      /approval_requests_decision_note_len_check/,
    );
    await expect(tx(() => approval({ card_warnings: ["a", "b", "c", "d"] }))).rejects.toThrow(
      /approval_requests_card_warnings_check/,
    );
    // One approval per card message.
    const seededCard = (
      await migrator.query("select card_message_id from app.approval_requests where organization_id = $1", [
        A,
      ])
    ).rows[0].card_message_id;
    expect(seededCard).toBe(card);
    await expect(
      tx(() =>
        migrator.query(
          "insert into app.approval_requests (organization_id, kind, mode, resource_type, resource_id, action_hash, card_message_id, expires_at) values ($1, 'memory.write', 'server_apply', 'memory_proposal', $2, $3, $4, now())",
          [A, randomUUID(), "b".repeat(64), card],
        ),
      ),
    ).rejects.toThrow(/approval_requests_card_message_uq/);

    // Cards: platform-owned defaults to false; the decision note is optional and short.
    const cardRow = (
      await migrator.query(
        "select platform_owned, decision_note from app.message_cards where message_id = $1",
        [card],
      )
    ).rows[0];
    expect(cardRow).toEqual({ platform_owned: false, decision_note: null });
    await expect(
      tx(() =>
        migrator.query("update app.message_cards set decision_note = $2 where message_id = $1", [
          card,
          "n".repeat(281),
        ]),
      ),
    ).rejects.toThrow(/message_cards_decision_note_len_check/);

    // Folder rules: only memory permissions, only the folder form (ends with "/").
    const rule = (permission: string, pathPrefix: string | null) =>
      migrator.query(
        "insert into app.permission_rules (organization_id, subject_kind, permission, effect, path_prefix) values ($1, 'everyone', $2, 'deny', $3)",
        [A, permission, pathPrefix],
      );
    expect((await tx(() => rule("memory.read", "hr/"))).rowCount).toBe(1);
    expect((await tx(() => rule("memory.*", "hr/payroll/"))).rowCount).toBe(1);
    expect((await tx(() => rule("channel.create", null))).rowCount).toBe(1);
    await expect(tx(() => rule("channel.create", "hr/"))).rejects.toThrow(
      /permission_rules_path_prefix_check/,
    );
    await expect(tx(() => rule("memory.read", "hr"))).rejects.toThrow(/permission_rules_path_prefix_check/);

    // Deleting an approval keeps the revision it produced and only unlinks it; deleting the card unlinks the approval.
    const linked = await tx(async () => {
      await migrator.query("delete from app.approval_requests where organization_id = $1", [A]);
      return (
        await migrator.query(
          "select approval_request_id from app.memory_file_revisions where organization_id = $1",
          [A],
        )
      ).rows;
    });
    expect(linked).toEqual([{ approval_request_id: null }]);
    const unlinked = await tx(async () => {
      await migrator.query("delete from app.messages where id = $1", [card]);
      return (
        await migrator.query("select card_message_id from app.approval_requests where organization_id = $1", [
          A,
        ])
      ).rows;
    });
    expect(unlinked).toEqual([{ card_message_id: null }]);
  });

  it("Phase 07.4: the seven connector, keychain and template tables are org-scoped, forced, seeded, with the tenant policy (+ owner-only on keys)", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of CONNECTOR_TABLES) {
      // vault_items (personal keys, 07.4-07), their grants (07.4-14) and connector_connections (07.4-10) also carry the restrictive owner-only
      // policy; a connection is visible to its member's own session only.
      const ownerOnly =
        tbl === "app.vault_items" || tbl === "app.connector_connections" || tbl === "app.agent_vault_grants";
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: ownerOnly ? 2 : 1 });
      const owner =
        tbl === "app.connector_connections"
          ? (
              await migrator.query(
                "select user_id from app.connector_connections where organization_id = $1 limit 1",
                [A],
              )
            ).rows[0].user_id
          : null;
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`), owner);
      expect(own.rows[0].n, `${tbl} seeded`).toBeGreaterThan(0);
    }
    // The `mcp.manage` path over every member's connection (WINDOWS #186): migrator-owned, fixed search_path,
    // executable by the app role only, scoped to the tenant transaction's organization.
    const fns = await migrator.query(
      `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
              has_function_privilege('ocw_app', p.oid, 'execute') as app,
              has_function_privilege('public', p.oid, 'execute') as public
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname in ('connector_connection_counts', 'clear_connector_connections')
        order by 1`,
    );
    expect(fns.rows).toEqual(
      ["clear_connector_connections", "connector_connection_counts"].map((proname) => ({
        proname,
        prosecdef: true,
        owner: "ocw_migrator",
        proconfig: ["search_path=pg_catalog, pg_temp"],
        app: true,
        public: false,
      })),
    );
    const total = async (org: string) =>
      (
        await migrator.query(
          "select count(*)::int as n from app.connector_connections where organization_id = $1",
          [org],
        )
      ).rows[0].n as number;
    const counted = await inTenant(A, () =>
      app.query("select coalesce(sum(connections), 0)::int as n from app.connector_connection_counts(null)"),
    );
    expect(counted.rows[0].n).toBe(await total(A));
    // Without a tenant the functions see nothing; org B's clearing never reaches org A's rows.
    expect(
      (await app.query("select count(*)::int as n from app.connector_connection_counts(null)")).rows[0].n,
    ).toBe(0);
    const aServer = (
      await migrator.query(
        "select server_id from app.connector_connections where organization_id = $1 limit 1",
        [A],
      )
    ).rows[0].server_id;
    const before = await total(A);
    await inTenant(B, () => app.query("select * from app.clear_connector_connections($1)", [aServer]));
    expect(await total(A)).toBe(before);
  });

  it("Phase 07.4: a member's connector connection of org B is invisible, unchangeable and unforgeable from org A", async () => {
    const b = (
      await migrator.query(
        "select id, user_id, server_id from app.connector_connections where organization_id = $1",
        [B],
      )
    ).rows[0];
    expect(b).toBeDefined();
    await inTenant(A, async () => {
      expect(
        (await app.query("select * from app.connector_connections where id = $1", [b.id])).rowCount,
      ).toBe(0);
      expect(
        (
          await app.query(
            "update app.connector_connections set status = 'needs_reconnect', last_error = 'revoked' where id = $1",
            [b.id],
          )
        ).rowCount,
      ).toBe(0);
      expect((await app.query("delete from app.connector_connections where id = $1", [b.id])).rowCount).toBe(
        0,
      );
    });
    // A row claiming organization B, written in A's context, is refused by the tenant policy.
    await expect(
      inTenant(A, () =>
        app.query(
          "insert into app.connector_connections (organization_id, user_id, server_id, status) values ($1, $2, $3, 'connected')",
          [B, randomUUID(), b.server_id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const after = await migrator.query(
      "select status, last_error from app.connector_connections where id = $1",
      [b.id],
    );
    expect(after.rows).toEqual([{ status: "connected", last_error: null }]);
  });

  it("Phase 07.4: OAuth clients, shares, keys, key grants, templates and versions of org B are invisible and unwritable from org A", async () => {
    for (const tbl of CONNECTOR_TABLES.filter((t) => t !== "app.connector_connections")) {
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [B],
      );
      expect(seeded.rows[0].n, `${tbl} has B rows`).toBeGreaterThan(0);
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () => app.query(stmt, [B]).then((res) => res.rowCount));
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // Moving one of A's own rows into B is refused too (WITH CHECK on UPDATE). A template version refuses every
      // update before RLS is checked (07.4-08: versions are immutable, a BEFORE UPDATE trigger).
      await expect(
        inTenant(A, () =>
          app.query(`update ${tbl} set organization_id = $1 where organization_id = $2`, [B, A]),
        ),
        `${tbl} cross-tenant move`,
      ).rejects.toThrow(
        tbl === "app.agent_template_versions"
          ? /agent template versions are immutable/
          : /row-level security/,
      );
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      const cols = (
        await migrator.query(
          `select a.attname from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0
             and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
          [tbl],
        )
      ).rows.map((r) => `"${r.attname}"`);
      await expect(
        inTenant(A, () =>
          app.query(
            `insert into ${tbl} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_record(null::${tbl}, $1::json)`,
            [JSON.stringify(row.rows[0].j)],
          ),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
      const still = await migrator.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [
        B,
      ]);
      expect(still.rows[0].n, `${tbl} B rows intact`).toBe(seeded.rows[0].n);
    }
  });

  it("Phase 07.5: the three approval-policy, stored-action and proposal tables are org-scoped, forced, seeded and invisible and unwritable across tenants", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of TOOL_APPROVAL_TABLES) {
      // Tenant isolation only: deciders other than the requester read the stored action (P-09), so no owner-only policy.
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: 1 });
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [B],
      );
      expect(seeded.rows[0].n, `${tbl} has B rows`).toBeGreaterThan(0);
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded for A`).toBeGreaterThan(0);
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () => app.query(stmt, [B]).then((res) => res.rowCount));
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // Moving one of A's own rows into B is refused: by the tenant policy, or first by the immutability trigger of the
      // stored action and of the proposal (a stored row never changes, except the links a deletion clears).
      await expect(
        inTenant(A, () =>
          app.query(`update ${tbl} set organization_id = $1 where organization_id = $2`, [B, A]),
        ),
        `${tbl} cross-tenant move`,
      ).rejects.toThrow(tbl === "app.tool_approval_policies" ? /row-level security/ : /are immutable/);
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      const cols = (
        await migrator.query(
          `select a.attname from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0
             and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
          [tbl],
        )
      ).rows.map((r) => `"${r.attname}"`);
      await expect(
        inTenant(A, () =>
          app.query(
            `insert into ${tbl} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_record(null::${tbl}, $1::json)`,
            [JSON.stringify(row.rows[0].j)],
          ),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
      const still = await migrator.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [
        B,
      ]);
      expect(still.rows[0].n, `${tbl} B rows intact`).toBe(seeded.rows[0].n);
    }

    // Foreign keys bypass RLS, so every reference carries the organization (composite keys): a row of A naming B's bot,
    // unit, project, device, session or rule is refused even though the app role cannot read any of them.
    const ids = async (org: string) =>
      (
        await migrator.query(
          `select (select id from app.agents where organization_id = $1 and scope = 'personal' limit 1) as agent,
                  (select id from app.org_units where organization_id = $1 limit 1) as unit,
                  (select id from app.projects where organization_id = $1 limit 1) as project,
                  (select device_id from app.projects where organization_id = $1 limit 1) as device,
                  (select id from app.work_sessions where organization_id = $1 limit 1) as session,
                  (select id from app.tool_approval_policies where organization_id = $1 and scope_unit_id is null limit 1) as policy,
                  (select user_id from app.org_members where organization_id = $1 limit 1) as user`,
          [org],
        )
      ).rows[0];
    const a = await ids(A);
    const b = await ids(B);
    const hash = "d".repeat(64);
    const approval = (over: { agent?: string; policy?: string | null }) =>
      app.query(
        `insert into app.tool_call_approvals (organization_id, agent_id, requested_for_user_id, conversation_id, event_id, tool, source_kind, arguments_canonical, arguments_sha256, action_hash, tainted, policy_id)
         values ($1, $2, $3, $4, $4, 'ocw_http_request', 'vault', '{}', $5, $5, false, $6)`,
        [
          A,
          over.agent ?? a.agent,
          a.user,
          randomUUID(),
          hash,
          over.policy === undefined ? null : over.policy,
        ],
      );
    const proposal = (over: { agent?: string; project?: string; device?: string; session?: string | null }) =>
      app.query(
        `insert into app.work_zone_proposals (organization_id, agent_id, requested_for_user_id, conversation_id, event_id, project_id, device_id, runtime, prompt, prompt_sha256, work_session_id)
         values ($1, $2, $3, $4, $4, $5, $6, 'codex', 'Run the tests', $7, $8)`,
        [
          A,
          over.agent ?? a.agent,
          a.user,
          randomUUID(),
          over.project ?? a.project,
          over.device ?? a.device,
          hash,
          over.session === undefined ? null : over.session,
        ],
      );
    const fk = /violates foreign key constraint/;
    await inTenant(A, async () => {
      await approval({});
      await approval({ policy: a.policy });
      await proposal({ session: a.session });
    });
    await expect(inTenant(A, () => approval({ agent: b.agent }))).rejects.toThrow(fk);
    await expect(inTenant(A, () => approval({ policy: b.policy }))).rejects.toThrow(fk);
    await expect(inTenant(A, () => proposal({ agent: b.agent }))).rejects.toThrow(fk);
    await expect(inTenant(A, () => proposal({ project: b.project, device: b.device }))).rejects.toThrow(fk);
    await expect(inTenant(A, () => proposal({ session: b.session }))).rejects.toThrow(fk);
    // A project is proposed on its own device only.
    const otherDevice = randomUUID();
    await migrator.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'desktop', 'linux', $4)",
      [otherDevice, A, a.user, `dev-${otherDevice}`],
    );
    await expect(inTenant(A, () => proposal({ device: otherDevice }))).rejects.toThrow(fk);
    await expect(
      inTenant(A, () =>
        app.query(
          "insert into app.tool_approval_policies (organization_id, scope_unit_id, tool_pattern, mode) values ($1, $2, 'ocw_http_request', 'always')",
          [A, b.unit],
        ),
      ),
    ).rejects.toThrow(fk);
    await expect(
      inTenant(A, () =>
        app.query(
          "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position, proposed_by_agent_id) values ($1, $2, $3, 'x', 9, $4)",
          [A, a.session, a.user, b.agent],
        ),
      ),
    ).rejects.toThrow(fk);

    // The two new columns exist and are nullable; the ledger's approval link has no foreign key (it outlives requests).
    const columns = await migrator.query(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'app' and ((table_name = 'work_prompts' and column_name = 'proposed_by_agent_id')
           or (table_name = 'agent_tool_calls' and column_name = 'approval_id')) order by table_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: "agent_tool_calls", column_name: "approval_id", data_type: "uuid", is_nullable: "YES" },
      {
        table_name: "work_prompts",
        column_name: "proposed_by_agent_id",
        data_type: "uuid",
        is_nullable: "YES",
      },
    ]);
    const ledgerFks = await migrator.query(
      `select count(*)::int as n from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'app.agent_tool_calls'::regclass and c.contype = 'f' and a.attname = 'approval_id'`,
    );
    expect(ledgerFks.rows[0].n).toBe(0);
  });

  it("Phase 07.5: the stored action and the Work Zone proposal cannot be truncated by the app role (WINDOWS #201)", async () => {
    // The immutability triggers fire on UPDATE only; TRUNCATE would erase every stored action and proposal of every
    // tenant at once (it ignores RLS), so the app role must not hold it. DELETE stays: cascades of a bot, project or
    // device remove their rows.
    for (const tbl of ["app.tool_call_approvals", "app.work_zone_proposals"]) {
      const before = await migrator.query(`select count(*)::int as n from ${tbl}`);
      await expect(
        inTenant(A, () => app.query(`truncate ${tbl}`)),
        `truncate ${tbl}`,
      ).rejects.toThrow(/permission denied/);
      const after = await migrator.query(`select count(*)::int as n from ${tbl}`);
      expect(after.rows[0].n, `${tbl} rows intact`).toBe(before.rows[0].n);
    }
    // post-migrate.sql revokes it explicitly, like the memory history tables, so a broader grant added later (or by
    // hand) is taken back on the next migrate. Checked inside a rolled-back transaction: DDL is transactional.
    await migrator.query("begin");
    try {
      await migrator.query("grant truncate on app.tool_call_approvals, app.work_zone_proposals to ocw_app");
      await migrator.query(readFileSync(new URL("../sql/post-migrate.sql", import.meta.url), "utf8"));
      const held = await migrator.query(
        `select t, has_table_privilege('ocw_app', t, 'TRUNCATE') as truncate
           from unnest(array['app.tool_call_approvals', 'app.work_zone_proposals']) as t order by t`,
      );
      expect(held.rows).toEqual([
        { t: "app.tool_call_approvals", truncate: false },
        { t: "app.work_zone_proposals", truncate: false },
      ]);
    } finally {
      await migrator.query("rollback");
    }
  });

  it("Phase 07.8: the eleven sandbox and browser tables (agent_member_data since 07.8-28) are org-scoped, forced, seeded and invisible and unwritable across tenants", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    const sessionOwner = async (org: string) =>
      (
        await migrator.query("select user_id from app.browser_sessions where organization_id = $1 limit 1", [
          org,
        ])
      ).rows[0].user_id as string;
    const ownerA = await sessionOwner(A);
    for (const tbl of SANDBOX_TABLES) {
      // browser_sessions also carries the restrictive owner-only policy (D-08, F-10): it is read here as its owner.
      const ownerOnly = tbl === "app.browser_sessions";
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: ownerOnly ? 2 : 1 });
      const asA = <T>(fn: () => Promise<T>) => inTenant(A, fn, ownerOnly ? ownerA : null);
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [B],
      );
      expect(seeded.rows[0].n, `${tbl} has B rows`).toBeGreaterThan(0);
      const own = await asA(() => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded for A`).toBeGreaterThan(0);
      const cross = await asA(() =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await asA(() => app.query(stmt, [B]).then((res) => res.rowCount));
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // Moving one of A's own rows into B is refused by the tenant policy (or first by a composite foreign key, which
      // carries the organization and so finds no parent in B).
      await expect(
        asA(() => app.query(`update ${tbl} set organization_id = $1 where organization_id = $2`, [B, A])),
        `${tbl} cross-tenant move`,
      ).rejects.toThrow(/row-level security|violates foreign key constraint/);
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      const cols = (
        await migrator.query(
          `select a.attname from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0
             and not a.attisdropped and a.attgenerated = '' order by a.attnum`,
          [tbl],
        )
      ).rows.map((r) => `"${r.attname}"`);
      await expect(
        asA(() =>
          app.query(
            `insert into ${tbl} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_record(null::${tbl}, $1::json)`,
            [JSON.stringify(row.rows[0].j)],
          ),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
      const still = await migrator.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [
        B,
      ]);
      expect(still.rows[0].n, `${tbl} B rows intact`).toBe(seeded.rows[0].n);
    }

    // Foreign keys bypass RLS, so every reference carries the organization (composite keys): a row of A naming B's bot,
    // conversation, secret, session, context or package is refused even though the app role cannot read any of them.
    const ids = async (org: string) =>
      (
        await migrator.query(
          `select (select id from app.agents where organization_id = $1 and scope = 'personal' limit 1) as agent,
                  (select conversation_id from app.browser_contexts where organization_id = $1 limit 1) as conv,
                  (select secret_id from app.browser_sessions where organization_id = $1 limit 1) as secret,
                  (select id from app.browser_sessions where organization_id = $1 limit 1) as session,
                  (select user_id from app.browser_sessions where organization_id = $1 limit 1) as user,
                  (select id from app.browser_contexts where organization_id = $1 limit 1) as context,
                  (select id from app.sandbox_packages where organization_id = $1 limit 1) as package`,
          [org],
        )
      ).rows[0];
    const a = await ids(A);
    const b = await ids(B);
    const fk = /violates foreign key constraint/;
    const refusals: Array<[string, unknown[]]> = [
      [
        "insert into app.bot_sandboxes (organization_id, agent_id, kind, state) values ($1, $2, 'sbx', 'starting')",
        [A, b.agent],
      ],
      [
        "insert into app.sandbox_usage_daily (organization_id, agent_id, day) values ($1, $2, '2026-01-01')",
        [A, b.agent],
      ],
      [
        "insert into app.browser_contexts (organization_id, agent_id, conversation_id, requested_for_user_id, event_id, host, secure, state) values ($1, $2, $3, $4, $4, 'a.example.test', true, 'live')",
        [A, a.agent, b.conv, a.user],
      ],
      [
        "insert into app.browser_contexts (organization_id, agent_id, conversation_id, requested_for_user_id, event_id, host, secure, state, session_id) values ($1, $2, $3, $4, $4, 'a.example.test', true, 'live', $5)",
        [A, a.agent, a.conv, a.user, b.session],
      ],
      [
        "insert into app.browser_sessions (organization_id, user_id, agent_id, site_key, secret_id, expires_at) values ($1, $2, $3, 'b.example.test', $4, now() + interval '1 day')",
        [A, a.user, a.agent, b.secret],
      ],
      [
        "insert into app.browser_signin_requests (organization_id, agent_id, context_id, requester_user_id, conversation_id, event_id, host, reason, expires_at) values ($1, $2, $3, $4, $5, $4, 'a.example.test', 'x', now())",
        [A, a.agent, b.context, a.user, a.conv],
      ],
      [
        "insert into app.bot_turn_activity (event_id, organization_id, agent_id, conversation_id) values ($1, $2, $3, $4)",
        [randomUUID(), A, b.agent, a.conv],
      ],
      [
        "insert into app.sandbox_package_installs (organization_id, agent_id, package_id, status) values ($1, $2, $3, 'pending')",
        [A, a.agent, b.package],
      ],
    ];
    for (const [stmt, values] of refusals) {
      await expect(
        inTenant(A, () => app.query(stmt, values), a.user),
        stmt,
      ).rejects.toThrow(fk);
    }
  });

  it("Phase 07.8: a member's sealed browser session is hers alone; another member, an admin and a session without a user read, change and write none (D-08, F-10)", async () => {
    const ana = randomUUID();
    const sam = randomUUID();
    for (const [u, name] of [
      [ana, "Ana"],
      [sam, "Sam"],
    ] as const) {
      await migrator.query("insert into auth.user (id, name, email) values ($1, $2, $3)", [
        u,
        name,
        `${u}@example.test`,
      ]);
      await migrator.query(
        "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, $3, 'standard')",
        [A, u, name],
      );
    }
    const admin = (
      await migrator.query(
        "select user_id from app.org_members where organization_id = $1 and role = 'admin' limit 1",
        [A],
      )
    ).rows[0].user_id as string;
    const agent = (
      await migrator.query("select id from app.agents where organization_id = $1 and scope = 'personal'", [A])
    ).rows[0].id as string;
    const seal = async () => {
      const secret = randomUUID();
      await migrator.query(
        "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'browser session', 'browser_session', 'c', 'i', 't')",
        [secret, A],
      );
      return secret;
    };
    const session = randomUUID();
    await migrator.query(
      "insert into app.browser_sessions (id, organization_id, user_id, agent_id, site_key, secret_id, expires_at) values ($1, $2, $3, $4, 'panel.autofy.app', $5, now() + interval '30 days')",
      [session, A, ana, agent, await seal()],
    );

    const sees = (user: string | null) =>
      inTenant(
        A,
        async () =>
          (await app.query("select id from app.browser_sessions where id = $1", [session])).rowCount,
        user,
      );
    expect(await sees(ana), "Ana reads her own session").toBe(1);
    for (const [who, user] of [
      ["another member", sam],
      ["an admin of the organization", admin],
      ["a session without a user", null],
    ] as const) {
      expect(await sees(user), `${who} reads it`).toBe(0);
      const changed = await inTenant(
        A,
        async () =>
          (await app.query("update app.browser_sessions set last_used_at = now() where id = $1", [session]))
            .rowCount,
        user,
      );
      expect(changed, `${who} updates it`).toBe(0);
      const deleted = await inTenant(
        A,
        async () => (await app.query("delete from app.browser_sessions where id = $1", [session])).rowCount,
        user,
      );
      expect(deleted, `${who} deletes it`).toBe(0);
    }
    // Writing a row for Ana while the session is Sam's fails the policy check; Ana may write her own.
    const secret = await seal();
    const insertFor = (owner: string, site: string) =>
      app.query(
        "insert into app.browser_sessions (organization_id, user_id, agent_id, site_key, secret_id, expires_at) values ($1, $2, $3, $4, $5, now() + interval '1 day')",
        [A, owner, agent, site, secret],
      );
    await expect(inTenant(A, () => insertFor(ana, "mail.autofy.app"), sam)).rejects.toThrow(
      /row-level security/,
    );
    await expect(inTenant(A, () => insertFor(ana, "mail.autofy.app"), admin)).rejects.toThrow(
      /row-level security/,
    );
    await expect(inTenant(A, () => insertFor(ana, "mail.autofy.app"))).rejects.toThrow(/row-level security/);
    expect(await inTenant(A, async () => (await insertFor(ana, "mail.autofy.app")).rowCount, ana)).toBe(1);
    // Ana cannot hand her session to Sam either (WITH CHECK on update).
    await expect(
      inTenant(
        A,
        () => app.query("update app.browser_sessions set user_id = $2 where id = $1", [session, sam]),
        ana,
      ),
    ).rejects.toThrow(/row-level security/);
    const still = await migrator.query(
      "select user_id, last_used_at from app.browser_sessions where id = $1",
      [session],
    );
    expect(still.rows).toEqual([{ user_id: ana, last_used_at: null }]);
    // The policy is the restrictive owner-only one (ANDed with tenant isolation), never a permissive widening.
    const policy = await migrator.query(
      `select polname, polpermissive, pg_get_expr(polqual, polrelid) as using, pg_get_expr(polwithcheck, polrelid) as check
         from pg_policy where polrelid = 'app.browser_sessions'::regclass and polname = 'personal_owner_only'`,
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0].polpermissive).toBe(false);
    expect(policy.rows[0].using).toMatch(/user_id = \(NULLIF\(current_setting\('app\.user_id'/);
    expect(policy.rows[0].check).toMatch(/user_id = \(NULLIF\(current_setting\('app\.user_id'/);
  });

  it("Phase 07.8: turns count sandbox calls and mark member data, and secrets accept the browser_session kind", async () => {
    const t = (
      await migrator.query(
        "select organization_id, agent_id, user_id, conversation_id from app.agent_turns where organization_id = $1 limit 1",
        [A],
      )
    ).rows[0];
    const fresh = randomUUID();
    await migrator.query(
      "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id) values ($1, $2, $3, $4, $5, 'dm', $6)",
      [fresh, A, t.agent_id, t.user_id, t.conversation_id, randomUUID()],
    );
    const row = await migrator.query(
      "select sandbox_calls, member_data from app.agent_turns where event_id = $1",
      [fresh],
    );
    expect(row.rows).toEqual([{ sandbox_calls: 0, member_data: false }]);
    const kind = async (k: string) =>
      migrator.query(
        "insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag) values ($1, 'k', $2, 'c', 'i', 't')",
        [A, k],
      );
    await expect(kind("browser_session")).resolves.toBeDefined();
    await expect(kind("cookie_jar")).rejects.toMatchObject({ constraint: "secrets_kind_check" });
  });

  it("Phase 07.9: the four team-project and audience tables are org-scoped, forced, seeded and invisible and unwritable across tenants", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of WORK_ZONE_VISIBILITY_TABLES) {
      // Tenant isolation, plus (07.9-12) the RESTRICTIVE audience backstop on work_session_grants
      // (work-session-audience.int.test.ts proves it).
      const backstop = tbl === "app.work_session_grants";
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: backstop ? 2 : 1 });
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [B],
      );
      expect(seeded.rows[0].n, `${tbl} has B rows`).toBeGreaterThan(0);
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded for A`).toBeGreaterThan(0);
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () => app.query(stmt, [B]).then((res) => res.rowCount));
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // Moving one of A's own rows into B is refused by the tenant policy (or first by a composite foreign key, which
      // carries the organization and so finds no parent in B).
      await expect(
        inTenant(A, () =>
          app.query(`update ${tbl} set organization_id = $1 where organization_id = $2`, [B, A]),
        ),
        `${tbl} cross-tenant move`,
      ).rejects.toThrow(/row-level security|violates foreign key constraint/);
      const still = await migrator.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [
        B,
      ]);
      expect(still.rows[0].n, `${tbl} B rows intact`).toBe(seeded.rows[0].n);
    }
  });

  it("Phase 07.9: audiences, defaults, team assignments, repo links and their references are checked by the database (D-01, D-03, D-04)", async () => {
    const ids = async (org: string) =>
      (
        await migrator.query(
          `select g.subject_id as user, r.device_id as device, r.project_id as project, s.id as session,
                  s.conversation_id as conv, r.unit_id as unit, t.team_unit_id as team
           from app.work_session_grants g
           join app.work_sessions s on s.id = g.work_session_id
           join app.work_project_repos r on r.project_id = s.project_id
           join app.work_project_teams t on t.project_unit_id = r.unit_id
           where g.organization_id = $1 and g.subject_kind = 'user'`,
          [org],
        )
      ).rows[0];
    const a = await ids(A);
    const b = await ids(B);
    /** Each check runs in its own migrator transaction that is rolled back, so the seeds stay as they are. */
    const rolledBack = async <T>(fn: () => Promise<T>): Promise<T> => {
      await migrator.query("begin");
      try {
        return await fn();
      } finally {
        await migrator.query("rollback");
      }
    };
    const m = (text: string, values: unknown[]) => migrator.query(text, values);

    // A session created without an audience reads `project` (the D-06 default); other audiences are refused.
    const fresh = await rolledBack(async () => {
      const r = await m(
        "insert into app.work_sessions (organization_id, conversation_id, project_id, device_id, title, created_by) values ($1, $2, $3, $4, 'New', $5) returning visibility",
        [A, a.conv, a.project, a.device, a.user],
      );
      return r.rows[0].visibility;
    });
    expect(fresh).toBe("project");
    for (const ok of ["owner", "project", "teams", "people"]) {
      const n = await rolledBack(() =>
        m("update app.work_sessions set visibility = $2 where id = $1", [a.session, ok]).then(
          (r) => r.rowCount,
        ),
      );
      expect(n, ok).toBe(1);
    }
    await expect(
      rolledBack(() => m("update app.work_sessions set visibility = 'public' where id = $1", [a.session])),
    ).rejects.toThrow(/work_sessions_visibility_ck/);
    await expect(
      rolledBack(() =>
        m("update app.work_project_settings set default_visibility = 'teams' where unit_id = $1", [a.unit]),
      ),
    ).rejects.toThrow(/work_project_settings_default_ck/);
    await expect(
      rolledBack(() =>
        m(
          "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $2, $3)",
          [A, a.unit, a.user],
        ),
      ),
    ).rejects.toThrow(/work_project_teams_not_self_ck/);

    // Grants: a user or a unit; one active grant per subject; a revoke frees the slot and keeps the row.
    const grant = (kind: string, subject: string) =>
      m(
        "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, $3, $4, $5)",
        [A, a.session, kind, subject, a.user],
      );
    await expect(rolledBack(() => grant("role", randomUUID()))).rejects.toThrow(
      /work_session_grants_subject_kind_ck/,
    );
    await expect(rolledBack(() => grant("user", a.user))).rejects.toThrow(/work_session_grants_active_uq/);
    await expect(rolledBack(() => grant("unit", a.team))).rejects.toThrow(/work_session_grants_active_uq/);
    const regranted = await rolledBack(async () => {
      const revoked = await m(
        "update app.work_session_grants set revoked_at = now(), revoked_by = $3 where work_session_id = $1 and subject_kind = 'user' and subject_id = $2 and revoked_at is null",
        [a.session, a.user, a.user],
      );
      expect(revoked.rowCount).toBe(1);
      const r = await grant("user", a.user);
      const n = await m(
        "select count(*)::int as n from app.work_session_grants where work_session_id = $1 and subject_id = $2",
        [a.session, a.user],
      );
      return { inserted: r.rowCount, rows: n.rows[0].n };
    });
    expect(regranted).toEqual({ inserted: 1, rows: 2 });

    // One team project per repo; a project unit with a linked repo cannot be deleted.
    await expect(
      rolledBack(async () => {
        const other = randomUUID();
        await m(
          "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'project', 'Other', ARRAY[$3, $1]::uuid[])",
          [other, A, a.team],
        );
        return m(
          "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
          [A, a.project, a.device, other, a.user],
        );
      }),
    ).rejects.toThrow(/work_project_repos_pkey/);
    await expect(rolledBack(() => m("delete from app.org_units where id = $1", [a.unit]))).rejects.toThrow(
      /work_project_repos_unit_fk/,
    );

    // Every reference carries the organization (FKs bypass RLS): org B's team, repo, unit or session named from org A
    // is refused even for the migrator.
    const fk = /violates foreign key constraint/;
    const refusals: Array<[string, unknown[]]> = [
      [
        "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
        [A, a.unit, b.team, a.user],
      ],
      [
        "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
        [A, b.unit, a.team, a.user],
      ],
      [
        "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'user', $3, $3)",
        [A, b.session, a.user],
      ],
    ];
    for (const [stmt, values] of refusals) {
      await expect(
        rolledBack(() => m(stmt, values)),
        stmt,
      ).rejects.toThrow(fk);
    }
    // Settings of A naming a project unit of B (one with no settings yet, so the primary key cannot refuse it first).
    await expect(
      rolledBack(async () => {
        const other = randomUUID();
        await m(
          "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, $3, 'project', 'Other', ARRAY[$3, $1]::uuid[])",
          [other, B, b.team],
        );
        return m(
          "insert into app.work_project_settings (organization_id, unit_id, default_visibility, updated_by) values ($1, $2, 'project', $3)",
          [A, other, a.user],
        );
      }),
    ).rejects.toThrow(/work_project_settings_unit_fk/);
    // A link in A naming a repo of B (an unlinked one, so the primary key cannot refuse it first).
    await expect(
      rolledBack(async () => {
        const repo = randomUUID();
        await m(
          "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'p2', 'other')",
          [repo, B, b.device],
        );
        return m(
          "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
          [A, repo, b.device, a.unit, a.user],
        );
      }),
    ).rejects.toThrow(/work_project_repos_project_fk/);
    // Org A's own repo linked to org B's project unit.
    await expect(
      rolledBack(async () => {
        await m("delete from app.work_project_repos where project_id = $1", [a.project]);
        return m(
          "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
          [A, a.project, a.device, b.unit, a.user],
        );
      }),
    ).rejects.toThrow(/work_project_repos_unit_fk/);
    // The repo link names the repo's own device: a link pairing the repo with another device is refused.
    await expect(
      rolledBack(async () => {
        const otherDevice = randomUUID();
        await m(
          "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'other', 'linux', $4)",
          [otherDevice, A, a.user, `dev-${otherDevice}`],
        );
        await m("delete from app.work_project_repos where project_id = $1", [a.project]);
        return m(
          "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
          [A, a.project, otherDevice, a.unit, a.user],
        );
      }),
    ).rejects.toThrow(fk);

    // Cascades: a removed device takes its repo links; a deleted session takes its grants; a deleted project unit with
    // no linked repo takes its settings and team assignments.
    const cascades = await rolledBack(async () => {
      const count = async (sql: string, v: unknown[]) => (await m(sql, v)).rows[0].n as number;
      const links = "select count(*)::int as n from app.work_project_repos where organization_id = $1";
      const grants = "select count(*)::int as n from app.work_session_grants where work_session_id = $1";
      const settings =
        "select (select count(*)::int from app.work_project_settings where unit_id = $1) + (select count(*)::int from app.work_project_teams where project_unit_id = $1) as n";
      const before = {
        links: await count(links, [A]),
        grants: await count(grants, [a.session]),
        settings: await count(settings, [a.unit]),
      };
      await m("delete from app.work_sessions where id = $1", [a.session]);
      const grantsAfter = await count(grants, [a.session]);
      await m("delete from app.devices where id = $1", [a.device]);
      const linksAfter = await count(links, [A]);
      await m("delete from app.org_units where id = $1", [a.unit]);
      const settingsAfter = await count(settings, [a.unit]);
      return { before, after: { links: linksAfter, grants: grantsAfter, settings: settingsAfter } };
    });
    expect(cascades).toEqual({
      before: { links: 1, grants: 2, settings: 2 },
      after: { links: 0, grants: 0, settings: 0 },
    });
    // The RESTRICT guards a unit's deletion only: deleting the whole organization still removes everything.
    const orgGone = await rolledBack(async () => {
      await m("delete from auth.organization where id = $1", [A]);
      return (
        await m("select count(*)::int as n from app.work_project_repos where organization_id = $1", [A])
      ).rows[0].n;
    });
    expect(orgGone).toBe(0);
  });

  it("Phase 07.6: the ten automation, inbound, watched-record and Work Zone memory tables are org-scoped, forced, seeded and invisible and unwritable across tenants (C-02)", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of AUTOMATION_TABLES) {
      // Tenant isolation, plus the RESTRICTIVE audience backstop on work_session_memory (a session's memory state
      // follows its session, as work_prompts and work_approvals do).
      const backstop = tbl === "app.work_session_memory";
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: backstop ? 2 : 1 });
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [B],
      );
      expect(seeded.rows[0].n, `${tbl} has B rows`).toBeGreaterThan(0);
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded for A`).toBeGreaterThan(0);
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      // UPDATE / DELETE of B's rows from A affect 0 rows (watched_record_changes is append-only: not even granted).
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () =>
          app.query(stmt, [B]).then(
            (res) => res.rowCount,
            (err: Error) => (/permission denied/.test(err.message) ? 0 : Promise.reject(err)),
          ),
        );
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // INSERT of a copy of B's row while in A's context is refused by the tenant policy.
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      await expect(
        inTenant(A, () =>
          app.query(`insert into ${tbl} select * from json_populate_record(null::${tbl}, $1::json)`, [
            JSON.stringify(row.rows[0].j),
          ]),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
      // Moving one of A's own rows into B is refused by the tenant policy (or first by a composite foreign key, which
      // carries the organization and so finds no parent in B), or not granted at all (append-only changes).
      await expect(
        inTenant(A, () =>
          app.query(`update ${tbl} set organization_id = $1 where organization_id = $2`, [B, A]),
        ),
        `${tbl} cross-tenant move`,
      ).rejects.toThrow(/row-level security|violates foreign key constraint|permission denied/);
      const still = await migrator.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [
        B,
      ]);
      expect(still.rows[0].n, `${tbl} B rows intact`).toBe(seeded.rows[0].n);
    }
  });

  it("Phase 07.7: the two agent chain tables are org-scoped, forced, seeded and invisible and unwritable across tenants (C-02, D-14)", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of AGENT_CHAIN_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: 1 });
      const seeded = await migrator.query(
        `select count(*)::int as n from ${tbl} where organization_id = $1`,
        [B],
      );
      expect(seeded.rows[0].n, `${tbl} has B rows`).toBeGreaterThan(0);
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded for A`).toBeGreaterThan(0);
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const n = await inTenant(A, () => app.query(stmt, [B]).then((res) => res.rowCount));
        expect(n, `${tbl}: ${stmt}`).toBe(0);
      }
      // INSERT of a copy of B's row while in A's context is refused by the tenant policy.
      const row = await migrator.query(
        `select row_to_json(t) as j from ${tbl} t where organization_id = $1 limit 1`,
        [B],
      );
      await expect(
        inTenant(A, () =>
          app.query(`insert into ${tbl} select * from json_populate_record(null::${tbl}, $1::json)`, [
            JSON.stringify(row.rows[0].j),
          ]),
        ),
        `${tbl} cross-tenant insert`,
      ).rejects.toThrow(/row-level security/);
      // Moving one of A's own rows into B is refused by the tenant policy (or first by a composite foreign key, which
      // carries the organization and so finds no parent in B).
      await expect(
        inTenant(A, () =>
          app.query(`update ${tbl} set organization_id = $1 where organization_id = $2`, [B, A]),
        ),
        `${tbl} cross-tenant move`,
      ).rejects.toThrow(/row-level security|violates foreign key constraint/);
      const still = await migrator.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [
        B,
      ]);
      expect(still.rows[0].n, `${tbl} B rows intact`).toBe(seeded.rows[0].n);
    }
    // A's tenant cannot open a chain on B's conversation or root it at B's bot, nor add a hop to B's chain, even with
    // A's own organization id: the composite keys carry the organization (FKs bypass RLS).
    const b = (
      await migrator.query(
        "select c.id, c.conversation_id, c.root_agent_id, h.target_agent_id from app.agent_chains c join app.agent_chain_hops h on h.chain_id = c.id where c.organization_id = $1 limit 1",
        [B],
      )
    ).rows[0];
    const a = (
      await migrator.query(
        "select c.conversation_id, c.thread_root_id, c.root_agent_id, c.human_user_id, h.target_agent_id from app.agent_chains c join app.agent_chain_hops h on h.chain_id = c.id where c.organization_id = $1 limit 1",
        [A],
      )
    ).rows[0];
    const openChain = (conversation: string, rootAgent: string) =>
      inTenant(A, () =>
        app.query(
          "insert into app.agent_chains (organization_id, conversation_id, thread_root_id, root_event_id, root_agent_id, human_user_id) values ($1, $2, $3, $4, $5, $6)",
          [A, conversation, a.thread_root_id, randomUUID(), rootAgent, a.human_user_id],
        ),
      );
    await expect(openChain(b.conversation_id, a.root_agent_id)).rejects.toMatchObject({
      constraint: "agent_chains_conversation_fk",
    });
    await expect(openChain(a.conversation_id, b.root_agent_id)).rejects.toMatchObject({
      constraint: "agent_chains_root_agent_fk",
    });
    await expect(
      inTenant(A, async () => {
        const question = randomUUID();
        await app.query(
          "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 99, 'agent', $4, 'q')",
          [question, A, a.conversation_id, a.root_agent_id],
        );
        await app.query(
          "insert into app.agent_chain_hops (organization_id, chain_id, root_agent_id, source_agent_id, target_agent_id, depth, mode, source_event_id, question_message_id, idempotency_key, deadline_at) values ($1, $2, $3, $3, $4, 1, 'consult', $5, $6, 'k', now())",
          [A, b.id, a.root_agent_id, a.target_agent_id, randomUUID(), question],
        );
      }),
    ).rejects.toMatchObject({ constraint: "agent_chain_hops_chain_fk" });
  });

  it("Phase 07.16: the four bot Work Zone tables are org-scoped, forced, seeded and invisible across tenants; the bot session also has the audience backstop (D-07, D-16)", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of BOT_WORK_ZONE_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({
        rls: true,
        force: true,
        policies: tbl === "app.bot_work_sessions" ? 2 : 1,
      });
      const own = await inTenant(A, () => app.query(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} seeded for A`).toBeGreaterThan(0);
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
    }
    const policies = await migrator.query(
      "select policyname, permissive from pg_policies where schemaname = 'app' and tablename = 'bot_work_sessions' order by policyname",
    );
    expect(policies.rows).toEqual([
      { policyname: "audience_backstop", permissive: "RESTRICTIVE" },
      { policyname: "tenant_isolation", permissive: "PERMISSIVE" },
    ]);
  });

  it("Phase 07.17.1.1: the bot file ledger is org-scoped, forced, seeded and invisible across tenants (D-05)", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of BOT_FILE_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: 1 });
      for (const org of [A, B]) {
        const own = await inTenant(org, () => app.query(`select count(*)::int as n from ${tbl}`));
        expect(own.rows[0].n, `${tbl} seeded for ${org}`).toBeGreaterThan(0);
      }
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
    }
  });

  it("Phase 07.17.1.1.2: the bot task tables are org-scoped, forced, seeded, invisible across tenants and never truncated by the app role (D-01, E22)", async () => {
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    for (const tbl of BOT_TASK_TABLES) {
      expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: 1 });
      for (const org of [A, B]) {
        const own = await inTenant(org, () => app.query(`select count(*)::int as n from ${tbl}`));
        expect(own.rows[0].n, `${tbl} seeded for ${org}`).toBeGreaterThan(0);
      }
      const cross = await inTenant(A, () =>
        app.query(`select count(*)::int as n from ${tbl} where organization_id = $1`, [B]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      await expect(
        inTenant(A, () => app.query(`truncate ${tbl}`)),
        `truncate ${tbl}`,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("Phase 07.11 schema constraints: the update history is org-scoped and checked, the policy level too (D-02, D-06, PD-04)", async () => {
    const tbl = "app.device_runtime_updates";
    const scoped = new Map((await orgScopedTables()).map((t) => [t.tbl, t]));
    expect(scoped.get(tbl), tbl).toMatchObject({ rls: true, force: true, policies: 1 });
    const seeded = async (org: string) =>
      (
        await migrator.query(
          "select u.device_id as device, u.run_id as run, d.owner_user_id as user from app.device_runtime_updates u join app.devices d on d.id = u.device_id where u.organization_id = $1",
          [org],
        )
      ).rows[0] as { device: string; run: string; user: string };
    const a = await seeded(A);
    const b = await seeded(B);

    // Tenant isolation as the app role: B reads none of A's history and cannot write a row for A's device.
    expect(
      (
        await inTenant(A, () =>
          app.query(`select count(*)::int as n from ${tbl} where device_id = $1`, [a.device]),
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await inTenant(B, () =>
          app.query(`select count(*)::int as n from ${tbl} where device_id = $1`, [a.device]),
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      inTenant(B, () =>
        app.query(
          `insert into ${tbl} (organization_id, device_id, runtime, trigger, state) values ($1, $2, 'codex', 'manual', 'requested')`,
          [A, a.device],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Inside its own tenant, B naming A's device finds no parent: the device reference carries the organization.
    await expect(
      inTenant(B, () =>
        app.query(
          `insert into ${tbl} (organization_id, device_id, runtime, trigger, state) values ($1, $2, 'codex', 'manual', 'requested')`,
          [B, a.device],
        ),
      ),
    ).rejects.toThrow(/device_runtime_updates_device_fk/);

    /** Each check runs in its own migrator transaction that is rolled back, so the seeds stay as they are. */
    const rolledBack = async <T>(fn: () => Promise<T>): Promise<T> => {
      await migrator.query("begin");
      try {
        return await fn();
      } finally {
        await migrator.query("rollback");
      }
    };
    const m = (text: string, values: unknown[]) => migrator.query(text, values);
    const request = (device = a.device, runtime = "claude-code", org = A) =>
      m(
        `insert into ${tbl} (organization_id, device_id, runtime, trigger, requested_by, state, requested_at) values ($1, $2, $3, 'manual', $4, 'requested', now()) returning id`,
        [org, device, runtime, a.user],
      );

    // One pending "Update now" per device and runtime; the other runtime and an expired request leave the slot free.
    await expect(
      rolledBack(async () => {
        await request();
        return request();
      }),
    ).rejects.toThrow(/device_runtime_updates_requested_uq/);
    const freed = await rolledBack(async () => {
      const first = (await request()).rows[0].id as string;
      await request(a.device, "codex");
      await m(`update ${tbl} set state = 'expired' where id = $1`, [first]);
      return (await request()).rowCount;
    });
    expect(freed).toBe(1);

    // A replayed run id on the same device is refused.
    await expect(
      m(
        `insert into ${tbl} (organization_id, device_id, runtime, run_id, trigger, state) values ($1, $2, 'claude-code', $3, 'automatic', 'started')`,
        [A, a.device, a.run],
      ),
    ).rejects.toThrow(/device_runtime_updates_run_uq/);

    // Closed vocabularies and bounded text.
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ runtime: "opencode" }, /device_runtime_updates_runtime_ck/],
      [{ trigger: "cron" }, /device_runtime_updates_trigger_ck/],
      [{ state: "queued" }, /device_runtime_updates_state_ck/],
      [{ output: "x".repeat(4097) }, /device_runtime_updates_output_len_ck/],
      [{ error: "x".repeat(501) }, /device_runtime_updates_error_len_ck/],
    ];
    for (const [patch, ck] of bad) {
      const row = {
        runtime: "codex",
        trigger: "automatic",
        state: "started",
        output: null,
        error: null,
        ...patch,
      };
      await expect(
        m(
          `insert into ${tbl} (organization_id, device_id, runtime, trigger, state, output, error) values ($1, $2, $3, $4, $5, $6, $7)`,
          [A, a.device, row.runtime, row.trigger, row.state, row.output, row.error],
        ),
        JSON.stringify(Object.keys(patch)),
      ).rejects.toThrow(ck);
    }
    // At the limits it is accepted.
    const atLimit = await rolledBack(() =>
      m(
        `insert into ${tbl} (organization_id, device_id, runtime, trigger, state, output, error) values ($1, $2, 'codex', 'local', 'failed', $3, $4)`,
        [A, a.device, "x".repeat(4096), "x".repeat(500)],
      ).then((r) => r.rowCount),
    );
    expect(atLimit).toBe(1);

    // A row of org A naming org B's device fails the composite foreign key, even for the migrator.
    await expect(request(b.device)).rejects.toThrow(/device_runtime_updates_device_fk/);

    // Deleting a device deletes its history.
    const cascade = await rolledBack(async () => {
      const device = randomUUID();
      await m(
        "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'spare', 'linux', $4)",
        [device, A, a.user, `dev-${device}`],
      );
      await request(device);
      const count = async () =>
        (await m(`select count(*)::int as n from ${tbl} where device_id = $1`, [device])).rows[0].n as number;
      const before = await count();
      await m("delete from app.devices where id = $1", [device]);
      return [before, await count()];
    });
    expect(cascade).toEqual([1, 0]);

    // The organization's level is checked and defaults to automatic; a device's snapshot starts empty.
    const defaults = await migrator.query(
      "select p.runtime_updates, d.runtime_maintenance from app.work_zone_policies p join app.devices d on d.organization_id = p.organization_id where d.id = $1",
      [a.device],
    );
    expect(defaults.rows[0]).toEqual({ runtime_updates: "automatic", runtime_maintenance: null });
    await expect(
      m("update app.work_zone_policies set runtime_updates = 'sometimes' where organization_id = $1", [A]),
    ).rejects.toThrow(/work_zone_policies_runtime_updates_ck/);
    for (const ok of ["automatic", "notify", "off"]) {
      const n = await rolledBack(() =>
        m("update app.work_zone_policies set runtime_updates = $2 where organization_id = $1", [A, ok]).then(
          (r) => r.rowCount,
        ),
      );
      expect(n, ok).toBe(1);
    }
  });

  it("Phase 4: accent-insensitive Spanish search, a stored tsvector and the search indexes", async () => {
    const match = await migrator.query(
      "select to_tsvector('app.ocw_es', 'migración') @@ websearch_to_tsquery('app.ocw_es', 'migracion') as ok",
    );
    expect(match.rows[0].ok).toBe(true);
    const english = await migrator.query(
      "select to_tsvector('app.ocw_en', 'Deploying migrations') @@ websearch_to_tsquery('app.ocw_en', 'deploy migration') as ok",
    );
    expect(english.rows[0].ok).toBe(true);
    const tsv = await inTenant(A, () =>
      app.query("select search_tsv::text as tsv from app.messages where body = 'hi' limit 1"),
    );
    expect(tsv.rows[0].tsv).toContain("hi");
    // Written by the app role on insert (generated column), searchable within the tenant.
    const found = await inTenant(A, async () => {
      const conv = (await app.query("select id from app.conversations where kind = 'channel' limit 1"))
        .rows[0].id;
      await app.query(
        "insert into app.messages (organization_id, conversation_id, seq, author_kind, body) values ($1, $2, 99, 'system', 'Revisión de la autenticación')",
        [A, conv],
      );
      return app.query(
        "select count(*)::int as n from app.messages where search_tsv @@ (websearch_to_tsquery('app.ocw_simple', $1) || websearch_to_tsquery('app.ocw_es', $1) || websearch_to_tsquery('app.ocw_en', $1))",
        ["autenticacion"],
      );
    });
    expect(found.rows[0].n).toBe(1);
    const idx = await migrator.query(
      "select indexname from pg_indexes where schemaname = 'app' and indexname = any($1) order by 1",
      [["messages_search_gin", "org_members_name_trgm", "conversations_name_trgm", "agents_name_trgm"]],
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      "agents_name_trgm",
      "conversations_name_trgm",
      "messages_search_gin",
      "org_members_name_trgm",
    ]);
    const group = await migrator.query(
      "select indexdef from pg_indexes where schemaname = 'app' and indexname = 'conversations_org_group_key_uq'",
    );
    expect(group.rows[0].indexdef).toMatch(/WHERE \(kind = 'group'::text\)/);
  });

  it("app role is denied on schema auth", async () => {
    await expect(app.query("select * from auth.user")).rejects.toThrow(/permission denied/);
    await expect(app.query("select * from auth.session")).rejects.toThrow(/permission denied/);
  });

  it("survives Postgres dropping an idle pooled connection (no crash, next query reconnects)", async () => {
    const errors: Error[] = [];
    const db: TenantDb = createTenantDb(tdb.appUrl, { max: 1, onIdleError: (e) => errors.push(e) });
    try {
      const pid = (await db.pool.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const su = new pg.Client({ connectionString: tdb.superuserUrl });
      await su.connect();
      try {
        await su.query("select pg_terminate_backend($1)", [pid]);
      } finally {
        await su.end();
      }
      await expect.poll(() => errors.length).toBeGreaterThan(0);
      const n = await db.withTenant({ organizationId: A }, async (tx) => {
        const r = await tx.execute("select count(*)::int as n from app.conversations");
        return (r.rows[0] as { n: number }).n;
      });
      expect(n).toBe(5); // channel + work-session conversation + the 3.1 DM + the Phase 6 AI chat + the 07.1 board
    } finally {
      await db.close();
    }
  });

  it("survives Postgres killing a connection that is checked out mid-transaction (no crash)", async () => {
    const errors: Error[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    const db: TenantDb = createTenantDb(tdb.appUrl, { max: 1, onIdleError: (e) => errors.push(e) });
    try {
      const attempt = db.withTenant({ organizationId: A }, async (tx) => {
        const pid = ((await tx.execute("select pg_backend_pid() as pid")).rows[0] as { pid: number }).pid;
        const su = new pg.Client({ connectionString: tdb.superuserUrl });
        await su.connect();
        try {
          await su.query("select pg_terminate_backend($1)", [pid]);
        } finally {
          await su.end();
        }
        await new Promise((r) => setTimeout(r, 200));
        await tx.execute("select 1");
      });
      await expect(attempt).rejects.toThrow();
      await expect.poll(() => errors.length).toBeGreaterThan(0);
      expect(uncaught).toEqual([]);
      const n = await db.withTenant({ organizationId: A }, async (tx) => {
        const r = await tx.execute("select count(*)::int as n from app.conversations");
        return (r.rows[0] as { n: number }).n;
      });
      expect(n).toBe(5); // channel + work-session conversation + the 3.1 DM + the Phase 6 AI chat + the 07.1 board
    } finally {
      process.off("uncaughtException", onUncaught);
      await db.close();
    }
  });

  it("withTenant scopes queries and does not leak context to the pooled connection", async () => {
    const db: TenantDb = createTenantDb(tdb.appUrl, { max: 1 });
    try {
      const n = await db.withTenant({ organizationId: A }, async (tx) => {
        const r = await tx.execute("select count(*)::int as n from app.conversations");
        return (r.rows[0] as { n: number }).n;
      });
      expect(n).toBe(5); // channel + work-session conversation + the 3.1 DM + the Phase 6 AI chat + the 07.1 board
      // Same single pooled connection, no tenant context now.
      const after = await db.pool.query("select count(*)::int as n from app.conversations");
      expect(after.rows[0].n).toBe(0);

      const hooks: string[] = [];
      await expect(
        db.withTenant({ organizationId: A }, async (_tx, afterCommit) => {
          afterCommit(() => {
            hooks.push("ran");
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(hooks).toEqual([]);

      const lookup = await db.lookups.deviceByTokenHash("nope");
      expect(lookup).toBeNull();
    } finally {
      await db.close();
    }
  });
});
