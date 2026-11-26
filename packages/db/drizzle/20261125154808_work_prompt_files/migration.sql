-- ADR-0045: files on a person's Work Zone prompt reuse the transfer ledger of ADR-0041. `bot_work_session_files` gains
-- `work_prompt_id` (nullable: the prompt a file is copied in for) and `agent_id` / `event_id` become nullable; the new
-- `bot_work_session_files_owner_ck` keeps exactly one owner per row (a bot's turn, or a prompt, `to_device` only).
-- `devices.prompt_files_version` (nullable, 1 … 100) records `hello.promptFiles`, written only from the device's own
-- hello: a device without it never gets a prompt file. Ids, sizes and a digest only, never a path or a file name (P1).
-- Tenant isolation of the ledger is unchanged (post-migrate). Additive for N-1 code: a new nullable column, two NOT
-- NULLs relaxed (N-1 never writes a null there), a new check every existing row satisfies, no rewrite, no data update.
-- Chained after 20261124150907_account_pool (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DELETE FROM app.bot_work_session_files WHERE work_prompt_id IS NOT NULL;
-- ALTER TABLE app.bot_work_session_files DROP CONSTRAINT bot_work_session_files_owner_ck, DROP COLUMN work_prompt_id,
-- ALTER COLUMN agent_id SET NOT NULL, ALTER COLUMN event_id SET NOT NULL; DROP INDEX
-- app.bot_work_session_files_prompt_idx; ALTER TABLE app.devices DROP CONSTRAINT devices_prompt_files_version_ck, DROP
-- COLUMN prompt_files_version; delete this migration's row from drizzle.__drizzle_migrations.
ALTER TABLE "app"."bot_work_session_files" ADD COLUMN "work_prompt_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "prompt_files_version" integer;--> statement-breakpoint
ALTER TABLE "app"."bot_work_session_files" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."bot_work_session_files" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "bot_work_session_files_prompt_idx" ON "app"."bot_work_session_files" ("organization_id","work_prompt_id");--> statement-breakpoint
ALTER TABLE "app"."bot_work_session_files" ADD CONSTRAINT "bot_work_session_files_owner_ck" CHECK (("work_prompt_id" is null and "agent_id" is not null and "event_id" is not null) or ("work_prompt_id" is not null and "agent_id" is null and "event_id" is null and "direction" = 'to_device'));--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_prompt_files_version_ck" CHECK ("prompt_files_version" is null or "prompt_files_version" between 1 and 100);