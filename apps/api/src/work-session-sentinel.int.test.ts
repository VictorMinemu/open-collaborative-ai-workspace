import { type ServerFrame, WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WorkSessionService } from "./modules/work-session";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "./testing";
import { eventually, FakeDevice, sleep } from "./testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createTeamProject,
  invite,
  pairDevice,
  shareDevice,
  startSession,
} from "./testing-workzone";

/**
 * Phase 07.9-07 (D-08, P-08, UI-SPEC secrecy backstop): a session's live updates reach exactly the people the resolver
 * lets read it, unstored, on their own `user:` topic after commit; nothing about a session is written on `org:`, which
 * every member reads (Work Zone on or off). Real PostgreSQL and Redis, the real gateway, a contracts-level fake device.
 *
 * Cast: Víctor (admin), Dora (lead, owns "Dora's Quokka Laptop" with the repo `sentinel-api` linked to the team project
 * Atlas and the personal repo `sentinel-notes`), Ana (developer, Atlas member, a grant on Dora's device, creates the
 * sessions), Pia and Leo (developers, Atlas members), Olga (developer, nothing), Wes (developer, a grant on Dora's
 * device, Work Zone off by a rule on his department).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const DEVICE_NAME = "Dora's Quokka Laptop";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let admin: TestClient;
let adminId: string;
let dora: TestClient;
let doraId: string;
let ana: TestClient;
let anaId: string;
let pia: TestClient;
let piaId: string;
let leoId: string;
let olga: TestClient;
let olgaId: string;
let wes: TestClient;
let wesId: string;
let device: FakeDevice;
let deviceId: string;
let apiRepo: string;
let notesRepo: string;
let atlas: string;

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** Every frame the bus carries on `topic` (what any socket subscribed to it would be sent), from now on. */
async function tap(topic: string) {
  const frames: ServerFrame[] = [];
  const stop = await stack.built.core.realtime.listen(topic, (f) => frames.push(f));
  return { frames, stop };
}
type Tap = Awaited<ReturnType<typeof tap>>;

const sessionFrames = (t: Tap, sessionId: string) =>
  t.frames.filter(
    (f) => f.op === "eph" && f.type === "work_session.updated" && (f.data as Json | null)?.id === sessionId,
  );

const orgSeq = async () =>
  Number(
    (await su.query("select last_seq from app.streams where id = $1", [`org:${orgId}`])).rows[0]?.last_seq ??
      0,
  );
const orgSessionEvents = async () =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'work_session.updated'",
      [`org:${orgId}`],
    )
  ).rows;

