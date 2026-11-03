-- Phase 07.7 review (CR-A-06; ADR-0027): a chain whose last done was lost must still end. The one-minute `consult.tick`
-- also lists active chains with nothing pending and no activity for ten minutes (`app.idle_agent_chains`, post-migrate)
-- and completes them; this partial index serves that listing. Additive; no row changes.
-- Rollback (as ocw_migrator): DROP INDEX app.agent_chains_active_idx;
CREATE INDEX "agent_chains_active_idx" ON "app"."agent_chains" ("updated_at") WHERE status = 'active';
