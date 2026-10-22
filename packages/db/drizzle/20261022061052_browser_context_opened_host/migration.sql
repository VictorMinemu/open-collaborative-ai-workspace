-- Phase 07.8 (07.8-27; UI-SPEC § 3.6, WINDOWS #286): the host a browser page was opened on, kept apart from `host`,
-- which follows the page's navigation. The bot page's Browser tab says "Opened {host}" with it; before this column the
-- tab named the page's current host. Additive and nullable: rows written before it keep NULL, and readers fall back
-- to `host` (no backfill, which would only copy that same guess). Same host shape check as `host`.
-- Chained after 20261022040054_signin_card_kind (P-17: earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): ALTER TABLE app.browser_contexts DROP CONSTRAINT
-- browser_contexts_opened_host_check, DROP COLUMN opened_host.
ALTER TABLE "app"."browser_contexts" ADD COLUMN "opened_host" text;--> statement-breakpoint
ALTER TABLE "app"."browser_contexts" ADD CONSTRAINT "browser_contexts_opened_host_check" CHECK ("opened_host" = lower("opened_host") and char_length("opened_host") between 1 and 260
      and position('/' in "opened_host") = 0 and position('@' in "opened_host") = 0);