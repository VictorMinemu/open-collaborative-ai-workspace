import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.13 (D-10, D-23, D-30, PD-03 … PD-05, PD-14, PD-20; ADR-0035): the storage of the Work Zone browser. The
 * organization's switch (`work_zone_policies.allow_browser`), the device's own opt-in and capability version
 * (`devices.browser_opt_in`, `devices.browser_version`), one `app.work_browsers` row per session browser and a member's
 * sealed Work Zone sign-ins (`app.work_browser_signins`, a sibling of the bots' `browser_sessions`, never shared with
 * them). Seeded as ocw_migrator on a fresh database with every migration applied; storage, tenant isolation, the
 * owner-only and audience policies, the cascades, the clean-up triggers and the TRUNCATE revoke are proven as ocw_app.
 */

let tdb: TestDatabase;
let db: pg.Client;
let app: pg.Client;

type Q = pg.Client["query"];

interface Org {
  id: string;
  /** The member who owns the sign-ins, the device and the session. */
  user: string;
  /** Another member (role `developer`). */
  member: string;
  /** An admin of the organization. */
  admin: string;
  device: string;
  project: string;
  session: string;
}

async function person(org: string, role: "admin" | "developer"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into auth.user (id, name, email) values ($1, 'P', $2)", [id, `${id}@wb.test`]);
  await db.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, $3)", [
    org,
    id,
    role,
  ]);
  await db.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', $3)",
    [org, id, role],
  );
  return id;
}

/** A Work Zone session of `org` on `device`, created by `user`, visible to its creator only (`owner`). */
async function workSession(org: string, project: string, device: string, user: string): Promise<string> {
  const conversation = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [conversation, org],
  );
  const session = randomUUID();
  await db.query(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, visibility) values ($1, $2, $3, $4, $5, 'T', $6, 'owner')",
    [session, org, conversation, project, device, user],
  );
  return session;
}

async function seedOrg(): Promise<Org> {
  const id = randomUUID();
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [id, `o-${id}`]);
  const user = await person(id, "developer");
  const member = await person(id, "developer");
  const admin = await person(id, "admin");
  const device = randomUUID();
  await db.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'laptop', 'linux', $4)",
    [device, id, user, `tok-${device}`],
  );
  const project = randomUUID();
  await db.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
    [project, id, device, `l-${project}`],
  );
  const session = await workSession(id, project, device, user);
  return { id, user, member, admin, device, project, session };
}

/** One sealed `browser_session` secret of `o` (fake ciphertext), as `q` (the migrator by default). */
async function browserSecret(o: Org, q: Q = db.query.bind(db) as Q): Promise<string> {
  const id = randomUUID();
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'browser session', 'browser_session', 'c', 'i', 't')",
    [id, o.id],
  );
  return id;
}

/** A Work Zone sign-in of `user` in `o` for `site` (its own fresh secret), as `q`; returns its id and secret id. */
async function signin(
  o: Org,
  user: string,
  site: string,
  opts: { expires?: string; q?: Q } = {},
): Promise<{ id: string; secret: string }> {
  const q = opts.q ?? (db.query.bind(db) as Q);
  const secret = await browserSecret(o, q);
  const res = await q(
    `insert into app.work_browser_signins (organization_id, user_id, site_key, secret_id, expires_at)
     values ($1, $2, $3, $4, ${opts.expires ?? "now() + interval '30 days'"}) returning id`,
    [o.id, user, site, secret],
  );
  return { id: res.rows[0].id as string, secret };
}

async function refused(p: Promise<unknown>, named: { constraint: string }): Promise<void> {
  await expect(p, named.constraint).rejects.toMatchObject(named);
}

/** Runs `fn` as ocw_app with withTenant()'s two settings (`null` user = a user-less system transaction); rolled back. */
async function as<T>(org: string, userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query(
      "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [org, userId ?? ""],
    );
    return await fn(app.query.bind(app) as Q);
  } finally {
    await app.query("rollback");
  }
}

const count = async (sql: string, values: unknown[] = []) =>
  (await db.query(`select count(*)::int as n from ${sql}`, values)).rows[0].n as number;

