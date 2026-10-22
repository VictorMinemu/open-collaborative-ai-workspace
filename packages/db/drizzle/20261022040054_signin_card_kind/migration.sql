-- Phase 07.8 (07.8-21; D-07, D-08, UI-SPEC R1; WINDOWS #234, #230): the platform-owned "Sign in needed" card and the
-- clean-up of sealed browser sessions.
-- 1. `app.message_cards.kind` accepts `browser`, so a sign-in card can be stored (07.8-02 kept the 8 older kinds), and
--    `browser_signin_requests.session_expires_at` (additive, nullable) carries the sealed session's expiry for the card.
-- 2. A sealed session is its `browser_session` secret: whenever a `browser_sessions` row goes (a revoke, the expiry
--    purge, a deleted bot's cascade), its secret goes in the same statement, so no sealed state outlives its row.
-- 3. A member who leaves the organization (deactivated, or removed from `org_members` or `auth.member`) loses every
--    browser session there, and with them their secrets (2).
-- Both clean-up functions are SECURITY DEFINER as ocw_migrator (BYPASSRLS), fixed search_path: they run inside FK
-- cascades and identity writes that carry no `app.user_id`, and the owner-only policy would hide the rows otherwise.
-- They delete only rows of the triggering row's own organization and member; they return nothing.
-- Chained after 20261021200025_tool_call_requester_decides (P-17: earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TRIGGER browser_session_secret_cleanup ON app.browser_sessions;
-- DROP TRIGGER browser_sessions_member_left ON app.org_members; DROP TRIGGER browser_sessions_member_removed ON
-- app.org_members; DROP TRIGGER browser_sessions_auth_member_removed ON auth.member; DROP FUNCTION
-- app.browser_session_secret_cleanup(); DROP FUNCTION app.browser_sessions_member_gone(); ALTER TABLE
-- app.browser_signin_requests DROP COLUMN session_expires_at; then restore the kind check without 'browser' (only once
-- no `browser` card row is left).
ALTER TABLE "app"."browser_signin_requests" ADD COLUMN "session_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."message_cards" DROP CONSTRAINT "message_cards_kind_check", ADD CONSTRAINT "message_cards_kind_check" CHECK ("kind" in ('work_zone','approval','report','artifact','automation','deployment','pr','generic','browser'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.browser_session_secret_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  DELETE FROM app.secrets s
  WHERE s.organization_id = OLD.organization_id AND s.id = OLD.secret_id AND s.kind = 'browser_session';
  RETURN OLD;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.browser_session_secret_cleanup() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER browser_session_secret_cleanup AFTER DELETE ON app.browser_sessions
  FOR EACH ROW EXECUTE FUNCTION app.browser_session_secret_cleanup();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.browser_sessions_member_gone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  DELETE FROM app.browser_sessions b
  WHERE b.organization_id = OLD.organization_id AND b.user_id = OLD.user_id;
  RETURN NULL;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.browser_sessions_member_gone() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER browser_sessions_member_left AFTER UPDATE OF deactivated_at ON app.org_members
  FOR EACH ROW WHEN (OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL)
  EXECUTE FUNCTION app.browser_sessions_member_gone();--> statement-breakpoint
CREATE OR REPLACE TRIGGER browser_sessions_member_removed AFTER DELETE ON app.org_members
  FOR EACH ROW EXECUTE FUNCTION app.browser_sessions_member_gone();--> statement-breakpoint
CREATE OR REPLACE TRIGGER browser_sessions_auth_member_removed AFTER DELETE ON auth.member
  FOR EACH ROW EXECUTE FUNCTION app.browser_sessions_member_gone();
