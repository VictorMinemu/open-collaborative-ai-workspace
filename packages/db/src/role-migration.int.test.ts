import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./migrate";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * D-06 / T-02-01-01: the one-way role data migration maps MVP 0 roles owner/admin → admin and
 * member → developer (never standard: former members keep Work Zone, Pitfall 8), resets auth.member.role to
 * the existence-only value, is idempotent, and the CHECK added afterwards rejects every legacy value.
 * Runs the exact SQL of the migration folders against legacy rows seeded with the CHECK dropped.
 */

let tdb: TestDatabase;
let su: pg.Client;

function migrationSql(suffix: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith(suffix));
  expect(dirs, `exactly one *${suffix} migration`).toHaveLength(1);
  return readFileSync(join(MIGRATIONS_DIR, dirs[0] as string, "migration.sql"), "utf8");
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  await su.connect();
});

afterAll(async () => {
  await su?.end();
  await tdb?.stop();
});

describe("role_values + role_check migrations", () => {
  it("sorts the data migration before the constraint migration", () => {
    const dirs = readdirSync(MIGRATIONS_DIR).sort();
    const values = dirs.findIndex((d) => d.endsWith("_role_values"));
    const check = dirs.findIndex((d) => d.endsWith("_role_check"));
    expect(values).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(values);
    expect(migrationSql("_role_check")).toContain("org_members_role_check");
  });

  it("maps legacy rows, is idempotent, and the CHECK then rejects legacy roles", async () => {
    const roleValues = migrationSql("_role_values");
    const roleCheck = migrationSql("_role_check");
    const org = randomUUID();
    const [owner, admin, member] = [randomUUID(), randomUUID(), randomUUID()];
    const [invAdmin, invMember] = [randomUUID(), randomUUID()];

    await su.query("begin");
    try {
      await su.query("alter table app.org_members drop constraint org_members_role_check");
      await su.query("insert into auth.organization (id, name, slug) values ($1, 'Legacy', $2)", [
        org,
        `legacy-${org}`,
      ]);
      for (const [u, role] of [
        [owner, "owner"],
        [admin, "admin"],
        [member, "member"],
      ] as const) {
        await su.query("insert into auth.user (id, name, email) values ($1, $2, $3)", [
          u,
          role,
          `${role}-${u}@example.test`,
        ]);
        await su.query(
          "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, $3, $4)",
          [org, u, role, role],
        );
        await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, $3)", [
          org,
          u,
          role,
        ]);
      }
      for (const [inv, role] of [
        [invAdmin, "admin"],
        [invMember, "member"],
      ] as const) {
        await su.query(
          "insert into auth.invitation (id, organization_id, email, role, status, expires_at, inviter_id) values ($1, $2, $3, $4, 'pending', now() + interval '1 day', $5)",
          [inv, org, `${role}-invitee@example.test`, role, owner],
        );
      }

      const snapshot = async () => ({
        members: Object.fromEntries(
          (
            await su.query("select user_id, role from app.org_members where organization_id = $1", [org])
          ).rows.map((r) => [r.user_id, r.role]),
        ),
        invitations: Object.fromEntries(
          (await su.query("select id, role from auth.invitation where organization_id = $1", [org])).rows.map(
            (r) => [r.id, r.role],
          ),
        ),
        authMembers: (
          await su.query("select distinct role from auth.member where organization_id = $1", [org])
        ).rows.map((r) => r.role),
      });

      await su.query(roleValues);
      const first = await snapshot();
      expect(first.members).toEqual({ [owner]: "admin", [admin]: "admin", [member]: "developer" });
      expect(first.invitations).toEqual({ [invAdmin]: "admin", [invMember]: "developer" });
      expect(first.authMembers).toEqual(["member"]);

      await su.query(roleValues);
      expect(await snapshot()).toEqual(first);

      await su.query(roleCheck);
      for (const legacy of ["owner", "member", "superadmin"]) {
        await su.query("savepoint s");
        const err = await su
          .query("update app.org_members set role = $1 where user_id = $2", [legacy, admin])
          .then(
            () => null,
            (e: { code?: string }) => e,
          );
        await su.query("rollback to savepoint s");
        expect(err?.code, legacy).toBe("23514");
      }
      const extra = randomUUID();
      await su.query("insert into auth.user (id, name, email) values ($1, 'x', $2)", [
        extra,
        `${extra}@example.test`,
      ]);
      await expect(
        su.query(
          "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'x', 'owner')",
          [org, extra],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await su.query("rollback");
    }
  });

  it("the migrated schema accepts exactly the four PRD roles", async () => {
    const org = randomUUID();
    await su.query("begin");
    try {
      await su.query("insert into auth.organization (id, name, slug) values ($1, 'New', $2)", [
        org,
        `new-${org}`,
      ]);
      for (const role of ["standard", "developer", "lead", "admin"]) {
        const u = randomUUID();
        await su.query("insert into auth.user (id, name, email) values ($1, 'n', $2)", [
          u,
          `${u}@example.test`,
        ]);
        await su.query(
          "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'n', $3)",
          [org, u, role],
        );
      }
      const r = await su.query("select count(*)::int as n from app.org_members where organization_id = $1", [
        org,
      ]);
      expect(r.rows[0].n).toBe(4);
    } finally {
      await su.query("rollback");
    }
  });
});
