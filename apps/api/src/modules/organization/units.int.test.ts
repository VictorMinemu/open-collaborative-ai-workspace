import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let dev: TestClient;
let orgId: string;
let devId: string;

type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

/** The error code of a failed request, asserting its status. */
async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return (r.body as Record<string, any>).error as { code: string; details?: Record<string, unknown> };
}

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

const orgEvents = async () =>
  (
    await su.query("select type, payload from app.stream_events where stream_id = $1 order by seq", [
      `org:${orgId}`,
    ])
  ).rows as Array<{ type: string; payload: { unitId: string; action: string } }>;

async function invite(email: string, role: string, name: string) {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id as string };
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: dev, id: devId } = await invite("dev@example.test", "developer", "Dana Dev"));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("units: build and rearrange the hierarchy", () => {
  let it_: string;
  let backend: string;
  let alpha: string;
  let marketing: string;

  it("admin creates department → team → project with materialised paths", async () => {
    const itUnit = await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "IT", parentId: null }),
    );
    it_ = itUnit.id;
    expect(itUnit).toMatchObject({ kind: "department", name: "IT", parentId: null, path: [it_] });
    expect(itUnit.viewerCan).toEqual(["unit.manage", "unit.members.manage"]);

    const be = await ok(
      admin.request("POST", "/api/v1/units", { kind: "team", name: "Backend", parentId: it_ }),
    );
    backend = be.id;
    expect(be.path).toEqual([it_, backend]);

    const al = await ok(
      admin.request("POST", "/api/v1/units", { kind: "project", name: "Alpha", parentId: backend }),
    );
    alpha = al.id;
    expect(al.path).toEqual([it_, backend, alpha]);

    const list = await ok(admin.request("GET", "/api/v1/units"));
    expect(list.units.map((u: { name: string }) => u.name)).toEqual(["IT", "Backend", "Alpha"]);
    for (const u of list.units) expect(u).toMatchObject({ memberCount: 0, leadCount: 0 });
    expect(list.lastSeq).toBeGreaterThanOrEqual(3);
  });

  it("enforces kind rules, sibling names and tenant-scoped parents", async () => {
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", { kind: "team", name: "Loose", parentId: null }),
          400,
        )
      ).code,
    ).toBe("invalid_parent_kind");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", { kind: "team", name: "Under project", parentId: alpha }),
          400,
        )
      ).code,
    ).toBe("invalid_parent_kind");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", { kind: "department", name: "it", parentId: null }),
          409,
        )
      ).code,
    ).toBe("unit_name_taken");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", {
            kind: "team",
            name: "Ghost",
            parentId: "01900000-0000-7000-8000-000000000000",
          }),
          404,
        )
      ).code,
    ).toBe("unit_not_found");
  });

  it("moving a unit rewrites its whole subtree in one transaction", async () => {
    const mk = await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "Marketing", parentId: null }),
    );
    marketing = mk.id;
    const moved = await ok(admin.request("POST", `/api/v1/units/${backend}/move`, { parentId: marketing }));
    expect(moved).toMatchObject({ id: backend, parentId: marketing, path: [marketing, backend] });

    const list = await ok(admin.request("GET", "/api/v1/units"));
    const byId = new Map(list.units.map((u: { id: string }) => [u.id, u]));
    expect(byId.get(alpha)).toMatchObject({ parentId: backend, path: [marketing, backend, alpha] });
    expect(byId.get(it_)).toMatchObject({ path: [it_] });
    const db = await su.query("select path from app.org_units where id = $1", [alpha]);
    expect(db.rows[0].path).toEqual([marketing, backend, alpha]);
  });

  it("audits every change and emits units.updated on the org topic", async () => {
    const created = await audit("unit.created");
    expect(created).toHaveLength(4);
    expect(created.every((r) => r.result === "success" && r.organization_id === orgId)).toBe(true);
    expect(created[1].metadata).toMatchObject({ name: "Backend", kind: "team", parentId: it_ });

    const moved = await audit("unit.moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ resource_id: backend, result: "success" });
    expect(moved[0].metadata).toMatchObject({ fromParentId: it_, toParentId: marketing });

    const events = (await orgEvents()).filter((e) => e.type === "units.updated");
    expect(events.map((e) => e.payload.action)).toEqual([
      "created",
      "created",
      "created",
      "created",
      "moved",
    ]);
    expect(events.at(-1)?.payload.unitId).toBe(backend);
  });

  it("a developer reads the tree but cannot change it (403, audited)", async () => {
    const list = await ok(dev.request("GET", "/api/v1/units"));
    expect(list.units).toHaveLength(4);
    expect(list.units[0].viewerCan).toEqual([]);

    const denied = await fails(
      dev.request("POST", "/api/v1/units", { kind: "department", name: "Shadow", parentId: null }),
      403,
    );
    expect(denied.details).toMatchObject({ permission: "unit.manage" });
    await fails(dev.request("POST", `/api/v1/units/${backend}/move`, { parentId: it_ }), 403);

    const rows = await audit("authz.denied");
    const mine = rows.filter((r) => r.user_id === devId && r.metadata.permission === "unit.manage");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect((await su.query("select count(*)::int as n from app.org_units")).rows[0].n).toBe(4);
  });
});
