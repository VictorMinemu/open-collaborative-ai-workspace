-- Phase 07.15 (D-11, D-17): the per-turn attachment read budget, additive only. `attachment_reads` and
-- `attachment_chars` count the `ocw_attachment_read` reads of a turn and the UTF-16 characters they returned, against
-- `ATTACHMENT_READ_LIMITS`, separately from `tool_calls` and `sandbox_calls`. Every existing turn reads 0 (no data
-- migration). Tenant RLS on app.agent_turns already covers the new columns (post-migrate.sql).
-- Rollback (as ocw_migrator): ALTER TABLE app.agent_turns DROP CONSTRAINT agent_turns_attachment_chars_check, DROP
-- CONSTRAINT agent_turns_attachment_reads_check, DROP COLUMN attachment_chars, DROP COLUMN attachment_reads;
ALTER TABLE "app"."agent_turns" ADD COLUMN "attachment_reads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "attachment_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD CONSTRAINT "agent_turns_attachment_reads_check" CHECK ("attachment_reads" >= 0);--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD CONSTRAINT "agent_turns_attachment_chars_check" CHECK ("attachment_chars" >= 0);