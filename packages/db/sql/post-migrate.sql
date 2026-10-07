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
