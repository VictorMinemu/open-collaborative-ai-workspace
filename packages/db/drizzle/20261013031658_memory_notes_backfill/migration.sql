-- Phase 07.2 (D-02, D-08, MEM-07): the per-(bot, human) notes of `app.agent_memories` (`ocw_memory_save`) become that
-- human's personal `MEMORY.md` with that bot. Per distinct (organization, bot, human) with notes and no personal scope
-- yet: a `personal` memory scope (`origin = legacy_notes`), one `MEMORY.md` file ("# Memory", a blank line, then one
-- "- <note>" line per note, oldest first by created_at then id, newlines inside a note flattened to one space) at
-- version 1, and its revision 1 (`create`, authored by `system`). Owner-only from the first row: the post-migrate
-- trigger is installed AFTER migrations run, so `personal_owner_user_id` is set explicitly here to the note's human
-- (never the bot's owner, never an admin). `app.agent_memories` is only read: never dropped, altered or emptied (its
-- removal needs explicit owner confirmation later).
-- Idempotent: a pair that already has a personal scope (from the app or a previous run) is skipped, and a file or
-- revision is only added to a backfilled scope that has none, so nothing is ever duplicated or overwritten.
-- Rollback: run as ocw_migrator, verbatim (the indented lines below; memory-notes-migration.int.test.ts executes them).
-- It removes only backfilled scopes nobody touched since (just their MEMORY.md at version 1 and its system revision);
-- an edited backfilled scope is kept, never thrown away, and the NOTICE says how many were kept.
--   DO $rollback$
--   DECLARE
--     kept integer;
--   BEGIN
--     WITH legacy AS (
--       SELECT s.id, (
--         EXISTS (SELECT 1 FROM app.memory_files f WHERE f.scope_id = s.id AND (f.version <> 1
--           OR f.path <> 'MEMORY.md' OR f.deleted_at IS NOT NULL OR f.updated_by_kind <> 'system'))
--         OR EXISTS (SELECT 1 FROM app.memory_file_revisions r WHERE r.scope_id = s.id AND (r.version <> 1
--           OR r.op <> 'create' OR r.author_kind <> 'system'))
--         OR EXISTS (SELECT 1 FROM app.memory_proposals p WHERE p.scope_id = s.id)
--       ) AS touched
--       FROM app.memory_scopes s WHERE s.origin = 'legacy_notes'
--     ), removed AS (
--       DELETE FROM app.memory_scopes s USING legacy l WHERE l.id = s.id AND NOT l.touched RETURNING s.id
--     )
--     SELECT count(*) FILTER (WHERE touched) INTO kept FROM legacy;
--     RAISE NOTICE 'memory_notes_backfill rollback: kept % edited backfilled scope(s)', kept;
--   END
--   $rollback$;
insert into app.memory_scopes (organization_id, kind, agent_id, owner_user_id, personal_owner_user_id, origin)
select distinct m.organization_id, 'personal', m.agent_id, m.user_id, m.user_id, 'legacy_notes'
from app.agent_memories m
join app.agents a on a.id = m.agent_id and a.organization_id = m.organization_id
where not exists (
  select 1 from app.memory_scopes s
  where s.kind = 'personal' and s.organization_id = m.organization_id and s.agent_id = m.agent_id
    and s.owner_user_id = m.user_id
);--> statement-breakpoint
insert into app.memory_files
  (organization_id, scope_id, personal_owner_user_id, path, content, version, bytes, updated_by_kind)
select s.organization_id, s.id, s.owner_user_id, 'MEMORY.md', n.content, 1, octet_length(n.content), 'system'
from app.memory_scopes s
cross join lateral (
  select E'# Memory\n\n'
    || string_agg('- ' || regexp_replace(m.text, '\s*\n\s*', ' ', 'g'), E'\n' order by m.created_at, m.id)
    || E'\n' as content
  from app.agent_memories m
  where m.organization_id = s.organization_id and m.agent_id = s.agent_id and m.user_id = s.owner_user_id
) n
where s.origin = 'legacy_notes' and n.content is not null
  and not exists (select 1 from app.memory_files f where f.scope_id = s.id);--> statement-breakpoint
insert into app.memory_file_revisions
  (organization_id, file_id, scope_id, personal_owner_user_id, version, op, path, content, lines_added, author_kind)
select f.organization_id, f.id, f.scope_id, f.personal_owner_user_id, 1, 'create', f.path, f.content,
  length(f.content) - length(replace(f.content, E'\n', '')), 'system'
from app.memory_files f
join app.memory_scopes s on s.id = f.scope_id
where s.origin = 'legacy_notes' and f.path = 'MEMORY.md' and f.version = 1 and f.updated_by_kind = 'system'
  and not exists (select 1 from app.memory_file_revisions r where r.file_id = f.id);
