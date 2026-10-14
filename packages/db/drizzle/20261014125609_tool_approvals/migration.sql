CREATE TABLE "app"."tool_approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"scope_unit_id" uuid,
	"tool_pattern" text NOT NULL,
	"mode" text NOT NULL,
	"approver_kind" text DEFAULT 'requester' NOT NULL,
	"approver_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_approval_policies_scope_pattern_uq" UNIQUE NULLS NOT DISTINCT("organization_id","scope_unit_id","tool_pattern"),
	CONSTRAINT "tool_approval_policies_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "tool_approval_policies_mode_check" CHECK ("mode" in ('never','always','when_tainted')),
	CONSTRAINT "tool_approval_policies_approver_kind_check" CHECK ("approver_kind" in ('requester','users','unit_leads','admins')),
	CONSTRAINT "tool_approval_policies_approvers_check" CHECK (array_position("approver_user_ids", null) is null and case when "approver_kind" = 'users'
        then cardinality("approver_user_ids") between 1 and 20
        else cardinality("approver_user_ids") = 0 end),
	CONSTRAINT "tool_approval_policies_unit_leads_scope_check" CHECK ("approver_kind" <> 'unit_leads' or "scope_unit_id" is not null),
	CONSTRAINT "tool_approval_policies_never_requester_check" CHECK ("mode" <> 'never' or "approver_kind" = 'requester'),
	CONSTRAINT "tool_approval_policies_version_check" CHECK ("version" >= 1),
	CONSTRAINT "tool_approval_policies_tool_pattern_len_check" CHECK (char_length("tool_pattern") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "app"."tool_call_approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"requested_for_user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_root_message_id" uuid,
	"event_id" uuid NOT NULL,
	"tool_call_id" text,
	"tool" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid,
	"target" text,
	"arguments_canonical" text NOT NULL,
	"arguments_sha256" text NOT NULL,
	"action_hash" text NOT NULL,
	"tainted" boolean NOT NULL,
	"policy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_call_approvals_source_kind_check" CHECK ("source_kind" in ('builtin','mcp','plugin','vault')),
	CONSTRAINT "tool_call_approvals_arguments_size_check" CHECK (octet_length("arguments_canonical") <= 32768),
	CONSTRAINT "tool_call_approvals_arguments_sha256_check" CHECK ("arguments_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tool_call_approvals_action_hash_check" CHECK ("action_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tool_call_approvals_tool_len_check" CHECK (char_length("tool") between 1 and 200),
	CONSTRAINT "tool_call_approvals_tool_call_id_len_check" CHECK ("tool_call_id" is null or char_length("tool_call_id") between 1 and 200),
	CONSTRAINT "tool_call_approvals_target_len_check" CHECK ("target" is null or char_length("target") <= 255)
);
--> statement-breakpoint
CREATE TABLE "app"."work_zone_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"requested_for_user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_root_message_id" uuid,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"prompt" text NOT NULL,
	"prompt_sha256" text NOT NULL,
	"work_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_zone_proposals_runtime_check" CHECK ("runtime" in ('claude-code','codex')),
	CONSTRAINT "work_zone_proposals_prompt_len_check" CHECK (char_length("prompt") between 1 and 50000),
	CONSTRAINT "work_zone_proposals_prompt_sha256_check" CHECK ("prompt_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD COLUMN "proposed_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "app"."org_units" ADD CONSTRAINT "org_units_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_org_id_device_uq" UNIQUE("organization_id","id","device_id");--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE INDEX "tool_call_approvals_hash_idx" ON "app"."tool_call_approvals" ("organization_id","action_hash");--> statement-breakpoint
CREATE INDEX "tool_call_approvals_requester_idx" ON "app"."tool_call_approvals" ("organization_id","agent_id","requested_for_user_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_call_approvals_policy_idx" ON "app"."tool_call_approvals" ("organization_id","policy_id") WHERE policy_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_approvals_event_call_uq" ON "app"."tool_call_approvals" ("organization_id","event_id","tool_call_id") WHERE tool_call_id is not null;--> statement-breakpoint
CREATE INDEX "work_prompts_proposed_by_idx" ON "app"."work_prompts" ("organization_id","proposed_by_agent_id") WHERE proposed_by_agent_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "work_zone_proposals_request_uq" ON "app"."work_zone_proposals" ("organization_id","event_id","project_id","device_id","prompt_sha256");--> statement-breakpoint
CREATE INDEX "work_zone_proposals_requester_idx" ON "app"."work_zone_proposals" ("organization_id","agent_id","requested_for_user_id","created_at");--> statement-breakpoint
CREATE INDEX "work_zone_proposals_session_idx" ON "app"."work_zone_proposals" ("organization_id","work_session_id") WHERE work_session_id is not null;--> statement-breakpoint
ALTER TABLE "app"."tool_approval_policies" ADD CONSTRAINT "tool_approval_policies_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."tool_approval_policies" ADD CONSTRAINT "tool_approval_policies_unit_fk" FOREIGN KEY ("organization_id","scope_unit_id") REFERENCES "app"."org_units"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."tool_call_approvals" ADD CONSTRAINT "tool_call_approvals_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."tool_call_approvals" ADD CONSTRAINT "tool_call_approvals_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."tool_call_approvals" ADD CONSTRAINT "tool_call_approvals_policy_fk" FOREIGN KEY ("organization_id","policy_id") REFERENCES "app"."tool_approval_policies"("organization_id","id") ON DELETE SET NULL ("policy_id");--> statement-breakpoint
ALTER TABLE "app"."work_prompts" ADD CONSTRAINT "work_prompts_proposed_by_agent_fk" FOREIGN KEY ("organization_id","proposed_by_agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE SET NULL ("proposed_by_agent_id");--> statement-breakpoint
ALTER TABLE "app"."work_zone_proposals" ADD CONSTRAINT "work_zone_proposals_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_zone_proposals" ADD CONSTRAINT "work_zone_proposals_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_zone_proposals" ADD CONSTRAINT "work_zone_proposals_project_fk" FOREIGN KEY ("organization_id","project_id","device_id") REFERENCES "app"."projects"("organization_id","id","device_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_zone_proposals" ADD CONSTRAINT "work_zone_proposals_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "app"."devices"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_zone_proposals" ADD CONSTRAINT "work_zone_proposals_session_fk" FOREIGN KEY ("organization_id","work_session_id") REFERENCES "app"."work_sessions"("organization_id","id") ON DELETE SET NULL ("work_session_id");--> statement-breakpoint
-- Phase 07.5 (D-04, APPROVE-02/03), hand-written below drizzle's output:
-- * The three composite ON DELETE SET NULL keys above name their column (PostgreSQL 15+; drizzle 1.0.0-rc.4 has no
--   builder for the list), so a deleted rule, bot or session clears only its link and never `organization_id`.
-- * A stored tool-call action never changes once stored: the approval hash is recomputed from it at every decision and
--   grant use. The only update allowed is the rule's ON DELETE SET NULL of `policy_id`. A Work Zone proposal never
--   changes either, except `work_session_id`: set once when the person starts it, cleared by the session's deletion.
--   Both refuse every other update for every role, as defence in depth (as 07.4's template versions); deletes are not
--   blocked (they happen through the bot's, project's or device's cascade).
-- Forward-only. Rollback (as ocw_migrator): DROP TRIGGER tool_call_approval_immutable ON app.tool_call_approvals;
-- DROP TRIGGER work_zone_proposal_immutable ON app.work_zone_proposals; DROP FUNCTION
-- app.tool_call_approval_immutable(); DROP FUNCTION app.work_zone_proposal_immutable(); DROP TABLE
-- app.work_zone_proposals, app.tool_call_approvals, app.tool_approval_policies; ALTER TABLE app.work_prompts DROP COLUMN
-- proposed_by_agent_id; ALTER TABLE app.agent_tool_calls DROP COLUMN approval_id; and the five `*_org_id*_uq` constraints.
CREATE OR REPLACE FUNCTION app.tool_call_approval_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF (to_jsonb(NEW) - 'policy_id') IS DISTINCT FROM (to_jsonb(OLD) - 'policy_id')
     OR (NEW.policy_id IS NOT NULL AND NEW.policy_id IS DISTINCT FROM OLD.policy_id) THEN
    RAISE EXCEPTION 'tool call approvals are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tool_call_approval_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER tool_call_approval_immutable BEFORE UPDATE ON app.tool_call_approvals
  FOR EACH ROW EXECUTE FUNCTION app.tool_call_approval_immutable();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.work_zone_proposal_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF (to_jsonb(NEW) - 'work_session_id') IS DISTINCT FROM (to_jsonb(OLD) - 'work_session_id')
     OR (OLD.work_session_id IS NOT NULL AND NEW.work_session_id IS NOT NULL
         AND NEW.work_session_id IS DISTINCT FROM OLD.work_session_id) THEN
    RAISE EXCEPTION 'work zone proposals are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.work_zone_proposal_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE TRIGGER work_zone_proposal_immutable BEFORE UPDATE ON app.work_zone_proposals
  FOR EACH ROW EXECUTE FUNCTION app.work_zone_proposal_immutable();
