-- Phase 07.8 (D-11, D-13, ADR-0029; 07.8-14 broken window 7): the member-session floor. A stored tool call that runs
-- with the requester's own signed-in session (a signed-in browser act, a D-13 navigation or exec after member data) is
-- decided by the requester alone, whatever 07.5 rule applies: admins, unit leads and named approvers never decide it
-- in the member's place. The flag is fixed at request time (the row stays immutable by its trigger) and is part of the
-- action hash when true. Additive with a default: existing rows read false and keep their 07.5 deciders. Chained after
-- 20261015173538_share_attachment_turn (P-17: never edited).
-- Forward-only. Rollback (as ocw_migrator): ALTER TABLE app.tool_call_approvals DROP COLUMN requester_decides.
ALTER TABLE "app"."tool_call_approvals" ADD COLUMN "requester_decides" boolean DEFAULT false NOT NULL;