/** The work-session service the stack wired as the Device Link's session handler. */
function service(): WorkSessionService {
  const handler = stack.built.deviceHub.sessionHandler;
  if (!(handler instanceof WorkSessionService)) throw new Error("no work-session service");
  return handler;
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN, orgName: "Autofy Labs" }),
  );
  orgId = setup.organization.id;
  adminId = setup.user.id;
  ({ client: dora, userId: doraId } = await invite(stack, admin, "dora@example.test", "Dora", "lead"));
  ({ client: ana, userId: anaId } = await invite(stack, admin, "ana@example.test", "Ana", "developer"));
  ({ client: pia, userId: piaId } = await invite(stack, admin, "pia@example.test", "Pia", "developer"));
  ({ userId: leoId } = await invite(stack, admin, "leo@example.test", "Leo", "developer"));
  ({ client: olga, userId: olgaId } = await invite(stack, admin, "olga@example.test", "Olga", "developer"));
  ({ client: wes, userId: wesId } = await invite(stack, admin, "wes@example.test", "Wes", "developer"));

  const paired = await pairDevice(stack, dora, DEVICE_NAME);
  deviceId = paired.deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, { codexLoggedIn: true });
  device.send({
    type: "projects.sync",
    projects: [
      { localId: "lp_api", name: "sentinel-api", gitRemote: null, defaultBranch: "main" },
      { localId: "lp_notes", name: "sentinel-notes", gitRemote: null, defaultBranch: "main" },
    ],
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG]);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  const repos = (await ok(dora.request("GET", "/api/v1/projects"))).projects as Json[];
  apiRepo = repos.find((p) => p.name === "sentinel-api")!.id;
  notesRepo = repos.find((p) => p.name === "sentinel-notes")!.id;

  await shareDevice(dora, deviceId, anaId, "acceptEdits");
  await shareDevice(dora, deviceId, wesId);
  atlas = (
    await createTeamProject(stack, admin, {
      name: "Atlas",
      members: [{ userId: doraId, role: "lead" }, { userId: anaId }, { userId: piaId }, { userId: leoId }],
    })
  ).unitId;
  // Dora leads Atlas and may use the device: she links the repository through the route (P-11).
  await ok(dora.request("POST", `/api/v1/work-projects/${atlas}/repos`, { projectId: apiRepo }));

  // Wes's department has Work Zone off (ADR-0024: one deny row per catalog pattern, scoped to the unit).
  const ops = await ok(
    admin.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }),
  );
  await ok(admin.request("POST", `/api/v1/units/${ops.id}/members`, { userId: wesId, role: "member" }));
  await ok(
    admin.request("PUT", "/api/v1/module-access", {
      module: "work_zone",
      scopeUnitId: ops.id,
      subject: { kind: "everyone" },
      enabled: false,
    }),
  );
}, 240_000);

