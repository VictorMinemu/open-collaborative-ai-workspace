-- Phase 07.17 (D-02, D-03, D-07, D-08, D-10, D-11, D-14, PD-04, PD-05, PD-12): automation fan-out and team mentions,
-- additive only. One new table, `app.automation_conversations` (one row per item a fan-out run opened: ids and a sha256
-- hex of the external key only, never the key, a title or a body), five defaulted or nullable automation columns
-- (`fan_out_enabled` false, `fan_out_per_run` 10, `fan_out_per_day` 100, `escalation_targets` '[]', `run_log_message_id`),
-- `notifications.unit_id` (nullable) with `team_mention` admitted by `notifications_kind_check`, `org_units.handle`, the
-- `automation_runs_org_id_uq` target of the new run key and the `bot_policies` defaults 5 / 288. No drop, rename or
-- rewrite: every existing automation reads fan-out off, so its runs, cards and turns are byte-identical.
-- Hand-written below drizzle's output, and nothing else:
--   * the three composite ON DELETE SET NULL keys name their column (PostgreSQL 15+; drizzle 1.0.0-rc.4 has no builder
--     for the list, as 20261109173604_bot_work_zone), so a deleted root, run log root or unit clears only its link and
--     never `conversation_id` or `organization_id`;
--   * `org_units.handle` is added NULL, filled by `app.org_unit_handle` (the SQL twin of the contracts' `unitHandle` on
--     `app.unaccent`: lower, whitespace runs to "-", strip `[^a-z0-9._-]`, collapse "-", trim `._-`, first 40, empty →
--     'team', reserved → base || '-1'; then base-2, base-3, … with the base trimmed so a handle stays within the 40
--     characters `MENTION_TOKEN_RE` matches, until no other unit of the organization and no live bot username holds
--     it) walking units in (organization_id, created_at, id) order, then made NOT NULL, unique and checked; the
--     `org_units_fill_handle` trigger runs the same allocator for an insert that omits the handle, so N-1 code and raw
--     inserts keep working against this schema;
--   * the two data changes: `bot_policies` rows still holding the 07.6 defaults move 15 → 5 and 96 → 288 (no route
--     writes those columns, so those rows are defaults; any other value stays). These and the handle backfill are the
--     only data updates.
-- Tenant RLS on the new table is the generic post-migrate loop; its TRUNCATE revoke is in post-migrate.sql.
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.automation_conversations; DROP TRIGGER org_units_fill_handle
-- ON app.org_units; DROP FUNCTION app.org_units_fill_handle(), app.org_unit_handle(uuid, text); DROP INDEX
-- app.org_units_handle_uq; ALTER TABLE app.org_units DROP CONSTRAINT org_units_handle_check, DROP COLUMN handle; ALTER
-- TABLE app.notifications DROP CONSTRAINT notifications_unit_fk, DROP COLUMN unit_id, DROP CONSTRAINT
-- notifications_kind_check, ADD CONSTRAINT notifications_kind_check CHECK (kind in ('mention','channel','here','dm',
-- 'group_dm','thread_reply','ai_chat_shared','card_updated')) (after deleting any team_mention rows); ALTER TABLE
-- app.automations DROP CONSTRAINT automations_run_log_fk, DROP CONSTRAINT automations_fan_out_check, DROP CONSTRAINT
-- automations_fan_out_per_run_check, DROP CONSTRAINT automations_fan_out_per_day_check, DROP CONSTRAINT
-- automations_escalation_targets_check, DROP COLUMN fan_out_enabled, DROP COLUMN fan_out_per_run, DROP COLUMN
-- fan_out_per_day, DROP COLUMN escalation_targets, DROP COLUMN run_log_message_id; ALTER TABLE app.automation_runs DROP
-- CONSTRAINT automation_runs_org_id_uq; ALTER TABLE app.bot_policies ALTER COLUMN min_schedule_minutes SET DEFAULT 15,
-- ALTER COLUMN max_runs_per_day_cap SET DEFAULT 96 (rows moved to 5 / 288 keep those values unless reset by hand); and
-- delete this migration's row from drizzle.__drizzle_migrations.
CREATE TABLE "app"."automation_conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_key_hash" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"root_message_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"agent_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_conversations_key_uq" UNIQUE("automation_id","external_key_hash"),
	CONSTRAINT "automation_conversations_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "automation_conversations_hash_check" CHECK ("external_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "automation_conversations_status_check" CHECK ("status" in ('queued','delivered','skipped','failed')),
	CONSTRAINT "automation_conversations_reason_len_check" CHECK ("reason" is null or char_length("reason") <= 64)
);
--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "fan_out_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "fan_out_per_run" smallint DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "fan_out_per_day" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "escalation_targets" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "run_log_message_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."org_units" ADD COLUMN "handle" text;--> statement-breakpoint
CREATE FUNCTION app.org_unit_handle(p_organization_id uuid, p_name text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog
AS $fn$
DECLARE
  base text;
  candidate text;
  suffix text;
  n integer := 1;
BEGIN
  base := lower(app.unaccent('app.unaccent'::regdictionary, coalesce(p_name, '')));
  base := regexp_replace(base, '\s+', '-', 'g');
  base := regexp_replace(base, '[^a-z0-9._-]', '', 'g');
  base := regexp_replace(base, '-+', '-', 'g');
  base := regexp_replace(base, '^[._-]+|[._-]+$', '', 'g');
  base := regexp_replace(left(base, 40), '^[._-]+|[._-]+$', '', 'g');
  IF base = '' THEN
    base := 'team';
  END IF;
  IF base IN ('channel', 'here', 'everyone') THEN
    base := base || '-1';
  END IF;
  candidate := base;
  LOOP
    EXIT WHEN NOT EXISTS (
        SELECT 1 FROM app.org_units u WHERE u.organization_id = p_organization_id AND u.handle = candidate)
      AND NOT EXISTS (
        SELECT 1 FROM app.agents a
        WHERE a.organization_id = p_organization_id AND a.deleted_at IS NULL AND lower(a.username) = candidate);
    n := n + 1;
    suffix := '-' || n;
    candidate := regexp_replace(left(base, 40 - length(suffix)), '[._-]+$', '', 'g') || suffix;
  END LOOP;
  RETURN candidate;
END
$fn$;--> statement-breakpoint
DO $$
DECLARE
  u record;
BEGIN
  FOR u IN SELECT id, organization_id, name FROM app.org_units ORDER BY organization_id, created_at, id LOOP
    UPDATE app.org_units SET handle = app.org_unit_handle(u.organization_id, u.name) WHERE id = u.id;
  END LOOP;
END
$$;--> statement-breakpoint
ALTER TABLE "app"."org_units" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
CREATE FUNCTION app.org_units_fill_handle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $fn$
BEGIN
  IF NEW.handle IS NULL THEN
    NEW.handle := app.org_unit_handle(NEW.organization_id, NEW.name);
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER org_units_fill_handle BEFORE INSERT ON app.org_units
  FOR EACH ROW EXECUTE FUNCTION app.org_units_fill_handle();--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ALTER COLUMN "min_schedule_minutes" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "app"."bot_policies" ALTER COLUMN "max_runs_per_day_cap" SET DEFAULT 288;--> statement-breakpoint
UPDATE app.bot_policies SET min_schedule_minutes = 5 WHERE min_schedule_minutes = 15;--> statement-breakpoint
UPDATE app.bot_policies SET max_runs_per_day_cap = 288 WHERE max_runs_per_day_cap = 96;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE INDEX "automation_conversations_day_idx" ON "app"."automation_conversations" ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_conversations_run_idx" ON "app"."automation_conversations" ("run_id");--> statement-breakpoint
CREATE INDEX "automation_conversations_root_idx" ON "app"."automation_conversations" ("root_message_id") WHERE root_message_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "org_units_handle_uq" ON "app"."org_units" ("organization_id","handle");--> statement-breakpoint
ALTER TABLE "app"."automation_conversations" ADD CONSTRAINT "automation_conversations_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_conversations" ADD CONSTRAINT "automation_conversations_automation_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "app"."automations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_conversations" ADD CONSTRAINT "automation_conversations_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "app"."automation_runs"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_conversations" ADD CONSTRAINT "automation_conversations_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."automation_conversations" ADD CONSTRAINT "automation_conversations_root_fk" FOREIGN KEY ("root_message_id","conversation_id") REFERENCES "app"."messages"("id","conversation_id") ON DELETE SET NULL ("root_message_id");--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_run_log_fk" FOREIGN KEY ("run_log_message_id","conversation_id") REFERENCES "app"."messages"("id","conversation_id") ON DELETE SET NULL ("run_log_message_id");--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_unit_fk" FOREIGN KEY ("organization_id","unit_id") REFERENCES "app"."org_units"("organization_id","id") ON DELETE SET NULL ("unit_id");--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_fan_out_check" CHECK (not "fan_out_enabled" or ("action_kind" = 'agent_turn' and "trigger_kind" = 'schedule'
          and "target_kind" in ('channel','board')));--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_fan_out_per_run_check" CHECK ("fan_out_per_run" between 1 and 25);--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_fan_out_per_day_check" CHECK ("fan_out_per_day" between 1 and 500 and "fan_out_per_day" >= "fan_out_per_run");--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_escalation_targets_check" CHECK (jsonb_typeof("escalation_targets") = 'array' and jsonb_array_length("escalation_targets") <= 5);--> statement-breakpoint
ALTER TABLE "app"."org_units" ADD CONSTRAINT "org_units_handle_check" CHECK ("handle" ~ '^[a-z0-9]([a-z0-9._-]{0,46}[a-z0-9])?$');--> statement-breakpoint
ALTER TABLE "app"."notifications" DROP CONSTRAINT "notifications_kind_check", ADD CONSTRAINT "notifications_kind_check" CHECK ("kind" in ('mention','channel','here','dm','group_dm','thread_reply','ai_chat_shared','card_updated','team_mention'));