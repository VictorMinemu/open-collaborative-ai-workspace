-- Phase 07.7 review (CR-A-07; ADR-0027): a chain completes only once no hop is pending and none of its turns still
-- runs. `agent_turns.done_at` records the cell's first `POST /turns/:eventId/done` for a chain turn (null for every
-- other turn, and for every existing row: no value changes), and `agent_turns_chain_idx` finds one chain's turns.
-- Additive. Rollback (as ocw_migrator): DROP INDEX app.agent_turns_chain_idx; ALTER TABLE app.agent_turns DROP COLUMN
-- done_at;
ALTER TABLE "app"."agent_turns" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_turns_chain_idx" ON "app"."agent_turns" ("chain_id") WHERE chain_id is not null;
