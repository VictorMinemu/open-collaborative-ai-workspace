-- Phase 07.7 review (CR-B-01; ADR-0027 §3): depth ≤ 2 becomes a database guard. `agent_chain_hops_parent_fk` also
-- carries the hop's root: a depth-2 hop's parent must have been asked by the chain's root, i.e. be at depth 1
-- (`agent_chain_hops_source_depth_check`: depth 1 ⇔ asked by the root), so a hop parented on a depth-2 hop fails the
-- key whatever depth it claims. Its target is the new 5-column key `agent_chain_hops_parent_root_key_uq`, which
-- replaces `agent_chain_hops_parent_key_uq` (the foreign key is dropped first, since it depends on the old key). Every
-- existing depth-2 hop was opened by the consult route on a depth-1 parent, so it satisfies the new key. No row changes.
-- Rollback (as ocw_migrator): ALTER TABLE app.agent_chain_hops DROP CONSTRAINT agent_chain_hops_parent_fk; ALTER TABLE
-- app.agent_chain_hops ADD CONSTRAINT agent_chain_hops_parent_key_uq UNIQUE (organization_id, chain_id, id,
-- target_agent_id); ALTER TABLE app.agent_chain_hops ADD CONSTRAINT agent_chain_hops_parent_fk FOREIGN KEY
-- (organization_id, chain_id, parent_hop_id, source_agent_id) REFERENCES app.agent_chain_hops (organization_id,
-- chain_id, id, target_agent_id) ON DELETE CASCADE; ALTER TABLE app.agent_chain_hops DROP CONSTRAINT
-- agent_chain_hops_parent_root_key_uq;
ALTER TABLE "app"."agent_chain_hops" DROP CONSTRAINT "agent_chain_hops_parent_fk";--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_parent_root_key_uq" UNIQUE("organization_id","chain_id","id","target_agent_id","source_agent_id");--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_parent_fk" FOREIGN KEY ("organization_id","chain_id","parent_hop_id","source_agent_id","root_agent_id") REFERENCES "app"."agent_chain_hops"("organization_id","chain_id","id","target_agent_id","source_agent_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" DROP CONSTRAINT "agent_chain_hops_parent_key_uq";
