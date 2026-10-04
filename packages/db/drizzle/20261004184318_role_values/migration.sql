-- Phase 2 (D-06): one-way, idempotent data migration of the MVP 0 role vocabulary to the four PRD roles.
-- owner/admin -> admin (Organization Admin); member -> developer (keeps Work Zone, Pitfall 8).
-- auth.member.role is existence-only from now on (better-auth requires a value); app.org_members.role is
-- the single source of truth. History (audit_events metadata, stream_events payloads) is never rewritten.
UPDATE app.org_members SET role = CASE role WHEN 'owner' THEN 'admin' WHEN 'admin' THEN 'admin' WHEN 'member' THEN 'developer' ELSE role END WHERE role IN ('owner', 'admin', 'member');
--> statement-breakpoint
UPDATE auth.invitation SET role = CASE role WHEN 'owner' THEN 'admin' WHEN 'admin' THEN 'admin' WHEN 'member' THEN 'developer' ELSE role END WHERE role IN ('owner', 'admin', 'member');
--> statement-breakpoint
UPDATE auth.member SET role = 'member' WHERE role IS DISTINCT FROM 'member';
