-- Phase 07.8 (ADR-0029, live view and takeover): a takeover abandoned after input closes the page. `lease_input` records,
-- before the input reaches the page, that the current lease holder sent input (typed, clicked, pasted); it is reset
-- when a lease starts or ends. A lease that ends without a hand back (the socket closed, the idle release, lost access,
-- a dead instance's lease swept) with that flag set, or with a member's session loaded, ends the page with the new
-- reason `takeover_abandoned` instead of handing it back to the bot and its watchers; a sign-in card still waiting on it
-- stops with the same reason. Additive: existing rows get false (no lease in progress knows of input), the two reason
-- checks gain one value.
-- Chained after 20261022070138_agent_member_data (P-17: earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator), only while no row uses the new reason: ALTER TABLE app.browser_contexts
-- DROP COLUMN lease_input, and restore both checks without 'takeover_abandoned'.
ALTER TABLE "app"."browser_contexts" ADD COLUMN "lease_input" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."browser_contexts" DROP CONSTRAINT "browser_contexts_end_reason_check", ADD CONSTRAINT "browser_contexts_end_reason_check" CHECK ("end_reason" is null or "end_reason" in ('closed_by_bot','idle','kill_switch','module_off','crashed','access_lost','takeover_abandoned'));--> statement-breakpoint
ALTER TABLE "app"."browser_signin_requests" DROP CONSTRAINT "browser_signin_requests_stop_reason_check", ADD CONSTRAINT "browser_signin_requests_stop_reason_check" CHECK ("stop_reason" is null or "stop_reason" in ('closed_by_bot','idle','kill_switch','module_off','crashed','access_lost','takeover_abandoned'));