let A: Org;
let B: Org;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await db.connect();
  await app.connect();
  A = await seedOrg();
  B = await seedOrg();
});

afterAll(async () => {
  await db?.end();
  await app?.end();
  await tdb?.stop();
});

describe("the switch, the opt-in and the capability version (07.13 D-10, PD-20)", () => {
  it("starts a policy with the browser off and a device without opt-in or version; a version of 0 or 101 is refused", async () => {
    await db.query("insert into app.work_zone_policies (organization_id) values ($1)", [A.id]);
    const policy = await db.query(
      "select allow_browser from app.work_zone_policies where organization_id = $1",
      [A.id],
    );
    expect(policy.rows).toEqual([{ allow_browser: false }]);
    const device = await db.query("select browser_opt_in, browser_version from app.devices where id = $1", [
      A.device,
    ]);
    expect(device.rows).toEqual([{ browser_opt_in: false, browser_version: null }]);
    for (const bad of [0, 101]) {
      await refused(db.query("update app.devices set browser_version = $2 where id = $1", [A.device, bad]), {
        constraint: "devices_browser_version_ck",
      });
    }
    for (const ok of [1, 100]) {
      const r = await db.query(
        "update app.devices set browser_version = $2, browser_opt_in = true where id = $1",
        [A.device, ok],
      );
      expect(r.rowCount).toBe(1);
    }
    await db.query("update app.devices set browser_version = null, browser_opt_in = false where id = $1", [
      A.device,
    ]);
  });
});

