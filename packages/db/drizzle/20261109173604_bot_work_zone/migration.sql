-- Phase 07.16 (D-01, D-03, D-06, D-08, D-09, D-15, D-16, D-18, D-19, D-20): bot Work Zone orchestration, additive only.
-- Four new tables (a bot's profile and its allowed projects, the device owner's per-bot consent, the bot side of a
-- bot-started session) and nine nullable or defaulted columns: `devices.host_kind` / `isolated_server` (written only
-- from the device's own frames), `work_sessions.started_by_agent_id` / `tainted_at`, `work_prompts.author_agent_id` /
-- `tainted`, `work_zone_policies.bot_sessions_max` (10), `work_zone_proposals.tainted`, `agent_turns.session_output_read`.
-- No drop, rename, rewrite or data update: every existing row reads "no bot, not tainted", so bots without a profile and
-- every person's session behave exactly as before, and N-1 code keeps working against this schema (D-16).
-- Hand-written below drizzle's output: the three composite ON DELETE SET NULL keys name their column (PostgreSQL 15+;
-- drizzle 1.0.0-rc.4 has no builder for the list, as 20261014125609_tool_approvals), so a deleted bot or profile clears
-- only its link and never `organization_id`. Tenant RLS on the new tables, the session audience backstop on
-- `app.bot_work_sessions` and the TRUNCATE revokes are applied by post-migrate.sql.
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.bot_work_sessions, app.bot_work_zone_profile_projects,
-- app.device_bot_consents, app.bot_work_zone_profiles; ALTER TABLE app.work_prompts DROP CONSTRAINT
-- work_prompts_agent_author_ck, DROP COLUMN author_agent_id, DROP COLUMN tainted; ALTER TABLE app.work_sessions DROP
-- COLUMN started_by_agent_id, DROP COLUMN tainted_at; ALTER TABLE app.devices DROP CONSTRAINT devices_host_kind_ck, DROP
-- COLUMN host_kind, DROP COLUMN isolated_server; ALTER TABLE app.work_zone_policies DROP CONSTRAINT
-- work_zone_policies_bot_sessions_max_ck, DROP COLUMN bot_sessions_max; ALTER TABLE app.work_zone_proposals DROP COLUMN
-- tainted; ALTER TABLE app.agent_turns DROP COLUMN session_output_read; and delete this migration's row from
-- drizzle.__drizzle_migrations.
CREATE TABLE "app"."bot_work_sessions" (
	"work_session_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"profile_id" uuid,
	"sponsor_user_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"origin_conversation_id" uuid NOT NULL,
	"origin_thread_root_id" uuid,
	"origin_message_id" uuid NOT NULL,
	"origin_event_id" uuid NOT NULL,
	"card_message_id" uuid,
	"wake_pending" boolean DEFAULT false NOT NULL,
	"wakes_day" date,
	"wakes_used" smallint DEFAULT 0 NOT NULL,
	"last_woken_status" text,
	"last_woken_prompt_id" uuid,
	"stopped_by_agent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_work_sessions_wakes_used_ck" CHECK ("wakes_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."bot_work_zone_profile_projects" (
	"organization_id" uuid NOT NULL,
	"profile_id" uuid,
	"device_id" uuid NOT NULL,
	"project_id" uuid,
	CONSTRAINT "bot_work_zone_profile_projects_pkey" PRIMARY KEY("profile_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "app"."bot_work_zone_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"sponsor_user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"default_model" text,
	"allowed_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_effort" text,
	"allowed_efforts" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_context_window" text,
	"allowed_context_windows" text[] DEFAULT '{}'::text[] NOT NULL,
	"fast_mode" text DEFAULT 'off' NOT NULL,
	"default_mode" text DEFAULT 'default' NOT NULL,
	"max_mode" text DEFAULT 'default' NOT NULL,
	"worktree" boolean DEFAULT true NOT NULL,
	"max_concurrent" smallint DEFAULT 2 NOT NULL,
	"prompts_per_hour" smallint DEFAULT 30 NOT NULL,
	"wakes_per_session_day" smallint DEFAULT 20 NOT NULL,
	"act_on_outside_content" boolean DEFAULT false NOT NULL,
	"act_on_outside_content_by" uuid,
	"act_on_outside_content_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_work_zone_profiles_agent_uq" UNIQUE("organization_id","agent_id"),
	CONSTRAINT "bot_work_zone_profiles_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "bot_work_zone_profiles_org_id_device_uq" UNIQUE("organization_id","id","device_id"),
	CONSTRAINT "bot_work_zone_profiles_runtime_ck" CHECK ("runtime" in ('claude-code','codex')),
	CONSTRAINT "bot_work_zone_profiles_fast_mode_ck" CHECK ("fast_mode" in ('off','allowed','on')),
	CONSTRAINT "bot_work_zone_profiles_default_mode_ck" CHECK ("default_mode" in ('default','acceptEdits','plan','auto','fullAccess')),
	CONSTRAINT "bot_work_zone_profiles_max_mode_ck" CHECK ("max_mode" in ('default','acceptEdits','plan','auto','fullAccess')),
	CONSTRAINT "bot_work_zone_profiles_max_concurrent_ck" CHECK ("max_concurrent" between 1 and 10),
	CONSTRAINT "bot_work_zone_profiles_prompts_per_hour_ck" CHECK ("prompts_per_hour" between 1 and 120),
	CONSTRAINT "bot_work_zone_profiles_wakes_per_session_day_ck" CHECK ("wakes_per_session_day" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "app"."device_bot_consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"allow_full_access" boolean DEFAULT false NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "session_output_read" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "host_kind" text;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "isolated_server" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD COLUMN "author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD COLUMN "tainted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "started_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "tainted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD COLUMN "bot_sessions_max" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_zone_proposals" ADD COLUMN "tainted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "bot_work_sessions_agent_idx" ON "app"."bot_work_sessions" ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "bot_work_zone_profile_projects_project_idx" ON "app"."bot_work_zone_profile_projects" ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "bot_work_zone_profiles_device_idx" ON "app"."bot_work_zone_profiles" ("organization_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_bot_consents_live_uq" ON "app"."device_bot_consents" ("organization_id","device_id","agent_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "device_bot_consents_agent_idx" ON "app"."device_bot_consents" ("organization_id","agent_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "work_prompts_author_agent_idx" ON "app"."work_prompts" ("organization_id","author_agent_id") WHERE author_agent_id is not null;--> statement-breakpoint
CREATE INDEX "work_sessions_started_by_agent_idx" ON "app"."work_sessions" ("organization_id","started_by_agent_id") WHERE started_by_agent_id is not null;--> statement-breakpoint
ALTER TABLE "app"."bot_work_sessions" ADD CONSTRAINT "bot_work_sessions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_sessions" ADD CONSTRAINT "bot_work_sessions_session_fk" FOREIGN KEY ("organization_id","work_session_id") REFERENCES "app"."work_sessions"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_sessions" ADD CONSTRAINT "bot_work_sessions_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_sessions" ADD CONSTRAINT "bot_work_sessions_profile_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "app"."bot_work_zone_profiles"("organization_id","id") ON DELETE SET NULL ("profile_id");--> statement-breakpoint
ALTER TABLE "app"."bot_work_sessions" ADD CONSTRAINT "bot_work_sessions_origin_conversation_fk" FOREIGN KEY ("organization_id","origin_conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profile_projects" ADD CONSTRAINT "bot_work_zone_profile_projects_aG38Gi0MhaW9_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profile_projects" ADD CONSTRAINT "bot_work_zone_profile_projects_profile_fk" FOREIGN KEY ("organization_id","profile_id","device_id") REFERENCES "app"."bot_work_zone_profiles"("organization_id","id","device_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profile_projects" ADD CONSTRAINT "bot_work_zone_profile_projects_project_fk" FOREIGN KEY ("organization_id","project_id","device_id") REFERENCES "app"."projects"("organization_id","id","device_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profiles" ADD CONSTRAINT "bot_work_zone_profiles_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profiles" ADD CONSTRAINT "bot_work_zone_profiles_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_work_zone_profiles" ADD CONSTRAINT "bot_work_zone_profiles_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "app"."devices"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_bot_consents" ADD CONSTRAINT "device_bot_consents_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_bot_consents" ADD CONSTRAINT "device_bot_consents_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "app"."devices"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_bot_consents" ADD CONSTRAINT "device_bot_consents_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD CONSTRAINT "work_prompts_author_agent_fk" FOREIGN KEY ("organization_id","author_agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE SET NULL ("author_agent_id");--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_started_by_agent_fk" FOREIGN KEY ("organization_id","started_by_agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE SET NULL ("started_by_agent_id");--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_host_kind_ck" CHECK ("host_kind" in ('desktop','service'));--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD CONSTRAINT "work_prompts_agent_author_ck" CHECK ("author_agent_id" is null or "proposed_by_agent_id" is null);--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD CONSTRAINT "work_zone_policies_bot_sessions_max_ck" CHECK ("bot_sessions_max" between 0 and 1000);