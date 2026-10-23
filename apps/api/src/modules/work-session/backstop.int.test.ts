import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import {
  connectWithProject,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  startSession,
} from "../../testing-workzone";

/**
 * 07.9-12 Task 2 (D-09, D-13, P-10): the API paths the RESTRICTIVE `audience_backstop` changed, each fixed at its
 * source and proven here through the real API.
 * - A project lead may narrow a session past themself in one request: the answer is the new audience (built from what
 *   the request stored), the people who keep the session get its snapshot (appended by the system after commit), and
 *   nobody who keeps it is counted as removed (the facts of others come from the definer shape, not the caller's RLS).
 * - A route that finds no session still audits the audience denial when the session exists (`sessionNotFound`), and
 *   only then: an unknown id stays a plain 404.
 */

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let lea: TestClient;
let gus: TestClient;
let pia: TestClient;
let olga: TestClient;
let leaId = "";
let piaId = "";
let olgaId = "";
let device: FakeDevice | null = null;
let session = "";

type Res = { status: number; body: Record<string, unknown> | null };
async function ok(res: Promise<Res>) {
  const r = await res;
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

const audienceDenials = async (userId: string) =>
  (
    await su.query(
      `select count(*)::int as n from app.audit_events where action = 'authz.denied' and user_id = $1
         and metadata->>'reason' = 'not_in_audience'`,
      [userId],
    )
  ).rows[0].n as number;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  const org = setup.organization.id as string;
  ({ client: lea, userId: leaId } = await invite(stack, victor, "lea@example.test", "Lea Lund", "lead"));
  const { client: gusClient, userId: gusId } = await invite(
    stack,
    victor,
    "gus@example.test",
    "Gus Garcia",
    "developer",
  );
  gus = gusClient;
  ({ client: pia, userId: piaId } = await invite(
    stack,
    victor,
    "pia@example.test",
    "Pia Perez",
    "developer",
  ));
  ({ client: olga, userId: olgaId } = await invite(
    stack,
    victor,
    "olga@example.test",
    "Olga Ortiz",
    "developer",
  ));

  const { unitId } = await createTeamProject(stack, victor, {
    name: "Atlas",
    members: [{ userId: leaId, role: "lead" }, { userId: gusId }, { userId: piaId }],
  });
  const paired = await pairDevice(stack, gus, "Gus's Mac");
  const connected = await connectWithProject(stack, gus, paired.token, { localId: "atlas", name: "atlas" });
  device = connected.device;
  await linkRepo(stack, {
    organizationId: org,
    unitId,
    projectId: connected.projectId,
    deviceId: paired.deviceId,
    linkedBy: gusId,
  });
  session = await startSession(gus, connected.device, connected.projectId, { title: "Atlas session" });
}, 240_000);

afterAll(async () => {
  await device?.close();
  await su?.end();
  await stack?.stop();
});

describe("a project lead narrows a session past themself (07.9-12)", () => {
  it("gets the new audience, loses the session, and the people who keep it are neither removed nor left stale", async () => {
    expect((await ok(lea.request("GET", `/api/v1/work-sessions/${session}`))).session.title).toBe(
      "Atlas session",
    );
    const before = (
      await su.query("select coalesce(max(seq), 0)::int as seq from app.stream_events where stream_id = $1", [
        `ws:${session}`,
      ])
    ).rows[0].seq as number;

    const res = await ok(
      lea.request("PUT", `/api/v1/work-sessions/${session}/visibility`, { kind: "owner" }),
    );
    expect(res.visibility.kind).toBe("owner");
    expect(res.visibility.teams).toEqual([]);
    expect(res.visibility.people).toEqual([]);
    // Gus (the owner, who runs it on his own Mac) still sees it; Lea and Pia do not, and only they are removed.
    expect(res.visibility.viewers.people.map((p: { name: string }) => p.name)).toEqual(["Gus Garcia"]);
    expect(res.removedCount).toBe(2);
    expect(res.removedNames).toEqual(["Lea Lund", "Pia Perez"]);
    expect(res.visibility.viewerCan).toEqual({ change: false });

    expect((await lea.request("GET", `/api/v1/work-sessions/${session}`)).status).toBe(404);
    expect((await pia.request("GET", `/api/v1/work-sessions/${session}`)).status).toBe(404);
    const kept = await ok(gus.request("GET", `/api/v1/work-sessions/${session}`));
    expect(kept.session.visibility.kind).toBe("owner");

    // The snapshot of the change reached the session's stream (the system appended it after Lea's commit).
    const snapshot = await eventually(async () => {
      const rows = (
        await su.query(
          "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' and seq > $2 order by seq desc limit 1",
          [`ws:${session}`, before],
        )
      ).rows;
      return rows[0]?.payload as { visibility?: { kind?: string } } | undefined;
    });
    expect(snapshot.visibility?.kind).toBe("owner");

    // The audit row of the change names the actor and the counts, as before the backstop.
    const audit = (
      await su.query(
        "select user_id, metadata from app.audit_events where action = 'work_session.visibility_changed' and resource_id = $1 order by occurred_at desc limit 1",
        [session],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      user_id: leaId,
      metadata: { from: "project", to: "owner", removedCount: 2 },
    });
  });
});

describe("a session the caller cannot see still audits the attempt (07.9-12)", () => {
  it("audits not_in_audience for a change to an existing session outside the audience, never for an unknown id", async () => {
    // Reads answer the same 404 as an unknown id (GET denials are not audited, as before the backstop).
    const hidden = await olga.request("GET", `/api/v1/work-sessions/${session}`);
    const unknown = await olga.request("GET", `/api/v1/work-sessions/${randomUUID()}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(unknown.body);

    // Changes are audited as the resolver's audience denial, whatever lookup the route uses (locked, visibility).
    const before = await audienceDenials(olgaId);
    const attempts: Array<[string, string, unknown]> = [
      ["POST", "prompts", { body: "hi" }],
      ["POST", "interrupt", undefined],
      ["PUT", "visibility", { kind: "project" }],
    ];
    for (const [method, path, body] of attempts) {
      const onHidden = await olga.request(method, `/api/v1/work-sessions/${session}/${path}`, body);
      const onUnknown = await olga.request(method, `/api/v1/work-sessions/${randomUUID()}/${path}`, body);
      expect(onHidden.status, path).toBe(404);
      expect(onHidden.body, path).toEqual(onUnknown.body);
    }
    await eventually(async () => (await audienceDenials(olgaId)) === before + attempts.length);
    await new Promise((r) => setTimeout(r, 200));
    expect(await audienceDenials(olgaId)).toBe(before + attempts.length);
    // Nothing changed for Gus.
    expect((await ok(gus.request("GET", `/api/v1/work-sessions/${session}`))).session.visibility.kind).toBe(
      "owner",
    );
  });
});
