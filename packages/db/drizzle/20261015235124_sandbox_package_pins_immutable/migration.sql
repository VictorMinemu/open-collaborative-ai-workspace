-- Phase 07.8 (07.8-18, WINDOWS #231, P-12, ADR-0011's model): an approved sandbox package is one pinned (source, name,
-- version, artifact sha256, dependency tree) bound to the review token the admin approved. The API never edits a pin:
-- approving another version, or re-approving after an upstream change, marks the old row `removed` and inserts a new one.
-- This makes the database refuse an in-place change of a pin too, for every role, as defence in depth: installs read
-- the lockfile and the tree hash from this row, so a changed pin would install something nobody reviewed. The switches
-- (`enabled`, `personal_allowed`), `changed_upstream`, `status`, the risk columns and `updated_at` stay writable.
-- Chained after 20261015173538_share_attachment_turn (P-17: 02's migration is never edited).
-- Forward-only and idempotent. Rollback (as ocw_migrator): DROP TRIGGER sandbox_package_pins_immutable ON
-- app.sandbox_packages; DROP FUNCTION app.sandbox_package_pins_immutable();
CREATE OR REPLACE FUNCTION app.sandbox_package_pins_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.tree_sha256 IS DISTINCT FROM OLD.tree_sha256
    OR NEW.lockfile IS DISTINCT FROM OLD.lockfile
    OR NEW.dependency_count IS DISTINCT FROM OLD.dependency_count
    OR NEW.review_token IS DISTINCT FROM OLD.review_token THEN
    RAISE EXCEPTION 'sandbox package pins are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sandbox_package_pins_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER sandbox_package_pins_immutable BEFORE UPDATE ON app.sandbox_packages
  FOR EACH ROW EXECUTE FUNCTION app.sandbox_package_pins_immutable();
