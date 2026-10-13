-- Phase 07.2 (WINDOWS 136, ADR-0023 decision 1): a memory file never changes scope. The API already never moves a
-- file across scopes (a move between scopes is create in the target plus delete in the source), so each file's history
-- stays under the scope and the owner it was written in; this makes the database refuse it too, as defence in depth.
-- Moving a file would otherwise leave its revisions under the old scope (and its old owner) while the file itself
-- changed hands. Fires before the owner trigger (`memory_owner`, post-migrate.sql): trigger names sort first.
-- Forward-only and idempotent. Rollback (as ocw_migrator): DROP TRIGGER memory_file_scope_fixed ON app.memory_files;
-- DROP FUNCTION app.memory_file_scope_fixed();
CREATE OR REPLACE FUNCTION app.memory_file_scope_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
    RAISE EXCEPTION 'memory file scope is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.memory_file_scope_fixed() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER memory_file_scope_fixed BEFORE UPDATE OF scope_id ON app.memory_files
  FOR EACH ROW EXECUTE FUNCTION app.memory_file_scope_fixed();
