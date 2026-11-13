-- Phase 07.17.1.1.2 code review WR-02 (D-03, PD-13; ADR-0042 amendment): a background command that ends within
-- milliseconds of its yield can have its sandboxd `process` event applied before the exec's outcome transaction writes
-- the link row, and the end was lost (the task then waited to the row's deadline and heard `lost`). The end is now kept
-- as an unlinked `app.bot_task_processes` row (`task_id` and `event_id` null, never `running`) that the link takes
-- (`ON CONFLICT` on `bot_task_processes_process_uq`); an unclaimed one is pruned after an hour. `bot_task_processes_link_ck`
-- keeps both ids or neither and an unlinked row never running; `bot_task_processes_unlinked_idx` serves the prune.
-- Additive only: two NOT NULL constraints relaxed, one check and one partial index added, no rewrite and no data
-- update, so N-1 code keeps working (it only ever reads rows by task id and updates `running` ones). Chained after
-- 20261112230733_bot_tasks (earlier migrations are never edited). Tenant isolation is unchanged (post-migrate's generic
-- `tenant_isolation`).
-- Forward-only. Rollback (as ocw_migrator): DELETE FROM app.bot_task_processes WHERE task_id IS NULL; ALTER TABLE
-- app.bot_task_processes DROP CONSTRAINT bot_task_processes_link_ck, ALTER COLUMN task_id SET NOT NULL, ALTER COLUMN
-- event_id SET NOT NULL; DROP INDEX app.bot_task_processes_unlinked_idx; delete this migration's row from
-- drizzle.__drizzle_migrations.
ALTER TABLE "app"."bot_task_processes" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_task_processes" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "bot_task_processes_unlinked_idx" ON "app"."bot_task_processes" ("organization_id","ended_at") WHERE task_id is null;--> statement-breakpoint
ALTER TABLE "app"."bot_task_processes" ADD CONSTRAINT "bot_task_processes_link_ck" CHECK (("task_id" is null) = ("event_id" is null) and ("task_id" is not null or "status" <> 'running'));
