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
