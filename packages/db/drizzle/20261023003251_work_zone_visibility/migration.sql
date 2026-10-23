-- Phase 07.9 (D-01, D-03, D-04, D-06, D-13; ADR-0030): shared Work Zone projects and session audiences. Creates
-- `work_project_settings` (a team project's default audience for new sessions; an absent row means "everyone in the
-- project"), `work_project_teams` (teams or departments assigned to a team project), `work_project_repos` (a device repo
-- linked to one team project; the project unit cannot be deleted while a repo is linked) and `work_session_grants` (the
-- selected teams or people of a session's audience, one active row per subject, soft-revoked), and adds
-- `work_sessions.visibility` (`owner` | `project` | `teams` | `people`, default `project`). Tenant isolation comes from
-- post-migrate (every `app` table with `organization_id`); every reference is composite with the organization (07.4
-- #169). The access rule itself is the SQL functions of post-migrate.sql (`app.work_session_access` and its siblings).
--
-- D-06, deliberate narrowing: before this migration every Work Zone user saw every session of the organization; from
-- now on an existing session (audience `project` on a repo that no team project links yet) is seen by its creator, the
-- device owner, the device's grantees and admins only. Linking its repo to a team project later opens it to that
-- project. Existing sessions keep their creator and history. No audit row is written by this migration.
--
-- D-13, irreversible redaction of stored history: until now every session update was also stored on the organization
-- stream (`org:<organization id>`, readable by every member) as a full session snapshot (title, branch, device name).
-- Those stored `org:` `work_session.updated` payloads are blanked to `{}`; their sequence numbers are kept so replay
-- stays continuous, and every other event (the sessions' own `ws:` streams included) is untouched. The redaction is
-- one-way: the blanked snapshots cannot be restored. Run it only through `migrate` (as ocw_migrator, who alone may
-- update `stream_events`), never by hand against a database whose history must be kept.
-- Chained after 20261022213335_browser_takeover_abandoned (P-17: earlier migrations are never edited).
-- Forward-only. Rollback (as ocw_migrator): DROP TABLE app.work_session_grants, app.work_project_repos,
-- app.work_project_teams, app.work_project_settings; ALTER TABLE app.work_sessions DROP COLUMN visibility. The D-13
-- redaction cannot be rolled back.
CREATE TABLE "app"."work_project_repos" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid PRIMARY KEY,
	"device_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."work_project_settings" (
	"organization_id" uuid NOT NULL,
	"unit_id" uuid PRIMARY KEY,
	"default_visibility" text DEFAULT 'project' NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_project_settings_default_ck" CHECK ("default_visibility" in ('project','owner'))
);
--> statement-breakpoint
CREATE TABLE "app"."work_project_teams" (
	"organization_id" uuid NOT NULL,
	"project_unit_id" uuid,
	"team_unit_id" uuid,
	"assigned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_project_teams_pkey" PRIMARY KEY("project_unit_id","team_unit_id"),
	CONSTRAINT "work_project_teams_not_self_ck" CHECK ("project_unit_id" <> "team_unit_id")
);
--> statement-breakpoint
CREATE TABLE "app"."work_session_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"organization_id" uuid NOT NULL,
	"work_session_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "work_session_grants_subject_kind_ck" CHECK ("subject_kind" in ('user','unit'))
);
--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD COLUMN "visibility" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
CREATE INDEX "work_project_repos_unit_idx" ON "app"."work_project_repos" ("organization_id","unit_id");--> statement-breakpoint
CREATE INDEX "work_project_teams_team_idx" ON "app"."work_project_teams" ("organization_id","team_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_session_grants_active_uq" ON "app"."work_session_grants" ("work_session_id","subject_kind","subject_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "work_session_grants_session_idx" ON "app"."work_session_grants" ("organization_id","work_session_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "work_session_grants_subject_idx" ON "app"."work_session_grants" ("organization_id","subject_kind","subject_id") WHERE revoked_at is null;--> statement-breakpoint
ALTER TABLE "app"."work_project_repos" ADD CONSTRAINT "work_project_repos_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_project_repos" ADD CONSTRAINT "work_project_repos_project_fk" FOREIGN KEY ("organization_id","project_id","device_id") REFERENCES "app"."projects"("organization_id","id","device_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_project_repos" ADD CONSTRAINT "work_project_repos_unit_fk" FOREIGN KEY ("organization_id","unit_id") REFERENCES "app"."org_units"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."work_project_settings" ADD CONSTRAINT "work_project_settings_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_project_settings" ADD CONSTRAINT "work_project_settings_unit_fk" FOREIGN KEY ("organization_id","unit_id") REFERENCES "app"."org_units"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_project_teams" ADD CONSTRAINT "work_project_teams_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_project_teams" ADD CONSTRAINT "work_project_teams_project_fk" FOREIGN KEY ("organization_id","project_unit_id") REFERENCES "app"."org_units"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_project_teams" ADD CONSTRAINT "work_project_teams_team_fk" FOREIGN KEY ("organization_id","team_unit_id") REFERENCES "app"."org_units"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_session_grants" ADD CONSTRAINT "work_session_grants_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_session_grants" ADD CONSTRAINT "work_session_grants_session_fk" FOREIGN KEY ("organization_id","work_session_id") REFERENCES "app"."work_sessions"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."work_sessions" ADD CONSTRAINT "work_sessions_visibility_ck" CHECK ("visibility" in ('owner','project','teams','people'));--> statement-breakpoint
-- D-13 (hand-written, one-way): blank the session snapshots stored on organization streams; seq is kept.
UPDATE "app"."stream_events" SET "payload" = '{}'::jsonb
WHERE "stream_id" LIKE 'org:%' AND "type" = 'work_session.updated' AND "payload" <> '{}'::jsonb;