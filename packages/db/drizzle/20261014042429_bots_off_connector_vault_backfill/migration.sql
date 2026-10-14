-- Phase 07.4 (07.4-14, WINDOWS #177): the Bots module grew from 5 to 7 catalog patterns (`connector.connect` and
-- `vault.use`, 07.4-01). A unit, organization or person that turned Bots off before 07.4 holds the old 5 deny rows, so
-- the API now reads that set as `custom` and the two new grains are not denied. For every (organization, scope,
-- subject) that holds the complete old set (deny, no tool, no folder), the 2 missing rows are added with the same scope
-- and subject, so the module reads `off` again and denies connector connections and keychain use. A partial (custom)
-- set is left exactly as it is, and nothing else is ever written, changed or deleted.
-- Idempotent: a row is added only when no equal rule exists (a second run, or a set already completed by re-toggling
-- Bots in the UI, adds nothing).
-- Rollback (as ocw_migrator): removes the rows without an author for these two grains, which is what this backfill
-- writes (a rule an API caller wrote without a signed-in user would go too, so re-check Settings › Modules after):
--   delete from app.permission_rules where created_by is null and effect = 'deny' and tool is null
--     and path_prefix is null and permission in ('connector.connect', 'vault.use');
insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, subject_id, permission, effect)
select o.organization_id, o.scope_unit_id, o.subject_kind, o.subject_id, p.permission, 'deny'
from (
  select organization_id, scope_unit_id, subject_kind, subject_id
  from app.permission_rules
  where effect = 'deny' and tool is null and path_prefix is null
    and permission in ('bot.read', 'bot.create_personal', 'bot.configure', 'bot.internet', 'bot.tool.use')
  group by organization_id, scope_unit_id, subject_kind, subject_id
  having count(distinct permission) = 5
) o
cross join (values ('connector.connect'), ('vault.use')) as p (permission)
where not exists (
  select 1 from app.permission_rules r
  where r.organization_id = o.organization_id
    and r.scope_unit_id is not distinct from o.scope_unit_id
    and r.subject_kind = o.subject_kind
    and r.subject_id is not distinct from o.subject_id
    and r.permission = p.permission
    and r.effect = 'deny' and r.tool is null and r.path_prefix is null
);
