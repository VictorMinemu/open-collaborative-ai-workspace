-- Quick 261113-id6: how the cell summarizes long bot conversations, chosen by an admin in Settings › Bot policy
-- (`BotPolicy.conversations`, OpenClaw's `agents.defaults.compaction`): `conversation_strict_summaries` (OpenClaw's summary
-- quality guard, default off), `conversation_keep_identifiers` (default off), `conversation_keep_recent_tokens`
-- (default 20000, 2000 … 100000) and `conversation_fresh_session_on_failure` (default on).
-- Additive only: four NOT NULL columns with constant defaults on an existing table (no rewrite on PostgreSQL 11+, no data
-- update) and one CHECK every default satisfies; N-1 code never reads them. RLS and grants are unchanged (the table's
-- existing policies and table grants cover them). Chained after 20261113175346_projects_git (earlier migrations are never
-- edited).
-- Forward-only. Rollback (as ocw_migrator): ALTER TABLE app.bot_policies DROP CONSTRAINT
-- bot_policies_conversation_keep_recent_tokens_check, DROP COLUMN conversation_strict_summaries, DROP COLUMN
-- conversation_keep_identifiers, DROP COLUMN conversation_keep_recent_tokens, DROP COLUMN
-- conversation_fresh_session_on_failure; delete this migration's row from drizzle.__drizzle_migrations.
ALTER TABLE "app"."bot_policies" ADD COLUMN "conversation_strict_summaries" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "conversation_keep_identifiers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "conversation_keep_recent_tokens" integer DEFAULT 20000 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "conversation_fresh_session_on_failure" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_conversation_keep_recent_tokens_check" CHECK ("conversation_keep_recent_tokens" between 2000 and 100000);