describe("a member's Work Zone sign-ins (07.13 D-23, D-30, PD-03)", () => {
  it("stores a sign-in as its owner; another member, an admin and a user-less session read, change and delete none", async () => {
    await as(A.id, A.user, async (q) => {
      const s = await signin(A, A.user, "github.com", { q });
      const own = await q(
        "select user_id, site_key, secret_id, last_used_at, created_at is not null as created from app.work_browser_signins",
      );
      expect(own.rows).toEqual([
        { user_id: A.user, site_key: "github.com", secret_id: s.secret, last_used_at: null, created: true },
      ]);
    });
    const s = await signin(A, A.user, "github.com");
    for (const other of [A.member, A.admin, null]) {
      const label = other ?? "no user";
      await as(A.id, other, async (q) => {
        expect((await q("select count(*)::int as n from app.work_browser_signins")).rows[0].n, label).toBe(0);
        const up = await q("update app.work_browser_signins set last_used_at = now() where id = $1", [s.id]);
        expect(up.rowCount, `${label} update`).toBe(0);
        const del = await q("delete from app.work_browser_signins where id = $1", [s.id]);
        expect(del.rowCount, `${label} delete`).toBe(0);
      });
    }
    // Nobody may write a sign-in in another member's name.
    await expect(
      as(A.id, A.member, (q) => signin(A, A.user, "gitlab.com", { q })),
      "insert for another member",
    ).rejects.toThrow(/row-level security/);
    expect(await count("app.work_browser_signins where id = $1 and last_used_at is null", [s.id])).toBe(1);
    // The owner reads it.
    const mine = await as(A.id, A.user, (q) => q("select id from app.work_browser_signins"));
    expect(mine.rows).toEqual([{ id: s.id }]);
  });

  it("hides one organization's sign-ins from another and refuses an insert with its id", async () => {
    await as(B.id, B.user, async (q) => {
      expect(
        (
          await q("select count(*)::int as n from app.work_browser_signins where organization_id = $1", [
            A.id,
          ])
        ).rows[0].n,
      ).toBe(0);
      const del = await q("delete from app.work_browser_signins where organization_id = $1", [A.id]);
      expect(del.rowCount).toBe(0);
    });
    const secretA = await browserSecret(A);
    await expect(
      as(B.id, A.user, (q) =>
        q(
          "insert into app.work_browser_signins (organization_id, user_id, site_key, secret_id, expires_at) values ($1, $2, 'example.com', $3, now() + interval '1 day')",
          [A.id, A.user, secretA],
        ),
      ),
      "cross-tenant insert",
    ).rejects.toThrow(/row-level security/);
    // A composite foreign key: a sign-in of B can never point at A's secret.
    await refused(
      db.query(
        "insert into app.work_browser_signins (organization_id, user_id, site_key, secret_id, expires_at) values ($1, $2, 'example.com', $3, now() + interval '1 day')",
        [B.id, B.user, secretA],
      ),
      { constraint: "work_browser_signins_secret_fk" },
    );
  });

  it("allows one sign-in per member and site; a site with a path is refused", async () => {
    await signin(A, A.member, "example.org");
    await refused(signin(A, A.member, "example.org"), { constraint: "work_browser_signins_owner_site_uq" });
    // Another member, another site: fine.
    await signin(A, A.admin, "example.org");
    await signin(A, A.member, "example.org:8443");
    for (const bad of ["github.com/x", "GitHub.com", "user@github.com", ""]) {
      await refused(signin(A, A.member, bad), { constraint: "work_browser_signins_site_key_check" });
    }
  });

  it("deletes the sealed secret with the sign-in", async () => {
    const s = await signin(A, A.user, "secret-cleanup.test");
    await as(A.id, A.user, async (q) => {
      const r = await q("delete from app.work_browser_signins where id = $1", [s.id]);
      expect(r.rowCount).toBe(1);
      // The secret went in the same statement (the owner's own transaction sees it gone).
      expect(
        (await q("select count(*)::int as n from app.secrets where id = $1", [s.secret])).rows[0].n,
      ).toBe(0);
    });
    // Rolled back above; now for real, as the migrator.
    expect(await count("app.secrets where id = $1", [s.secret])).toBe(1);
    await db.query("delete from app.work_browser_signins where id = $1", [s.id]);
    expect(await count("app.secrets where id = $1", [s.secret])).toBe(0);
    // Deleting the secret first deletes its sign-in (composite FK, on delete cascade).
    const t = await signin(A, A.user, "secret-first.test");
    await db.query("delete from app.secrets where id = $1", [t.secret]);
    expect(await count("app.work_browser_signins where id = $1", [t.id])).toBe(0);
  });

  it("deletes a member's sign-ins and their secrets when the member is deactivated or removed", async () => {
    const gone = await person(A.id, "developer");
    const left = await signin(A, gone, "left.test");
    const stays = await signin(A, A.user, "left.test");
    await db.query(
      "update app.org_members set deactivated_at = now() where organization_id = $1 and user_id = $2",
      [A.id, gone],
    );
    expect(await count("app.work_browser_signins where id = $1", [left.id])).toBe(0);
    expect(await count("app.secrets where id = $1", [left.secret])).toBe(0);
    expect(await count("app.work_browser_signins where id = $1", [stays.id])).toBe(1);

    const removed = await person(A.id, "developer");
    const r1 = await signin(A, removed, "removed.test");
    await db.query("delete from app.org_members where organization_id = $1 and user_id = $2", [
      A.id,
      removed,
    ]);
    expect(await count("app.work_browser_signins where id = $1", [r1.id])).toBe(0);
    expect(await count("app.secrets where id = $1", [r1.secret])).toBe(0);

    const authGone = await person(A.id, "developer");
    const r2 = await signin(A, authGone, "auth-removed.test");
    await db.query("delete from auth.member where organization_id = $1 and user_id = $2", [A.id, authGone]);
    expect(await count("app.work_browser_signins where id = $1", [r2.id])).toBe(0);
    expect(await count("app.secrets where id = $1", [r2.secret])).toBe(0);
    // Another organization's rows of the same person are never touched (B's own member stays signed in).
    const other = await signin(B, B.user, "auth-removed.test");
    expect(await count("app.work_browser_signins where id = $1", [other.id])).toBe(1);
  });

  it("the clean-up functions are SECURITY DEFINER with a fixed search_path and not callable by the public", async () => {
    const fns = await db.query(
      `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
              has_function_privilege('public', p.oid, 'execute') as public
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname in ('work_browser_signin_secret_cleanup', 'work_browser_signins_member_gone')
        order by 1`,
    );
    expect(fns.rows).toEqual(
      ["work_browser_signin_secret_cleanup", "work_browser_signins_member_gone"].map((proname) => ({
        proname,
        prosecdef: true,
        owner: "ocw_migrator",
        proconfig: ["search_path=pg_catalog, pg_temp"],
        public: false,
      })),
    );
  });
});

