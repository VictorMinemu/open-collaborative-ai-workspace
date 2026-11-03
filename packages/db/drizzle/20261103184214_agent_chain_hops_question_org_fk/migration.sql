-- Phase 07.7 review (CR-B-04; D-14, ADR-0027 §3): every foreign key onto an organization-scoped table carries
-- `organization_id` (FKs bypass RLS, so another organization's id must fail the key itself). The hop's question was
-- keyed on `messages(id)` alone, because `messages` had no `(organization_id, id)` key. `messages_org_id_uq` adds it
-- (an index build over messages; no row changes) and `agent_chain_hops_question_fk` replaces the single-column key, same
-- ON DELETE CASCADE. Every existing hop's question was posted by the consult route in the hop's own organization, so
-- it satisfies the new key.
-- Rollback (as ocw_migrator): ALTER TABLE app.agent_chain_hops DROP CONSTRAINT agent_chain_hops_question_fk; ALTER
-- TABLE app.agent_chain_hops ADD CONSTRAINT agent_chain_hops_question_message_id_messages_id_fkey FOREIGN KEY
-- (question_message_id) REFERENCES app.messages (id) ON DELETE CASCADE; ALTER TABLE app.messages DROP CONSTRAINT
-- messages_org_id_uq;
ALTER TABLE "app"."agent_chain_hops" DROP CONSTRAINT "agent_chain_hops_question_message_id_messages_id_fkey";--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "app"."agent_chain_hops" ADD CONSTRAINT "agent_chain_hops_question_fk" FOREIGN KEY ("organization_id","question_message_id") REFERENCES "app"."messages"("organization_id","id") ON DELETE CASCADE;
