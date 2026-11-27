-- Phase 07.13.1.1 (D-07, D-08, PD-11, PD-16; ADR-0047): session naming rules and the per-turn agent rename claim.
-- `work_zone_policies.session_naming_rule` (the organization's rule) and `work_project_settings.naming_rule` (a
-- project's rule, added after the organization's) are nullable text of at most 600 characters, untrusted wording data
-- the title call and the session's agent follow; `work_prompts.title_renamed_at` is set once when the turn's agent
-- renamed its session (the API claims it with a conditional update: one rename per turn). The ownership transfer of
-- Assign to me is an UPDATE of `work_sessions.created_by` and needs no SQL, RLS or function change (PD-01).
-- Additive only: nullable columns and checks on new columns; no drop, no rename, no rewrite, no data update, so N-1 code
-- keeps working. Chained after 20261125164903_work_zone_browser (earlier migrations are never edited). Its snapshot is
-- the merge point of the two snapshot leaves (20261125154808_work_prompt_files and 20261125164903_work_zone_browser,
-- both chained after 20261124150907_account_pool): drizzle-kit generated it with `--ignore-conflicts` and repeated
-- work_prompt_files' statements (already applied by that migration), which were removed from this file by hand.
-- Forward-only. Rollback (as ocw_migrator): ALTER TABLE app.work_zone_policies DROP CONSTRAINT
-- work_zone_policies_session_naming_rule_ck, DROP COLUMN session_naming_rule; ALTER TABLE app.work_project_settings DROP
-- CONSTRAINT work_project_settings_naming_rule_ck, DROP COLUMN naming_rule; ALTER TABLE app.work_prompts DROP COLUMN
-- title_renamed_at; and delete this migration's row from drizzle.__drizzle_migrations.
ALTER TABLE "app"."work_project_settings" ADD COLUMN "naming_rule" text;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD COLUMN "title_renamed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD COLUMN "session_naming_rule" text;--> statement-breakpoint
ALTER TABLE "app"."work_project_settings" ADD CONSTRAINT "work_project_settings_naming_rule_ck" CHECK (char_length("naming_rule") <= 600);--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD CONSTRAINT "work_zone_policies_session_naming_rule_ck" CHECK (char_length("session_naming_rule") <= 600);