afterAll(async () => {
  try {
    await device?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: one update reaches only its audience

describe("a session update reaches only the people who may see it (D-08, P-08)", () => {
  let team: string;
  let taps: Record<string, Tap>;
  const audience = () => ({ Ana: anaId, Pia: piaId, Dora: doraId, Víctor: adminId });
  const outside = () => ({ Leo: leoId, Olga: olgaId, Wes: wesId });

  beforeAll(async () => {
    team = await startSession(ana, device, apiRepo, { title: "Delivery check" });
    // Let the deliveries of the start's own transactions land before the audience changes and the taps open.
    await sleep(500);
    // Audience `people [Pia]`, set as the system would (the visibility API is 07.9-06's).
    await su.query("update app.work_sessions set visibility = 'people' where id = $1", [team]);
    await su.query(
      "insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by) values ($1, $2, 'user', $3, $4)",
      [orgId, team, piaId, anaId],
    );
    taps = {};
    for (const [name, id] of Object.entries({ ...audience(), ...outside() }))
      taps[name] = await tap(`user:${id}`);
  });

  afterAll(async () => {
    for (const t of Object.values(taps ?? {})) await t.stop();
  });

  const reset = () => {
    for (const t of Object.values(taps)) t.frames.length = 0;
  };

  it("three emits in one transaction: one frame per allowed person, none for anyone else, nothing on org:", async () => {
    reset();
    const before = await orgSeq();
    await stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
      await service().emitSession(tx, team);
      await service().emitSession(tx, team);
      await service().emitSession(tx, team);
    });
    for (const name of Object.keys(audience())) {
      await eventually(async () => sessionFrames(taps[name]!, team).length > 0, 3000);
    }
    await sleep(400);
    for (const name of Object.keys(audience())) {
      const got = sessionFrames(taps[name]!, team);
      expect(got, name).toHaveLength(1);
      expect((got[0] as Json).data).toMatchObject({
        id: team,
        title: "Delivery check",
        deviceName: DEVICE_NAME,
      });
    }
    for (const name of Object.keys(outside())) expect(sessionFrames(taps[name]!, team), name).toEqual([]);
    expect(await orgSeq()).toBe(before);
  });

  it("a rolled-back transaction delivers nothing", async () => {
    reset();
    await expect(
      stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
        await service().emitSession(tx, team);
        await tx.execute(sql`select 1`);
        throw new Error("rolled back on purpose");
      }),
    ).rejects.toThrow("rolled back on purpose");
    await sleep(600);
    for (const t of Object.values(taps)) expect(sessionFrames(t, team)).toEqual([]);
  });

  it("a queued prompt reaches Ana, Pia, the device owner and the admin; Leo, Olga and Wes get nothing", async () => {
    reset();
    await ok(ana.request("POST", `/api/v1/work-sessions/${team}/prompts`, { body: "Delivery prompt" }));
    for (const name of Object.keys(audience())) {
      await eventually(async () => sessionFrames(taps[name]!, team).length > 0, 3000);
    }
    const prompt = await device.command("prompt", team);
    device.ack(prompt.id);
    device.event(team, { type: "prompt.started", promptId: prompt.payload.promptId });
    device.event(team, {
      type: "prompt.completed",
      promptId: prompt.payload.promptId,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    device.event(team, { type: "session.state", status: "idle" });
    await eventually(async () => {
      const d = await ok(ana.request("GET", `/api/v1/work-sessions/${team}`));
      return d.session.runningSince === null && d.session.status === "idle";
    });
    await sleep(400);
    for (const name of Object.keys(outside())) {
      expect(JSON.stringify(taps[name]!.frames), name).not.toContain(team);
    }
    expect(await orgSessionEvents()).toEqual([]);
  });
});

// ---------------------------------------------------------------- Task 2: the sentinel

/** An authenticated /ws socket that records every frame, raw, as the server sent it. */
async function openSocket(as: TestClient) {
  const socket = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await as.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const raw: string[] = [];
  const frames: Json[] = [];
  socket.on("message", (m) => {
    raw.push(String(m));
    frames.push(JSON.parse(String(m)) as Json);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const send = (f: unknown) => socket.send(JSON.stringify(f));
  const sub = async (topic: string, opts: { afterSeq?: number } = {}) => {
    send({ op: "sub", topic, ...opts });
    return eventually(async () =>
      frames.find((f) => (f.op === "subscribed" || f.op === "err") && f.topic === topic),
    );
  };
  return { socket, raw, frames, send, sub };
}
type Sock = Awaited<ReturnType<typeof openSocket>>;

/** The device runs the next prompt of `sessionId` to completion. */
async function runPrompt(sessionId: string) {
  const prompt = await device.command("prompt", sessionId);
  device.ack(prompt.id);
  device.event(sessionId, { type: "prompt.started", promptId: prompt.payload.promptId });
  device.event(sessionId, {
    type: "prompt.completed",
    promptId: prompt.payload.promptId,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  device.event(sessionId, { type: "session.state", status: "idle" });
  await eventually(async () => {
    const d = await ok(ana.request("GET", `/api/v1/work-sessions/${sessionId}`));
    return d.session.status === "idle" && d.session.queuedCount === 0 && d.session.runningSince === null;
  });
}

describe("the sentinel: nothing about a session reaches an outsider or a member with Work Zone off (D-08, D-13)", () => {
  const PROMPT = "Quokkafirst heuristic ledger rounding";
  const TITLE = "Quokkatitle ledger rounding fix";
  const BRANCH = "quokka/sentinel-branch";

  it("created, prompted, retitled, re-scoped by link and unlink: Olga and Wes receive nothing, live or by replay", async () => {
    // Olga (outside everything) and Wes (a device grantee whose Work Zone is off) follow the org stream from its
    // first event and their own topic, for the whole life of the session.
    const watchers: Record<string, Sock> = { Olga: await openSocket(olga), Wes: await openSocket(wes) };
    for (const [name, s] of Object.entries(watchers)) {
      const userId = name === "Olga" ? olgaId : wesId;
      expect((await s.sub(`org:${orgId}`, { afterSeq: 0 })).op, name).toBe("subscribed");
      expect((await s.sub(`user:${userId}`, { afterSeq: 0 })).op, name).toBe("subscribed");
    }
    // Control: Pia follows her own topic; she is in the audience once the repo is linked to her team project.
    const control = await openSocket(pia);
    expect((await control.sub(`user:${piaId}`, { afterSeq: 0 })).op).toBe("subscribed");

    try {
      // Created on the personal repo; its first prompt's first line becomes the (heuristic) title.
      const id = await startSession(ana, device, notesRepo);
      await ok(ana.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: PROMPT }));
      const titleCmd = await device.command("session.title", id);
      await runPrompt(id);
      // Retitled by the device.
      device.titleResult(titleCmd.id, id, TITLE, "haiku");
      device.ack(titleCmd.id);
      await eventually(async () => {
        const d = await ok(ana.request("GET", `/api/v1/work-sessions/${id}`));
        return d.session.title === TITLE;
      });
      // The branch, reported by the device in its diff answers (the one asked after the turn and Ana's).
      const diff = ana.request("GET", `/api/v1/work-sessions/${id}/diff`);
      let answered = false;
      void diff.finally(() => {
        answered = true;
      });
      while (!answered) {
        const cmd = await device.command("diff.request", id, 500).catch(() => null);
        if (!cmd) continue;
        device.ack(cmd.id);
        device.send({
          type: "diff.result",
          requestId: cmd.id,
          sessionId: id,
          files: [{ path: "src/ledger.ts", status: "modified", additions: 2, deletions: 1 }],
          patch: "",
          branch: BRANCH,
        });
      }
      expect((await diff).status).toBe(200);
      await eventually(async () => {
        const d = await ok(ana.request("GET", `/api/v1/work-sessions/${id}`));
        return d.session.branch === BRANCH;
      });
      const detail = (await ok(ana.request("GET", `/api/v1/work-sessions/${id}`))).session as Json;
      expect(detail).toMatchObject({ title: TITLE, branch: BRANCH, deviceName: DEVICE_NAME });

      // Re-scoped: the repo joins Atlas (neither Olga nor Wes is in it); a prompt runs; the repo leaves; another runs.
      await ok(dora.request("POST", `/api/v1/work-projects/${atlas}/repos`, { projectId: notesRepo }));
      await ok(ana.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "Second quokka prompt" }));
      await runPrompt(id);
      await eventually(async () => control.raw.some((r) => r.includes(TITLE)), 3000);
      await ok(dora.request("DELETE", `/api/v1/work-projects/${atlas}/repos/${notesRepo}`));
      await ok(ana.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "Third quokka prompt" }));
      await runPrompt(id);

      await sleep(500);

      const secrets = [id, PROMPT, TITLE, BRANCH, DEVICE_NAME];
      for (const [name, s] of Object.entries(watchers)) {
        // The whole serialized stream, not selected fields: a future field cannot slip through.
        const everything = JSON.stringify(s.raw);
        expect(s.raw.length, name).toBeGreaterThan(0);
        for (const secret of secrets)
          expect(everything, `${name} received "${secret}"`).not.toContain(secret);
        expect(
          s.frames.some((f) => f.op === "revoked"),
          name,
        ).toBe(false);
      }

      // Following the session itself is refused to both (on another socket: the refusal echoes the id they sent).
      for (const [name, as] of [
        ["Olga", olga],
        ["Wes", wes],
      ] as const) {
        const probe = await openSocket(as);
        try {
          expect(await probe.sub(`ws:${id}`), name).toMatchObject({ op: "err", code: "forbidden" });
        } finally {
          probe.socket.close();
        }
      }

      // A fresh replay of the org stream from its first event carries no session event at all.
      const replay = await openSocket(olga);
      try {
        expect((await replay.sub(`org:${orgId}`, { afterSeq: 0 })).op).toBe("subscribed");
        const events = replay.frames.filter((f) => f.op === "ev");
        expect(events.length).toBeGreaterThan(0);
        expect(events.filter((f) => String(f.type).startsWith("work_session."))).toEqual([]);
        for (const secret of secrets) expect(JSON.stringify(replay.raw)).not.toContain(secret);
      } finally {
        replay.socket.close();
      }
      expect(await orgSessionEvents()).toEqual([]);

      // REST: the list, the detail, the controls and the diff say nothing about it either.
      for (const [name, as] of [
        ["Olga", olga],
        ["Wes", wes],
      ] as const) {
        for (const path of [
          "/api/v1/work-sessions",
          "/api/v1/work-sessions?archived=1",
          `/api/v1/work-sessions/${id}`,
          `/api/v1/work-sessions/${id}/controls`,
          `/api/v1/work-sessions/${id}/diff`,
        ]) {
          const res = await as.request("GET", path);
          expect([200, 403, 404], `${name} ${path}`).toContain(res.status);
          if (!path.endsWith("/work-sessions") && !path.includes("archived")) {
            expect(res.status, `${name} ${path}`).not.toBe(200);
          }
          const body = JSON.stringify(res.body);
          for (const secret of secrets)
            expect(body, `${name} ${path} carried "${secret}"`).not.toContain(secret);
        }
      }

      // The sentinel is not vacuous: Pia, in the audience while the repo was in Atlas, saw the title on her topic.
      expect(control.raw.some((r) => r.includes(TITLE) && r.includes(id))).toBe(true);
    } finally {
      for (const s of [...Object.values(watchers), control]) s.socket.close();
    }
  });
});

