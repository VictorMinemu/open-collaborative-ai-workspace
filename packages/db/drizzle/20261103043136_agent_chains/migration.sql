-- Phase 07.7 (A2A-01, A2A-03, D-03, D-04, D-11, D-14; ADR-0027): the agent-to-agent ledger. Creates `agent_chains`
-- (one per root turn, `root_event_id` unique; the root turn's human pays and runs every hop; a hop budget of 3 that only
-- the conditional `hops_used < hop_budget` update consumes, bounded by `agent_chains_budget_check`) and
-- `agent_chain_hops` (one consult or handoff, its question message, deadline and status). The loop guards are
-- constraints, never read-then-write: `agent_chain_hops_target_once` (an agent is a target once per chain),
-- `agent_chain_hops_not_root`, `agent_chain_hops_not_self`, `agent_chain_hops_depth_check` (1..2),
-- `agent_chain_hops_parent_depth_check` (a parent exactly at depth 2), `agent_chain_hops_source_depth_check` (depth 1 is
-- asked by the root), `agent_chain_hops_parent_fk` (a depth-2 hop is asked by the target of its parent, in the same
-- chain), `agent_chain_hops_one_pending` (one pending consult per source per chain) and `agent_chain_hops_idempotency`.
-- Every foreign key onto an organization-scoped table carries `organization_id` (FKs bypass RLS), and the hops' chain
-- key names the chain's root, so the not-root check compares against the real root. `agent_turns` gains the chain
-- context as plain ledger ids (no FK, like `message_id`); every existing turn reads `chain_depth = 0` with null chain
-- columns, i.e. outside any chain. Tenant isolation comes from post-migrate (every `app` table with `organization_id`),
-- with the ids-only SECURITY DEFINER `app.expired_agent_chain_hops` that the `consult.tick` job reads. No existing row
-- changes value.
-- Chained after 20261102210622_automation_events_full_message (earlier migrations are never edited). drizzle-kit merged
-- the two 07.6 snapshot branches here and re-emitted `watched_records.write_lease_until`, which
-- 20261102201704_watched_write_lease already adds; that statement was removed by hand.
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.agent_chain_hops, app.agent_chains; ALTER TABLE
-- app.agent_turns DROP CONSTRAINT agent_turns_chain_depth_check, DROP COLUMN chain_id, DROP COLUMN chain_depth,
-- DROP COLUMN answering_hop_id, DROP COLUMN returning_hop_id, DROP COLUMN reply_message_id;
CREATE TABLE "app"."agent_chain_hops" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"chain_id" uuid NOT NULL,
	"root_agent_id" uuid NOT NULL,
	"parent_hop_id" uuid,
	"source_agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"depth" smallint NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"refusal_reason" text,
	"source_event_id" uuid NOT NULL,
	"target_event_id" uuid,
	"question_message_id" uuid NOT NULL CONSTRAINT "agent_chain_hops_question_uq" UNIQUE,
	"answer_message_id" uuid,
	"idempotency_key" text NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_chain_hops_parent_key_uq" UNIQUE("organization_id","chain_id","id","target_agent_id"),
	CONSTRAINT "agent_chain_hops_target_once" UNIQUE("chain_id","target_agent_id"),
	CONSTRAINT "agent_chain_hops_idempotency" UNIQUE("source_agent_id","idempotency_key"),
	CONSTRAINT "agent_chain_hops_not_self" CHECK ("target_agent_id" <> "source_agent_id"),
	CONSTRAINT "agent_chain_hops_not_root" CHECK ("target_agent_id" <> "root_agent_id"),
	CONSTRAINT "agent_chain_hops_depth_check" CHECK ("depth" between 1 and 2),
	CONSTRAINT "agent_chain_hops_parent_depth_check" CHECK (("depth" = 1) = ("parent_hop_id" is null)),
	CONSTRAINT "agent_chain_hops_source_depth_check" CHECK (("depth" = 1) = ("source_agent_id" = "root_agent_id")),
	CONSTRAINT "agent_chain_hops_mode_check" CHECK ("mode" in ('consult','handoff')),
	CONSTRAINT "agent_chain_hops_status_check" CHECK ("status" in ('pending','answered','failed','timed_out','cancelled','refused')),
	CONSTRAINT "agent_chain_hops_refusal_reason_len_check" CHECK ("refusal_reason" is null or char_length("refusal_reason") <= 64),
	CONSTRAINT "agent_chain_hops_idempotency_len_check" CHECK (char_length("idempotency_key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_chains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_root_id" uuid NOT NULL,
	"root_event_id" uuid NOT NULL CONSTRAINT "agent_chains_root_event_uq" UNIQUE,
	"root_agent_id" uuid NOT NULL,
	"human_user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"hop_budget" smallint DEFAULT 3 NOT NULL,
	"hops_used" smallint DEFAULT 0 NOT NULL,
	"cancel_reason" text,
	"cancelled_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_chains_org_id_root_uq" UNIQUE("organization_id","id","root_agent_id"),
	CONSTRAINT "agent_chains_status_check" CHECK ("status" in ('active','completed','cancelled')),
	CONSTRAINT "agent_chains_cancel_reason_check" CHECK ("cancel_reason" is null or "cancel_reason" in ('user','auto')),
	CONSTRAINT "agent_chains_budget_check" CHECK ("hop_budget" between 1 and 10 and "hops_used" between 0 and "hop_budget")
);
--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "chain_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "chain_depth" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "answering_hop_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "returning_hop_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD COLUMN "reply_message_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chain_hops_one_pending" ON "app"."agent_chain_hops" ("chain_id","source_agent_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "agent_chain_hops_pending_deadline_idx" ON "app"."agent_chain_hops" ("deadline_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "agent_chain_hops_answer_idx" ON "app"."agent_chain_hops" ("answer_message_id") WHERE answer_message_id is not null;--> statement-breakpoint
CREATE INDEX "agent_chains_conversation_idx" ON "app"."agent_chains" ("organization_id","conversation_id","thread_root_id");--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_question_message_id_messages_id_fkey" FOREIGN KEY ("question_message_id") REFERENCES "app"."messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_chain_fk" FOREIGN KEY ("organization_id","chain_id","root_agent_id") REFERENCES "app"."agent_chains"("organization_id","id","root_agent_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_parent_fk" FOREIGN KEY ("organization_id","chain_id","parent_hop_id","source_agent_id") REFERENCES "app"."agent_chain_hops"("organization_id","chain_id","id","target_agent_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_source_fk" FOREIGN KEY ("organization_id","source_agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_target_fk" FOREIGN KEY ("organization_id","target_agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chains" ADD CONSTRAINT "agent_chains_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chains" ADD CONSTRAINT "agent_chains_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."conversations"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chains" ADD CONSTRAINT "agent_chains_root_agent_fk" FOREIGN KEY ("organization_id","root_agent_id") REFERENCES "app"."agents"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_turns" ADD CONSTRAINT "agent_turns_chain_depth_check" CHECK ("chain_depth" between 0 and 2);