describe("policies and privileges (07.13 PD-03, PD-04)", () => {
  it("both tables are ENABLE + FORCE RLS with the tenant policy and their restrictive one; the app role may not TRUNCATE them", async () => {
    const policies = await db.query(
      `select tablename, policyname, permissive, cmd from pg_policies
        where schemaname = 'app' and tablename in ('work_browsers', 'work_browser_signins') order by tablename, policyname`,
    );
    expect(policies.rows).toEqual([
      {
        tablename: "work_browser_signins",
        policyname: "personal_owner_only",
        permissive: "RESTRICTIVE",
        cmd: "ALL",
      },
      {
        tablename: "work_browser_signins",
        policyname: "tenant_isolation",
        permissive: "PERMISSIVE",
        cmd: "ALL",
      },
      { tablename: "work_browsers", policyname: "audience_backstop", permissive: "RESTRICTIVE", cmd: "ALL" },
      { tablename: "work_browsers", policyname: "tenant_isolation", permissive: "PERMISSIVE", cmd: "ALL" },
    ]);
    const rls = await db.query(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname in ('work_browsers', 'work_browser_signins') order by c.relname`,
    );
    expect(rls.rows).toEqual([
      { relname: "work_browser_signins", rls: true, force: true },
      { relname: "work_browsers", rls: true, force: true },
    ]);
    for (const tbl of ["app.work_browsers", "app.work_browser_signins"]) {
      await expect(
        as(A.id, null, (q) => q(`truncate ${tbl}`)),
        `truncate ${tbl}`,
      ).rejects.toMatchObject({ code: "42501" });
      const priv = await db.query("select has_table_privilege('ocw_app', $1, 'TRUNCATE') as t", [tbl]);
      expect(priv.rows[0].t, tbl).toBe(false);
    }
  });
});

describe("the session browser (07.13 PD-04, PD-14)", () => {
  it("stores one row per session with the defaults; a second row is refused; deleting the session deletes it", async () => {
    const session = await workSession(A.id, A.project, A.device, A.user);
    await as(A.id, A.user, async (q) => {
      await q("insert into app.work_browsers (work_session_id, organization_id) values ($1, $2)", [
        session,
        A.id,
      ]);
      const row = await q(
        `select state, origin, controller_user_id, lease_id, lease_expires_at, lease_input, signin_id, signin_user_id,
                upload_id, upload_user_id, upload_origin, upload_expires_at, closed_at,
                opened_at is not null as opened, updated_at is not null as stamped
           from app.work_browsers where work_session_id = $1`,
        [session],
      );
      expect(row.rows).toEqual([
        {
          state: "open",
          origin: null,
          controller_user_id: null,
          lease_id: null,
          lease_expires_at: null,
          lease_input: false,
          signin_id: null,
          signin_user_id: null,
          upload_id: null,
          upload_user_id: null,
          upload_origin: null,
          upload_expires_at: null,
          closed_at: null,
          opened: true,
          stamped: true,
        },
      ]);
    });
    await db.query("insert into app.work_browsers (work_session_id, organization_id) values ($1, $2)", [
      session,
      A.id,
    ]);
    await refused(
      db.query("insert into app.work_browsers (work_session_id, organization_id) values ($1, $2)", [
        session,
        A.id,
      ]),
      { constraint: "work_browsers_pkey" },
    );
    // A session of another organization is never a parent (composite FK).
    await refused(
      db.query("insert into app.work_browsers (work_session_id, organization_id) values ($1, $2)", [
        B.session,
        A.id,
      ]),
      { constraint: "work_browsers_session_fk" },
    );
    await db.query("delete from app.work_sessions where id = $1", [session]);
    expect(await count("app.work_browsers where work_session_id = $1", [session])).toBe(0);
  });

  it("unlinks a deleted sign-in; refuses a partial lease, a partial upload and an origin with a path", async () => {
    const session = await workSession(A.id, A.project, A.device, A.user);
    const s = await signin(A, A.user, "loaded.test");
    await db.query(
      "insert into app.work_browsers (work_session_id, organization_id, origin, signin_id, signin_user_id) values ($1, $2, 'https://loaded.test:443', $3, $4)",
      [session, A.id, s.id, A.user],
    );
    await db.query("delete from app.work_browser_signins where id = $1", [s.id]);
    const after = await db.query(
      "select organization_id, signin_id, origin from app.work_browsers where work_session_id = $1",
      [session],
    );
    expect(after.rows).toEqual([
      { organization_id: A.id, signin_id: null, origin: "https://loaded.test:443" },
    ]);

    const set = (cols: string, values: unknown[]) =>
      db.query(`update app.work_browsers set ${cols} where work_session_id = $1`, [session, ...values]);
    await refused(set("lease_id = $2", [randomUUID()]), { constraint: "work_browsers_lease_ck" });
    await refused(set("lease_id = $2, controller_user_id = $3", [randomUUID(), A.user]), {
      constraint: "work_browsers_lease_ck",
    });
    const lease = await set(
      "lease_id = $2, controller_user_id = $3, lease_expires_at = now() + interval '1 minute'",
      [randomUUID(), A.user],
    );
    expect(lease.rowCount).toBe(1);
    await refused(set("upload_id = $2", [randomUUID()]), { constraint: "work_browsers_upload_ck" });
    const upload = await set(
      "upload_id = $2, upload_user_id = $3, upload_origin = 'http://localhost:3000', upload_expires_at = now() + interval '5 minutes'",
      [randomUUID(), A.user],
    );
    expect(upload.rowCount).toBe(1);
    for (const bad of [
      "http://h:3000/x",
      "https://h",
      "https://h:3000?q=1",
      "ftp://h:21",
      "https://user@h:443",
      "HTTPS://H:443",
    ]) {
      await refused(set("origin = $2", [bad]), { constraint: "work_browsers_origin_ck" });
      await refused(set("upload_origin = $2", [bad]), { constraint: "work_browsers_upload_origin_ck" });
    }
    for (const ok of ["http://h:3000", "https://[::1]:8443", "http://127.0.0.1:5173"]) {
      expect((await set("origin = $2", [ok])).rowCount, ok).toBe(1);
    }
  });

  it("follows its session's audience: a member outside it reads and writes no row; the creator and a user-less path do", async () => {
    const session = await workSession(A.id, A.project, A.device, A.user);
    await db.query("insert into app.work_browsers (work_session_id, organization_id) values ($1, $2)", [
      session,
      A.id,
    ]);
    const seen = (user: string | null) =>
      as(
        A.id,
        user,
        async (q) =>
          (await q("select count(*)::int as n from app.work_browsers where work_session_id = $1", [session]))
            .rows[0].n,
      );
    expect(await seen(A.member), "outside the audience").toBe(0);
    expect(await seen(A.user), "creator").toBe(1);
    expect(await seen(null), "user-less (Device Link, sweeps)").toBe(1);
    await as(A.id, A.member, async (q) => {
      const up = await q("update app.work_browsers set lease_input = true where work_session_id = $1", [
        session,
      ]);
      expect(up.rowCount).toBe(0);
      const del = await q("delete from app.work_browsers where work_session_id = $1", [session]);
      expect(del.rowCount).toBe(0);
    });
    const other = await workSession(A.id, A.project, A.device, A.user);
    await expect(
      as(A.id, A.member, (q) =>
        q("insert into app.work_browsers (work_session_id, organization_id) values ($1, $2)", [other, A.id]),
      ),
      "insert outside the audience",
    ).rejects.toThrow(/row-level security/);
    // Another tenant sees nothing, even without a user.
    expect(
      (
        await as(B.id, null, (q) =>
          q("select count(*)::int as n from app.work_browsers where organization_id = $1", [A.id]),
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

describe("the sweep and the purge (07.13 D-23, PD-14)", () => {
  it("purges only the caller organization's expired sign-ins and returns ids, owner and site only", async () => {
    const expiredA = await signin(A, A.user, "expired-a.test", { expires: "now() - interval '1 hour'" });
    const freshA = await signin(A, A.user, "fresh-a.test");
    const expiredB = await signin(B, B.user, "expired-b.test", { expires: "now() - interval '1 hour'" });
    // As a user-less tenant transaction (the sweep's): past the owner-only policy, only through the function.
    const purged = await as(A.id, null, async (q) => {
      const r = await q("select * from app.purge_work_browser_signins(now())");
      // Committed by the function's caller in the sweep; here the outer rollback undoes it, so read inside.
      expect(
        (await q("select count(*)::int as n from app.secrets where id = $1", [expiredA.secret])).rows[0].n,
      ).toBe(0);
      return r;
    });
    expect(purged.fields.map((f) => f.name)).toEqual(["id", "user_id", "site_key"]);
    expect(purged.rows).toEqual([{ id: expiredA.id, user_id: A.user, site_key: "expired-a.test" }]);
    // Rolled back with the tenant transaction: now for real, as the sweep commits it.
    await app.query("begin");
    await app.query(
      "select set_config('app.organization_id', $1, true), set_config('app.user_id', '', true)",
      [A.id],
    );
    await app.query("select * from app.purge_work_browser_signins(now())");
    await app.query("commit");
    expect(await count("app.work_browser_signins where id = $1", [expiredA.id])).toBe(0);
    expect(await count("app.secrets where id = $1", [expiredA.secret])).toBe(0);
    expect(await count("app.work_browser_signins where id = $1", [freshA.id])).toBe(1);
    expect(await count("app.work_browser_signins where id = $1", [expiredB.id]), "B's row stays").toBe(1);
    // Without a tenant it deletes nothing.
    const none = await app.query("select * from app.purge_work_browser_signins(now())");
    expect(none.rows).toEqual([]);
    await db.query("delete from app.work_browser_signins where id = $1", [expiredB.id]);
  });

  it("lists the organizations with an expired sign-in or a lapsed lease, ids only, keyset by id", async () => {
    const C = await seedOrg();
    const D = await seedOrg();
    await signin(A, A.user, "sweep-a.test", { expires: "now() - interval '1 minute'" });
    // C: a lapsed takeover lease on its session browser; D: a lease still running.
    for (const [o, at] of [
      [C, "now() - interval '1 second'"],
      [D, "now() + interval '1 minute'"],
    ] as const) {
      await db.query(
        `insert into app.work_browsers (work_session_id, organization_id, controller_user_id, lease_id, lease_expires_at)
         values ($1, $2, $3, $4, ${at})`,
        [o.session, o.id, o.user, randomUUID()],
      );
    }
    const swept = await as(A.id, null, (q) =>
      q("select * from app.work_browser_sweep_organizations(now(), now(), null, 100)"),
    );
    expect(swept.fields.map((f) => f.name)).toEqual(["organization_id"]);
    const ids = swept.rows.map((r) => r.organization_id as string);
    expect(ids).toContain(A.id);
    expect(ids).toContain(C.id);
    expect(ids).not.toContain(B.id);
    expect(ids).not.toContain(D.id);
    expect(ids).toEqual([...ids].sort());
    // Keyset: after the first id, the first is gone; the limit is honoured (and clamped to at least 1).
    const first = ids[0];
    const after = await as(A.id, null, (q) =>
      q("select * from app.work_browser_sweep_organizations(now(), now(), $1, 100)", [first]),
    );
    expect(after.rows.map((r) => r.organization_id)).toEqual(ids.slice(1));
    const one = await as(A.id, null, (q) =>
      q("select * from app.work_browser_sweep_organizations(now(), now(), null, 0)"),
    );
    expect(one.rows).toHaveLength(1);
  });

  it("both functions are SECURITY DEFINER with a fixed search_path, executable by the app role and not by the public", async () => {
    const fns = await db.query(
      `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
              has_function_privilege('ocw_app', p.oid, 'execute') as app,
              has_function_privilege('public', p.oid, 'execute') as public
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname in ('purge_work_browser_signins', 'work_browser_sweep_organizations')
        order by 1`,
    );
    expect(fns.rows).toEqual(
      ["purge_work_browser_signins", "work_browser_sweep_organizations"].map((proname) => ({
        proname,
        prosecdef: true,
        owner: "ocw_migrator",
        proconfig: ["search_path=pg_catalog, pg_temp"],
        app: true,
        public: false,
      })),
    );
  });
});