// ---------------------------------------------------------------- 07.9 fan-out: privacy first when a session narrows

describe("narrowing a session: the people it removes get `revoked` and `work_session.removed`, nothing else (07.9 fan-out)", () => {
  it("the narrowing's own snapshot and every later frame of the session stay away from Pia; Ana still gets them", async () => {
    const id = await startSession(ana, device, apiRepo, { title: "Narrowing check" });
    const piaSock = await openSocket(pia);
    const anaSock = await openSocket(ana);
    try {
      for (const [name, s] of [
        ["Pia", piaSock],
        ["Ana", anaSock],
      ] as const) {
        expect((await s.sub(`ws:${id}`)).op, name).toBe("subscribed");
      }
      expect((await piaSock.sub(`user:${piaId}`)).op).toBe("subscribed");
      // Every delivery of the start has landed before the mark: what follows is caused by the narrowing.
      await sleep(500);
      const mark = piaSock.frames.length;
      const anaMark = anaSock.frames.length;

      const res = await ok(ana.request("PUT", `/api/v1/work-sessions/${id}/visibility`, { kind: "owner" }));
      expect(res.removedCount).toBeGreaterThan(0);
      // Right after the commit, the device reports a durable event and a delta for the session.
      device.event(id, { type: "assistant.message", messageId: "after-narrowing", text: "Narrowed answer" });
      device.event(id, { type: "assistant.delta", messageId: "after-narrowing", text: "Narrowed delta" });

      // Ana keeps the session: the snapshot, the event and the delta reach her.
      await eventually(async () => {
        const seen = JSON.stringify(anaSock.frames.slice(anaMark));
        return seen.includes("Narrowed answer") && seen.includes("Narrowed delta");
      }, 3000);
      await eventually(
        async () => piaSock.frames.slice(mark).some((f) => f.op === "revoked" && f.topic === `ws:${id}`),
        2000,
      );
      await sleep(400);

      const after = piaSock.frames.slice(mark);
      expect(
        after.filter((f) => f.topic === `ws:${id}` && (f.op === "ev" || f.op === "eph")),
        "no frame of the session after the narrowing",
      ).toEqual([]);
      expect(after.find((f) => f.op === "revoked")).toMatchObject({ topic: `ws:${id}`, cause: "visibility" });
      const mine = after.filter((f) => f.topic === `user:${piaId}`);
      expect(mine.filter((f) => f.type === "work_session.updated" && f.data?.id === id)).toEqual([]);
      expect(mine.filter((f) => f.type === "work_session.removed" && f.data?.id === id)).toHaveLength(1);
      expect(JSON.stringify(after)).not.toContain("Narrowed");
    } finally {
      piaSock.socket.close();
      anaSock.socket.close();
    }
  });
});
