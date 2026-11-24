-- Phase 07.18 (D-01, D-03, D-04, D-06, D-13, PD-04, PD-15, PD-21, PD-25; ADR-0044): the subscription account pool.
-- `app.account_pool_accounts` (the organization's Claude setup-token accounts, whose token is only a `secret_id` to a
-- sealed `pool_token` secret, never a column; its ChatGPT sign-ins on a device, `device_slot`, and in the OpenClaw cell,
-- `cell_profile`; order, weight, cooldown, limit reason, last use, weighted round-robin state and the last reported
-- usage; soft removal through `removed_at`, which frees the slot and profile keys) and `app.account_pool_policies` (one
-- strategy, scope and device-login fallback per organization and provider, defaults `failover`, `all`, on);
-- `work_sessions.pool_account_id` (nullable, `SET NULL ("pool_account_id")`), `work_prompts.account_switches` (default 0,
-- 0 … 3) and `devices.account_pool_version` (nullable, 1 … 100, written only from the device's own hello); and
-- `secrets_kind_check` accepts `pool_token`. Every reference is composite with the organization (FKs bypass RLS); deleting
-- a device deletes its slots, deleting a secret only unlinks it. Tenant isolation (ENABLE + FORCE RLS,
-- `tenant_isolation`) and the TRUNCATE revokes come from post-migrate.
-- Additive only: new tables, nullable or defaulted columns, the secret kind check widened; no drop, no rename, no
-- rewrite, no data update, so N-1 code keeps working. Chained after 20261113182003_bot_policy_conversations (earlier
-- migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): ALTER TABLE app.work_sessions DROP CONSTRAINT work_sessions_pool_account_fk;
-- DROP INDEX app.work_sessions_pool_account_idx; ALTER TABLE app.work_sessions DROP COLUMN pool_account_id; ALTER TABLE
-- app.work_prompts DROP CONSTRAINT work_prompts_account_switches_ck, DROP COLUMN account_switches; ALTER TABLE
-- app.devices DROP CONSTRAINT devices_account_pool_version_ck, DROP COLUMN account_pool_version; DROP TABLE
-- app.account_pool_policies; DROP TABLE app.account_pool_accounts; restore the kind check without 'pool_token' (only
-- once no `pool_token` secret is left); run the previous release's post-migrate and delete this migration's row from
-- drizzle.__drizzle_migrations.
CREATE TABLE "app"."account_pool_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"secret_id" uuid,
	"device_id" uuid,
	"slot_id" uuid,
	"cell_profile_id" text,
	"origin" text DEFAULT 'admin' NOT NULL,
	"credential_state" text DEFAULT 'ok' NOT NULL,
	"plan_type" text,
	"cooldown_until" timestamp with time zone,
	"limit_reason" text,
	"last_used_at" timestamp with time zone,
	"wrr_current" integer DEFAULT 0 NOT NULL,
	"usage" jsonb,
	"usage_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "account_pool_accounts_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "account_pool_accounts_provider_ck" CHECK ("provider" in ('claude','chatgpt')),
	CONSTRAINT "account_pool_accounts_kind_ck" CHECK ("kind" in ('token','device_slot','cell_profile')),
	CONSTRAINT "account_pool_accounts_origin_ck" CHECK ("origin" in ('admin','device_cli','adopted')),
	CONSTRAINT "account_pool_accounts_credential_state_ck" CHECK ("credential_state" in ('ok','needs_sign_in')),
	CONSTRAINT "account_pool_accounts_limit_reason_ck" CHECK ("limit_reason" is null or "limit_reason" in ('five_hour','seven_day','weekly_model','usage_limit','rate_limit','billing','auth_failed','unknown')),
	CONSTRAINT "account_pool_accounts_label_ck" CHECK (char_length("label") between 1 and 120),
	CONSTRAINT "account_pool_accounts_weight_ck" CHECK ("weight" between 1 and 100),
	CONSTRAINT "account_pool_accounts_priority_ck" CHECK ("priority" >= 0),
	CONSTRAINT "account_pool_accounts_plan_type_ck" CHECK ("plan_type" is null or char_length("plan_type") <= 64),
	CONSTRAINT "account_pool_accounts_cell_profile_id_ck" CHECK ("cell_profile_id" is null or char_length("cell_profile_id") between 1 and 120),
	CONSTRAINT "account_pool_accounts_shape_ck" CHECK (case "kind"
        when 'token' then "provider" = 'claude' and "device_id" is null and "cell_profile_id" is null and ("secret_id" is not null or "removed_at" is not null)
        when 'device_slot' then "provider" = 'chatgpt' and "device_id" is not null and "slot_id" is not null
        when 'cell_profile' then "provider" = 'chatgpt' and "cell_profile_id" is not null
        else false end)
);
--> statement-breakpoint
CREATE TABLE "app"."account_pool_policies" (
	"organization_id" uuid,
	"provider" text,
	"strategy" text DEFAULT 'failover' NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"fallback_to_device_login" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_pool_policies_pkey" PRIMARY KEY("organization_id","provider"),
	CONSTRAINT "account_pool_policies_provider_ck" CHECK ("provider" in ('claude','chatgpt')),
	CONSTRAINT "account_pool_policies_strategy_ck" CHECK ("strategy" in ('failover','round_robin','weighted')),
	CONSTRAINT "account_pool_policies_scope_ck" CHECK ("scope" in ('all','work_zone','bots'))
);
--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "account_pool_version" integer;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD COLUMN "account_switches" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "pool_account_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "account_pool_accounts_slot_uq" ON "app"."account_pool_accounts" ("organization_id","device_id","slot_id") WHERE removed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_pool_accounts_profile_uq" ON "app"."account_pool_accounts" ("organization_id","cell_profile_id") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "account_pool_accounts_org_provider_idx" ON "app"."account_pool_accounts" ("organization_id","provider","priority");--> statement-breakpoint
CREATE INDEX "work_sessions_pool_account_idx" ON "app"."work_sessions" ("organization_id","pool_account_id") WHERE pool_account_id is not null;--> statement-breakpoint
ALTER TABLE "app"."account_pool_accounts" ADD CONSTRAINT "account_pool_accounts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."account_pool_accounts" ADD CONSTRAINT "account_pool_accounts_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "app"."devices"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."account_pool_accounts" ADD CONSTRAINT "account_pool_accounts_secret_fk" FOREIGN KEY ("organization_id","secret_id") REFERENCES "app"."secrets"("organization_id","id") ON DELETE SET NULL ("secret_id");--> statement-breakpoint
ALTER TABLE "app"."account_pool_policies" ADD CONSTRAINT "account_pool_policies_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_pool_account_fk" FOREIGN KEY ("organization_id","pool_account_id") REFERENCES "app"."account_pool_accounts"("organization_id","id") ON DELETE SET NULL ("pool_account_id");--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_account_pool_version_ck" CHECK ("account_pool_version" is null or "account_pool_version" between 1 and 100);--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD CONSTRAINT "work_prompts_account_switches_ck" CHECK ("account_switches" between 0 and 3);--> statement-breakpoint
ALTER TABLE "app"."secrets" DROP CONSTRAINT "secrets_kind_check", ADD CONSTRAINT "secrets_kind_check" CHECK ("kind" in ('provider_api_key','mcp_credential','user_model_credential','connector_credential','vault_item','browser_session','webhook_secret','pool_token'));