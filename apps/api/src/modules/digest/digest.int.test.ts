import { randomUUID } from "node:crypto";
import { DigestPreview, DigestView } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, startAiStack } from "../../testing-ai";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  setAudience,
  settled,
  startSession,
} from "../../testing-workzone";
import type { ApprovalKind } from "../approval/registry";
import { tickOnce } from "../automation/runner";

/**
 * 07.6-13 (AUTO-05; D-05, D-07, D-11; P-14, P-16; UI-SPEC R6): the personal digest. A person saves when and what; it
 * becomes their one `digest` automation; the runner fires it on schedule; the four sections are re-checked for read
 * access at send time (sessions only through `app.work_session_access` via the resolver); it arrives as a DM from the
 * bot they chose, posted by the platform (no turn); skip-empty skips it; the optional AI summary is the person's,
 * metered, and only sees the composed list. Real PostgreSQL, Redis and pg-boss; the fake model only.
 *
 * Cast (organization A): Root (admin, runs the org), Víctor Ruiz (developer: the digest's owner), Ana (developer, owns
 * "Ana's MacBook" with `billing-api`, linked to the team project Billing), Sam Lee (developer); the team bot Scout
 * (organization-wide), the team bot Ledger (Finance only, Víctor outside), Víctor's and Sam's personal bots. Eve (her
 * own organization B, no bots).
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: AiStack;
let su: pg.Client;
let orgId: string;
let root: TestClient;
let victor: TestClient;
let victorId: string;
let ana: TestClient;
let anaId: string;
let sam: TestClient;
let samId: string;
let eve: TestClient;
let scoutId: string;
let ledgerId: string;
let victorBotId: string;
let samBotId: string;
let salesId: string;
let victorDevice: FakeDevice;
let victorRepo: string;
let anaDevice: FakeDevice;
let billingRepo: string;
let billing: { unitId: string; parentId: string };
let billingTeam: string;
/** The digest automation of Víctor (Task 1). */
let digestId: string;
/** The items of the tracer's digest (they must never come back). */
const tracer: Record<string, string> = {};

const deciders = new Set<string>();
const core = () => stack.built.core;
const drain = () => core().jobs.drain("automation.fire");

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = async (res: Promise<Res>, status: number) => {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return (r.body?.error as Json | undefined)?.code as string | undefined;
};

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const ALL = ["decisions", "follows", "mentions", "work_zone"];

const settings = (extra: Json = {}): Json => ({
  enabled: true,
  days: WEEKDAYS,
  time: "08:00",
  timeZone: "Europe/Madrid",
  sections: ALL,
  skipEmpty: true,
  agentId: scoutId,
  summary: { enabled: false, modelRef: null },
  ...extra,
});

const view = async (as: TestClient = victor) =>
  DigestView.parse(await ok(as.request("GET", "/api/v1/digest")));
const save = (body: Json, as: TestClient = victor) => as.request("PUT", "/api/v1/digest", body);
const preview = async (body: Json = settings(), as: TestClient = victor) =>
  DigestPreview.parse(await ok(as.request("POST", "/api/v1/digest/preview", body)));

const digestRow = async () =>
  (
    await su.query("select * from app.automations where action_kind = 'digest' and run_as_user_id = $1", [
      victorId,
    ])
  ).rows as Json[];

const runsOf = async (automationId: string) =>
  (
    await su.query("select * from app.automation_runs where automation_id = $1 order by created_at, id", [
      automationId,
    ])
  ).rows as Json[];

const messageById = async (id: string) =>
  (await su.query("select * from app.messages where id = $1", [id])).rows[0] as Json;

/** Makes the digest due and lets the runner fire it: the last run row. */
async function fireDigest(): Promise<Json> {
  await su.query("update app.automations set next_run_at = $2 where id = $1", [
    digestId,
    new Date(Date.now() - 30_000).toISOString(),
  ]);
  const ticked = await tickOnce(core());
  expect(ticked.fired).toBeGreaterThanOrEqual(1);
  await drain();
  const runs = await runsOf(digestId);
  return runs[runs.length - 1] as Json;
}

/** The ids every link of a digest names, by kind. */
function linked(md: string, prefix: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\((\/[^)]*)\)/g)) {
    const href = m[1] as string;
    if (href.startsWith(prefix)) out.push(href.slice(prefix.length).split(/[?&]/)[0] as string);
  }
  return out;
}

