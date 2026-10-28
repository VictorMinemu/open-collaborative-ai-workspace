-- Phase 07.11 (D-02, D-06, PD-04; ADR-0032): runtime CLI auto-updates. Adds `work_zone_policies.runtime_updates`
-- (the organization's level, `automatic` | `notify` | `off`, default `automatic`, checked by
-- `work_zone_policies_runtime_updates_ck`; a device can only lower it), `devices.runtime_maintenance` (the device's
-- last `runtime.maintenance` snapshot, written only from the device socket; null = never reported) and creates
-- `device_runtime_updates` (the update history: one row per "Update now" request and per run a device reports; at most
-- one `requested` row per device and runtime, `device_runtime_updates_requested_uq`; replays refused by
-- `device_runtime_updates_run_uq`; output and error length-checked; no column ever holds a host path). Tenant isolation
-- comes from post-migrate (every `app` table with `organization_id`); the device reference is composite with the
-- organization (07.4 #169), so deleting a device deletes its history. `device_commands.kind` gains `runtime.update`
-- in the TypeScript enum only (the column has no check). No existing row changes value: every policy row reads
-- `automatic`, every device `null`.
-- Chained after 20261023003251_work_zone_visibility (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.device_runtime_updates; ALTER TABLE app.devices DROP COLUMN
-- runtime_maintenance; ALTER TABLE app.work_zone_policies DROP COLUMN runtime_updates.
CREATE TABLE "app"."device_runtime_updates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"run_id" uuid,
	"command_id" uuid,
	"trigger" text NOT NULL,
	"requested_by" uuid,
	"state" text NOT NULL,
	"from_version" text,
	"to_version" text,
	"candidate" text,
	"method" text,
	"output" text,
	"error" text,
	"requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_runtime_updates_run_uq" UNIQUE("organization_id","device_id","run_id"),
	CONSTRAINT "device_runtime_updates_runtime_ck" CHECK ("runtime" in ('claude-code','codex')),
	CONSTRAINT "device_runtime_updates_trigger_ck" CHECK ("trigger" in ('automatic','manual','local')),
	CONSTRAINT "device_runtime_updates_state_ck" CHECK ("state" in ('requested','started','succeeded','unchanged','failed','skipped_broken','refused','expired')),
	CONSTRAINT "device_runtime_updates_output_len_ck" CHECK ("output" is null or char_length("output") <= 4096),
	CONSTRAINT "device_runtime_updates_error_len_ck" CHECK ("error" is null or char_length("error") <= 500)
);
--> statement-breakpoint
ALTER TABLE "app"."devices" ADD COLUMN "runtime_maintenance" jsonb;--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD COLUMN "runtime_updates" text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "device_runtime_updates_requested_uq" ON "app"."device_runtime_updates" ("organization_id","device_id","runtime") WHERE state = 'requested';--> statement-breakpoint
CREATE INDEX "device_runtime_updates_device_idx" ON "app"."device_runtime_updates" ("organization_id","device_id","created_at");--> statement-breakpoint
ALTER TABLE "app"."device_runtime_updates" ADD CONSTRAINT "device_runtime_updates_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."device_runtime_updates" ADD CONSTRAINT "device_runtime_updates_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "app"."devices"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_zone_policies" ADD CONSTRAINT "work_zone_policies_runtime_updates_ck" CHECK ("runtime_updates" in ('automatic','notify','off'));