# Semgrep rule fixtures for ocw.rls-bypass (`node scripts/guard/run.mjs --rule-tests`). Annotations use "#" because
# Semgrep's test runner does not read "--" comments; the "--" lines below are the SQL comments the rule must ignore.
# ruleid: ocw.rls-bypass
ALTER ROLE ocw_app BYPASSRLS;
# ruleid: ocw.rls-bypass
alter role ocw_app with login bypassrls;
# ruleid: ocw.rls-bypass
ALTER TABLE app.messages DISABLE ROW LEVEL SECURITY;
# ruleid: ocw.rls-bypass
ALTER TABLE app.messages NO FORCE ROW LEVEL SECURITY;
# ok: ocw.rls-bypass
ALTER ROLE ocw_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
# ok: ocw.rls-bypass
ALTER TABLE app.messages FORCE ROW LEVEL SECURITY;
# ok: ocw.rls-bypass
ALTER TABLE app.messages ENABLE ROW LEVEL SECURITY;
# ok: ocw.rls-bypass
-- SECURITY DEFINER as ocw_migrator (BYPASSRLS); a comment naming the attribute grants nothing.
# ok: ocw.rls-bypass
  -- an indented comment: DISABLE ROW LEVEL SECURITY