/** A pending approval of the test kind, decided by `deciders` (07.2's inbox lists it for them). */
async function pendingApproval(title: string): Promise<string> {
  const resourceId = randomUUID();
  titles.set(resourceId, title);
  return (
    await su.query(
      `insert into app.approval_requests (organization_id, kind, mode, resource_type, resource_id, action_hash,
         requested_by_agent_id, requested_for_user_id, expires_at)
       values ($1, 'test.digest', 'grant', 'test_action', $2, repeat('a', 64), $3, $4, now() + interval '1 day')
       returning id`,
      [orgId, resourceId, scoutId, samId],
    )
  ).rows[0].id as string;
}
const titles = new Map<string, string>();

const digestKind: ApprovalKind = {
  kind: "test.digest",
  mode: "grant",
  resourceType: "test_action",
  ttlMs: 60 * 60 * 1000,
  async hashInput(_tx, row) {
    return [row.resourceId];
  },
  async canDecide(_tx, userId) {
    return deciders.has(userId);
  },
  async audience() {
    return [...deciders];
  },
  async view(_tx, row) {
    return { type: "fields", title: titles.get(row.resourceId) ?? "Test", fields: [] };
  },
  async headline(_tx, row) {
    return {
      title: titles.get(row.resourceId) ?? "Test",
      context: null,
      requester: "Scout for Sam Lee",
      tags: [],
    };
  },
};

/** An Agent Card posted by Scout in `conversationId` (the bridge chat uses for every agent post). */
async function postCard(conversationId: string, title: string): Promise<string> {
  return core().db.withTenant({ organizationId: orgId, userId: null }, async (tx) => {
    const posted = await core().chatAgent.postAgentMessageIn(tx, {
      agentId: scoutId,
      conversationId,
      threadRootId: null,
      body: title,
      idempotencyKey: `card:${randomUUID()}`,
      card: { kind: "report", title, summary: title, status: "running", fields: [], actions: [] },
    });
    return posted.messageId;
  });
}

/** The card changed now (what an agent PATCH does to `updated_at`). */
const touchCard = (messageId: string) =>
  su.query("update app.message_cards set updated_at = now(), status = 'succeeded' where message_id = $1", [
    messageId,
  ]);

/** `as` writes in `conversationId`, mentioning Víctor. */
const mention = async (as: TestClient, conversationId: string, body: string) =>
  (
    await ok(
      as.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
        body,
        mentions: [{ kind: "user", id: victorId }],
      }),
    )
  ).id as string;

async function channel(name: string, members: Array<{ kind: string; id: string }>): Promise<string> {
  const id = (await ok(root.request("POST", "/api/v1/channels", { name, visibility: "private" })))
    .id as string;
  for (const m of members) await ok(root.request("POST", `/api/v1/channels/${id}/members`, m));
  return id;
}

/** A session brought to `status` now (`waiting_approval` or ended), after the device's own events have landed. */
async function setStatus(sessionId: string, status: string): Promise<void> {
  // The device's start acknowledgement may still land after the session showed idle: set it until it stays.
  await eventually(async () => {
    await settled(stack, orgId);
    await su.query("update app.work_sessions set status = $2, updated_at = now() where id = $1", [
      sessionId,
      status,
    ]);
    await new Promise((r) => setTimeout(r, 150));
    await settled(stack, orgId);
    const now = await su.query("select status from app.work_sessions where id = $1", [sessionId]);
    return now.rows[0]?.status === status;
  });
}

