CREATE TABLE "app"."device_grants" (
	"organization_id" uuid NOT NULL,
	"device_id" uuid,
	"principal_kind" text,
	"principal_id" uuid,
	"max_mode" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "device_grants_pkey" PRIMARY KEY("device_id","principal_kind","principal_id"),
	CONSTRAINT "device_grants_principal_kind_ck" CHECK ("principal_kind" in ('user','unit')),
	CONSTRAINT "device_grants_max_mode_ck" CHECK ("max_mode" in ('default','acceptEdits','plan','auto','fullAccess'))
);
--> statement-breakpoint
CREATE TABLE "app"."work_zone_policies" (
	"organization_id" uuid PRIMARY KEY,
	"allowed_permission_modes" text[] DEFAULT '{plan,default,acceptEdits,auto}'::text[] NOT NULL,
	"allow_full_access" boolean DEFAULT false NOT NULL,
	"allowed_models" jsonb DEFAULT '{}' NOT NULL,
	"max_effort" jsonb DEFAULT '{}' NOT NULL,
	"allow_fast_mode" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "full_access_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "share_max_mode" text DEFAULT 'acceptEdits' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "runtime_catalog" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD COLUMN "permission_mode" text;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "settings" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "effective_settings" jsonb;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "settings_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "diff_stat" jsonb;--> statement-breakpoint
CREATE INDEX "device_grants_principal_idx" ON "app"."device_grants" ("organization_id","principal_kind","principal_id");--> statement-breakpoint
ALTER TABLE "app"."device_grants" ADD CONSTRAINT "device_grants_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_grants" ADD CONSTRAINT "device_grants_device_id_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "app"."devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD CONSTRAINT "work_zone_policies_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_share_max_mode_ck" CHECK ("share_max_mode" in ('default','acceptEdits','plan','auto','fullAccess'));--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD CONSTRAINT "work_prompts_permission_mode_ck" CHECK ("permission_mode" in ('default','acceptEdits','plan','auto','fullAccess'));--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_permission_mode_ck" CHECK ("permission_mode" in ('default','acceptEdits','plan','auto','fullAccess'));