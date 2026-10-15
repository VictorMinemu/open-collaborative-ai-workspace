-- Phase 07.8 (D-01, D-08, D-09, D-11, D-12, C-02), hand-edited in drizzle's output below:
-- * The two composite ON DELETE SET NULL keys on `session_id` name their column (PostgreSQL 15+; drizzle 1.0.0-rc.4 has
--   no builder for the list), so a revoked browser session unlinks its contexts and sign-in requests and never nulls
--   `organization_id`.
-- * `secrets_kind_check` is new: until now only the TypeScript enum listed the kinds. It lists every kind written so
--   far plus `browser_session`.
-- * Forced tenant RLS on the ten tables comes from post-migrate.sql's generic loop; the RESTRICTIVE owner-only policy on
--   `browser_sessions` is in post-migrate.sql too. No deny rule is seeded and nothing is backfilled (D-12).
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.sandbox_package_installs, app.sandbox_packages,
-- app.bot_turn_activity, app.browser_signin_requests, app.browser_contexts, app.browser_sessions,
-- app.sandbox_event_cursor, app.sandbox_usage_daily, app.bot_sandboxes, app.sandbox_policies; ALTER TABLE
-- app.agent_turns DROP COLUMN sandbox_calls, DROP COLUMN member_data; ALTER TABLE app.secrets DROP CONSTRAINT
-- secrets_kind_check, DROP CONSTRAINT secrets_org_id_uq; ALTER TABLE app.conversations DROP CONSTRAINT
-- conversations_org_id_uq. Delete the `browser_session` rows of app.secrets before dropping the kind check.
CREATE TABLE "app"."bot_sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"runtime" text,
	"disk_bytes" bigint DEFAULT 0 NOT NULL,
	"last_active_at" timestamp with time zone,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_sandboxes_agent_kind_uq" UNIQUE("organization_id","agent_id","kind"),
	CONSTRAINT "bot_sandboxes_kind_check" CHECK ("kind" in ('sbx','brw')),
	CONSTRAINT "bot_sandboxes_state_check" CHECK ("state" in ('absent','starting','running','stopping','stopped','disk_full','killed','unavailable')),
	CONSTRAINT "bot_sandboxes_runtime_check" CHECK ("runtime" is null or "runtime" in ('gvisor','hardened-runc')),
	CONSTRAINT "bot_sandboxes_stop_reason_check" CHECK ("stop_reason" is null or "stop_reason" in ('kill_switch','disk_full','idle','user','service_down')),
	CONSTRAINT "bot_sandboxes_disk_check" CHECK ("disk_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."bot_turn_activity" (
	"event_id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_root_message_id" uuid,
	"reply_message_id" uuid,
	"steps" jsonb DEFAULT '[]' NOT NULL,
	"more" integer DEFAULT 0 NOT NULL,
	"running" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_turn_activity_steps_check" CHECK (jsonb_typeof("steps") = 'array' and jsonb_array_length("steps") <= 50
        and "more" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."browser_contexts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_root_message_id" uuid,
	"requested_for_user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"host" text NOT NULL,
	"secure" boolean NOT NULL,
	"state" text NOT NULL,
	"session_id" uuid,
	"controller_user_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"paused_for" text,
	"held_until" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "browser_contexts_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "browser_contexts_host_check" CHECK ("host" = lower("host") and char_length("host") between 1 and 260
      and position('/' in "host") = 0 and position('@' in "host") = 0),
	CONSTRAINT "browser_contexts_state_check" CHECK ("state" in ('live','idle','paused','ended')),
	CONSTRAINT "browser_contexts_paused_for_check" CHECK ("paused_for" is null or "paused_for" in ('approval','signin')),
	CONSTRAINT "browser_contexts_end_reason_check" CHECK ("end_reason" is null or "end_reason" in ('closed_by_bot','idle','kill_switch','module_off','crashed','access_lost')),
	CONSTRAINT "browser_contexts_lease_check" CHECK (("controller_user_id" is null) = ("lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"site_key" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "browser_sessions_owner_site_uq" UNIQUE("organization_id","user_id","agent_id","site_key"),
	CONSTRAINT "browser_sessions_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "browser_sessions_site_key_check" CHECK ("site_key" = lower("site_key") and char_length("site_key") between 1 and 260
      and position('/' in "site_key") = 0 and position('@' in "site_key") = 0)
);
--> statement-breakpoint
CREATE TABLE "app"."browser_signin_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"card_message_id" uuid,
	"host" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"stop_reason" text,
	"session_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_signin_requests_event_uq" UNIQUE("organization_id","event_id","context_id"),
	CONSTRAINT "browser_signin_requests_host_check" CHECK ("host" = lower("host") and char_length("host") between 1 and 260
      and position('/' in "host") = 0 and position('@' in "host") = 0),
	CONSTRAINT "browser_signin_requests_reason_check" CHECK (char_length("reason") between 1 and 200),
	CONSTRAINT "browser_signin_requests_status_check" CHECK ("status" in ('waiting','signing_in','signed_in','skipped','expired','stopped')),
	CONSTRAINT "browser_signin_requests_stop_reason_check" CHECK ("stop_reason" is null or "stop_reason" in ('closed_by_bot','idle','kill_switch','module_off','crashed','access_lost'))
);
--> statement-breakpoint
CREATE TABLE "app"."sandbox_event_cursor" (
	"organization_id" uuid PRIMARY KEY,
	"boot_id" uuid NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_event_cursor_seq_check" CHECK ("seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."sandbox_package_installs" (
	"organization_id" uuid,
	"agent_id" uuid,
	"package_id" uuid,
	"status" text NOT NULL,
	"detail" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_package_installs_pkey" PRIMARY KEY("organization_id","agent_id","package_id"),
	CONSTRAINT "sandbox_package_installs_status_check" CHECK ("status" in ('pending','installing','installed','failed','removing')),
	CONSTRAINT "sandbox_package_installs_detail_check" CHECK ("detail" is null or char_length("detail") <= 200)
);
--> statement-breakpoint
CREATE TABLE "app"."sandbox_packages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"license" text,
	"publisher" text,
	"has_install_script" boolean NOT NULL,
	"risk" text NOT NULL,
	"risk_reasons" jsonb DEFAULT '[]' NOT NULL,
	"review_token" text NOT NULL,
	"tree_sha256" text NOT NULL,
	"dependency_count" integer NOT NULL,
	"lockfile" text NOT NULL,
	"changed_upstream" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"personal_allowed" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_packages_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "sandbox_packages_source_check" CHECK ("source" in ('npm','pypi','debian','clawhub')),
	CONSTRAINT "sandbox_packages_name_check" CHECK (char_length("name") between 1 and 214),
	CONSTRAINT "sandbox_packages_version_check" CHECK (char_length("version") between 1 and 128),
	CONSTRAINT "sandbox_packages_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sandbox_packages_size_check" CHECK ("size_bytes" >= 0),
	CONSTRAINT "sandbox_packages_risk_check" CHECK ("risk" in ('low','medium','high','refuse')),
	CONSTRAINT "sandbox_packages_risk_reasons_check" CHECK (jsonb_typeof("risk_reasons") = 'array' and jsonb_array_length("risk_reasons") <= 10),
	CONSTRAINT "sandbox_packages_tree_check" CHECK ("tree_sha256" ~ '^[0-9a-f]{64}$'
        and "dependency_count" between 0 and 5000),
	CONSTRAINT "sandbox_packages_lockfile_check" CHECK (octet_length("lockfile") <= 2097152),
	CONSTRAINT "sandbox_packages_status_check" CHECK ("status" in ('approved','removed'))
);
--> statement-breakpoint
CREATE TABLE "app"."sandbox_policies" (
	"organization_id" uuid PRIMARY KEY,
	"enabled" boolean DEFAULT false NOT NULL,
	"sandbox_egress_mode" text DEFAULT 'allowlist' NOT NULL,
	"browser_egress_mode" text DEFAULT 'public' NOT NULL,
	"egress_allow_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_sandboxes" integer DEFAULT 10 NOT NULL,
	"max_browsers" integer DEFAULT 3 NOT NULL,
	"cpu_minutes_per_day" integer DEFAULT 600 NOT NULL,
	"disk_per_bot_mb" integer DEFAULT 2048 NOT NULL,
	"disk_total_mb" integer DEFAULT 51200 NOT NULL,
	"browser_session_max_days" integer DEFAULT 30 NOT NULL,
	"killed_at" timestamp with time zone,
	"killed_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_policies_egress_mode_check" CHECK ("sandbox_egress_mode" in ('off','allowlist','public') and "browser_egress_mode" in ('off','allowlist','public')),
	CONSTRAINT "sandbox_policies_allow_hosts_check" CHECK (cardinality("egress_allow_hosts") <= 64
        and array_position("egress_allow_hosts", null) is null),
	CONSTRAINT "sandbox_policies_limits_check" CHECK ("max_sandboxes" between 0 and 100 and "max_browsers" between 0 and 50
        and "cpu_minutes_per_day" between 1 and 100000 and "disk_per_bot_mb" between 64 and 102400
        and "disk_total_mb" between 64 and 1048576),
	CONSTRAINT "sandbox_policies_session_days_check" CHECK ("browser_session_max_days" between 1 and 90),
	CONSTRAINT "sandbox_policies_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."sandbox_usage_daily" (
	"organization_id" uuid,
	"agent_id" uuid,
	"day" date,
	"cpu_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sandbox_usage_daily_pkey" PRIMARY KEY("organization_id","agent_id","day"),
	CONSTRAINT "sandbox_usage_daily_cpu_check" CHECK ("cpu_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "sandbox_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "member_data" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD CONSTRAINT "secrets_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE INDEX "bot_turn_activity_reply_idx" ON "app"."bot_turn_activity" ("organization_id","reply_message_id") WHERE reply_message_id is not null;--> statement-breakpoint
CREATE INDEX "bot_turn_activity_agent_idx" ON "app"."bot_turn_activity" ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "browser_contexts_open_idx" ON "app"."browser_contexts" ("organization_id","conversation_id") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "browser_contexts_agent_idx" ON "app"."browser_contexts" ("organization_id","agent_id","opened_at");--> statement-breakpoint
CREATE INDEX "browser_contexts_session_idx" ON "app"."browser_contexts" ("organization_id","session_id") WHERE session_id is not null;--> statement-breakpoint
CREATE INDEX "browser_sessions_secret_idx" ON "app"."browser_sessions" ("organization_id","secret_id");--> statement-breakpoint
CREATE INDEX "browser_sessions_agent_idx" ON "app"."browser_sessions" ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "browser_signin_requests_context_idx" ON "app"."browser_signin_requests" ("organization_id","context_id");--> statement-breakpoint
CREATE INDEX "browser_signin_requests_session_idx" ON "app"."browser_signin_requests" ("organization_id","session_id") WHERE session_id is not null;--> statement-breakpoint
CREATE INDEX "sandbox_package_installs_package_idx" ON "app"."sandbox_package_installs" ("organization_id","package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_packages_org_source_name_uq" ON "app"."sandbox_packages" ("organization_id","source","name") WHERE status <> 'removed';--> statement-breakpoint
ALTER TABLE "app"."bot_sandboxes" ADD CONSTRAINT "bot_sandboxes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_sandboxes" ADD CONSTRAINT "bot_sandboxes_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_turn_activity" ADD CONSTRAINT "bot_turn_activity_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."bot_turn_activity" ADD CONSTRAINT "bot_turn_activity_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_contexts" ADD CONSTRAINT "browser_contexts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_contexts" ADD CONSTRAINT "browser_contexts_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_contexts" ADD CONSTRAINT "browser_contexts_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_contexts" ADD CONSTRAINT "browser_contexts_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "app"."browser_sessions"("organization_id","id") ON DELETE SET NULL ("session_id");--> statement-breakpoint
ALTER TABLE "app"."browser_sessions" ADD CONSTRAINT "browser_sessions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_sessions" ADD CONSTRAINT "browser_sessions_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_sessions" ADD CONSTRAINT "browser_sessions_secret_fk" FOREIGN KEY ("organization_id","secret_id") REFERENCES "app"."secrets"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_signin_requests" ADD CONSTRAINT "browser_signin_requests_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_signin_requests" ADD CONSTRAINT "browser_signin_requests_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_signin_requests" ADD CONSTRAINT "browser_signin_requests_context_fk" FOREIGN KEY ("organization_id","context_id") REFERENCES "app"."browser_contexts"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."browser_signin_requests" ADD CONSTRAINT "browser_signin_requests_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "app"."browser_sessions"("organization_id","id") ON DELETE SET NULL ("session_id");--> statement-breakpoint
ALTER TABLE "app"."sandbox_event_cursor" ADD CONSTRAINT "sandbox_event_cursor_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."sandbox_package_installs" ADD CONSTRAINT "sandbox_package_installs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."sandbox_package_installs" ADD CONSTRAINT "sandbox_package_installs_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."sandbox_package_installs" ADD CONSTRAINT "sandbox_package_installs_package_fk" FOREIGN KEY ("organization_id","package_id") REFERENCES "app"."sandbox_packages"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."sandbox_packages" ADD CONSTRAINT "sandbox_packages_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."sandbox_policies" ADD CONSTRAINT "sandbox_policies_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."sandbox_usage_daily" ADD CONSTRAINT "sandbox_usage_daily_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."sandbox_usage_daily" ADD CONSTRAINT "sandbox_usage_daily_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD CONSTRAINT "agent_turns_sandbox_calls_check" CHECK ("sandbox_calls" >= 0);--> statement-breakpoint
ALTER TABLE "app"."secrets" ADD CONSTRAINT "secrets_kind_check" CHECK ("kind" in ('provider_api_key','mcp_credential','user_model_credential','connector_credential','vault_item','browser_session'));
