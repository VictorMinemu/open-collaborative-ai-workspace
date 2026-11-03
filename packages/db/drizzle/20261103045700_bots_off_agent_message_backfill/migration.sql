-- Phase 07.7 (07.7-02, P-06, D-14; ADR-0027): the Bots module grew from 9 to 10 catalog patterns (`agent.message`
-- joined it, so Bots off also stops agent-to-agent consults). A unit, organization or person that turned Bots off
-- before 07.7 holds the 9 earlier deny rows, so the API would read that set as `custom` and consults would not be
-- denied. Same rule as 20261014042429 (07.4-14) and 20261030071644 (07.6-01): for every (organization, scope, subject)
-- that holds the complete earlier set (deny, no tool, no folder), the missing `agent.message` deny row is added with
-- the same scope and subject and no author, so the module reads `off` again. A partial (custom) set is left exactly as
-- it is, no allow row is ever written, and nothing else is written, changed or deleted. Runs after 20261014042429 and
-- 20261030071644, which complete 5 → 7 → 9 first.
-- Idempotent: a row is added only when no equal rule exists (a second run, or a set already completed by re-toggling
-- Bots in the UI, adds nothing).
-- Rollback (as ocw_migrator): removes the rows without an author for this grain, which is what this backfill writes (a
-- rule an API caller wrote without a signed-in user would go too, so re-check Settings › Modules after):
--   delete from app.permission_rules where created_by is null and effect = 'deny' and tool is null
--     and path_prefix is null and permission = 'agent.message';
insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, subject_id, permission, effect)
select o.organization_id, o.scope_unit_id, o.subject_kind, o.subject_id, 'agent.message', 'deny'
from (
  select organization_id, scope_unit_id, subject_kind, subject_id
  from app.permission_rules
  where effect = 'deny' and tool is null and path_prefix is null
    and permission in (
      'bot.read', 'bot.create_personal', 'bot.configure', 'bot.internet', 'bot.tool.use', 'connector.connect',
      'vault.use', 'automation.create', 'automation.webhook'
    )
  group by organization_id, scope_unit_id, subject_kind, subject_id
  having count(distinct permission) = 9
) o
where not exists (
  select 1 from app.permission_rules r
  where r.organization_id = o.organization_id
    and r.scope_unit_id is not distinct from o.scope_unit_id
    and r.subject_kind = o.subject_kind
    and r.subject_id is not distinct from o.subject_id
    and r.permission = 'agent.message'
    and r.effect = 'deny' and r.tool is null and r.path_prefix is null
);
