-- Idempotent post-migration step, run as ocw_migrator after every `migrate`.
-- drizzle-kit never emits FORCE ROW LEVEL SECURITY, so tenant isolation is applied here generically:
-- every table in schema `app` with an `organization_id` column gets ENABLE + FORCE RLS and the
-- `tenant_isolation` policy. New tables are covered automatically (and by the enumerator test).

GRANT USAGE ON SCHEMA app TO ocw_app, ocw_auth;
GRANT USAGE ON SCHEMA auth TO ocw_auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM ocw_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO ocw_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO ocw_app;

-- Append-only logs.
REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_events FROM ocw_app;
REVOKE UPDATE, DELETE, TRUNCATE ON app.stream_events FROM ocw_app;
-- Message edit/delete history (CHAT-06): the app role may only add versions, never rewrite them.
REVOKE UPDATE, DELETE, TRUNCATE ON app.message_versions FROM ocw_app;
-- AI chat usage (Phase 5, D-06 / AICHAT-07): one immutable record per generation; never rewritten or erased.
REVOKE UPDATE, DELETE, TRUNCATE ON app.ai_usage_records FROM ocw_app;

-- Identity plane writes its audit rows and the org_members projection in the same transaction.
GRANT SELECT, INSERT ON app.audit_events TO ocw_auth;
GRANT SELECT, INSERT, UPDATE ON app.org_members TO ocw_auth;

-- Schema-version guard (SELF-03, plan 07-02): the API reads the applied migration names + hashes at boot and refuses
-- to start on a mismatch. Read-only, one table; ocw_migrator stays the only writer.
GRANT USAGE ON SCHEMA drizzle TO ocw_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO ocw_app;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p') AND n.nspname = 'app'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t.tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL '
      'USING (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid) '
      'WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      t.tbl);
  END LOOP;
END
$$;

DROP POLICY IF EXISTS auth_plane ON app.audit_events;
CREATE POLICY auth_plane ON app.audit_events AS PERMISSIVE FOR ALL TO ocw_auth USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS auth_plane ON app.org_members;
CREATE POLICY auth_plane ON app.org_members AS PERMISSIVE FOR ALL TO ocw_auth USING (true) WITH CHECK (true);

-- Scoped memory (Phase 07.2, MEM-01 / MEM-07 / D-08). Layered ON TOP of the tenant loop above, never instead of it.
--
-- History is append-only (ADR-0023): the app role may add revisions and proposals but never rewrite them. DELETE
-- stays granted: FK cascades (a deleted bot, scope or file) and a person's "forget" of their own personal memory.
REVOKE UPDATE, TRUNCATE ON app.memory_file_revisions FROM ocw_app;
REVOKE UPDATE, TRUNCATE ON app.memory_proposals FROM ocw_app;

-- Per-tool approvals and Work Zone proposals (Phase 07.5): the stored action behind a `tool.call` approval and a
-- proposal are immutable by trigger (UPDATE only), and triggers do not fire on TRUNCATE, which also ignores RLS. The app
-- role never truncates them; DELETE stays granted for the cascades of a bot, project or device (ADR-0026).
REVOKE TRUNCATE ON app.tool_call_approvals FROM ocw_app;
REVOKE TRUNCATE ON app.work_zone_proposals FROM ocw_app;

-- Bot Work Zone orchestration (Phase 07.16, D-16): TRUNCATE ignores RLS (and the session audience backstop below), so the
-- app role never truncates a bot's profile, its projects, the device consents or the bot side of a session. The generic
-- grant above never includes TRUNCATE; this states it explicitly, as for 07.5. DELETE stays granted for the cascades of
-- a bot, device, project, session or conversation, and for the API's own profile and consent changes.
REVOKE TRUNCATE ON app.bot_work_zone_profiles, app.bot_work_zone_profile_projects, app.device_bot_consents, app.bot_work_sessions FROM ocw_app;

-- Automation fan-out (Phase 07.17, D-03): TRUNCATE ignores RLS, and the opened rows are the dedupe history that keeps an
-- item from ever being opened twice, so the app role never truncates them (stated explicitly, as for 07.16). DELETE stays
-- granted for the cascades of an automation, a run or a conversation.
REVOKE TRUNCATE ON app.automation_conversations FROM ocw_app;

-- Long bot tasks (Phase 07.17.1.1.2, D-01): TRUNCATE ignores RLS, so the app role never truncates every organization's
-- tasks or the processes they wait for (stated explicitly, as for 07.16). DELETE stays granted for the cascades of a bot,
-- a conversation or a task.
REVOKE TRUNCATE ON app.bot_tasks, app.bot_task_processes FROM ocw_app;