async function connect(
  owner: TestClient,
  name: string,
  repo: string,
): Promise<{ device: FakeDevice; repo: string; deviceId: string }> {
  const paired = await pairDevice(stack, owner, name);
  const device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: [{ localId: `lp_${repo}`, name: repo, gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [paired.deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 1;
  });
  const repos = (await ok(owner.request("GET", "/api/v1/projects"))).projects as Json[];
  return { device, repo: repos.find((p) => p.name === repo)!.id as string, deviceId: paired.deviceId };
}

/** Organization B: Eve leaves A and becomes the admin of her own organization (no bots there). */
async function moveToOrgB(userId: string): Promise<void> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `o-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
}

beforeAll(async () => {
  stack = await startAiStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  root = new TestClient(stack.baseUrl);
  const setup = await ok(
    root.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Root Admin",
      email: "root@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: victor, userId: victorId } = await invite(
    stack,
    root,
    "victor@example.test",
    "Víctor Ruiz",
    "developer",
  ));
  ({ client: ana, userId: anaId } = await invite(stack, root, "ana@example.test", "Ana", "developer"));
  ({ client: sam, userId: samId } = await invite(stack, root, "sam@example.test", "Sam Lee", "developer"));
  ({ client: eve } = await invite(stack, root, "eve@example.test", "Eve", "developer"));
  const eveId = ((await ok(eve.request("GET", "/api/v1/me"))).user as Json).id as string;
  await moveToOrgB(eveId);

  stack.built.approvals.register(digestKind);
  deciders.add(victorId);

  const bot = async (name: string, username: string, unitId?: string) =>
    (
      await ok(
        root.request("POST", "/api/v1/agents", {
          name,
          username,
          instructions: `You are ${name}.`,
          modelProvider: "mock",
          modelId: "mock-1",
          ...(unitId ? { unitId } : {}),
        }),
      )
    ).id as string;
  scoutId = await bot("Scout", "scout");
  const finance = (
    await ok(root.request("POST", "/api/v1/units", { kind: "department", name: "Finance", parentId: null }))
  ).id as string;
  ledgerId = await bot("Ledger", "ledger", finance);
  victorBotId = (await ok(victor.request("POST", "/api/v1/agents/personal", {}))).agent.id as string;
  samBotId = (await ok(sam.request("POST", "/api/v1/agents/personal", {}))).agent.id as string;

  salesId = await channel("sales", [
    { kind: "user", id: victorId },
    { kind: "user", id: samId },
    { kind: "agent", id: scoutId },
  ]);

  // Víctor's own device and repository (his own sessions: he may approve them).
  const mine = await connect(victor, "Víctor's Mac", "web-app");
  victorDevice = mine.device;
  victorRepo = mine.repo;
  // Ana's MacBook, its repository linked to the team project Billing (Ana and Víctor), with the team "Billing East".
  const anas = await connect(ana, "Ana's MacBook", "billing-api");
  anaDevice = anas.device;
  billingRepo = anas.repo;
  billing = await createTeamProject(stack, root, {
    name: "Billing",
    members: [{ userId: anaId }, { userId: victorId }],
  });
  await linkRepo(stack, {
    organizationId: orgId,
    unitId: billing.unitId,
    projectId: billingRepo,
    deviceId: anas.deviceId,
    linkedBy: anaId,
  });
  billingTeam = (
    await ok(
      root.request("POST", "/api/v1/units", {
        kind: "team",
        name: "Billing East",
        parentId: billing.parentId,
      }),
    )
  ).id as string;
  await ok(root.request("POST", `/api/v1/units/${billingTeam}/members`, { userId: victorId }));
  await ok(root.request("POST", `/api/v1/work-projects/${billing.unitId}/teams`, { unitId: billingTeam }));
}, 300_000);

afterAll(async () => {
  try {
    vi.restoreAllMocks();
    await victorDevice?.close().catch(() => {});
    await anaDevice?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("Víctor saves a weekday 08:00 Madrid digest and receives it in his DM with Scout (AUTO-05, D-05, D-07)", () => {
  it("GET /digest: no settings yet, his personal bot first, then the team bots he may read", async () => {
    const v = await view();
    expect(v.settings).toBeNull();
    expect(v.automationId).toBeNull();
    const ids = v.bots.map((b) => b.id);
    expect(ids[0]).toBe(victorBotId);
    expect(v.bots[0]?.personal).toBe(true);
    expect(ids).toContain(scoutId);
    expect(ids).not.toContain(ledgerId);
    expect(ids).not.toContain(samBotId);
  });

  it("PUT /digest makes his one digest automation (derived cron, DM target, run as him); a second PUT updates it; off pauses it", async () => {
    const saved = DigestView.parse(await ok(save(settings())));
    expect(saved.settings).toEqual(settings());
    expect(saved.nextRunAt).not.toBeNull();
    const rows = await digestRow();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Json;
    digestId = row.id;
    expect(saved.automationId).toBe(digestId);
    expect(row).toMatchObject({
      action_kind: "digest",
      trigger_kind: "schedule",
      target_kind: "dm",
      schedule_cron: "0 8 * * 1,2,3,4,5",
      time_zone: "Europe/Madrid",
      run_as_user_id: victorId,
      created_by: victorId,
      agent_id: scoutId,
      status: "active",
      instructions: "",
    });
    expect(row.config).toMatchObject({ sections: ALL, skipEmpty: true, summary: { enabled: false } });

    const again = DigestView.parse(await ok(save(settings({ time: "09:30", days: ["fri", "mon"] }))));
    expect(again.automationId).toBe(digestId);
    expect(again.settings).toMatchObject({ time: "09:30", days: ["mon", "fri"] });
    expect(await digestRow()).toHaveLength(1);
    expect((await digestRow())[0]).toMatchObject({ schedule_cron: "30 9 * * 1,5" });

    const off = DigestView.parse(await ok(save(settings({ enabled: false }))));
    expect(off.settings?.enabled).toBe(false);
    expect(off.nextRunAt).toBeNull();
    expect((await digestRow())[0]).toMatchObject({ status: "paused", paused_by: victorId });

    const on = DigestView.parse(await ok(save(settings())));
    expect(on.settings).toEqual(settings());
    expect((await digestRow())[0]).toMatchObject({ status: "active", schedule_cron: "0 8 * * 1,2,3,4,5" });
    const audits = await su.query(
      "select user_id, metadata from app.audit_events where action = 'digest.saved' and resource_id = $1",
      [digestId],
    );
    expect(audits.rows).toHaveLength(4);
    // Tests below send several digests in a day.
    await su.query("update app.automations set max_runs_per_day = 50 where id = $1", [digestId]);
  });

  it("on schedule the runner sends one DM from Scout with the four sections, counts and relative links; answered; audited with counts only", async () => {
    const approvalId = await pendingApproval("Append to clients/acme.md");
    const cardId = await postCard(salesId, "Q3 pipeline report");
    await ok(victor.request("POST", `/api/v1/cards/${cardId}/follow`), 204);
    await touchCard(cardId);
    const mentionId = await mention(sam, salesId, "@victor the totals look off, can you check?");
    const sessionId = await startSession(victor, victorDevice, victorRepo, { title: "Fix login redirect" });
    await setStatus(sessionId, "waiting_approval");
    Object.assign(tracer, { approvalId, cardId, mentionId, sessionId });
    const modelCalls = stack.fake.requests().length;

    const run = await fireDigest();
    expect(run).toMatchObject({ status: "answered", trigger: "schedule", reason: null });
    expect(run.anchor_message_id).toBeTruthy();
    const msg = await messageById(run.anchor_message_id);
    expect(msg).toMatchObject({
      author_kind: "agent",
      author_id: scoutId,
      client_message_id: `digest:${run.id}`,
    });
    // Víctor's DM with Scout.
    const dm = (await su.query("select kind from app.conversations where id = $1", [msg.conversation_id]))
      .rows[0];
    expect(dm.kind).toBe("dm");
    const members = (
      await su.query(
        "select member_kind, member_id from app.conversation_members where conversation_id = $1",
        [msg.conversation_id],
      )
    ).rows.map((r) => `${r.member_kind}:${r.member_id}`);
    expect(members.sort()).toEqual([`agent:${scoutId}`, `user:${victorId}`].sort());

    const body = msg.body as string;
    expect(body).toMatch(/^### Your digest · \w{3}, \w{3} \d{1,2}\n/u);
    for (const heading of [
      "**Waiting for you (1)**",
      "**Cards you follow (1)**",
      "**Unread mentions (1)**",
      "**Work Zone (1)**",
    ]) {
      expect(body).toContain(heading);
    }
    expect(linked(body, "/approvals/")).toEqual([approvalId]);
    expect(body).toContain(`(/chat/${salesId}?m=${cardId})`);
    expect(body).toContain(`(/chat/${salesId}?m=${mentionId})`);
    expect(linked(body, "/work-zone/")).toEqual([sessionId]);
    expect(body).toContain("Fix login redirect](/work-zone/");
    expect(body).toContain("Waiting for your approval");
    expect(body).toContain("Sam Lee mentioned you in \\#sales");
    expect(body.endsWith("Change what's included in [Settings › Digest](/settings/digest).")).toBe(true);
    // No message body reached the digest (titles, names and states only), and no model was called.
    expect(body).not.toContain("totals look off");
    expect(stack.fake.requests().length).toBe(modelCalls);

    const audit = (
      await su.query(
        "select user_id, agent_id, metadata from app.audit_events where action = 'digest.sent' and resource_id = $1",
        [run.id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: victorId, agent_id: scoutId });
    expect(audit[0]?.metadata).toMatchObject({
      automationId: digestId,
      runId: run.id,
      counts: { decisions: 1, follows: 1, mentions: 1, work_zone: 1 },
      summary: "off",
    });
    const text = JSON.stringify(audit[0]?.metadata);
    for (const leaked of ["Append to clients", "Q3 pipeline", "totals", "Fix login"])
      expect(text).not.toContain(leaked);
    // His view now says when it was last sent.
    expect((await view()).lastSentAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------- Task 2: exact and safe

describe("the digest says exactly what Víctor can see now, once, and nothing when there is nothing (D-05, P-14)", () => {
  it("nothing new with skip-empty on: nothing is sent and the run is skipped (nothing_new); off: a short Nothing new digest", async () => {
    const skipped = await fireDigest();
    expect(skipped).toMatchObject({ status: "skipped", reason: "nothing_new", anchor_message_id: null });
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'automation.run_skipped' and resource_id = $1",
      [skipped.id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ reason: "nothing_new" });
    expect(
      await su.query("select 1 from app.messages where client_message_id = $1", [`digest:${skipped.id}`]),
    ).toMatchObject({ rowCount: 0 });
    // A skip with nothing new is not a failure (the breaker is untouched).
    expect((await digestRow())[0]).toMatchObject({ status: "active", consecutive_failures: 0 });

    await ok(save(settings({ skipEmpty: false })));
    const sent = await fireDigest();
    expect(sent).toMatchObject({ status: "answered" });
    const body = (await messageById(sent.anchor_message_id)).body as string;
    expect(body).toContain("Nothing new since your last digest.");
    expect(body).not.toContain("**");
    await ok(save(settings()));
  });

  it("only what happened since the last digest is listed: the tracer's items never come back", async () => {
    const newer = await mention(sam, salesId, "@victor one more thing");
    const p = await preview();
    expect(p.empty).toBe(false);
    expect(p.markdown).toContain(`(/chat/${salesId}?m=${newer})`);
    expect(p.markdown).not.toContain(tracer.mentionId);
    expect(p.markdown).not.toContain(tracer.approvalId);
    expect(p.markdown).not.toContain(tracer.cardId);
    expect(p.markdown).not.toContain(tracer.sessionId);
    expect(p.markdown).toContain("**Unread mentions (1)**");
    // Read in the inbox, it is not "unread" any more.
    await ok(victor.request("POST", "/api/v1/notifications/read", { all: true }));
    expect((await preview()).empty).toBe(true);
  });

  it("access lost before sending: removed from a channel, its followed card and its mention are gone", async () => {
    const opsId = await channel("ops", [
      { kind: "user", id: victorId },
      { kind: "user", id: samId },
      { kind: "agent", id: scoutId },
    ]);
    const cardId = await postCard(opsId, "Incident review");
    await ok(victor.request("POST", `/api/v1/cards/${cardId}/follow`), 204);
    await touchCard(cardId);
    const mentionId = await mention(sam, opsId, "@victor ops needs you");
    let p = await preview();
    expect(p.markdown).toContain(`(/chat/${opsId}?m=${cardId})`);
    expect(p.markdown).toContain(`(/chat/${opsId}?m=${mentionId})`);
    expect(p.markdown).toContain("Incident review");

    await ok(root.request("DELETE", `/api/v1/channels/${opsId}/members/user/${victorId}`));
    p = await preview();
    expect(p.markdown).not.toContain(opsId);
    expect(p.markdown).not.toContain("Incident review");
    expect(p.empty).toBe(true);
  });

  it("an unchecked section is not queried and not shown", async () => {
    await pendingApproval("Delete the staging database");
    const list = vi.spyOn(stack.built.approvals, "list");
    try {
      const p = await preview(settings({ sections: ["mentions", "follows"] }));
      expect(list).not.toHaveBeenCalled();
      expect(p.markdown).not.toContain("Waiting for you");
      const q = await preview(settings({ sections: ["decisions"] }));
      expect(list).toHaveBeenCalledTimes(1);
      expect(q.markdown).toContain("**Waiting for you (1)**");
      expect(q.markdown).toContain("Delete the staging database");
    } finally {
      list.mockRestore();
    }
    // A decider who lost the right stops seeing it (07.2's live rule).
    deciders.delete(victorId);
    try {
      expect((await preview(settings({ sections: ["decisions"] }))).empty).toBe(true);
    } finally {
      deciders.add(victorId);
    }
  });
});

describe("Work Zone sessions only through app.work_session_access via the resolver (D-11)", () => {
  const wz = async (body: Json = settings({ sections: ["work_zone"] })) =>
    linked((await preview(body)).markdown, "/work-zone/");

  it("Ana's ended session in Billing (project audience) is listed and named while Víctor reads it; owner audience hides it", async () => {
    const s1 = await startSession(ana, anaDevice, billingRepo, { title: "Invoice rounding" });
    await setStatus(s1, "completed");
    const p = await preview(settings({ sections: ["work_zone"] }));
    expect(linked(p.markdown, "/work-zone/")).toContain(s1);
    expect(p.markdown).toContain(`[Invoice rounding](/work-zone/${s1}) · Billing · Ended`);

    await setAudience(ana, s1, { kind: "owner" });
    await setStatus(s1, "completed");
    expect(await wz()).not.toContain(s1);
    await setAudience(ana, s1, { kind: "project" });
    await setStatus(s1, "completed");
    expect(await wz()).toContain(s1);
    tracer.billingSession = s1;
  });

  it("a waiting session he reads but may not decide (work_session.approve) is not listed as waiting for him", async () => {
    const s2 = await startSession(ana, anaDevice, billingRepo, { title: "Pending deploy" });
    await setStatus(s2, "waiting_approval");
    // He reads it (the session's own route) …
    await ok(victor.request("GET", `/api/v1/work-sessions/${s2}`));
    // … but only Ana (creator, device owner) and admins decide it.
    expect(await wz()).not.toContain(s2);
    await setStatus(s2, "completed");
    expect(await wz()).toContain(s2);
  });

  it("owner, project, teams and people audiences: the digest's set is the set GET /work-sessions returns to him", async () => {
    const west = (
      await ok(
        root.request("POST", "/api/v1/units", {
          kind: "team",
          name: "Billing West",
          parentId: billing.parentId,
        }),
      )
    ).id as string;
    await ok(root.request("POST", `/api/v1/units/${west}/members`, { userId: anaId }));
    await ok(root.request("POST", `/api/v1/work-projects/${billing.unitId}/teams`, { unitId: west }));
    const audiences: Array<[string, Parameters<typeof setAudience>[2]]> = [
      ["owner", { kind: "owner" }],
      ["project", { kind: "project" }],
      ["teams-east", { kind: "teams", teamIds: [billingTeam] }],
      ["teams-west", { kind: "teams", teamIds: [west] }],
      ["people-victor", { kind: "people", userIds: [victorId] }],
      ["people-ana", { kind: "people", userIds: [anaId] }],
    ];
    const made = new Map<string, string>();
    for (const [name, audience] of audiences) {
      const id = await startSession(ana, anaDevice, billingRepo, { title: `Audience ${name}` });
      await setAudience(ana, id, audience);
      made.set(name, id);
    }
    for (const id of made.values()) await setStatus(id, "completed");
    const fixture = new Set(made.values());
    const listed = ((await ok(victor.request("GET", "/api/v1/work-sessions"))).sessions as Json[])
      .map((s) => s.id as string)
      .filter((id) => fixture.has(id));
    const digested = (await wz()).filter((id) => fixture.has(id));
    expect(new Set(digested)).toEqual(new Set(listed));
    // The rule, as the list states it: he is in the project and in Billing East, not in Billing West.
    expect(listed).toEqual(
      expect.arrayContaining([made.get("project"), made.get("teams-east"), made.get("people-victor")]),
    );
    for (const hidden of ["owner", "teams-west", "people-ana"])
      expect(listed).not.toContain(made.get(hidden));
  });

  it("a session on his own device in a project he is not in is listed (device owner), without the project's name", async () => {
    const portal = await createTeamProject(stack, root, { name: "Portal", members: [{ userId: samId }] });
    const other = await connect(victor, "Víctor's Mini", "portal-web");
    try {
      await linkRepo(stack, {
        organizationId: orgId,
        unitId: portal.unitId,
        projectId: other.repo,
        deviceId: other.deviceId,
        linkedBy: victorId,
      });
      await ok(
        victor.request("PUT", `/api/v1/devices/${other.deviceId}/grants/user/${samId}`, {
          maxMode: "default",
        }),
      );
      const s3 = await startSession(sam, other.device, other.repo, { title: "Portal checkout" });
      await setStatus(s3, "completed");
      const p = await preview(settings({ sections: ["work_zone"] }));
      expect(linked(p.markdown, "/work-zone/")).toContain(s3);
      expect(p.markdown).toContain(`[Portal checkout](/work-zone/${s3}) · Ended`);
      expect(p.markdown).not.toContain("Portal ·");
    } finally {
      await other.device.close().catch(() => {});
    }
  });

  it("after Víctor leaves the project, its project-audience session is gone from his digest", async () => {
    const s1 = tracer.billingSession as string;
    await setStatus(s1, "completed");
    expect(await wz()).toContain(s1);
    // Billing East (assigned to the project) opens it to its people too (07.9 D-14): he leaves both.
    await ok(root.request("DELETE", `/api/v1/units/${billing.unitId}/members/${victorId}`));
    await ok(root.request("DELETE", `/api/v1/units/${billingTeam}/members/${victorId}`));
    await setStatus(s1, "completed");
    expect(await wz()).not.toContain(s1);
    const listed = ((await ok(victor.request("GET", "/api/v1/work-sessions"))).sessions as Json[]).map(
      (s) => s.id,
    );
    expect(listed).not.toContain(s1);
  });
});

describe("bot choice rules (D-07, T-07.6-13-04)", () => {
  it("only a bot he may DM: a team bot he cannot read or Sam's personal bot is 400 bot_not_readable; his own works", async () => {
    expect(await errorOf(save(settings({ agentId: ledgerId })), 400)).toBe("bot_not_readable");
    expect(await errorOf(save(settings({ agentId: samBotId })), 400)).toBe("bot_not_readable");
    // An unknown id reads the same (no existence leak).
    expect(await errorOf(save(settings({ agentId: randomUUID() })), 400)).toBe("bot_not_readable");
    expect((await digestRow())[0]).toMatchObject({ agent_id: scoutId });
    const personal = DigestView.parse(await ok(save(settings({ agentId: victorBotId }))));
    expect(personal.settings?.agentId).toBe(victorBotId);
    await ok(save(settings()));
  });

  it("a member with no bot gets bots: [] (the UI shows the create-bot box) and never another organization's digest", async () => {
    expect(await view(eve)).toMatchObject({ settings: null, automationId: null, bots: [] });
  });
});

// ---------------------------------------------------------------- Task 3: preview, test send, AI summary

const countOf = async (sql: string, params: unknown[] = []) =>
  Number((await su.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n);

const usageOf = async (subjectId: string) =>
  (
    await su.query(
      "select kind, subject_id, requester_user_id, generation_id, conversation_id from app.ai_usage_records where subject_id = $1",
      [subjectId],
    )
  ).rows as Json[];

describe("preview and test send (R6)", () => {
  it("preview renders the exact message for unsaved settings and stores, sends and bills nothing", async () => {
    const mentionId = await mention(sam, salesId, "@victor preview me");
    const before = {
      runs: await countOf("app.automation_runs where automation_id = $1", [digestId]),
      messages: await countOf("app.messages"),
      usage: await countOf("app.ai_usage_records"),
      models: stack.fake.requests().length,
    };
    const row = (await digestRow())[0] as Json;
    // Unsaved: other sections, another zone, the summary switched on (a preview never calls a model).
    const unsaved = await preview(
      settings({
        sections: ["mentions"],
        timeZone: "America/New_York",
        summary: { enabled: true, modelRef: null },
      }),
    );
    expect(unsaved.markdown).toContain(`(/chat/${salesId}?m=${mentionId})`);
    expect(unsaved.markdown).not.toContain("Work Zone");
    expect(await countOf("app.automation_runs where automation_id = $1", [digestId])).toBe(before.runs);
    expect(await countOf("app.messages")).toBe(before.messages);
    expect(await countOf("app.ai_usage_records")).toBe(before.usage);
    expect(stack.fake.requests().length).toBe(before.models);
    expect((await digestRow())[0]).toMatchObject({ version: row.version, config: row.config });

    // The saved settings' preview is exactly what "Send a test now" posts.
    const exact = await preview(settings());
    const sent = await ok(victor.request("POST", "/api/v1/digest/test"));
    const msg = await messageById(sent.messageId);
    expect(msg.conversation_id).toBe(sent.conversationId);
    expect(msg).toMatchObject({ author_kind: "agent", author_id: scoutId });
    expect(msg.body).toBe(exact.markdown);
    expect(exact.empty).toBe(false);
  });

  it("Send a test now sends the saved digest to the DM even with nothing new; 409 not_saved without settings", async () => {
    const sent = await ok(victor.request("POST", "/api/v1/digest/test"));
    const msg = await messageById(sent.messageId);
    expect(msg.body).toContain("Nothing new since your last digest.");
    const run = (
      await su.query("select * from app.automation_runs where anchor_message_id = $1", [sent.messageId])
    ).rows[0] as Json;
    expect(run).toMatchObject({ trigger: "manual", status: "answered", automation_id: digestId });
    const audit = await su.query(
      "select actor_kind, user_id from app.audit_events where action = 'digest.sent' and resource_id = $1",
      [run.id],
    );
    expect(audit.rows[0]).toMatchObject({ actor_kind: "user", user_id: victorId });
    expect(await errorOf(sam.request("POST", "/api/v1/digest/test"), 409)).toBe("not_saved");
  });
});

describe("the optional AI summary is the person's, metered, and sees only the list (P-16, T-07.6-13-02/03)", () => {
  it("a model that is not one of his AI chat models is refused at save", async () => {
    const bogus = { backend: "org_key", provider: "openai", modelId: "not-a-model" };
    expect(await errorOf(save(settings({ summary: { enabled: true, modelRef: bogus } })), 400)).toBe(
      "model_unavailable",
    );
  });

  it("summary on: one model call with the composed list only, the summary on top, one digest usage row for the run", async () => {
    await ok(save(settings({ summary: { enabled: true, modelRef: null } })));
    const secret = "SECRET-BODY-7781";
    await mention(sam, salesId, `@victor ${secret}`);
    const before = stack.fake.requests().length;
    const run = await fireDigest();
    expect(run).toMatchObject({ status: "answered", reason: null });
    const calls = stack.fake.requests().slice(before);
    expect(calls).toHaveLength(1);
    const prompt = JSON.stringify(calls[0]?.body);
    expect(prompt).toContain("<digest>");
    expect(prompt).toContain("Unread mentions (1)");
    expect(prompt).toContain("at most three sentences");
    // Never a message body: the digest itself names the mention, never its text.
    expect(prompt).not.toContain(secret);

    const body = (await messageById(run.anchor_message_id)).body as string;
    expect(body).not.toContain(secret);
    const parts = body.split("\n\n");
    expect(parts[0]).toMatch(/^### Your digest · /u);
    expect(parts[1]?.length).toBeGreaterThan(0);
    expect(parts[1]?.startsWith("**")).toBe(false);
    expect(parts[2]?.startsWith("**Unread mentions (1)**")).toBe(true);
    // Escaped plain text: the model cannot add a link (only the list's and the footer's).
    expect([...(parts[1] ?? "").matchAll(/\]\(/g)]).toHaveLength(0);

    expect(await usageOf(run.id)).toEqual([
      {
        kind: "digest",
        subject_id: run.id,
        requester_user_id: victorId,
        generation_id: null,
        conversation_id: null,
      },
    ]);
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'digest.sent' and resource_id = $1",
      [run.id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ summary: "added" });
  });

  it("at his AI chat cap the digest goes without a summary (run reason summary_skipped_limit), nothing generated or billed", async () => {
    await su.query(
      `insert into app.ai_chat_policies (organization_id, org_key_daily_generations) values ($1, 1)
       on conflict (organization_id) do update set org_key_daily_generations = 1`,
      [orgId],
    );
    await su.query(
      `insert into app.ai_usage_daily (organization_id, user_id, day, backend_class, generations)
       values ($1, $2, (now() at time zone 'utc')::date, 'org_key', 1)
       on conflict (organization_id, user_id, day, backend_class) do update set generations = 1`,
      [orgId, victorId],
    );
    try {
      await mention(sam, salesId, "@victor capped");
      const before = stack.fake.requests().length;
      const run = await fireDigest();
      expect(run).toMatchObject({ status: "answered", reason: "summary_skipped_limit" });
      expect(stack.fake.requests().length).toBe(before);
      const parts = ((await messageById(run.anchor_message_id)).body as string).split("\n\n");
      expect(parts[1]?.startsWith("**Unread mentions (1)**")).toBe(true);
      expect(await usageOf(run.id)).toEqual([]);
    } finally {
      await su.query(
        "update app.ai_chat_policies set org_key_daily_generations = 200 where organization_id = $1",
        [orgId],
      );
    }
  });

  it("summary off: no model call", async () => {
    await ok(save(settings()));
    await mention(sam, salesId, "@victor no summary");
    const before = stack.fake.requests().length;
    const run = await fireDigest();
    expect(run).toMatchObject({ status: "answered", reason: null });
    expect(stack.fake.requests().length).toBe(before);
    expect(await usageOf(run.id)).toEqual([]);
  });
});
