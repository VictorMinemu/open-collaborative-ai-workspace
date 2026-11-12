-- Phase 07.17.1.1.2 (D-01, D-03, D-04, PD-05, PD-09, PD-22, PD-23; ADR-0042): long bot tasks, scheduled by the platform.
-- `app.bot_tasks` (one row per task: the bot, its conversation and thread, the person it runs for, the turn that
-- controls it now, its status, wait and bounded progress text; at most one `running` or `waiting` task per bot and
-- thread, `bot_tasks_one_active_idx`, a DM's thread being its conversation) and `app.bot_task_processes` (the background
-- sandbox processes a task waits for: ids, a status, an exit code and a duration only, never argv, a path or output, P1);
-- `agent_turns.task_id` and `bot_work_sessions.task_id` (nullable ledger ids, no foreign key); the organization's limits
-- `bot_policies.task_max_turns` (default 40, 1 … 200), `task_max_hours` (default 8, 1 … 24) and `max_running_tasks`
-- (default 10, 0 … 100); and `message_cards_kind_check` accepts `task` (the platform-owned task card). Deleting a bot or
-- its conversation deletes its tasks, and a task its processes. Tenant isolation (ENABLE + FORCE RLS,
-- `tenant_isolation`), the TRUNCATE revokes and the tick's lister `app.due_bot_tasks` come from post-migrate.
-- Additive only: no drop, no rename, no rewrite, no data update, so N-1 code keeps working (the tables are new, the
-- `task_id` columns nullable, the limits defaulted, the kind check only widened). Chained after
-- 20261111225544_bot_work_session_files (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.bot_task_processes; DROP TABLE app.bot_tasks; DROP INDEX
-- app.agent_turns_task_idx; ALTER TABLE app.agent_turns DROP COLUMN task_id; DROP INDEX app.bot_work_sessions_task_idx;
-- ALTER TABLE app.bot_work_sessions DROP COLUMN task_id; ALTER TABLE app.bot_policies DROP CONSTRAINT
-- bot_policies_task_max_turns_check, DROP CONSTRAINT bot_policies_task_max_hours_check, DROP CONSTRAINT
-- bot_policies_max_running_tasks_check, DROP COLUMN task_max_turns, DROP COLUMN task_max_hours, DROP COLUMN
-- max_running_tasks; restore the kind check without 'task' (only once no `task` card row is left); run the previous
-- release's post-migrate (this one's `app.due_bot_tasks` reads the table) and delete this migration's row from
-- drizzle.__drizzle_migrations.
CREATE TABLE "app"."bot_task_processes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"process_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	CONSTRAINT "bot_task_processes_process_uq" UNIQUE("organization_id","agent_id","process_id"),
	CONSTRAINT "bot_task_processes_status_ck" CHECK ("status" in ('running','exited','killed','timed_out','lost')),
	CONSTRAINT "bot_task_processes_process_id_ck" CHECK (char_length("process_id") between 1 and 64),
	CONSTRAINT "bot_task_processes_duration_ms_ck" CHECK ("duration_ms" is null or "duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."bot_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_root_id" uuid,
	"card_message_id" uuid,
	"requester_user_id" uuid NOT NULL,
	"started_event_id" uuid NOT NULL,
	"current_event_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"outcome" text,
	"goal" text NOT NULL,
	"progress" text,
	"next_step" text,
	"summary" text,
	"turns_used" integer DEFAULT 1 NOT NULL,
	"max_turns" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"wait_kind" text,
	"wait_ref" text,
	"wake_at" timestamp with time zone,
	"wait_seq" integer DEFAULT 0 NOT NULL,
	"tainted" boolean DEFAULT false NOT NULL,
	"nudged" boolean DEFAULT false NOT NULL,
	"last_post_turn" integer DEFAULT 1 NOT NULL,
	"last_post_at" timestamp with time zone,
	"stopped_by_user_id" uuid,
	CONSTRAINT "bot_tasks_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "bot_tasks_status_ck" CHECK ("status" in ('running','waiting','done','failed','stopped')),
	CONSTRAINT "bot_tasks_outcome_ck" CHECK (("outcome" is null) = ("status" in ('running','waiting')) and ("outcome" is null or "outcome" in ('done','blocked','budget_turns','budget_time','daily_limit','access_lost','bot_unavailable','policy_off','stopped_by_person','no_progress','error'))),
	CONSTRAINT "bot_tasks_wait_kind_ck" CHECK ("wait_kind" is null or "wait_kind" in ('turn','timer','process','session','nudge')),
	CONSTRAINT "bot_tasks_goal_ck" CHECK (char_length("goal") between 1 and 200),
	CONSTRAINT "bot_tasks_progress_ck" CHECK ("progress" is null or char_length("progress") between 1 and 500),
	CONSTRAINT "bot_tasks_next_step_ck" CHECK ("next_step" is null or char_length("next_step") between 1 and 500),
	CONSTRAINT "bot_tasks_summary_ck" CHECK ("summary" is null or char_length("summary") between 1 and 1000),
	CONSTRAINT "bot_tasks_wait_ref_ck" CHECK ("wait_ref" is null or char_length("wait_ref") between 1 and 64),
	CONSTRAINT "bot_tasks_turns_used_ck" CHECK ("turns_used" >= 0),
	CONSTRAINT "bot_tasks_max_turns_ck" CHECK ("max_turns" between 1 and 200),
	CONSTRAINT "bot_tasks_wait_seq_ck" CHECK ("wait_seq" >= 0),
	CONSTRAINT "bot_tasks_last_post_turn_ck" CHECK ("last_post_turn" >= 0),
	CONSTRAINT "bot_tasks_finished_at_ck" CHECK (("finished_at" is null) = ("status" in ('running','waiting')))
);
--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "task_max_turns" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "task_max_hours" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD COLUMN "max_running_tasks" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_work_sessions" ADD COLUMN "task_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_turns_task_idx" ON "app"."agent_turns" ("task_id") WHERE task_id is not null;--> statement-breakpoint
CREATE INDEX "bot_task_processes_task_idx" ON "app"."bot_task_processes" ("organization_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tasks_one_active_idx" ON "app"."bot_tasks" ("organization_id","agent_id","conversation_id",coalesce("thread_root_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status in ('running','waiting');--> statement-breakpoint
CREATE INDEX "bot_tasks_due_idx" ON "app"."bot_tasks" ("status","wake_at") WHERE status = 'waiting';--> statement-breakpoint
CREATE INDEX "bot_tasks_org_active_idx" ON "app"."bot_tasks" ("organization_id") WHERE status in ('running','waiting');--> statement-breakpoint
CREATE INDEX "bot_work_sessions_task_idx" ON "app"."bot_work_sessions" ("organization_id","task_id") WHERE task_id is not null;--> statement-breakpoint
ALTER TABLE "app"."bot_task_processes" ADD CONSTRAINT "bot_task_processes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_task_processes" ADD CONSTRAINT "bot_task_processes_task_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "app"."bot_tasks"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_tasks" ADD CONSTRAINT "bot_tasks_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_tasks" ADD CONSTRAINT "bot_tasks_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_tasks" ADD CONSTRAINT "bot_tasks_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_task_max_turns_check" CHECK ("task_max_turns" between 1 and 200);--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_task_max_hours_check" CHECK ("task_max_hours" between 1 and 24);--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ADD CONSTRAINT "bot_policies_max_running_tasks_check" CHECK ("max_running_tasks" between 0 and 100);--> statement-breakpoint
ALTER TABLE "app"."message_cards" DROP CONSTRAINT "message_cards_kind_check", ADD CONSTRAINT "message_cards_kind_check" CHECK ("kind" in ('work_zone','approval','report','artifact','automation','deployment','pr','generic','browser','task'));