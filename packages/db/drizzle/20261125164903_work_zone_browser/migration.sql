-- Phase 07.13 (D-10, D-19, D-20, D-23, D-30, PD-03, PD-04, PD-05, PD-14, PD-20; ADR-0035): the Work Zone local browser.
-- `work_zone_policies.allow_browser` (the organization's switch, default off), `devices.browser_opt_in` (default off)
-- and `devices.browser_version` (nullable, 1 … 100), both written only from the device's own hello/capabilities;
-- `app.work_browsers` (one row per session browser: state, origin, takeover lease, the loaded sign-in, the pending
-- hand-back upload; deleted with its session, `SET NULL ("signin_id")` when its sign-in goes) and
-- `app.work_browser_signins` (a member's sealed sign-in per site, the sibling of the bots' `browser_sessions`, whose
-- storage state is only a `secret_id` to a sealed `browser_session` secret, never a column). Every reference is
-- composite with the organization (FKs bypass RLS). Tenant isolation (ENABLE + FORCE RLS, `tenant_isolation`), the
-- owner-only and audience policies, the TRUNCATE revokes and the purge and sweep functions come from post-migrate.
-- Two clean-up triggers, as 20261022040054_signin_card_kind did for the bots' sessions: a deleted sign-in deletes its
-- secret in the same statement (`work_browser_signin_secret_cleanup`), and a member who leaves the organization
-- (deactivated, or removed from `org_members` or `auth.member`) loses every Work Zone sign-in there
-- (`work_browser_signins_member_gone`). Both are SECURITY DEFINER as ocw_migrator (BYPASSRLS) with a fixed search_path:
-- they run inside FK cascades and identity writes that carry no `app.user_id`, which the owner-only policy would hide the
-- rows from. They delete only rows of the triggering row's own organization and member, and return nothing.
-- Additive only: new tables, defaulted or nullable columns, new checks on new columns; no drop, no rename, no rewrite, no
-- data update, so N-1 code keeps working. Chained after 20261124150907_account_pool (earlier migrations are never
-- edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TRIGGER work_browser_signin_secret_cleanup ON app.work_browser_signins;
-- DROP TRIGGER work_browser_signins_member_left ON app.org_members; DROP TRIGGER work_browser_signins_member_removed ON
-- app.org_members; DROP TRIGGER work_browser_signins_auth_member_removed ON auth.member; DROP FUNCTION
-- app.work_browser_signin_secret_cleanup(); DROP FUNCTION app.work_browser_signins_member_gone(); DROP TABLE
-- app.work_browsers; DROP TABLE app.work_browser_signins (delete their `browser_session` secrets first); ALTER TABLE
-- app.devices DROP CONSTRAINT devices_browser_version_ck, DROP COLUMN browser_version, DROP COLUMN browser_opt_in; ALTER
-- TABLE app.work_zone_policies DROP COLUMN allow_browser; run the previous release's post-migrate (it no longer names
-- `purge_work_browser_signins` or `work_browser_sweep_organizations`: drop both) and delete this migration's row from
-- drizzle.__drizzle_migrations.
CREATE TABLE "app"."work_browser_signins" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"site_key" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_browser_signins_owner_site_uq" UNIQUE("organization_id","user_id","site_key"),
	CONSTRAINT "work_browser_signins_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "work_browser_signins_site_key_check" CHECK ("site_key" = lower("site_key") and char_length("site_key") between 1 and 260
      and position('/' in "site_key") = 0 and position('@' in "site_key") = 0)
);
--> statement-breakpoint
CREATE TABLE "app"."work_browsers" (
	"work_session_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"origin" text,
	"controller_user_id" uuid,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"lease_input" boolean DEFAULT false NOT NULL,
	"signin_id" uuid,
	"signin_user_id" uuid,
	"upload_id" uuid,
	"upload_user_id" uuid,
	"upload_origin" text,
	"upload_expires_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "work_browsers_state_ck" CHECK ("state" in ('open','closed')),
	CONSTRAINT "work_browsers_origin_ck" CHECK ("origin" is null or (char_length("origin") <= 300 and "origin" ~ '^https?://[a-z0-9.\-\[\]:]+:[0-9]{1,5}$')),
	CONSTRAINT "work_browsers_upload_origin_ck" CHECK ("upload_origin" is null or (char_length("upload_origin") <= 300 and "upload_origin" ~ '^https?://[a-z0-9.\-\[\]:]+:[0-9]{1,5}$')),
	CONSTRAINT "work_browsers_lease_ck" CHECK (("lease_id" is null) = ("controller_user_id" is null) and ("lease_id" is null) = ("lease_expires_at" is null)),
	CONSTRAINT "work_browsers_upload_ck" CHECK (("upload_id" is null) = ("upload_user_id" is null) and ("upload_id" is null) = ("upload_origin" is null)
        and ("upload_id" is null) = ("upload_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "browser_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "browser_version" integer;--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD COLUMN "allow_browser" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "work_browser_signins_secret_idx" ON "app"."work_browser_signins" ("organization_id","secret_id");--> statement-breakpoint
CREATE INDEX "work_browser_signins_expires_idx" ON "app"."work_browser_signins" ("expires_at");--> statement-breakpoint
CREATE INDEX "work_browsers_signin_idx" ON "app"."work_browsers" ("organization_id","signin_id") WHERE signin_id is not null;--> statement-breakpoint
CREATE INDEX "work_browsers_lease_idx" ON "app"."work_browsers" ("lease_expires_at") WHERE lease_id is not null;--> statement-breakpoint
ALTER TABLE "app"."work_browser_signins" ADD CONSTRAINT "work_browser_signins_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_browser_signins" ADD CONSTRAINT "work_browser_signins_secret_fk" FOREIGN KEY ("organization_id","secret_id") REFERENCES "app"."secrets"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_browsers" ADD CONSTRAINT "work_browsers_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_browsers" ADD CONSTRAINT "work_browsers_session_fk" FOREIGN KEY ("organization_id","work_session_id") REFERENCES "app"."work_sessions"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_browsers" ADD CONSTRAINT "work_browsers_signin_fk" FOREIGN KEY ("organization_id","signin_id") REFERENCES "app"."work_browser_signins"("organization_id","id") ON DELETE SET NULL ("signin_id");--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_browser_version_ck" CHECK ("browser_version" is null or "browser_version" between 1 and 100);--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.work_browser_signin_secret_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  DELETE FROM app.secrets s
  WHERE s.organization_id = OLD.organization_id AND s.id = OLD.secret_id AND s.kind = 'browser_session';
  RETURN OLD;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.work_browser_signin_secret_cleanup() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER work_browser_signin_secret_cleanup AFTER DELETE ON app.work_browser_signins
  FOR EACH ROW EXECUTE FUNCTION app.work_browser_signin_secret_cleanup();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.work_browser_signins_member_gone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  DELETE FROM app.work_browser_signins w
  WHERE w.organization_id = OLD.organization_id AND w.user_id = OLD.user_id;
  RETURN NULL;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.work_browser_signins_member_gone() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER work_browser_signins_member_left AFTER UPDATE OF deactivated_at ON app.org_members
  FOR EACH ROW WHEN (OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL)
  EXECUTE FUNCTION app.work_browser_signins_member_gone();--> statement-breakpoint
CREATE OR REPLACE TRIGGER work_browser_signins_member_removed AFTER DELETE ON app.org_members
  FOR EACH ROW EXECUTE FUNCTION app.work_browser_signins_member_gone();--> statement-breakpoint
CREATE OR REPLACE TRIGGER work_browser_signins_auth_member_removed AFTER DELETE ON auth.member
  FOR EACH ROW EXECUTE FUNCTION app.work_browser_signins_member_gone();