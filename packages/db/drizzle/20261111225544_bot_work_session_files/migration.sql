-- Phase 07.17.1.1 (D-05, D-06, D-07, PD-05, PD-12, PD-16, PD-22; ADR-0041): bot file exchange with its Work Zone
-- sessions. `work_zone_policies.bot_file_max_bytes` (the organization's largest file a bot moves, NOT NULL DEFAULT
-- 26214400 = 25 MiB, `work_zone_policies_bot_file_max_bytes_ck` 1 MiB … 1 GiB) and `bot_work_zone_profiles.file_max_bytes`
-- (the bot's own, null = the organization's, `bot_work_zone_profiles_file_max_bytes_ck` null or the same range); the
-- transfer ledger `app.bot_work_session_files`: one row per move the API enqueued (the id is the device command's id),
-- ids, sizes, a digest and a path length only, never a path, a file name or content (P1); deleting the session deletes
-- its rows. Tenant isolation (ENABLE + FORCE RLS, `tenant_isolation`) and the hourly load that counts the ledger come from
-- post-migrate. Additive only: no drop, no rename, no rewrite, no data update, so N-1 code keeps working (the new
-- column is defaulted, the other nullable, the table new). Chained after 20261111194914_runtime_self_update (earlier
-- migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.bot_work_session_files; ALTER TABLE app.bot_work_zone_profiles
-- DROP CONSTRAINT bot_work_zone_profiles_file_max_bytes_ck, DROP COLUMN file_max_bytes; ALTER TABLE
-- app.work_zone_policies DROP CONSTRAINT work_zone_policies_bot_file_max_bytes_ck, DROP COLUMN bot_file_max_bytes; run
-- the previous release's post-migrate (this one's `app.bot_work_session_load` reads the table) and delete this
-- migration's row from drizzle.__drizzle_migrations.
CREATE TABLE "app"."bot_work_session_files" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"work_session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"max_bytes" bigint NOT NULL,
	"limit_source" text NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"path_length" smallint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bot_work_session_files_direction_ck" CHECK ("direction" in ('to_device','from_device')),
	CONSTRAINT "bot_work_session_files_status_ck" CHECK ("status" in ('pending','streaming','streamed','done','failed')),
	CONSTRAINT "bot_work_session_files_limit_source_ck" CHECK ("limit_source" in ('bot','organization','server')),
	CONSTRAINT "bot_work_session_files_sha256_ck" CHECK ("sha256" is null or "sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bot_work_session_files_sizes_ck" CHECK ("max_bytes" > 0 and ("size_bytes" is null or "size_bytes" >= 0) and "path_length" between 1 and 1024)
);
--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profiles" ADD COLUMN "file_max_bytes" bigint;--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD COLUMN "bot_file_max_bytes" bigint DEFAULT 26214400 NOT NULL;--> statement-breakpoint
CREATE INDEX "bot_work_session_files_agent_idx" ON "app"."bot_work_session_files" ("organization_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_work_session_files_turn_idx" ON "app"."bot_work_session_files" ("organization_id","event_id","direction");--> statement-breakpoint
ALTER TABLE "app"."bot_work_session_files" ADD CONSTRAINT "bot_work_session_files_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_session_files" ADD CONSTRAINT "bot_work_session_files_session_fk" FOREIGN KEY ("organization_id","work_session_id") REFERENCES "app"."work_sessions"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profiles" ADD CONSTRAINT "bot_work_zone_profiles_file_max_bytes_ck" CHECK ("file_max_bytes" is null or "file_max_bytes" between 1048576 and 1073741824);--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD CONSTRAINT "work_zone_policies_bot_file_max_bytes_ck" CHECK ("bot_file_max_bytes" between 1048576 and 1073741824);