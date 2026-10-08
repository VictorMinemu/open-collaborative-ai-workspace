-- Synthetic seed for the N-1 upgrade baseline (plan 07-02, SELF-03). Targets the schema at git ref 3bbcbd9 (Phase 5
-- merge) and is loaded as ocw_migrator by packages/db/scripts/upgrade-baseline.mjs before the golden dump is taken.
--
-- Everything here is fake: `.test` e-mail domains, placeholder password hashes, fixed ids and timestamps (so a
-- regenerated dump is stable). Two organizations so the upgrade test can prove tenant isolation still holds.
--
-- The `app.secrets` row is sealed with the API's own helper (apps/api/src/lib/crypto.ts `seal`, AES-256-GCM,
-- AAD = organization id) under a FIXED TEST KEY: 32 bytes of 0x07, base64
-- `BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=`. Its only purpose is to prove a sealed secret still decrypts after
-- the upgrade; it is not, and must never become, an instance key. Plaintext: `sk-upgrade-baseline-fake-provider-key`.
--
-- Ids: org A = aaaaaaaa-…, org B = bbbbbbbb-…; suffix 01xx users, 02xx conversations, 03xx secrets/providers/agents,
-- 04xx AI generations/usage, 05xx messages, 06xx attachments/audit.

BEGIN;

INSERT INTO auth.organization (id, name, slug, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Acme Upgrade Test', 'acme-upgrade-test', '2026-10-06 09:00:00+00'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Beta Upgrade Test', 'beta-upgrade-test', '2026-10-06 09:00:00+00');

