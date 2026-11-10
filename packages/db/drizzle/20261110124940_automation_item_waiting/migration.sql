-- Phase 07.17 code review WR-02: an opened item whose turn found no free Work Zone session (`too_many_sessions`) or the
-- bot at its daily limit waits (`status = 'waiting'`, reason `session_capacity` or `agent_daily_limit`) and is queued
-- again, with `attempt + 1` and a new derived event id, when one of the bot's sessions ends or on the automation's next
-- local day. Additive only: one defaulted column (`attempt` 0, checked 0 … 100), one partial index on the waiting rows
-- and `automation_conversations_status_check` widened by one value (the old values are all still admitted, so N-1 code
-- that never writes `waiting` keeps working). No drop of data, no rename, no rewrite, no data update.
-- Forward-only. Rollback (as ocw_migrator), after moving any waiting row to 'skipped': ALTER TABLE
-- app.automation_conversations DROP CONSTRAINT automation_conversations_status_check, ADD CONSTRAINT
-- automation_conversations_status_check CHECK (status in ('queued','delivered','skipped','failed')), DROP CONSTRAINT
-- automation_conversations_attempt_check, DROP COLUMN attempt; DROP INDEX app.automation_conversations_waiting_idx; and
-- delete this migration's row from drizzle.__drizzle_migrations.
ALTER TABLE "app"."automation_conversations" ADD COLUMN "attempt" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_conversations_waiting_idx" ON "app"."automation_conversations" ("automation_id","updated_at") WHERE status = 'waiting';--> statement-breakpoint
ALTER TABLE "app"."automation_conversations" ADD CONSTRAINT "automation_conversations_attempt_check" CHECK ("attempt" between 0 and 100);--> statement-breakpoint
ALTER TABLE "app"."automation_conversations" DROP CONSTRAINT "automation_conversations_status_check", ADD CONSTRAINT "automation_conversations_status_check" CHECK ("status" in ('queued','delivered','waiting','skipped','failed'));