-- ADR-0010 ("the human can see and clear the notes; admins cannot" / admins "can never read its chat, memory or
-- instructions"): every memory row of a personal scope, or of a personal bot's notebook, carries
-- `personal_owner_user_id`. These SECURITY DEFINER trigger functions (owner ocw_migrator, which bypasses RLS to read the
-- parent row; fixed search_path; no arguments; they only write NEW's owner column) derive it from the parent row on
-- every INSERT and on every UPDATE that could change it, ignoring whatever the application sent, so no code path can
-- store a personal row as shared. A parent outside the row's organization is refused (the plain FK alone would not).
CREATE OR REPLACE FUNCTION app.memory_scope_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- A scope's identity is fixed at creation: its rows' owner derives from it.
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.kind, NEW.agent_id, NEW.owner_user_id, NEW.unit_id)
      IS DISTINCT FROM (OLD.organization_id, OLD.kind, OLD.agent_id, OLD.owner_user_id, OLD.unit_id) THEN
    RAISE EXCEPTION 'memory scope identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.agents a WHERE a.id = NEW.agent_id AND a.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'memory scope agent not found in this organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.kind = 'personal' THEN
    NEW.personal_owner_user_id := NEW.owner_user_id;
  ELSIF NEW.kind = 'agent' THEN
    -- A personal bot's notebook is its owner's (personal bots never change owner or scope); a team bot's is shared.
    NEW.personal_owner_user_id := (
      SELECT a.owner_user_id FROM app.agents a
      WHERE a.id = NEW.agent_id AND a.organization_id = NEW.organization_id AND a.scope = 'personal'
    );
  ELSE
    NEW.personal_owner_user_id := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

-- Files and proposals take their scope's owner.
CREATE OR REPLACE FUNCTION app.memory_scoped_row_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  owner uuid;
BEGIN
  SELECT s.personal_owner_user_id INTO owner FROM app.memory_scopes s
  WHERE s.id = NEW.scope_id AND s.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory scope not found in this organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.personal_owner_user_id := owner;
  RETURN NEW;
END
$fn$;

-- Revisions take their file's owner, and must be filed under their file's scope (a personal file's history filed
-- under a shared scope would otherwise read as shared).
CREATE OR REPLACE FUNCTION app.memory_revision_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  file_scope uuid;
  owner uuid;
BEGIN
  SELECT f.scope_id, f.personal_owner_user_id INTO file_scope, owner FROM app.memory_files f
  WHERE f.id = NEW.file_id AND f.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory file not found in this organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.scope_id IS DISTINCT FROM file_scope THEN
    RAISE EXCEPTION 'memory revision scope mismatch' USING ERRCODE = 'check_violation';
  END IF;
  NEW.personal_owner_user_id := owner;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION app.memory_scope_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.memory_scoped_row_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.memory_revision_owner() FROM PUBLIC;

-- Column lists keep FK actions (ON DELETE SET NULL of `file_id` / `approval_request_id` during a cascade, when the
-- parent may already be gone) from re-running the lookups.
CREATE OR REPLACE TRIGGER memory_owner BEFORE INSERT OR UPDATE ON app.memory_scopes
  FOR EACH ROW EXECUTE FUNCTION app.memory_scope_owner();
CREATE OR REPLACE TRIGGER memory_owner BEFORE INSERT OR UPDATE OF organization_id, scope_id, personal_owner_user_id
  ON app.memory_files FOR EACH ROW EXECUTE FUNCTION app.memory_scoped_row_owner();
CREATE OR REPLACE TRIGGER memory_owner BEFORE INSERT OR UPDATE OF organization_id, scope_id, personal_owner_user_id
  ON app.memory_proposals FOR EACH ROW EXECUTE FUNCTION app.memory_scoped_row_owner();
CREATE OR REPLACE TRIGGER memory_owner
  BEFORE INSERT OR UPDATE OF organization_id, file_id, scope_id, personal_owner_user_id
  ON app.memory_file_revisions FOR EACH ROW EXECUTE FUNCTION app.memory_revision_owner();

-- ADR-0010, enforced by the database as defence in depth under the resolver: a personal row is visible to, and
-- writable by, only the session whose `app.user_id` (set transaction-locally by withTenant) is its owner. RESTRICTIVE,
-- so it ANDs with tenant_isolation: an admin of the same organization, a cell route without a user and any other
-- member read 0 rows and cannot insert one. FK cascades are not subject to it (memory-privacy.int.test.ts proves a
-- bot deletion still removes its memory).
DROP POLICY IF EXISTS personal_owner_only ON app.memory_scopes;
CREATE POLICY personal_owner_only ON app.memory_scopes AS RESTRICTIVE FOR ALL
  USING (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
DROP POLICY IF EXISTS personal_owner_only ON app.memory_files;
CREATE POLICY personal_owner_only ON app.memory_files AS RESTRICTIVE FOR ALL
  USING (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
DROP POLICY IF EXISTS personal_owner_only ON app.memory_file_revisions;
CREATE POLICY personal_owner_only ON app.memory_file_revisions AS RESTRICTIVE FOR ALL
  USING (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
DROP POLICY IF EXISTS personal_owner_only ON app.memory_proposals;
CREATE POLICY personal_owner_only ON app.memory_proposals AS RESTRICTIVE FOR ALL
  USING (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (personal_owner_user_id IS NULL
         OR personal_owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- Keychain (Phase 07.4, D-04, D-06): a personal key is its owner's alone, as personal memory is. Same RESTRICTIVE shape
-- (ANDed with tenant_isolation) on the row's own `owner_user_id` (scope 'personal' always has one, by CHECK): an admin
-- of the same organization, a cell route without a user and any other member read 0 personal keys and cannot write
-- one. Unit keys (scope 'unit') stay under tenant isolation only; the API decides `vault.manage` on them.
DROP POLICY IF EXISTS personal_owner_only ON app.vault_items;
CREATE POLICY personal_owner_only ON app.vault_items AS RESTRICTIVE FOR ALL
  USING (scope <> 'personal'
         OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (scope <> 'personal'
         OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- Grants of keys to bots (Phase 07.4, WINDOWS #182): a grant on a personal key says which bots its owner gave it to,
-- so it is the owner's alone, as the key is. RESTRICTIVE (ANDed with tenant_isolation): a grant is visible and
-- writable only while its key is visible to the session, i.e. through `vault_items`' own owner-only policy (another
-- member, an admin of the same organization and a session without a user see no grant on someone's personal key and
-- cannot write one); grants on unit keys stay under tenant isolation only. FK cascades (a deleted bot or key) are not
-- subject to it.
DROP POLICY IF EXISTS personal_owner_only ON app.agent_vault_grants;
CREATE POLICY personal_owner_only ON app.agent_vault_grants AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM app.vault_items v WHERE v.id = agent_vault_grants.vault_item_id))
  WITH CHECK (EXISTS (SELECT 1 FROM app.vault_items v WHERE v.id = agent_vault_grants.vault_item_id));

-- The cell's `alsoAllow` path over every grant (07.4-11, WINDOWS #182): `/agent-channel/v1/cell` runs without a user and
-- must still know which bots hold some key, so it can list `ocw_http_request` for them. SECURITY DEFINER as
-- ocw_migrator (BYPASSRLS), fixed search_path, scoped to the CALLER's organization; it returns agent ids only (never a
-- key, a handle, an owner or which key a bot holds).
CREATE OR REPLACE FUNCTION app.vault_grant_agents()
RETURNS TABLE (agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT DISTINCT g.agent_id FROM app.agent_vault_grants g
  WHERE g.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
$fn$;
REVOKE ALL ON FUNCTION app.vault_grant_agents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.vault_grant_agents() TO ocw_app;

-- Per-member connector connections (Phase 07.4, D-01; WINDOWS #170): a member's connection (the id of its sealed
-- credential, issuer, scopes, account label) is its owner's alone, as a personal key is. Same RESTRICTIVE shape, ANDed
-- with tenant_isolation, on the row's own `user_id`: an admin of the same organization, a session without a user and
-- any other member read 0 rows and cannot write one. FK cascades (a deleted connector) are not subject to it.
DROP POLICY IF EXISTS personal_owner_only ON app.connector_connections;
CREATE POLICY personal_owner_only ON app.connector_connections AS RESTRICTIVE FOR ALL
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- The `mcp.manage` path over every member's connection (WINDOWS #186): the admin's member count (UI-SPEC R4) and the
-- clearing on a mode switch or a delete (07.4-06) must still see and remove every member's row. SECURITY DEFINER as
-- ocw_migrator (BYPASSRLS), fixed search_path, scoped to the CALLER's organization (`app.organization_id` of the tenant
-- transaction, never an argument): the count returns numbers only, the clearing deletes and returns only the ids of the
-- sealed secrets the API then removes (they open only with each member's AAD). No function returns a credential, an
-- issuer, a scope or a user id. The API calls them only from the `mcp.manage` routes (`mcp/service.ts`).
CREATE OR REPLACE FUNCTION app.connector_connection_counts(p_server_id uuid DEFAULT NULL)
RETURNS TABLE (server_id uuid, connections integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT c.server_id, count(*)::int FROM app.connector_connections c
  WHERE c.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND (p_server_id IS NULL OR c.server_id = p_server_id)
  GROUP BY c.server_id
$fn$;
CREATE OR REPLACE FUNCTION app.clear_connector_connections(p_server_id uuid)
RETURNS TABLE (secret_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DELETE FROM app.connector_connections c
  WHERE c.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND c.server_id = p_server_id
  RETURNING c.secret_id
$fn$;
REVOKE ALL ON FUNCTION app.connector_connection_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.clear_connector_connections(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connector_connection_counts(uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.clear_connector_connections(uuid) TO ocw_app;

-- Sealed browser sessions (Phase 07.8, D-08, F-10, P-09): a member's sign-in to a site with a bot (the id of its sealed
-- `browser_session` secret, the site, the expiry) is its owner's alone, as a member connector connection is. Same
-- RESTRICTIVE shape, ANDed with tenant_isolation, on the row's own `user_id`: an admin of the same organization, a
-- session without a user (cell routes) and any other member read 0 rows and cannot insert, update or delete one. The
-- API answers 404 to anyone else. FK cascades (a deleted bot or secret) are not subject to it.
DROP POLICY IF EXISTS personal_owner_only ON app.browser_sessions;
CREATE POLICY personal_owner_only ON app.browser_sessions AS RESTRICTIVE FOR ALL
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- The browser sweep (07.8-21; D-08, R7, R9): sign-in cards that waited 15 minutes expire, and sessions expired for 7
-- days are removed; since 07.8-28 (WINDOWS #271) takeover leases left by a dead API instance are cleared. The sweep runs without a user, across organizations:
-- - `browser_sweep_organizations` lists the organizations that have such work (ids only, keyset-paged by id); the API
--   then works inside each organization's own withTenant() transaction;
-- - `purge_browser_sessions` deletes, in the CALLER's organization only (`app.organization_id` of the tenant
--   transaction, never an argument), the sessions that expired before `p_before`, past the owner-only policy no
--   user-less session could cross. Their sealed secrets go with them (`browser_session_secret_cleanup`). It returns the
--   ids, the owner, the bot and the site for the audit only: never a secret id or any sealed value.
CREATE OR REPLACE FUNCTION app.browser_sweep_organizations(
  p_now timestamptz, p_before timestamptz, p_after uuid, p_limit integer)
RETURNS TABLE (organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT o.organization_id FROM (
    SELECT r.organization_id FROM app.browser_signin_requests r
    WHERE r.status IN ('waiting', 'signing_in') AND r.expires_at <= p_now
    UNION
    SELECT b.organization_id FROM app.browser_sessions b WHERE b.expires_at < p_before
    UNION
    -- 07.8-28 (WINDOWS #271, #244): a takeover lease whose holding API instance died (nobody released it).
    SELECT c.organization_id FROM app.browser_contexts c
    WHERE c.controller_user_id IS NOT NULL AND c.closed_at IS NULL AND c.lease_expires_at <= p_now
  ) o
  WHERE p_after IS NULL OR o.organization_id > p_after
  ORDER BY o.organization_id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
CREATE OR REPLACE FUNCTION app.purge_browser_sessions(p_before timestamptz)
RETURNS TABLE (id uuid, user_id uuid, agent_id uuid, site_key text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DELETE FROM app.browser_sessions b
  WHERE b.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND b.expires_at < p_before
  RETURNING b.id, b.user_id, b.agent_id, b.site_key
$fn$;
-- 07.8-28 (WINDOWS #287): a bot's deletion is a soft delete (`agents.deleted_at`), so the FK cascade that takes its
-- sessions on a hard delete never fires. `purge_deleted_bot_browser_sessions` deletes, in the CALLER's organization
-- only, every member's sealed session with that bot, past the owner-only policy (the person deleting the bot, an admin
-- or its owner, reads none of the other members' rows), and only once the bot is deleted: a live bot's sessions are
-- never touched. Their secrets go with them (`browser_session_secret_cleanup`). Returns ids, owner, bot and site for the
-- audit only.
CREATE OR REPLACE FUNCTION app.purge_deleted_bot_browser_sessions(p_agent uuid)
RETURNS TABLE (id uuid, user_id uuid, agent_id uuid, site_key text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DELETE FROM app.browser_sessions b
  WHERE b.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND b.agent_id = p_agent
    AND EXISTS (SELECT 1 FROM app.agents a
                 WHERE a.organization_id = b.organization_id AND a.id = p_agent AND a.deleted_at IS NOT NULL)
  RETURNING b.id, b.user_id, b.agent_id, b.site_key
$fn$;
REVOKE ALL ON FUNCTION app.purge_deleted_bot_browser_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_deleted_bot_browser_sessions(uuid) TO ocw_app;
REVOKE ALL ON FUNCTION app.browser_sweep_organizations(timestamptz, timestamptz, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_browser_sessions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.browser_sweep_organizations(timestamptz, timestamptz, uuid, integer) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.purge_browser_sessions(timestamptz) TO ocw_app;

-- Pre-tenant lookups (bearer tokens / pairing codes arrive before the organization is known).
-- SECURITY DEFINER as ocw_migrator (BYPASSRLS); each returns only the ids needed to open withTenant().
CREATE OR REPLACE FUNCTION app.lookup_device_token(p_token_hash text)
RETURNS TABLE (device_id uuid, organization_id uuid, owner_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT d.id, d.organization_id, d.owner_user_id FROM app.devices d
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL
$fn$;

CREATE OR REPLACE FUNCTION app.lookup_agent_credential(p_token_hash text)
RETURNS TABLE (credential_id uuid, organization_id uuid, agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT c.id, c.organization_id, c.agent_id FROM app.agent_credentials c
  WHERE c.token_hash = p_token_hash AND c.revoked_at IS NULL
$fn$;

CREATE OR REPLACE FUNCTION app.lookup_device_enrollment(p_code_hash text)
RETURNS TABLE (organization_id uuid, user_id uuid, expires_at timestamptz, consumed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT e.organization_id, e.user_id, e.expires_at, e.consumed_at FROM app.device_enrollments e
  WHERE e.code_hash = p_code_hash
$fn$;

REVOKE ALL ON FUNCTION app.lookup_device_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lookup_agent_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lookup_device_enrollment(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lookup_device_token(text) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.lookup_agent_credential(text) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.lookup_device_enrollment(text) TO ocw_app;

-- Attachment sweeper (Plan 04-04): ids of attachments whose objects are due for deletion across organizations
-- (pending/rejected for 24 h, deleted for 30 days). Ids only, like the lookups above; the sweeper re-checks each
-- row inside its own organization's withTenant() transaction. p_now lets tests inject the clock.
CREATE OR REPLACE FUNCTION app.due_attachment_sweeps(p_limit integer, p_now timestamptz DEFAULT now())
RETURNS TABLE (id uuid, organization_id uuid, conversation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT a.id, a.organization_id, a.conversation_id FROM app.attachments a
  WHERE a.purged_at IS NULL
    AND (
      (a.status IN ('pending', 'rejected') AND a.created_at < p_now - interval '24 hours')
      OR (a.status = 'deleted' AND coalesce(a.deleted_at, a.created_at) < p_now - interval '30 days')
    )
  ORDER BY a.created_at
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.due_attachment_sweeps(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_attachment_sweeps(integer, timestamptz) TO ocw_app;

-- AI generation sweeper (Plan 05-06, D-05): running generations whose heartbeat is older than p_before (their API
-- process died or stalled). Ids only; the sweeper re-checks and finalizes each row as `interrupted` inside its own
-- organization's withTenant() transaction.
CREATE OR REPLACE FUNCTION app.stale_ai_generations(p_limit integer, p_before timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT g.id, g.organization_id FROM app.ai_generations g
  WHERE g.status = 'running' AND g.heartbeat_at < p_before
  ORDER BY g.heartbeat_at
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.stale_ai_generations(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stale_ai_generations(integer, timestamptz) TO ocw_app;

-- AI chat queue pickup (Plan 06-06, P-08): conversations with an addressed, unanswered, unskipped message and no
-- running generation (a crash between a finalize and the next start, or a requester at the concurrency cap). Ids
-- only; the sweeper starts each queue inside that organization's withTenant() transaction, under the stream lock.
CREATE OR REPLACE FUNCTION app.pending_ai_queues(p_limit integer)
RETURNS TABLE (organization_id uuid, conversation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT c.organization_id, c.conversation_id
  FROM app.ai_message_context c
  JOIN app.messages m ON m.id = c.message_id AND m.deleted_at IS NULL
  JOIN app.conversations conv ON conv.id = c.conversation_id AND conv.archived_at IS NULL
  WHERE c.author_kind = 'user' AND c.addressed AND c.answered_by_generation_id IS NULL AND c.skip_reason IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.ai_generations g WHERE g.conversation_id = c.conversation_id AND g.status = 'running'
    )
  GROUP BY c.organization_id, c.conversation_id
  ORDER BY min(c.created_at)
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.pending_ai_queues(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_ai_queues(integer) TO ocw_app;

-- Sandbox policy re-push (07.8 policy fix; D-09, the kill switch): sandboxd keeps every organization's policy in memory
-- only and refuses to start anything without one, so after it restarts the API's events consumer pushes the policy of
-- every organization that has a sandbox row. Organization ids only, keyset-paged by id; the consumer then reads each
-- policy inside that organization's own withTenant() transaction.
CREATE OR REPLACE FUNCTION app.sandbox_organizations(p_after uuid, p_limit integer)
RETURNS TABLE (organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT DISTINCT b.organization_id FROM app.bot_sandboxes b
  WHERE p_after IS NULL OR b.organization_id > p_after
  ORDER BY b.organization_id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.sandbox_organizations(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sandbox_organizations(uuid, integer) TO ocw_app;

-- Shared Work Zone projects and session audiences (Phase 07.9; C-01, D-02, D-04, D-09, D-11, D-12; P-03, ADR-0030).
-- THIS IS THE ONLY COPY OF THE AUDIENCE RULE. The resolver's facts (work-session/facts.ts), the readable lists and
-- counts, the live fan-out and the RLS backstop (plan 12, RESTRICTIVE `audience_backstop`) all call these functions;
-- nothing re-implements them in TypeScript or in another policy. They are SECURITY DEFINER as ocw_migrator (BYPASSRLS),
-- so a policy that calls them never recurses through the grant tables' own policies, and therefore each one scopes every
-- read to the CALLER's organization itself (`app.organization_id` of the tenant transaction, never an argument): an id
-- of another organization finds nothing. Fixed search_path, every table schema-qualified; none returns a title, a path
-- or a person's name (team names only, units being visible to the whole organization).
--
-- - Project access (D-02), `work_project_access(unit, user)`: `lead` / `member` = a direct membership of the project
--   unit; `team` = an assigned team (or department) on the path of one of the user's memberships of a team or
--   department, so a department assignment covers its teams, and never through a membership of a project nested under
--   the assigned team (D-14: projects are leaves, `ALLOWED_PARENT_KINDS`, so excluding project memberships excludes
--   every project descendant; the same holds for a `teams` audience); `admin` = an active admin (a fact for the backstop only: the resolver's admin rule is
--   its own explicit, audited precondition, P-03). People who are not active members of the organization have none.
-- - Personal projects (a repo no team project links): access is the use of the device, owner ∪ `shared` ∪ an active
--   user grant ∪ an active unit grant on a membership path. This is the SQL twin of `deviceModeCap(...) !== null`
--   (apps/api/src/modules/device/access.ts: revoked rows never match, `shared` applies to everyone); plan 05 proves
--   the parity on generated fixtures. Any change here changes there, in the same commit.
-- - Session facts (D-04, D-11, D-12), `work_session_access(session, user)`: `viewer` when the person has project access
--   (admins excluded) and the audience includes them: `project`; `teams` = an active unit grant whose team is still
--   assigned and on one of their membership paths; `people` = an active user grant; `owner` adds nobody. Entries outside
--   project access (a person who left, a team no longer assigned, a deleted unit) grant nothing, although their rows
--   stay. `creator` (personal project, or team project with access) / `creator_left` (team project without access);
--   `device_owner` always; `admin`; `project_lead` = a lead membership of the project unit. '{}' = no relation.
-- - Who can see a session, `work_session_viewers(session)`: every active member whose facts include `creator`,
--   `creator_left`, `device_owner` or `viewer`, computed by calling `work_session_access` itself, with one reason each
--   (`owner`, `owner_left`, `device_owner`, `lead`, `member`, `team` + the team it comes through, `device`). Admins are
--   never enumerated for being admins; `project_lead` alone does not let anyone see an `owner` session.
CREATE OR REPLACE FUNCTION app.work_project_access(p_unit uuid, p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH org AS (SELECT nullif(current_setting('app.organization_id', true), '')::uuid AS id),
  me AS (
    SELECT om.role FROM org
    JOIN app.org_members om ON om.organization_id = org.id AND om.user_id = p_user AND om.deactivated_at IS NULL
  ),
  proj AS (
    SELECT u.id FROM org
    JOIN app.org_units u ON u.organization_id = org.id AND u.id = p_unit AND u.kind = 'project'
  ),
  direct AS (
    SELECT um.role FROM proj
    JOIN app.unit_memberships um
      ON um.organization_id = (SELECT id FROM org) AND um.unit_id = proj.id AND um.user_id = p_user
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM me) OR NOT EXISTS (SELECT 1 FROM proj) THEN NULL
    WHEN EXISTS (SELECT 1 FROM direct WHERE role = 'lead') THEN 'lead'
    WHEN EXISTS (SELECT 1 FROM direct) THEN 'member'
    WHEN EXISTS (
      SELECT 1 FROM app.work_project_teams t
      JOIN app.unit_memberships um ON um.organization_id = t.organization_id AND um.user_id = p_user
      JOIN app.org_units ou ON ou.organization_id = um.organization_id AND ou.id = um.unit_id AND ou.kind <> 'project'
      WHERE t.organization_id = (SELECT id FROM org) AND t.project_unit_id = p_unit AND t.team_unit_id = ANY (ou.path)
    ) THEN 'team'
    WHEN (SELECT role FROM me) = 'admin' THEN 'admin'
  END
$fn$;

CREATE OR REPLACE FUNCTION app.work_session_access(p_session uuid, p_user uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH org AS (SELECT nullif(current_setting('app.organization_id', true), '')::uuid AS id),
  s AS (
    SELECT ws.id, ws.visibility, ws.created_by, ws.device_id, r.unit_id, d.owner_user_id, d.shared
    FROM org
    JOIN app.work_sessions ws ON ws.organization_id = org.id AND ws.id = p_session
    JOIN app.devices d ON d.organization_id = ws.organization_id AND d.id = ws.device_id
    LEFT JOIN app.work_project_repos r ON r.organization_id = ws.organization_id AND r.project_id = ws.project_id
  ),
  me AS (
    SELECT om.role FROM org
    JOIN app.org_members om ON om.organization_id = org.id AND om.user_id = p_user AND om.deactivated_at IS NULL
  ),
  paths AS (
    SELECT ou.path, ou.kind FROM org
    JOIN app.unit_memberships um ON um.organization_id = org.id AND um.user_id = p_user
    JOIN app.org_units ou ON ou.organization_id = um.organization_id AND ou.id = um.unit_id
  ),
  acc AS (
    SELECT CASE
      -- Team project: lead, member or team (an admin's access is the resolver's explicit rule, not a viewer).
      WHEN s.unit_id IS NOT NULL THEN nullif(app.work_project_access(s.unit_id, p_user), 'admin')
      -- Personal project: the use of the device (deviceModeCap(...) !== null).
      WHEN s.owner_user_id = p_user OR s.shared OR EXISTS (
        SELECT 1 FROM app.device_grants g
        WHERE g.organization_id = (SELECT id FROM org) AND g.device_id = s.device_id AND g.revoked_at IS NULL
          AND ((g.principal_kind = 'user' AND g.principal_id = p_user)
               OR (g.principal_kind = 'unit' AND EXISTS (SELECT 1 FROM paths p WHERE g.principal_id = ANY (p.path))))
      ) THEN 'device'
    END AS level
    FROM s
  )
  SELECT coalesce((
    SELECT array_remove(ARRAY[
      CASE WHEN s.created_by = p_user AND (s.unit_id IS NULL OR acc.level IS NOT NULL) THEN 'creator' END,
      CASE WHEN s.created_by = p_user AND s.unit_id IS NOT NULL AND acc.level IS NULL THEN 'creator_left' END,
      CASE WHEN s.owner_user_id = p_user THEN 'device_owner' END,
      CASE WHEN me.role = 'admin' THEN 'admin' END,
      CASE WHEN acc.level IS NOT NULL AND (
        s.visibility = 'project'
        OR (s.visibility = 'teams' AND EXISTS (
          SELECT 1 FROM app.work_session_grants g
          JOIN app.work_project_teams t
            ON t.organization_id = g.organization_id AND t.project_unit_id = s.unit_id AND t.team_unit_id = g.subject_id
          WHERE g.organization_id = (SELECT id FROM org) AND g.work_session_id = s.id AND g.subject_kind = 'unit'
            AND g.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM paths p WHERE p.kind <> 'project' AND g.subject_id = ANY (p.path))
        ))
        OR (s.visibility = 'people' AND EXISTS (
          SELECT 1 FROM app.work_session_grants g
          WHERE g.organization_id = (SELECT id FROM org) AND g.work_session_id = s.id AND g.subject_kind = 'user'
            AND g.subject_id = p_user AND g.revoked_at IS NULL
        ))
      ) THEN 'viewer' END,
      CASE WHEN s.unit_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM app.unit_memberships um
        WHERE um.organization_id = (SELECT id FROM org) AND um.unit_id = s.unit_id AND um.user_id = p_user
          AND um.role = 'lead'
      ) THEN 'project_lead' END
    ], NULL::text)
    FROM s CROSS JOIN me CROSS JOIN acc
  ), '{}'::text[])
$fn$;

-- The team through which a person reaches a team project (for `team` reasons): an assigned team on one of their
-- membership paths, preferring (for a `teams` audience) one the session selects. Same joins as the `team` branch above.
CREATE OR REPLACE FUNCTION app.work_project_team_via(p_unit uuid, p_user uuid, p_session uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT t.team_unit_id FROM app.work_project_teams t
  JOIN app.unit_memberships um ON um.organization_id = t.organization_id AND um.user_id = p_user
  JOIN app.org_units ou ON ou.organization_id = um.organization_id AND ou.id = um.unit_id AND ou.kind <> 'project'
  WHERE t.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND t.project_unit_id = p_unit AND t.team_unit_id = ANY (ou.path)
  ORDER BY (p_session IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.work_session_grants g
    WHERE g.organization_id = t.organization_id AND g.work_session_id = p_session AND g.subject_kind = 'unit'
      AND g.subject_id = t.team_unit_id AND g.revoked_at IS NULL
  )) DESC, t.team_unit_id
  LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION app.work_project_people(p_unit uuid)
RETURNS TABLE (user_id uuid, reason text, via uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT a.user_id, a.level,
         CASE WHEN a.level = 'team' THEN app.work_project_team_via(p_unit, a.user_id) END
  FROM (
    SELECT om.user_id, app.work_project_access(p_unit, om.user_id) AS level
    FROM app.org_members om
    WHERE om.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
      AND om.deactivated_at IS NULL
  ) a
  WHERE a.level IN ('lead', 'member', 'team')
$fn$;

CREATE OR REPLACE FUNCTION app.work_session_viewers(p_session uuid)
RETURNS TABLE (user_id uuid, reason text, via uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH org AS (SELECT nullif(current_setting('app.organization_id', true), '')::uuid AS id),
  s AS (
    SELECT ws.id, ws.visibility, r.unit_id
    FROM org
    JOIN app.work_sessions ws ON ws.organization_id = org.id AND ws.id = p_session
    LEFT JOIN app.work_project_repos r ON r.organization_id = ws.organization_id AND r.project_id = ws.project_id
  ),
  f AS (
    SELECT om.user_id, app.work_session_access(s.id, om.user_id) AS facts, s.unit_id, s.visibility
    FROM s
    JOIN app.org_members om ON om.organization_id = (SELECT id FROM org) AND om.deactivated_at IS NULL
  ),
  r AS (
    SELECT f.user_id, f.unit_id, f.visibility, CASE
      WHEN 'creator' = ANY (f.facts) THEN 'owner'
      WHEN 'creator_left' = ANY (f.facts) THEN 'owner_left'
      WHEN 'device_owner' = ANY (f.facts) THEN 'device_owner'
      WHEN f.unit_id IS NULL THEN 'device'
      ELSE app.work_project_access(f.unit_id, f.user_id)
    END AS reason
    FROM f
    WHERE f.facts && ARRAY['creator', 'creator_left', 'device_owner', 'viewer']::text[]
  )
  SELECT r.user_id, r.reason,
         CASE WHEN r.reason = 'team' THEN
           app.work_project_team_via(r.unit_id, r.user_id, CASE WHEN r.visibility = 'teams' THEN p_session END)
         END
  FROM r
$fn$;

-- The list DTO's summary (UI-SPEC R1, § 1.5): the audience kind, how many of its selected entries still count (teams
-- still assigned; people other than the creator who still see it through the rule above), whether it differs from the
-- project's default (absent settings = `project`; a personal project compares with `project`), the first active team's
-- name, and the team project. Never a person's name.
CREATE OR REPLACE FUNCTION app.work_session_visibility_summary(p_session uuid)
RETURNS TABLE (kind text, active_count integer, differs_from_default boolean, first_team_name text,
               team_project_id uuid, team_project_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH org AS (SELECT nullif(current_setting('app.organization_id', true), '')::uuid AS id),
  s AS (
    SELECT ws.id, ws.visibility, ws.created_by, r.unit_id, pu.name AS unit_name,
           coalesce(ps.default_visibility, 'project') AS default_visibility
    FROM org
    JOIN app.work_sessions ws ON ws.organization_id = org.id AND ws.id = p_session
    LEFT JOIN app.work_project_repos r ON r.organization_id = ws.organization_id AND r.project_id = ws.project_id
    LEFT JOIN app.org_units pu ON pu.organization_id = r.organization_id AND pu.id = r.unit_id
    LEFT JOIN app.work_project_settings ps ON ps.organization_id = r.organization_id AND ps.unit_id = r.unit_id
  ),
  teams AS (
    SELECT tu.id, tu.name FROM s
    JOIN app.work_session_grants g
      ON g.organization_id = (SELECT id FROM org) AND g.work_session_id = s.id AND g.subject_kind = 'unit'
         AND g.revoked_at IS NULL
    JOIN app.work_project_teams t
      ON t.organization_id = g.organization_id AND t.project_unit_id = s.unit_id AND t.team_unit_id = g.subject_id
    JOIN app.org_units tu ON tu.organization_id = t.organization_id AND tu.id = t.team_unit_id
  ),
  people AS (
    SELECT g.subject_id FROM s
    JOIN app.work_session_grants g
      ON g.organization_id = (SELECT id FROM org) AND g.work_session_id = s.id AND g.subject_kind = 'user'
         AND g.revoked_at IS NULL AND g.subject_id <> s.created_by
    WHERE 'viewer' = ANY (app.work_session_access(s.id, g.subject_id))
  )
  SELECT s.visibility,
         CASE s.visibility
           WHEN 'teams' THEN (SELECT count(*)::int FROM teams)
           WHEN 'people' THEN (SELECT count(*)::int FROM people)
           ELSE 0
         END,
         s.visibility <> CASE WHEN s.unit_id IS NULL THEN 'project' ELSE s.default_visibility END,
         CASE WHEN s.visibility = 'teams' THEN (SELECT name FROM teams ORDER BY lower(name), id LIMIT 1) END,
         s.unit_id, s.unit_name
  FROM s
$fn$;

-- Unlink impact (D-09, UI-SPEC "Unlink" dialog): how many non-archived sessions a repo has, whatever the caller can see
-- (a number only; the backstop would otherwise hide the sessions outside the caller's audience).
CREATE OR REPLACE FUNCTION app.work_project_repo_session_count(p_project uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT count(*)::int FROM app.work_sessions ws
  WHERE ws.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND ws.project_id = p_project AND ws.status <> 'archived'
$fn$;

-- The resolver's session shape (07.9-12): the device's owner and revocation and the team project's unit path, whatever
-- the caller can see. `sessionFactsForUsers` decides OTHER people on a session (who still reads it after an audience
-- change, the live fan-out), so these facts must not depend on the caller's own audience under the backstop. Ids and
-- one flag only (never a title, a path or a name).
CREATE OR REPLACE FUNCTION app.work_session_shape(p_session uuid)
RETURNS TABLE (owner uuid, revoked boolean, unit_path uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT d.owner_user_id, d.revoked_at IS NOT NULL, ou.path
  FROM app.work_sessions ws
  JOIN app.devices d ON d.organization_id = ws.organization_id AND d.id = ws.device_id
  LEFT JOIN app.work_project_repos r ON r.organization_id = ws.organization_id AND r.project_id = ws.project_id
  LEFT JOIN app.org_units ou ON ou.organization_id = r.organization_id AND ou.id = r.unit_id
  WHERE ws.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND ws.id = p_session
$fn$;

-- Whether a session exists in the CALLER's organization, whatever the caller can see (07.9-12): the live `ws:`
-- re-decision tells someone the audience just removed why they lost the view (`cause` = visibility), although the
-- backstop now hides the row from them. A boolean only (never a title or a person); a subscription that never was
-- allowed gets no cause, so an id is never confirmed to someone who had not seen it.
CREATE OR REPLACE FUNCTION app.work_session_exists(p_session uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app.work_sessions ws
    WHERE ws.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND ws.id = p_session
  )
$fn$;

-- A bot's start caps (Phase 07.16, D-15, PD-10), whatever the sponsor can see: the start runs in the sponsor's
-- transaction, where the backstop hides other people's sessions, but the caps count every one of the caller's
-- organization. Counts and one flag only (never a title, a person or a prompt): this bot's active sessions, the
-- organization's active bot sessions, this bot's prompts of the last hour, and whether an active session works on the
-- project's own tree (`worktree = false`). `p_states` are the API's active states (`ACTIVE_STATES`, one copy).
-- It bypasses RLS and backs every cap, so it fails closed (07.16 code review WR-10): without a tenant setting it
-- raises instead of counting zero and letting every cap pass.
-- Phase 07.17.1.1 (D-06, PD-12): each file transfer the API enqueued for the bot (a `bot_work_session_files` row) is one
-- unit of the same hourly prompt budget, whatever its outcome, so `bot_prompts_hour` counts the bot's prompts and its
-- ledger rows of the last hour (a failed move is never a free retry).
CREATE OR REPLACE FUNCTION app.bot_work_session_load(p_agent uuid, p_project uuid, p_states text[])
RETURNS TABLE (bot_active integer, org_active integer, bot_prompts_hour integer, tree_busy boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::int FROM app.work_sessions ws
      WHERE ws.organization_id = v_org AND ws.started_by_agent_id = p_agent AND ws.status = ANY (p_states)),
    (SELECT count(*)::int FROM app.work_sessions ws
      WHERE ws.organization_id = v_org AND ws.started_by_agent_id IS NOT NULL AND ws.status = ANY (p_states)),
    (SELECT count(*)::int FROM app.work_prompts wp
      WHERE wp.organization_id = v_org AND wp.author_agent_id = p_agent AND wp.created_at > now() - interval '1 hour')
    + (SELECT count(*)::int FROM app.bot_work_session_files f
      WHERE f.organization_id = v_org AND f.agent_id = p_agent AND f.created_at > now() - interval '1 hour'),
    EXISTS (SELECT 1 FROM app.work_sessions ws
      WHERE ws.organization_id = v_org AND ws.project_id = p_project AND NOT ws.worktree
        AND ws.status = ANY (p_states));
END
$fn$;

REVOKE ALL ON FUNCTION app.work_project_access(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_session_access(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_project_team_via(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_project_people(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_session_viewers(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_session_visibility_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_project_repo_session_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_session_exists(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.work_session_shape(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.bot_work_session_load(uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_project_access(uuid, uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.work_session_access(uuid, uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.work_project_people(uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.work_session_viewers(uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.work_session_visibility_summary(uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.work_project_repo_session_count(uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.work_session_exists(uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.work_session_shape(uuid) TO ocw_app;
GRANT EXECUTE ON FUNCTION app.bot_work_session_load(uuid, uuid, text[]) TO ocw_app;

-- The audience backstop (Phase 07.9, D-09, D-13, P-10; ADR-0030): the database's second line of defence under the
-- resolver, so a route that forgets the resolver still cannot read or change a session outside the user's relations.
-- RESTRICTIVE, so it ANDs with tenant_isolation (which stays as it is) and never widens anything.
-- - The rule's only copy is `app.work_session_access` above (C-01, P-03). A user request sees a session when the rule
--   gives it a seeing relation: `creator`, `creator_left` (D-12), `device_owner` (D-11), `viewer`, or `admin` (the
--   admin rule is the resolver's explicit, audited precondition; the database only lets the rows through). A
--   `project_lead` fact alone sees nothing, as in `work_session_viewers` (the resolver denies it every grain).
-- - Both clauses also pass the creator's own row by `created_by` first: the rule always gives an active creator
--   `creator` or `creator_left`, but it cannot find a row that does not exist yet, and PostgreSQL judges a new row of
--   `INSERT … RETURNING` by USING as well (a deactivated member's requests never reach the database). It is also the
--   cheap test that spares the function call on the creator's own rows. On UPDATE the rule reads the row as it was before the statement, so a lead may narrow a session in one
--   statement that leaves them outside it; USING then hides it from every later read.
-- - The prompts, approvals and audience grants of a session are visible and writable while the session itself is
--   (the `agent_vault_grants` EXISTS precedent). The function is SECURITY DEFINER (BYPASSRLS), so the policies never
--   recurse through each other (Pitfall 1).
-- - LIMIT (D-13): it judges user requests only. A transaction without a user (`app.user_id` = '', set by withTenant
--   for Device Link, the re-authorization sweeps and cell routes) passes explicitly, because those paths write
--   sessions; they stay under tenant isolation only. The follow-up is an explicit system actor (ADR-0030).
-- - Not covered: `device_commands` (read and acked only by user-less device paths; user paths only enqueue) and
--   `stream_events` (generic for every topic, hot append path; `ws:` topics are gated by the topic authorizer).
-- - FK cascades are not subject to RLS (a deleted device or project still removes its sessions).
DROP POLICY IF EXISTS audience_backstop ON app.work_sessions;
CREATE POLICY audience_backstop ON app.work_sessions AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.user_id', true), '') IS NULL
         OR created_by = nullif(current_setting('app.user_id', true), '')::uuid
         OR app.work_session_access(id, nullif(current_setting('app.user_id', true), '')::uuid)
            && ARRAY['creator', 'creator_left', 'device_owner', 'viewer', 'admin']::text[])
  WITH CHECK (nullif(current_setting('app.user_id', true), '') IS NULL
         OR created_by = nullif(current_setting('app.user_id', true), '')::uuid
         OR app.work_session_access(id, nullif(current_setting('app.user_id', true), '')::uuid)
            && ARRAY['creator', 'creator_left', 'device_owner', 'viewer', 'admin']::text[]);
DROP POLICY IF EXISTS audience_backstop ON app.work_prompts;
CREATE POLICY audience_backstop ON app.work_prompts AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_prompts.work_session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_prompts.work_session_id));
DROP POLICY IF EXISTS audience_backstop ON app.work_approvals;
CREATE POLICY audience_backstop ON app.work_approvals AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_approvals.work_session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_approvals.work_session_id));
DROP POLICY IF EXISTS audience_backstop ON app.work_session_grants;
CREATE POLICY audience_backstop ON app.work_session_grants AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_session_grants.work_session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_session_grants.work_session_id));
-- Phase 07.6 (D-11): a session's memory summary state follows its session, as its prompts and approvals do.
DROP POLICY IF EXISTS audience_backstop ON app.work_session_memory;
CREATE POLICY audience_backstop ON app.work_session_memory AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_session_memory.work_session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = work_session_memory.work_session_id));
-- Phase 07.16 (D-05, D-16): the bot side of a bot-started session (origin, card, wake state) follows its session's
-- audience, as its prompts do: a user request sees and writes it only while it sees the session; a user-less system
-- transaction (the wake job, Device Link, the cell routes) passes through the session policy's own rule.
DROP POLICY IF EXISTS audience_backstop ON app.bot_work_sessions;
CREATE POLICY audience_backstop ON app.bot_work_sessions AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = bot_work_sessions.work_session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM app.work_sessions s WHERE s.id = bot_work_sessions.work_session_id));

-- Automations and watched records (Phase 07.6; D-02, D-04, D-07, P-10, Pitfalls 3 and 6; ADR-0028).
--
-- Watched-record history is append-only (D-04): the app role may add a change, never rewrite or erase one. FK cascades
-- are not subject to the grant, so a deleted watched record (or its card, board, bot or connector) still takes its
-- history with it (automations-schema.int.test.ts proves it as ocw_app).
REVOKE UPDATE, DELETE ON app.watched_record_changes FROM ocw_app;
REVOKE TRUNCATE ON app.watched_record_changes FROM ocw_app;

-- The pre-tenant reads of the job ticks and the public webhook route (D-07). Same shape as `stale_ai_generations`:
-- SECURITY DEFINER as ocw_migrator (BYPASSRLS), fixed search_path, schema-qualified tables, limit clamped to 1..1000,
-- across organizations by design. Each returns ids only (the webhook lookup adds one boolean); the caller re-reads
-- every row by id inside that organization's own withTenant() transaction, where RLS applies again. Never a name, a
-- schedule, an instruction, a sender or any inbound content.
-- - `due_automations`: active scheduled automations whose `next_run_at` has come (the `automation.tick` cron).
-- - `stale_automation_runs`: runs handed to the cell (`delivered`) and unanswered since before `p_before` (`no_reply`).
-- - `due_mailboxes`: mailboxes to poll now, of active automations: `active` and `unreachable` ones when due,
--   `auth_failed` ones after their back-off (`next_poll_at`, 30 minutes) or as soon as their Keychain item changed after
--   the failure (07.6-11: a new password resumes the mailbox); `paused` ones wait for their owner.
-- - `due_watched_records`: watched records whose next scheduled check has come.
-- - `lookup_webhook_endpoint`: the endpoint and organization behind a public id. `active` is false for a tombstoned
--   (`deleted_at`) or unlinked endpoint, so the route answers 410 instead of 404 (Pitfall 4); an unknown id has no row.
-- - `expired_automation_events`: inbound items whose content is due for the 30-day purge (Pitfall 3).
-- - `day_waiting_automation_items` (07.17 code review WR-02): opened items of active automations waiting for the bot's
--   daily limit since before their automation's local midnight (`automations.time_zone`, else UTC), at most the
--   automation's `fan_out_per_day` per automation (the `automation.tick` cron queues them again).
CREATE OR REPLACE FUNCTION app.due_automations(p_limit integer, p_now timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT a.id, a.organization_id FROM app.automations a
  WHERE a.status = 'active' AND a.trigger_kind = 'schedule' AND a.next_run_at <= p_now
  ORDER BY a.next_run_at, a.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.due_automations(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_automations(integer, timestamptz) TO ocw_app;

CREATE OR REPLACE FUNCTION app.stale_automation_runs(p_limit integer, p_before timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT r.id, r.organization_id FROM app.automation_runs r
  WHERE r.status = 'delivered' AND r.delivered_at < p_before
  ORDER BY r.delivered_at, r.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.stale_automation_runs(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stale_automation_runs(integer, timestamptz) TO ocw_app;

CREATE OR REPLACE FUNCTION app.due_mailboxes(p_limit integer, p_now timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT m.id, m.organization_id FROM app.mailboxes m
  JOIN app.automations a ON a.organization_id = m.organization_id AND a.id = m.automation_id
  WHERE a.status = 'active' AND (
    (m.status IN ('active', 'unreachable', 'auth_failed') AND m.next_poll_at <= p_now)
    OR (m.status = 'auth_failed' AND EXISTS (
      SELECT 1 FROM app.vault_items v
      WHERE v.organization_id = m.organization_id AND v.id = m.vault_item_id AND v.updated_at > m.updated_at
    ))
  )
  ORDER BY m.next_poll_at, m.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.due_mailboxes(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_mailboxes(integer, timestamptz) TO ocw_app;

CREATE OR REPLACE FUNCTION app.due_watched_records(p_limit integer, p_now timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT w.id, w.organization_id FROM app.watched_records w
  WHERE w.next_check_at <= p_now
  ORDER BY w.next_check_at, w.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.due_watched_records(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_watched_records(integer, timestamptz) TO ocw_app;

CREATE OR REPLACE FUNCTION app.lookup_webhook_endpoint(p_public_id text)
RETURNS TABLE (endpoint_id uuid, organization_id uuid, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT e.id, e.organization_id, (e.deleted_at IS NULL AND e.automation_id IS NOT NULL)
  FROM app.webhook_endpoints e
  WHERE e.public_id = p_public_id
$fn$;
REVOKE ALL ON FUNCTION app.lookup_webhook_endpoint(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lookup_webhook_endpoint(text) TO ocw_app;

CREATE OR REPLACE FUNCTION app.expired_automation_events(p_limit integer, p_before timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT e.id, e.organization_id FROM app.automation_events e
  WHERE e.content_purged_at IS NULL AND e.received_at < p_before
  ORDER BY e.received_at, e.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.expired_automation_events(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expired_automation_events(integer, timestamptz) TO ocw_app;

CREATE OR REPLACE FUNCTION app.day_waiting_automation_items(p_limit integer, p_now timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT w.id, w.organization_id FROM (
    SELECT c.id, c.organization_id, c.updated_at, a.fan_out_per_day,
      row_number() OVER (PARTITION BY c.automation_id ORDER BY c.updated_at, c.id) AS n
    FROM app.automation_conversations c
    JOIN app.automations a ON a.organization_id = c.organization_id AND a.id = c.automation_id
    WHERE c.status = 'waiting' AND c.reason = 'agent_daily_limit' AND a.status = 'active'
      AND c.updated_at < (date_trunc('day', p_now AT TIME ZONE coalesce(a.time_zone, 'UTC'))
        AT TIME ZONE coalesce(a.time_zone, 'UTC'))
  ) w
  WHERE w.n <= w.fan_out_per_day
  ORDER BY w.updated_at, w.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.day_waiting_automation_items(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.day_waiting_automation_items(integer, timestamptz) TO ocw_app;

-- Phase 07.7 (A2A-03, D-04, D-11, ADR-0027): the pre-tenant read of the `consult.tick` job (one global cron, every
-- minute, UTC). Same shape as the 07.6 tick functions above: pending agent-to-agent hops whose deadline has passed,
-- across organizations by design, oldest deadline first, ids and organization ids only (never a question, an answer,
-- an agent or a chain). The tick re-reads every hop by id inside its organization's own withTenant() transaction, as
-- the chain's human, where RLS applies again, and times it out there with a conditional `pending →` update.
CREATE OR REPLACE FUNCTION app.expired_agent_chain_hops(p_limit integer, p_now timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT h.id, h.organization_id FROM app.agent_chain_hops h
  WHERE h.status = 'pending' AND h.deadline_at < p_now
  ORDER BY h.deadline_at, h.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.expired_agent_chain_hops(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expired_agent_chain_hops(integer, timestamptz) TO ocw_app;

-- Phase 07.7 review (CR-A-06): the `consult.tick`'s second pre-tenant read. A chain whose last pending thing was lost
-- (a done the cell never sent) must still end: active chains with no pending hop whose chain row and hops have not
-- changed since `p_before` (the tick passes now − 10 minutes), least recently touched first, ids and organization ids
-- only. The tick completes each inside its organization's own withTenant() transaction, under the chain's row lock,
-- with the same completion rule as a done (`completeChain`).
CREATE OR REPLACE FUNCTION app.idle_agent_chains(p_limit integer, p_before timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT c.id, c.organization_id FROM app.agent_chains c
  WHERE c.status = 'active' AND c.updated_at < p_before
    AND NOT EXISTS (
      SELECT 1 FROM app.agent_chain_hops h
      WHERE h.chain_id = c.id AND (h.status = 'pending' OR h.updated_at >= p_before)
    )
  ORDER BY c.updated_at, c.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.idle_agent_chains(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.idle_agent_chains(integer, timestamptz) TO ocw_app;

-- Phase 07.17.1.1.2 (D-02, D-12, PD-06, PD-09; ADR-0042): the pre-tenant read of the `bot_task.tick` job (one global
-- cron, every minute, UTC). Same shape as the chain listers above: active long tasks the tick must look at, across
-- organizations by design, ids and organization ids only (never a goal, progress, a wait reference or a person): a
-- waiting task whose wake is more than 60 s overdue (its job was lost), a running task unchanged for 30 minutes (its
-- turn was lost), a task past its deadline, and a task whose bot is disabled or archived (soft-deleted). Oldest wake (or
-- change) first. The tick re-reads every task by id inside its organization's own withTenant() transaction, where RLS
-- applies again, and decides there under the task's row lock.
CREATE OR REPLACE FUNCTION app.due_bot_tasks(p_limit integer, p_now timestamptz)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT t.id, t.organization_id FROM app.bot_tasks t
  JOIN app.agents a ON a.organization_id = t.organization_id AND a.id = t.agent_id
  WHERE t.status IN ('running', 'waiting')
    AND ((t.status = 'waiting' AND t.wake_at <= p_now - interval '60 seconds')
      OR (t.status = 'running' AND t.updated_at <= p_now - interval '30 minutes')
      OR t.deadline_at <= p_now
      OR a.status = 'disabled'
      OR a.deleted_at IS NOT NULL)
  ORDER BY coalesce(t.wake_at, t.updated_at), t.id
  LIMIT least(greatest(p_limit, 1), 1000)
$fn$;
REVOKE ALL ON FUNCTION app.due_bot_tasks(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_bot_tasks(integer, timestamptz) TO ocw_app;