INSERT INTO auth."user" (id, name, email, email_verified, created_at, updated_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000101', 'Ada Admin', 'ada.admin@acme.test', true, '2026-10-06 09:00:00+00', '2026-10-06 09:00:00+00'),
  ('aaaaaaaa-0000-4000-8000-000000000102', 'Max Member', 'max.member@acme.test', true, '2026-10-06 09:05:00+00', '2026-10-06 09:05:00+00'),
  ('bbbbbbbb-0000-4000-8000-000000000101', 'Bea Admin', 'bea.admin@beta.test', true, '2026-10-06 09:00:00+00', '2026-10-06 09:00:00+00');

INSERT INTO auth.account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000111', 'aaaaaaaa-0000-4000-8000-000000000101', 'credential', 'aaaaaaaa-0000-4000-8000-000000000101', 'fake-password-hash-not-a-real-credential', '2026-10-06 09:00:00+00', '2026-10-06 09:00:00+00'),
  ('aaaaaaaa-0000-4000-8000-000000000112', 'aaaaaaaa-0000-4000-8000-000000000102', 'credential', 'aaaaaaaa-0000-4000-8000-000000000102', 'fake-password-hash-not-a-real-credential', '2026-10-06 09:05:00+00', '2026-10-06 09:05:00+00'),
  ('bbbbbbbb-0000-4000-8000-000000000111', 'bbbbbbbb-0000-4000-8000-000000000101', 'credential', 'bbbbbbbb-0000-4000-8000-000000000101', 'fake-password-hash-not-a-real-credential', '2026-10-06 09:00:00+00', '2026-10-06 09:00:00+00');

-- auth.member.role is existence-only since the role_values migration; app.org_members.role is authoritative.
INSERT INTO auth.member (id, organization_id, user_id, role, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000121', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000101', 'member', '2026-10-06 09:00:00+00'),
  ('aaaaaaaa-0000-4000-8000-000000000122', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000102', 'member', '2026-10-06 09:05:00+00'),
  ('bbbbbbbb-0000-4000-8000-000000000121', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000101', 'member', '2026-10-06 09:00:00+00');

INSERT INTO app.org_members (id, organization_id, user_id, display_name, email, role, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000101', 'Ada Admin', 'ada.admin@acme.test', 'admin', '2026-10-06 09:00:00+00'),
  ('aaaaaaaa-0000-4000-8000-000000000132', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000102', 'Max Member', 'max.member@acme.test', 'developer', '2026-10-06 09:05:00+00'),
  ('bbbbbbbb-0000-4000-8000-000000000131', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000101', 'Bea Admin', 'bea.admin@beta.test', 'admin', '2026-10-06 09:00:00+00');

-- Org secret sealed with the fixed test key (see header) + the model provider that references it.
INSERT INTO app.secrets (id, organization_id, name, kind, provider, ciphertext, iv, tag, created_by, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000301', 'aaaaaaaa-0000-4000-8000-000000000001', 'openai-api-key', 'provider_api_key', 'openai',
   'U8B19hkytroO0aV/Yh5xf2DbMRNVn1DOdTgbZoZhtG0tdS/0rw==', 'SelU/E7aj963X6Mi', 'MmWJ6JkueFSJZPefcZNvtQ==',
   'aaaaaaaa-0000-4000-8000-000000000101', '2026-10-06 09:10:00+00');

INSERT INTO app.model_providers (id, organization_id, provider, secret_id, allowed_models, enabled, key_hint, created_at, updated_at, secret_ref) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000311', 'aaaaaaaa-0000-4000-8000-000000000001', 'openai', 'aaaaaaaa-0000-4000-8000-000000000301',
   '{gpt-upgrade-test}', true, '…-key', '2026-10-06 09:10:00+00', '2026-10-06 09:10:00+00',
   '{"provider": "db", "secretId": "aaaaaaaa-0000-4000-8000-000000000301", "organizationId": "aaaaaaaa-0000-4000-8000-000000000001"}');

INSERT INTO app.agents (id, organization_id, name, username, description, instructions, model_provider, model_id, status, created_by, created_at, updated_at, scope) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000321', 'aaaaaaaa-0000-4000-8000-000000000001', 'Helper Bot', 'helper-bot', 'Synthetic team bot for the upgrade test.',
   'Answer briefly.', 'openai', 'gpt-upgrade-test', 'ready', 'aaaaaaaa-0000-4000-8000-000000000101', '2026-10-06 09:15:00+00', '2026-10-06 09:15:00+00', 'team');

-- Conversations: org A channel, human DM, AI chat; org B channel.
INSERT INTO app.conversations (id, organization_id, kind, name, slug, topic, visibility, created_by, created_at, dm_key) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000201', 'aaaaaaaa-0000-4000-8000-000000000001', 'channel', 'general', 'general', 'Upgrade test channel', 'public', 'aaaaaaaa-0000-4000-8000-000000000101', '2026-10-06 09:20:00+00', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000202', 'aaaaaaaa-0000-4000-8000-000000000001', 'dm', NULL, NULL, NULL, 'private', 'aaaaaaaa-0000-4000-8000-000000000101', '2026-10-06 09:21:00+00',
   'user:aaaaaaaa-0000-4000-8000-000000000101|user:aaaaaaaa-0000-4000-8000-000000000102'),
  ('aaaaaaaa-0000-4000-8000-000000000203', 'aaaaaaaa-0000-4000-8000-000000000001', 'ai_chat', 'Upgrade checklist', NULL, NULL, 'private', 'aaaaaaaa-0000-4000-8000-000000000101', '2026-10-06 09:22:00+00', NULL),
  ('bbbbbbbb-0000-4000-8000-000000000201', 'bbbbbbbb-0000-4000-8000-000000000001', 'channel', 'general', 'general', NULL, 'public', 'bbbbbbbb-0000-4000-8000-000000000101', '2026-10-06 09:20:00+00', NULL);

INSERT INTO app.conversation_members (conversation_id, organization_id, member_kind, member_id, role, created_at, last_read_seq) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000201', 'aaaaaaaa-0000-4000-8000-000000000001', 'user', 'aaaaaaaa-0000-4000-8000-000000000101', 'owner', '2026-10-06 09:20:00+00', 3),
  ('aaaaaaaa-0000-4000-8000-000000000201', 'aaaaaaaa-0000-4000-8000-000000000001', 'user', 'aaaaaaaa-0000-4000-8000-000000000102', 'member', '2026-10-06 09:20:00+00', 2),
  ('aaaaaaaa-0000-4000-8000-000000000201', 'aaaaaaaa-0000-4000-8000-000000000001', 'agent', 'aaaaaaaa-0000-4000-8000-000000000321', 'member', '2026-10-06 09:20:00+00', 0),
  ('aaaaaaaa-0000-4000-8000-000000000202', 'aaaaaaaa-0000-4000-8000-000000000001', 'user', 'aaaaaaaa-0000-4000-8000-000000000101', 'member', '2026-10-06 09:21:00+00', 1),
  ('aaaaaaaa-0000-4000-8000-000000000202', 'aaaaaaaa-0000-4000-8000-000000000001', 'user', 'aaaaaaaa-0000-4000-8000-000000000102', 'member', '2026-10-06 09:21:00+00', 0),
  ('aaaaaaaa-0000-4000-8000-000000000203', 'aaaaaaaa-0000-4000-8000-000000000001', 'user', 'aaaaaaaa-0000-4000-8000-000000000101', 'owner', '2026-10-06 09:22:00+00', 2),
  ('bbbbbbbb-0000-4000-8000-000000000201', 'bbbbbbbb-0000-4000-8000-000000000001', 'user', 'bbbbbbbb-0000-4000-8000-000000000101', 'owner', '2026-10-06 09:20:00+00', 1);

INSERT INTO app.ai_chats (conversation_id, organization_id, owner_user_id, title_source, instructions, tools, last_model, last_activity_at, created_at, updated_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000203', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000101', 'user', 'Be concise.',
   '{"web": false}', '{"provider": "openai", "modelId": "gpt-upgrade-test"}', '2026-10-06 09:23:00+00', '2026-10-06 09:22:00+00', '2026-10-06 09:23:00+00');

-- Messages: channel root (with a thread reply) + an edited message, a DM, an AI chat turn, org B's channel message.
INSERT INTO app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, status, thread_id, reply_count, last_reply_at, client_kind, created_at, edited_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000501', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000201', 1, 'user', 'aaaaaaaa-0000-4000-8000-000000000101',
   'Welcome to the upgrade test channel', 'sent', NULL, 1, '2026-10-06 09:31:00+00', 'web', '2026-10-06 09:30:00+00', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000502', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000201', 2, 'user', 'aaaaaaaa-0000-4000-8000-000000000102',
   'Diagram attached (edited)', 'sent', NULL, 0, NULL, 'web', '2026-10-06 09:30:30+00', '2026-10-06 09:32:00+00'),
  ('aaaaaaaa-0000-4000-8000-000000000503', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000201', 3, 'user', 'aaaaaaaa-0000-4000-8000-000000000102',
   'Thread reply: thanks!', 'sent', 'aaaaaaaa-0000-4000-8000-000000000501', 0, NULL, 'web', '2026-10-06 09:31:00+00', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000504', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000202', 1, 'user', 'aaaaaaaa-0000-4000-8000-000000000101',
   'Private hello', 'sent', NULL, 0, NULL, 'web', '2026-10-06 09:33:00+00', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000505', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000203', 1, 'user', 'aaaaaaaa-0000-4000-8000-000000000101',
   'What changes in this upgrade?', 'sent', NULL, 0, NULL, 'web', '2026-10-06 09:34:00+00', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000506', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000203', 2, 'agent', NULL,
   'Three migrations and a grant.', 'completed', NULL, 0, NULL, NULL, '2026-10-06 09:34:05+00', NULL),
  ('bbbbbbbb-0000-4000-8000-000000000501', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000201', 1, 'user', 'bbbbbbbb-0000-4000-8000-000000000101',
   'Beta only: never visible to Acme', 'sent', NULL, 0, NULL, 'web', '2026-10-06 09:30:00+00', NULL);

INSERT INTO app.message_versions (id, organization_id, message_id, version, kind, body, edited_by_kind, edited_by, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000511', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000502', 1, 'edit',
   'Diagram attached', 'user', 'aaaaaaaa-0000-4000-8000-000000000102', '2026-10-06 09:32:00+00');

INSERT INTO app.ai_generations (id, organization_id, conversation_id, user_message_id, assistant_message_id, requester_user_id, backend, provider, model_id, status, finish_reason, partial_text, instance_id, heartbeat_at, started_at, finished_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000401', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000203', 'aaaaaaaa-0000-4000-8000-000000000505',
   'aaaaaaaa-0000-4000-8000-000000000506', 'aaaaaaaa-0000-4000-8000-000000000101', 'org_key', 'openai', 'gpt-upgrade-test', 'completed', 'stop',
   'Three migrations and a grant.', 'upgrade-baseline', '2026-10-06 09:34:05+00', '2026-10-06 09:34:01+00', '2026-10-06 09:34:05+00');

INSERT INTO app.ai_usage_records (id, organization_id, generation_id, kind, requester_user_id, conversation_id, message_id, backend, provider, model_id, input_tokens, output_tokens, estimated, cost_micros_usd, price_ref, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000411', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000401', 'chat', 'aaaaaaaa-0000-4000-8000-000000000101',
   'aaaaaaaa-0000-4000-8000-000000000203', 'aaaaaaaa-0000-4000-8000-000000000506', 'org_key', 'openai', 'gpt-upgrade-test', 12, 7, false, 42, 'test-price-ref', '2026-10-06 09:34:05+00');

INSERT INTO app.attachments (id, organization_id, conversation_id, message_id, uploader_id, filename, declared_type, content_type, size_bytes, sha256, status, width, height, created_at, completed_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000601', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000201', 'aaaaaaaa-0000-4000-8000-000000000502',
   'aaaaaaaa-0000-4000-8000-000000000102', 'diagram.png', 'image/png', 'image/png', 2048,
   '0000000000000000000000000000000000000000000000000000000000000000', 'ready', 64, 32, '2026-10-06 09:30:20+00', '2026-10-06 09:30:25+00');

INSERT INTO app.streams (id, organization_id, last_seq) VALUES
  ('conv:aaaaaaaa-0000-4000-8000-000000000201', 'aaaaaaaa-0000-4000-8000-000000000001', 3),
  ('conv:bbbbbbbb-0000-4000-8000-000000000201', 'bbbbbbbb-0000-4000-8000-000000000001', 1);

INSERT INTO app.stream_events (stream_id, seq, organization_id, type, payload, actor_user_id, created_at) VALUES
  ('conv:aaaaaaaa-0000-4000-8000-000000000201', 1, 'aaaaaaaa-0000-4000-8000-000000000001', 'message.created', '{"messageId": "aaaaaaaa-0000-4000-8000-000000000501"}', 'aaaaaaaa-0000-4000-8000-000000000101', '2026-10-06 09:30:00+00'),
  ('conv:aaaaaaaa-0000-4000-8000-000000000201', 2, 'aaaaaaaa-0000-4000-8000-000000000001', 'message.created', '{"messageId": "aaaaaaaa-0000-4000-8000-000000000502"}', 'aaaaaaaa-0000-4000-8000-000000000102', '2026-10-06 09:30:30+00'),
  ('conv:aaaaaaaa-0000-4000-8000-000000000201', 3, 'aaaaaaaa-0000-4000-8000-000000000001', 'message.created', '{"messageId": "aaaaaaaa-0000-4000-8000-000000000503"}', 'aaaaaaaa-0000-4000-8000-000000000102', '2026-10-06 09:31:00+00'),
  ('conv:bbbbbbbb-0000-4000-8000-000000000201', 1, 'bbbbbbbb-0000-4000-8000-000000000001', 'message.created', '{"messageId": "bbbbbbbb-0000-4000-8000-000000000501"}', 'bbbbbbbb-0000-4000-8000-000000000101', '2026-10-06 09:30:00+00');

INSERT INTO app.audit_events (id, organization_id, occurred_at, actor_kind, actor_id, user_id, resource_type, resource_id, action, result, metadata) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000611', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-10-06 09:10:00+00', 'user', 'aaaaaaaa-0000-4000-8000-000000000101', 'aaaaaaaa-0000-4000-8000-000000000101',
   'secret', 'aaaaaaaa-0000-4000-8000-000000000301', 'secret.created', 'success', '{"name": "openai-api-key", "kind": "provider_api_key", "provider": "openai"}'),
  ('aaaaaaaa-0000-4000-8000-000000000612', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-10-06 09:15:00+00', 'user', 'aaaaaaaa-0000-4000-8000-000000000101', 'aaaaaaaa-0000-4000-8000-000000000101',
   'agent', 'aaaaaaaa-0000-4000-8000-000000000321', 'agent.created', 'success', '{}'),
  ('bbbbbbbb-0000-4000-8000-000000000611', 'bbbbbbbb-0000-4000-8000-000000000001', '2026-10-06 09:20:00+00', 'user', 'bbbbbbbb-0000-4000-8000-000000000101', 'bbbbbbbb-0000-4000-8000-000000000101',
   'conversation', 'bbbbbbbb-0000-4000-8000-000000000201', 'channel.created', 'success', '{}');

COMMIT;
