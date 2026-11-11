-- Phase 07.17.1 (D-02, D-07, PD-14, PD-22; ADR-0040): runtime self-update. The 07.11 update history
-- (`device_runtime_updates`) accepts the OCW runtime itself as a maintenance target (`runtime = 'ocw-runtime'`,
-- `device_runtime_updates_runtime_ck` widened by one value) and records the builds of a run in two nullable columns,
-- `from_build` and `to_build`, each null or 12 lowercase hex (`device_runtime_updates_build_ck`; never a full sha256,
-- never a host path). The old runtime values are all still admitted and both builds may be null, so N-1 code that never
-- writes `ocw-runtime` or a build keeps working. `device_runtime_updates_requested_uq` is unchanged: at most one
-- `requested` row per device and target. Additive only: no drop of data, no rename, no rewrite, no data update.
-- Chained after 20261110124940_automation_item_waiting (earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator), after deleting any `ocw-runtime` row: ALTER TABLE
-- app.device_runtime_updates DROP CONSTRAINT device_runtime_updates_runtime_ck, ADD CONSTRAINT
-- device_runtime_updates_runtime_ck CHECK (runtime in ('claude-code','codex')), DROP CONSTRAINT
-- device_runtime_updates_build_ck, DROP COLUMN from_build, DROP COLUMN to_build; and delete this migration's row from
-- drizzle.__drizzle_migrations.
ALTER TABLE "app"."device_runtime_updates" ADD COLUMN "from_build" text;--> statement-breakpoint
ALTER TABLE "app"."device_runtime_updates" ADD COLUMN "to_build" text;--> statement-breakpoint
ALTER TABLE "app"."device_runtime_updates" ADD CONSTRAINT "device_runtime_updates_build_ck" CHECK (("from_build" is null or "from_build" ~ '^[0-9a-f]{12}$') and ("to_build" is null or "to_build" ~ '^[0-9a-f]{12}$'));--> statement-breakpoint
ALTER TABLE "app"."device_runtime_updates" DROP CONSTRAINT "device_runtime_updates_runtime_ck", ADD CONSTRAINT "device_runtime_updates_runtime_ck" CHECK ("runtime" in ('claude-code','codex','ocw-runtime'));