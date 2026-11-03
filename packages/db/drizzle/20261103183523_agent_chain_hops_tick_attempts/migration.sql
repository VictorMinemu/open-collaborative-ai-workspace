-- Phase 07.7 review (CR-A-08; ADR-0027): the consult tick no longer retries a failing hop forever. `tick_attempts`
-- counts the tick's failures on a hop (each one pushes its deadline out, so newer expired hops are reached first); after
-- the last attempt the hop ends `failed` with `refusal_reason = 'tick_error'`. Every existing hop reads 0.
-- Additive. Rollback (as ocw_migrator): ALTER TABLE app.agent_chain_hops DROP COLUMN tick_attempts;
ALTER TABLE "app"."agent_chain_hops" ADD COLUMN "tick_attempts" smallint DEFAULT 0 NOT NULL;
