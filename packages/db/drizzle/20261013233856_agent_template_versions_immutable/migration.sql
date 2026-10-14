-- Phase 07.4 (07.4-08, WINDOWS 171, D-05): a published agent template version never changes. The API never updates a
-- version (a change is a new version; agents started from a template keep theirs until their owner applies a newer
-- one), and this makes the database refuse it too, for every role, as defence in depth. Deletes are not blocked: they
-- only happen through the template's ON DELETE CASCADE (no route deletes a template; archiving keeps every version).
-- Forward-only and idempotent. Rollback (as ocw_migrator): DROP TRIGGER agent_template_version_immutable ON
-- app.agent_template_versions; DROP FUNCTION app.agent_template_version_immutable();
CREATE OR REPLACE FUNCTION app.agent_template_version_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'agent template versions are immutable' USING ERRCODE = 'check_violation';
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agent_template_version_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER agent_template_version_immutable BEFORE UPDATE ON app.agent_template_versions
  FOR EACH ROW EXECUTE FUNCTION app.agent_template_version_immutable();
