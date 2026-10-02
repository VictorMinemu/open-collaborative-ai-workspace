-- Idempotent role bootstrap. Run as the PostgreSQL superuser by the one-shot `migrate` service only.
-- Passwords are passed in as transaction-local settings (ocw.*_password); never hard-coded.
--   ocw_migrator: owns schemas app/auth, runs migrations, BYPASSRLS (owner of the narrow SECURITY DEFINER
--                 lookup functions used before a tenant is known, e.g. device/agent bearer tokens).
--   ocw_app:      the API's domain role. NOSUPERUSER NOBYPASSRLS, DML on schema app only, RLS enforced.
--   ocw_auth:     better-auth's role. DML on schema auth only + INSERT into app.audit_events/org_members.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ocw_migrator', current_setting('ocw.migrator_password')),
      ('ocw_app', current_setting('ocw.app_password')),
      ('ocw_auth', current_setting('ocw.auth_password'))
    ) AS v(name, pw)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r.name, r.pw);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', r.name, r.pw);
    END IF;
  END LOOP;
END
$$;

ALTER ROLE ocw_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
ALTER ROLE ocw_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE ocw_auth NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO ocw_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ocw_app, ocw_auth', current_database());
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
