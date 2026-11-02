import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Webhook } from "standardwebhooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeErpMcp,
  FAKE_ERP_TOOLS,
  type FakeErpMcp,
} from "../../../../../infra/fake-model/fake-erp-mcp.mjs";
import { sha256Hex } from "../../lib/crypto";
import { JOB_QUEUES, type JobData, type QueueName } from "../../lib/jobs";
import type { TestClient } from "../../testing";
import { type FakeModel, startFakeModel } from "../../testing-ai";
import { eventually, FakeDevice } from "../../testing-device";
import { type GreenMail, startGreenMail } from "../../testing-mail";
import {
  type Json,
  ok,
  type Res,
  SANDBOX_CELL_TOKEN,
  type SandboxStack,
  startSandboxStack,
} from "../../testing-sandbox";
import { CLAUDE_CATALOG, createTeamProject, pairDevice, startSession } from "../../testing-workzone";
import { replaceServerTools } from "../mcp";
import { mailboxTick } from "./mailboxes";
import { tickOnce } from "./runner";

/**
 * 07.6-24 (C-02, D-07, Pitfall 7; AUTO-01…AUTO-04): the phase's security properties across every 07.6 module, in two
 * organizations on one stack (real PostgreSQL, Redis and pg-boss; GreenMail; the fake ERP MCP server; the fake model;
 * fake devices). Organization A is Víctor Ruiz's (bot Keeper), organization B is Eve's (bot Warden). Each runs the same
 * scenarios with its own distinctive canaries: a scheduled run, Run now, a signed webhook, a mail, a watched check with a
 * change, a compare-and-set conflict, a Work Zone session summary and a digest with its AI summary. Then:
 *   - "07.6 route coverage (org B)": every registered 07.6 route (enumerated from the authz registry) has an organization
 *     B case aimed at organization A's objects that answers 404 (people), 403/404 for the cell, or B's own answer for a
 *     route without an id; a route added later without a case fails with its path;
 *   - "pgboss holds ids only": no canary, secret or password anywhere in the `pgboss` schema, and every stored job's data
 *     parses with its queue's strict schema;
 *   - "forged cross-tenant jobs": a job carrying organization A's id with one of B's run, event, mailbox, record or
 *     session ids completes and does nothing;
 *   - "no content in logs or audit": no canary, webhook secret, mailbox password or ERP value in the captured API log
 *     lines (debug) or any `audit_events.metadata`.
 */

const ERP_TOKEN = `erp-token-${randomBytes(12).toString("hex")}`;
const MAIL = { A: "inbox-a@acme.test", B: "inbox-b@evil.test" } as const;
const RECORD = { A: "SO-10442", B: "SO-10443" } as const;

let s: SandboxStack;
let gm: GreenMail;
let fake: FakeModel;
let erp: FakeErpMcp;
let erpServer: Server;
let erpUrl = "";

const core = () => s.stack.built.core;
/** Every canary written by the scenarios (names, instructions, payloads, mail, record values, summaries, titles). */
const CANARIES: string[] = [];
/** Secrets the scenarios handle: webhook secrets, mailbox passwords, the ERP token. Never in a log, an audit or a job. */
const SECRETS: string[] = [ERP_TOKEN];
/** Each canary by `<org>:<what>`. */
const CANARY = new Map<string, string>();

function canary(org: "A" | "B", what: string): string {
  const c = `OCWCANARY${org}${what}${randomBytes(5).toString("hex")}`;
  CANARIES.push(c);
  CANARY.set(`${org}:${what}`, c);
  return c;
}

type OrgKey = "A" | "B";

/** One organization's cast and objects, built by `setupOrg` and filled by `exercise`. */
interface Org {
  key: OrgKey;
  id: string;
  admin: TestClient;
  adminId: string;
  adminName: string;
  cellToken: string;
  botId: string;
  channelId: string;
  boardId: string;
  erpConnector: Json;
  scheduleAutomationId: string;
  runIds: string[];
  hook: { automationId: string; publicId: string; secret: string };
  webhookEventId: string;
  mailAutomationId: string;
  mailboxId: string;
  vaultItemId: string;
  watchedId: string;
  cardMessageId: string;
  device: FakeDevice;
  repoId: string;
  sessionId: string;
  digestId: string;
}

const orgs = {} as Record<OrgKey, Org>;

const req = (as: TestClient, method: string, path: string, body?: unknown) =>
  as.request(method, path, body) as Promise<Res>;

async function cell(path: string, body: unknown, token: string): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

/** A Standard Webhooks request signed by the `standardwebhooks` library, as another app sends it. */
async function sendHook(hook: { publicId: string; secret: string }, payload: unknown): Promise<Res> {
  const body = JSON.stringify(payload);
  const at = new Date();
  const id = `msg_${randomUUID()}`;
  const res = await fetch(`${s.stack.baseUrl}/api/v1/hooks/${hook.publicId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
      "webhook-signature": new Webhook(hook.secret).sign(id, at, body),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

const drain = (queue: QueueName) => core().jobs.drain(queue, { max: 200 });

/** Sends one job in organization `organizationId`'s tenant transaction (what a module's enqueue does). */
async function sendJob<Q extends QueueName>(
  organizationId: string,
  queue: Q,
  data: JobData<Q>,
): Promise<string> {
  const id = await core().db.withTenant({ organizationId }, (tx) => core().jobs.sendInTx(tx, queue, data));
  if (!id) throw new Error(`no job id for ${queue}`);
  return id;
}

/** The delivered turn of `agentId` for a message `as` posts (in a thread when `threadRootId`), from the cell stream. */
async function turnOf(o: Org, threadRootId: string | null, text: string): Promise<string> {
  await s.su.query("delete from app.agent_usage_daily");
  const msg = await ok(
    req(o.admin, "POST", `/api/v1/conversations/${o.boardId}/messages`, {
      body: `@${o.key === "A" ? "keeper" : "warden"} ${text}`,
      mentions: [{ kind: "agent", id: o.botId }],
      ...(threadRootId ? { threadRootId } : {}),
    }),
  );
  return eventually(async () => {
    const r = (
      await s.su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
        [`cell:${o.id}`, msg.id, o.botId],
      )
    ).rows;
    return r.length > 0 ? (r[0].payload.eventId as string) : undefined;
  });
}

// ---------------------------------------------------------------- the two organizations

async function setupOrg(
  key: OrgKey,
  p: { id: string; admin: TestClient; adminId: string; adminName: string; cellToken: string },
): Promise<Org> {
  const o = { key, ...p } as Org;
  await s.su.query(
    `insert into app.bot_policies (organization_id, max_automations_per_user) values ($1, 100)
     on conflict (organization_id) do update set max_automations_per_user = 100`,
    [o.id],
  );
  const bot = key === "A" ? "Keeper" : "Warden";
  o.botId = (
    await ok(
      req(o.admin, "POST", "/api/v1/agents", {
        name: bot,
        username: bot.toLowerCase(),
        instructions: `You are ${bot}.`,
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
  o.channelId = (
    await ok(
      req(o.admin, "POST", "/api/v1/channels", { name: `ops-${key.toLowerCase()}`, visibility: "private" }),
    )
  ).id as string;
  o.boardId = (
    await ok(
      req(o.admin, "POST", "/api/v1/channels", {
        name: `orders-${key.toLowerCase()}`,
        layout: "board",
        visibility: "private",
      }),
    )
  ).id as string;
  for (const c of [o.channelId, o.boardId]) {
    await ok(req(o.admin, "POST", `/api/v1/channels/${c}/members`, { kind: "agent", id: o.botId }));
  }
  // The ERP with the workspace's own access (07.4 org secret); its tools recorded as a probe would.
  o.erpConnector = await ok(
    req(o.admin, "POST", "/api/v1/mcp-servers", {
      name: "ERP",
      transport: "streamable-http",
      url: erpUrl,
      headers: [{ name: "Authorization", value: `Bearer ${ERP_TOKEN}` }],
    }),
  );
  await core().db.withTenant({ organizationId: o.id }, (tx) =>
    replaceServerTools(
      core(),
      tx,
      o.erpConnector.id,
      FAKE_ERP_TOOLS.map((t) => ({
        name: t.name,
        readOnly: t.annotations.readOnlyHint,
        destructive: t.annotations.destructiveHint,
      })),
    ),
  );
  const caps = await ok(req(o.admin, "GET", `/api/v1/agents/${o.botId}/capabilities`));
  const kept = (caps.tools as Json[])
    .filter((t) => t.granted)
    .map((t) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool }));
  await ok(
    req(o.admin, "PATCH", `/api/v1/agents/${o.botId}/capabilities`, {
      tools: [
        ...kept,
        ...["get_record", "update_record", "add_note"].map((t) => ({
          sourceKind: "mcp",
          sourceId: o.erpConnector.id,
          tool: `${o.erpConnector.safeName}__${t}`,
        })),
      ],
    }),
  );
  // A device of the admin with one repository, linked to a team project the admin leads (07.9).
  const paired = await pairDevice(s.stack, o.admin, `${o.adminName}'s MacBook`);
  o.device = await FakeDevice.connect(s.stack.baseUrl, paired.token);
  o.device.send({
    type: "projects.sync",
    projects: [
      { localId: `lp_${key}`, name: `ledger-${key.toLowerCase()}`, gitRemote: null, defaultBranch: "main" },
    ],
  });
  await o.device.next((f) => f.type === "projects.ack");
  o.device.capabilities([CLAUDE_CATALOG], false);
  await eventually(async () => {
    const r = await s.su.query("select runtime_catalog from app.devices where id = $1", [paired.deviceId]);
    return (r.rows[0]?.runtime_catalog as unknown[] | undefined)?.length === 1;
  });
  const repos = (await ok(req(o.admin, "GET", "/api/v1/projects"))).projects as Json[];
  o.repoId = repos.find((r) => r.name === `ledger-${key.toLowerCase()}`)?.id as string;
  const project = await createTeamProject(s.stack, o.admin, {
    name: `Ledger ${key}`,
    members: [{ userId: o.adminId, role: "lead" }],
  });
  await ok(req(o.admin, "POST", `/api/v1/work-projects/${project.unitId}/repos`, { projectId: o.repoId }));
  return o;
}

/** Every 07.6 scenario of one organization, each with its own canary. */
async function exercise(o: Org): Promise<void> {
  const k = o.key;
  // 1. A scheduled run, then Run now (09, 05).
  o.scheduleAutomationId = (
    await ok(
      req(o.admin, "POST", "/api/v1/automations", {
        name: `Report ${canary(k, "name")}`,
        agentId: o.botId,
        instructions: `Summarise the closed deals ${canary(k, "instructions")}`,
        trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
        target: { kind: "channel", conversationId: o.channelId },
        maxRunsPerDay: 24,
      }),
      201,
    )
  ).automation.id as string;
  await s.su.query("update app.automations set next_run_at = now() - interval '30 seconds' where id = $1", [
    o.scheduleAutomationId,
  ]);
  expect((await tickOnce(core())).fired).toBeGreaterThanOrEqual(1);
  expect(await drain("automation.fire")).toBeGreaterThanOrEqual(1);
  await ok(req(o.admin, "POST", `/api/v1/automations/${o.scheduleAutomationId}/run`), 202);
  expect(await drain("automation.fire")).toBe(1);
  o.runIds = (
    await s.su.query("select id from app.automation_runs where automation_id = $1 order by created_at", [
      o.scheduleAutomationId,
    ])
  ).rows.map((r) => r.id as string);
  expect(o.runIds).toHaveLength(2);

  // 2. A signed webhook (10, 21): the payload carries a canary in the title and the body.
  const created = await ok(
    req(o.admin, "POST", "/api/v1/automations", {
      name: `Orders hook ${canary(k, "hookname")}`,
      agentId: o.botId,
      instructions: `Flag the risky orders ${canary(k, "hookorder")}`,
      trigger: { kind: "webhook" },
      target: { kind: "channel", conversationId: o.channelId },
      inbound: {
        action: "post",
        askBot: true,
        config: { titlePointer: "/order/name", threadKeyPointer: "/order/id" },
      },
    }),
    201,
  );
  o.hook = {
    automationId: created.automation.id as string,
    publicId: created.automation.trigger.webhook.publicId as string,
    secret: created.webhookSecret as string,
  };
  SECRETS.push(o.hook.secret, o.hook.secret.slice("whsec_".length));
  const payload = {
    order: {
      id: 450789,
      name: `#${canary(k, "hooktitle")}`,
      note: `Deliver before noon ${canary(k, "hookbody")}`,
    },
  };
  expect((await sendHook(o.hook, payload)).status).toBe(202);
  expect(await drain("automation.inbound")).toBeGreaterThanOrEqual(1);
  await drain("automation.fire");
  o.webhookEventId = (
    await s.su.query(
      "select e.id from app.automation_events e join app.webhook_endpoints w on w.id = e.webhook_endpoint_id where w.public_id = $1",
      [o.hook.publicId],
    )
  ).rows[0]?.id as string;
  expect(o.webhookEventId).toBeTruthy();

  // 3. A mail (11, 21): a Keychain key for the GreenMail account, a mail automation, one mail with canaries.
  const mailUser = gm.users.find((u) => u.address === MAIL[k]);
  if (!mailUser) throw new Error("no GreenMail user");
  SECRETS.push(mailUser.password);
  o.vaultItemId = (
    await ok(
      req(o.admin, "POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "basic",
        name: `Mailbox ${k}`,
        allowedHosts: [`greenmail:${gm.imapPort}`],
        username: mailUser.login,
        password: mailUser.password,
      }),
      201,
    )
  ).id as string;
  o.mailAutomationId = (
    await ok(
      req(o.admin, "POST", "/api/v1/automations", {
        name: `Supplier inbox ${canary(k, "mailname")}`,
        agentId: o.botId,
        instructions: `Tell me what needs doing ${canary(k, "mailorder")}`,
        trigger: {
          kind: "mail",
          mailbox: {
            vaultItemId: o.vaultItemId,
            host: "greenmail",
            port: gm.imapPort,
            folder: "INBOX",
            pollIntervalMinutes: 5,
          },
        },
        target: { kind: "channel", conversationId: o.channelId },
        inbound: { action: "post", askBot: true, config: {} },
      }),
      201,
    )
  ).automation.id as string;
  o.mailboxId = (
    await s.su.query("select id from app.mailboxes where automation_id = $1", [o.mailAutomationId])
  ).rows[0]?.id as string;
  await gm.sendMail({
    from: "Shop Orders <orders@shop.example>",
    to: MAIL[k],
    subject: `Order ${canary(k, "mailsubject")}`,
    text: `Please deliver before noon. ${canary(k, "mailbody")}`,
  });
  await s.su.query("update app.mailboxes set next_poll_at = now() - interval '1 second' where id = $1", [
    o.mailboxId,
  ]);
  await mailboxTick(core());
  await drain("mailbox.poll");
  expect(
    Number(
      (
        await s.su.query("select count(*)::int as n from app.automation_events where mailbox_id = $1", [
          o.mailboxId,
        ])
      ).rows[0].n,
    ),
  ).toBe(1);
  await drain("automation.inbound");
  await drain("automation.fire");

  // 4. A watched record (07) with a change made elsewhere, then a compare-and-set conflict (14).
  o.cardMessageId = (
    await ok(
      req(o.admin, "POST", `/api/v1/boards/${o.boardId}/cards`, {
        description: `Pump order ${canary(k, "card")}`,
        clientMessageId: randomUUID(),
      }),
    )
  ).messageId as string;
  const fields = [
    { pointer: "/status", label: "Status" },
    { pointer: "/delivery_date", label: "Delivery date" },
  ];
  o.watchedId = (
    await ok(
      req(o.admin, "POST", "/api/v1/watched-records", {
        cardMessageId: o.cardMessageId,
        mcpServerId: o.erpConnector.id,
        externalRef: RECORD[k],
        readTool: "get_record",
        writeTool: "update_record",
        idArg: "id",
        fields,
        checkIntervalMinutes: 60,
        agentId: o.botId,
      }),
      201,
    )
  ).id as string;
  await drain("watched.check");
  const rec = erp.state.records.get(RECORD[k]);
  if (!rec) throw new Error("no ERP record");
  rec.status = canary(k, "erpstatus");
  rec.updated_at = new Date().toISOString();
  await s.su.query(
    "update app.watched_records set next_check_at = now() - interval '1 minute' where id = $1",
    [o.watchedId],
  );
  await sendJob(o.id, "watched.tick", {});
  await drain("watched.tick");
  await drain("watched.check");
  expect(
    Number(
      (
        await s.su.query(
          "select count(*)::int as n from app.watched_record_changes where watched_record_id = $1",
          [o.watchedId],
        )
      ).rows[0].n,
    ),
  ).toBe(1);
  // The bot is asked in the card's thread; the record changes again before its update: 409 record_changed.
  const eventId = await turnOf(o, o.cardMessageId, `please mark it shipped ${canary(k, "mention")}`);
  await drain("watched.check");
  rec.delivery_date = "2026-12-24";
  rec.updated_at = new Date().toISOString();
  const update = await cell(
    "/records/update",
    { eventId, agentId: o.botId, changes: { "/status": canary(k, "erpwrite") } },
    o.cellToken,
  );
  expect(update.status, JSON.stringify(update.body)).toBe(409);
  expect(update.body?.code).toBe("record_changed");
  await drain("watched.check");

  // 5. A Work Zone session summary (08): the prompt and the title carry canaries; the owner proposes it.
  o.sessionId = await startSession(o.admin, o.device, o.repoId, { title: `Export ${canary(k, "session")}` });
  await ok(
    req(o.admin, "POST", `/api/v1/work-sessions/${o.sessionId}/prompts`, {
      body: `Add the CSV export ${canary(k, "prompt")}`,
    }),
  );
  const cmd = (await o.device.command("prompt", o.sessionId)) as Json;
  o.device.ack(cmd.id);
  const promptId = cmd.payload.promptId as string;
  o.device.event(o.sessionId, { type: "prompt.started", promptId });
  o.device.event(o.sessionId, {
    type: "assistant.message",
    messageId: `m-${promptId}`,
    text: `Done ${canary(k, "answer")}`,
  });
  o.device.event(o.sessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  o.device.event(o.sessionId, { type: "session.state", status: "completed" });
  await eventually(
    async () =>
      ((await ok(req(o.admin, "GET", `/api/v1/work-sessions/${o.sessionId}`))).session as Json).status ===
      "completed",
  );
  await drain("work_session.summarize");
  const before = fake.requests().length;
  expect((await req(o.admin, "POST", `/api/v1/work-sessions/${o.sessionId}/memory/propose`, {})).status).toBe(
    202,
  );
  expect(await drain("work_session.summarize")).toBe(1);
  expect(fake.requests().length).toBeGreaterThan(before);

  // 6. A digest with its AI summary (13): sent as a DM from the bot, the list summarised by the person's model.
  await ok(
    req(o.admin, "PUT", "/api/v1/digest", {
      enabled: true,
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "08:00",
      timeZone: "Europe/Madrid",
      sections: ["decisions", "follows", "mentions", "work_zone"],
      skipEmpty: false,
      agentId: o.botId,
      summary: { enabled: true, modelRef: null },
    }),
  );
  o.digestId = (
    await s.su.query("select id from app.automations where action_kind = 'digest' and run_as_user_id = $1", [
      o.adminId,
    ])
  ).rows[0]?.id as string;
  await s.su.query("update app.automations set next_run_at = now() - interval '30 seconds' where id = $1", [
    o.digestId,
  ]);
  await tickOnce(core());
  await drain("automation.fire");
  const digestRun = (
    await s.su.query("select status from app.automation_runs where automation_id = $1", [o.digestId])
  ).rows[0] as Json | undefined;
  expect(digestRun?.status).toBe("answered");
}

beforeAll(async () => {
  gm = await startGreenMail({ users: [MAIL.A, MAIL.B] });
  fake = await startFakeModel();
  erp = createFakeErpMcp({ token: ERP_TOKEN });
  erpServer = createServer((rq, rs) => {
    const url = new URL(rq.url ?? "/", "http://fake-mcp");
    if (!erp.handle(rq, rs, url)) {
      rs.writeHead(404);
      rs.end();
    }
  });
  await new Promise<void>((resolve) => erpServer.listen(0, "127.0.0.1", resolve));
  erpUrl = `http://fake-mcp:${(erpServer.address() as AddressInfo).port}/erp-mcp`;
  s = await startSandboxStack({
    logLevel: "debug",
    env: {
      OCW_EGRESS_TEST_HOSTS: "fake-mcp=127.0.0.1,greenmail=127.0.0.1",
      OCW_AI_MOCK_BASE_URL: `${fake.baseUrl}/v1`,
      OCW_AI_SEND_RATE_LIMIT_PER_MINUTE: "600",
    },
  });
  // Organization B's cell credential (a real row, another organization).
  const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
  await s.su.query(
    "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
    [s.orgB, sha256Hex(tokenB)],
  );
  orgs.A = await setupOrg("A", {
    id: s.orgA,
    admin: s.victor,
    adminId: s.victorId,
    adminName: "Víctor Ruiz",
    cellToken: SANDBOX_CELL_TOKEN,
  });
  orgs.B = await setupOrg("B", {
    id: s.orgB,
    admin: s.eve,
    adminId: s.eveId,
    adminName: "Eve Black",
    cellToken: tokenB,
  });
  await exercise(orgs.A);
  await exercise(orgs.B);
}, 600_000);

afterAll(async () => {
  try {
    await Promise.allSettled([orgs.A?.device?.close(), orgs.B?.device?.close()]);
    erpServer?.closeAllConnections();
    await new Promise<void>((resolve) => (erpServer ? erpServer.close(() => resolve()) : resolve()));
    await s?.stop();
  } finally {
    await Promise.allSettled([gm?.stop(), fake?.stop()]);
  }
});

// ---------------------------------------------------------------- route coverage

/** What a route answers organization B when it names organization A's objects. */
type Case = (a: Org) => Promise<void>;

const eve = () => orgs.B.admin;
/** A well-formed public id (Crockford base32, 26 characters) that no endpoint has. */
const ULID = () => Array.from(randomBytes(26), (b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("");

/** B's admin aims at A's object: 404, and nothing of A in the body. */
const notFound =
  (method: string, path: (a: Org) => string, body?: (a: Org) => unknown): Case =>
  async (a) => {
    const r = await req(eve(), method, path(a), body?.(a));
    expect(r.status, `${method} ${path(a)}: ${JSON.stringify(r.body)}`).toBe(404);
    expectNothingOf(a, r);
  };
/** B's admin on a route without an id (or naming A's objects in a body): B's own answer or a refusal, never A's data. */
const own =
  (method: string, path: string, body?: (a: Org) => unknown, statuses = [200]): Case =>
  async (a) => {
    const r = await req(eve(), method, path, body?.(a));
    expect(statuses, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
    expectNothingOf(a, r);
  };
/** B's cell names A's turn: refused (403 no_trigger or 404 unknown_turn), nothing of A in the body. */
const cellRefused =
  (path: string, body: (a: Org, eventId: string) => Json): Case =>
  async (a) => {
    const eventId = await turnOf(a, a.cardMessageId, "one more look");
    const r = await cell(path, body(a, eventId), orgs.B.cellToken);
    expect([403, 404], `${path}: ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
    expectNothingOf(a, r);
  };

function expectNothingOf(a: Org, r: Res): void {
  const text = JSON.stringify(r.body ?? {});
  for (const id of [
    a.scheduleAutomationId,
    a.hook.automationId,
    a.mailAutomationId,
    a.mailboxId,
    a.watchedId,
    a.cardMessageId,
    a.sessionId,
    a.botId,
    a.channelId,
    a.boardId,
    a.erpConnector.id,
    a.vaultItemId,
    ...a.runIds,
  ]) {
    expect(text, id).not.toContain(id);
  }
  for (const c of CANARIES.filter((x) => x.startsWith("OCWCANARYA"))) expect(text).not.toContain(c);
}

const automationBody = (a: Org) => ({
  name: "From B",
  agentId: a.botId,
  instructions: "Read A.",
  trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
  target: { kind: "channel", conversationId: a.channelId },
});
const digestBody = (a: Org) => ({
  enabled: true,
  days: ["mon"],
  time: "08:00",
  timeZone: "Europe/Madrid",
  sections: ["mentions"],
  skipEmpty: true,
  agentId: a.botId,
  summary: { enabled: false, modelRef: null },
});
const watchBody = (a: Org) => ({
  cardMessageId: a.cardMessageId,
  mcpServerId: a.erpConnector.id,
  externalRef: RECORD.A,
  readTool: "get_record",
  idArg: "id",
  fields: [{ pointer: "/status", label: "Status" }],
  checkIntervalMinutes: 60,
  agentId: a.botId,
});

const CASES: Record<string, Case> = {
  // ---- automations (05, 09, 10, 11)
  "GET /api/v1/automations": own("GET", "/api/v1/automations"),
  "POST /api/v1/automations": own("POST", "/api/v1/automations", automationBody, [400, 403, 404]),
  "POST /api/v1/automations/schedule-preview": own("POST", "/api/v1/automations/schedule-preview", () => ({
    cron: "0 17 * * 5",
    timeZone: "Europe/Madrid",
  })),
  "GET /api/v1/automations/options": own("GET", "/api/v1/automations/options"),
  // Where A's bot could deliver is not B's to ask.
  "GET /api/v1/automations/target-options": async (a) => {
    const r = await req(eve(), "GET", `/api/v1/automations/target-options?agentId=${a.botId}`);
    expect([400, 403, 404], JSON.stringify(r.body)).toContain(r.status);
    expectNothingOf(a, r);
  },
  "GET /api/v1/automations/:id": notFound("GET", (a) => `/api/v1/automations/${a.scheduleAutomationId}`),
  "PATCH /api/v1/automations/:id": notFound(
    "PATCH",
    (a) => `/api/v1/automations/${a.scheduleAutomationId}`,
    () => ({ name: "Renamed by B", expectedVersion: 1 }),
  ),
  "DELETE /api/v1/automations/:id": notFound(
    "DELETE",
    (a) => `/api/v1/automations/${a.scheduleAutomationId}`,
  ),
  "POST /api/v1/automations/:id/pause": notFound(
    "POST",
    (a) => `/api/v1/automations/${a.scheduleAutomationId}/pause`,
    () => ({}),
  ),
  "POST /api/v1/automations/:id/resume": notFound(
    "POST",
    (a) => `/api/v1/automations/${a.scheduleAutomationId}/resume`,
    () => ({}),
  ),
  "POST /api/v1/automations/:id/run": notFound(
    "POST",
    (a) => `/api/v1/automations/${a.scheduleAutomationId}/run`,
    () => ({}),
  ),
  "GET /api/v1/automations/:id/runs": notFound(
    "GET",
    (a) => `/api/v1/automations/${a.scheduleAutomationId}/runs`,
  ),
  "GET /api/v1/automations/:id/webhook": notFound(
    "GET",
    (a) => `/api/v1/automations/${a.hook.automationId}/webhook`,
  ),
  "POST /api/v1/automations/:id/webhook/rotate": notFound(
    "POST",
    (a) => `/api/v1/automations/${a.hook.automationId}/webhook/rotate`,
    () => ({}),
  ),
  "GET /api/v1/automations/:id/mailbox": notFound(
    "GET",
    (a) => `/api/v1/automations/${a.mailAutomationId}/mailbox`,
  ),
  // A's Keychain item is not B's: refused, or a failed test (never a mailbox read with A's credential).
  "POST /api/v1/mailboxes/test": async (a) => {
    const polled = erp.state.calls.length;
    const r = await req(eve(), "POST", "/api/v1/mailboxes/test", {
      vaultItemId: a.vaultItemId,
      host: "greenmail",
      port: gm.imapPort,
      folder: "INBOX",
    });
    expect([200, 400, 403, 404], JSON.stringify(r.body)).toContain(r.status);
    if (r.status === 200) expect(r.body?.ok).toBe(false);
    expectNothingOf(a, r);
    expect(erp.state.calls.length).toBe(polled);
  },
  // ---- the public webhook route: an id B does not know is 404/410, nothing else (10)
  "POST /api/v1/hooks/:publicId": async () => {
    const r = await sendHook({ publicId: ULID(), secret: orgs.B.hook.secret }, { order: { id: 1 } });
    expect([404, 410], JSON.stringify(r.body)).toContain(r.status);
  },
  // ---- the digest (13, 16): B's own settings; A's bot is not B's to choose
  "GET /api/v1/digest": own("GET", "/api/v1/digest"),
  "PUT /api/v1/digest": own("PUT", "/api/v1/digest", digestBody, [400, 403, 404]),
  // The preview renders the caller's own list and never reads the bot (no send, no model): B's own digest only.
  "POST /api/v1/digest/preview": own("POST", "/api/v1/digest/preview", digestBody, [200, 400, 403, 404]),
  "POST /api/v1/digest/test": own("POST", "/api/v1/digest/test", undefined, [200, 202, 409]),
  // ---- watched records (07)
  // The watches of A's board: not found, or an empty list (never A's watch).
  "GET /api/v1/watched-records": async (a) => {
    const r = await req(eve(), "GET", `/api/v1/watched-records?conversationId=${a.boardId}`);
    expect([200, 403, 404], JSON.stringify(r.body)).toContain(r.status);
    expectNothingOf(a, r);
  },
  "GET /api/v1/watched-records/options": async (a) => {
    const r = await req(eve(), "GET", `/api/v1/watched-records/options?conversationId=${a.boardId}`);
    expect([403, 404], JSON.stringify(r.body)).toContain(r.status);
    expectNothingOf(a, r);
  },
  "POST /api/v1/watched-records": own("POST", "/api/v1/watched-records", watchBody, [400, 403, 404]),
  "POST /api/v1/watched-records/preview": own(
    "POST",
    "/api/v1/watched-records/preview",
    watchBody,
    [400, 403, 404],
  ),
  "PATCH /api/v1/watched-records/:id": notFound(
    "PATCH",
    (a) => `/api/v1/watched-records/${a.watchedId}`,
    () => ({ checkIntervalMinutes: 30, expectedVersion: 1 }),
  ),
  "DELETE /api/v1/watched-records/:id": notFound("DELETE", (a) => `/api/v1/watched-records/${a.watchedId}`),
  "POST /api/v1/watched-records/:id/check": notFound(
    "POST",
    (a) => `/api/v1/watched-records/${a.watchedId}/check`,
    () => ({ source: "manual" }),
  ),
  // ---- Work Zone memory (08, 22)
  "GET /api/v1/work-sessions/:id/memory": notFound(
    "GET",
    (a) => `/api/v1/work-sessions/${a.sessionId}/memory`,
  ),
  "POST /api/v1/work-sessions/:id/memory/propose": notFound(
    "POST",
    (a) => `/api/v1/work-sessions/${a.sessionId}/memory/propose`,
    () => ({}),
  ),
  "GET /api/v1/me/preferences": own("GET", "/api/v1/me/preferences"),
  "PUT /api/v1/me/preferences": own("PUT", "/api/v1/me/preferences", () => ({
    autoProposeSessionSummaries: false,
  })),
  // ---- the cell (12, 14): B's cell with A's turn
  "POST /agent-channel/v1/automations/propose": cellRefused("/automations/propose", (a, eventId) => ({
    eventId,
    agentId: a.botId,
    name: "From B",
    instructions: "Read A.",
    schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
    target: { kind: "here" },
  })),
  "POST /agent-channel/v1/records/update": cellRefused("/records/update", (a, eventId) => ({
    eventId,
    agentId: a.botId,
    changes: { "/status": "From B" },
  })),
};

const PHASE_ROUTE =
  /^[A-Z]+ (\/api\/v1\/(automations|hooks|mailboxes|digest|watched-records|me\/preferences)(\/|$)|\/api\/v1\/work-sessions\/:id\/memory|\/agent-channel\/v1\/(automations|records)(\/|$))/u;

/** Everything of organization A that organization B must never change. */
const snapshotA = async () =>
  JSON.stringify(
    await Promise.all(
      [
        "select id, name, status, next_run_at, updated_at from app.automations where organization_id = $1 order by id",
        "select id, status from app.automation_runs where organization_id = $1 order by id",
        "select id, status, last_uid from app.mailboxes where organization_id = $1 order by id",
        "select id, snapshot_hash, check_interval_minutes from app.watched_records where organization_id = $1 order by id",
        "select id, secret_id from app.webhook_endpoints where organization_id = $1 order by id",
        "select count(*)::int as n from app.memory_proposals where organization_id = $1",
      ].map(async (q) => (await s.su.query(q, [orgs.A.id])).rows),
    ),
  );

describe("07.6 route coverage (org B)", () => {
  it("every registered 07.6 route has an organization-B case; none reaches organization A", async () => {
    const routes = s.stack.built.authz.routes;
    const registered = [...routes.keys()]
      .filter((key) => !key.startsWith("HEAD ") && PHASE_ROUTE.test(key))
      .sort();
    // A route added later without a case fails here, naming its path.
    expect(registered).toEqual(Object.keys(CASES).sort());
    const before = await snapshotA();
    const erpCalls = erp.state.calls.length;
    for (const run of Object.values(CASES)) {
      await run(orgs.A);
    }
    expect(await snapshotA()).toBe(before);
    // No case of B ever reached A's ERP record or mailbox.
    expect(erp.state.calls.slice(erpCalls).filter((c) => c.arguments.id === RECORD.A)).toEqual([]);
    expect(routes.get("POST /api/v1/hooks/:publicId")).toBe("public");
  });
});

// ---------------------------------------------------------------- pgboss

/** Every text-like value of every base table in schema `pgboss`, one string per row. */
async function pgbossRows(): Promise<Array<{ table: string; text: string }>> {
  const tables = (
    await s.su.query(
      "select table_name from information_schema.tables where table_schema = 'pgboss' and table_type = 'BASE TABLE' order by 1",
    )
  ).rows.map((r) => r.table_name as string);
  const out: Array<{ table: string; text: string }> = [];
  for (const table of tables) {
    const rows = (await s.su.query(`select row_to_json(t)::text as text from pgboss."${table}" t`)).rows;
    for (const r of rows) out.push({ table, text: r.text as string });
  }
  return out;
}

describe("pgboss holds ids only (Pitfall 7, D-07)", () => {
  it("after both organizations' scenarios, no canary, secret or password is anywhere in the pgboss schema", async () => {
    const rows = await pgbossRows();
    // The scenarios really used the queues: fire, inbound, poll, check, summarize jobs exist for both organizations.
    const jobs = (await s.su.query("select name, data from pgboss.job")).rows as Json[];
    for (const queue of [
      "automation.fire",
      "automation.inbound",
      "mailbox.poll",
      "watched.check",
      "work_session.summarize",
    ]) {
      for (const o of [orgs.A, orgs.B]) {
        expect(
          jobs.some((j) => j.name === queue && j.data?.organizationId === o.id),
          `${queue} ${o.key}`,
        ).toBe(true);
      }
    }
    expect(CANARIES.length).toBeGreaterThan(30);
    // The canaries really travelled: the stored automation, payload, mail, record change and session summary hold them.
    const content = (
      await s.su.query(
        `select row_to_json(x)::text as text from (
           select name, instructions from app.automations
           union all select coalesce(subject, ''), coalesce(body_text, body_json::text, '') from app.automation_events
           union all select before::text, after::text from app.watched_record_changes
           union all select path, content from app.memory_proposals
         ) x`,
      )
    ).rows.map((r) => r.text as string);
    for (const k of ["A", "B"]) {
      for (const what of ["name", "instructions", "hookbody", "mailbody", "erpstatus"]) {
        const needle = CANARY.get(`${k}:${what}`) as string;
        expect(
          content.some((text) => text.includes(needle)),
          `${k}:${what}`,
        ).toBe(true);
      }
      // The session summary job read the session itself: its prompt reached the owner's model.
      const prompt = CANARY.get(`${k}:prompt`) as string;
      expect(
        fake.requests().some((r) => JSON.stringify(r.body).includes(prompt)),
        `${k}:prompt`,
      ).toBe(true);
    }
    // The sweep reads what the jobs hold: the run, event, mailbox, record and session ids are there.
    for (const o of [orgs.A, orgs.B]) {
      for (const id of [o.runIds[0], o.webhookEventId, o.mailboxId, o.watchedId, o.sessionId]) {
        expect(
          rows.some((r) => r.text.includes(id as string)),
          `${o.key} ${id}`,
        ).toBe(true);
      }
    }
    const leaks: string[] = [];
    for (const r of rows) {
      for (const needle of [...CANARIES, ...SECRETS]) {
        if (r.text.includes(needle)) leaks.push(`${r.table}: ${needle.slice(0, 18)}…`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("every stored job's data parses with its queue's strict ids-only schema", async () => {
    const jobs = (await s.su.query("select name, data, singleton_key from pgboss.job")).rows as Json[];
    const ours = jobs.filter((j) => j.name in JOB_QUEUES);
    expect(ours.length).toBeGreaterThan(10);
    for (const j of ours) {
      const parsed = JOB_QUEUES[j.name as QueueName].safeParse(j.data ?? {});
      expect(parsed.success, `${j.name} ${JSON.stringify(j.data)}`).toBe(true);
      // A singleton key, when a queue uses one, is ids and fixed words only.
      if (j.singleton_key) expect(j.singleton_key as string).toMatch(/^[0-9a-z:._-]+$/u);
    }
  });
});

// ---------------------------------------------------------------- forged jobs

/** What a no-op leaves untouched: messages, cell events, audits, usage, approvals, the ERP and the model. */
const sideEffects = async () => ({
  db: JSON.stringify(
    (
      await s.su.query(
        `select (select count(*)::int from app.messages) as messages,
                (select count(*)::int from app.stream_events where type like 'agent.%') as cell_events,
                (select count(*)::int from app.audit_events) as audits,
                (select count(*)::int from app.ai_usage_records) as usage,
                (select count(*)::int from app.approval_requests) as approvals,
                (select count(*)::int from app.automation_events) as events,
                (select count(*)::int from app.watched_record_changes) as changes`,
      )
    ).rows[0],
  ),
  erp: erp.state.calls.length,
  model: fake.requests().length,
});

/** Removes the real (not forged) queued jobs of `queue` for the given id, so only the forged one runs. */
async function dropQueued(queue: QueueName, key: string, id: string): Promise<void> {
  await s.su.query("delete from pgboss.job where name = $1 and data->>$2 = $3 and state = 'created'", [
    queue,
    key,
    id,
  ]);
}

const jobState = async (id: string) =>
  (await s.su.query("select state from pgboss.job where id = $1", [id])).rows[0]?.state as string | undefined;

describe("forged cross-tenant jobs do nothing (Pitfall 7)", () => {
  it("automation.fire with A's organization and B's queued run: completes, B's run stays queued, nothing posted", async () => {
    // Whatever earlier cases queued for real runs first: only the forged job runs below.
    await drain("automation.fire");
    const b = orgs.B;
    const runId = (await ok(req(b.admin, "POST", `/api/v1/automations/${b.scheduleAutomationId}/run`), 202))
      .runId as string;
    await dropQueued("automation.fire", "runId", runId);
    const before = await sideEffects();
    const job = await sendJob(orgs.A.id, "automation.fire", { organizationId: orgs.A.id, runId });
    expect(await drain("automation.fire")).toBe(1);
    expect(await jobState(job)).toBe("completed");
    expect(await sideEffects()).toEqual(before);
    expect(
      (await s.su.query("select status from app.automation_runs where id = $1", [runId])).rows[0]?.status,
    ).toBe("queued");
  });

  it("automation.inbound with A's organization and B's new event: completes, the event stays unprocessed", async () => {
    // Whatever earlier cases queued for real runs first: only the forged job runs below.
    await drain("automation.inbound");
    const b = orgs.B;
    expect((await sendHook(b.hook, { order: { id: 1, name: "#2", note: "forged" } })).status).toBe(202);
    const event = (
      await s.su.query(
        "select e.id, e.result, e.reason, e.message_id from app.automation_events e join app.webhook_endpoints w on w.id = e.webhook_endpoint_id where w.public_id = $1 order by e.received_at desc limit 1",
        [b.hook.publicId],
      )
    ).rows[0] as Json;
    await dropQueued("automation.inbound", "eventId", event.id);
    const before = await sideEffects();
    const job = await sendJob(orgs.A.id, "automation.inbound", {
      organizationId: orgs.A.id,
      eventId: event.id,
    });
    expect(await drain("automation.inbound")).toBe(1);
    expect(await jobState(job)).toBe("completed");
    expect(await sideEffects()).toEqual(before);
    expect(
      (
        await s.su.query("select id, result, reason, message_id from app.automation_events where id = $1", [
          event.id,
        ])
      ).rows[0],
    ).toEqual(event);
  });

  it("mailbox.poll with A's organization and B's mailbox: completes, the mailbox is not read", async () => {
    // Whatever earlier cases queued for real runs first: only the forged job runs below.
    await drain("mailbox.poll");
    const b = orgs.B;
    await gm.sendMail({ from: "x@shop.example", to: MAIL.B, subject: "Unread by A", text: "forged poll" });
    const row = async () =>
      JSON.stringify(
        (
          await s.su.query("select last_uid, last_polled_at, status from app.mailboxes where id = $1", [
            b.mailboxId,
          ])
        ).rows[0],
      );
    const mailbox = await row();
    const before = await sideEffects();
    const job = await sendJob(orgs.A.id, "mailbox.poll", {
      organizationId: orgs.A.id,
      mailboxId: b.mailboxId,
    });
    expect(await drain("mailbox.poll")).toBe(1);
    expect(await jobState(job)).toBe("completed");
    expect(await sideEffects()).toEqual(before);
    expect(await row()).toBe(mailbox);
  });

  it("watched.check with A's organization and B's record: completes, the ERP is never called", async () => {
    // Whatever earlier cases queued for real runs first: only the forged job runs below.
    await drain("watched.check");
    const b = orgs.B;
    const row = async () =>
      JSON.stringify(
        (
          await s.su.query(
            "select snapshot_hash, checked_at, last_status, next_check_at from app.watched_records where id = $1",
            [b.watchedId],
          )
        ).rows[0],
      );
    const watched = await row();
    const before = await sideEffects();
    const job = await sendJob(orgs.A.id, "watched.check", {
      organizationId: orgs.A.id,
      watchedRecordId: b.watchedId,
      source: "schedule",
    });
    expect(await drain("watched.check")).toBe(1);
    expect(await jobState(job)).toBe("completed");
    expect(await sideEffects()).toEqual(before);
    expect(await row()).toBe(watched);
  });

  it("work_session.summarize with A's organization and B's session: completes, no model call, no usage, no proposal", async () => {
    // Whatever earlier cases queued for real runs first: only the forged job runs below.
    await drain("work_session.summarize");
    const b = orgs.B;
    const before = await sideEffects();
    const proposals = async () =>
      Number((await s.su.query("select count(*)::int as n from app.memory_proposals")).rows[0].n);
    const p = await proposals();
    const job = await sendJob(orgs.A.id, "work_session.summarize", {
      organizationId: orgs.A.id,
      workSessionId: b.sessionId,
      mode: "manual",
    });
    expect(await drain("work_session.summarize")).toBe(1);
    expect(await jobState(job)).toBe("completed");
    expect(await sideEffects()).toEqual(before);
    expect(await proposals()).toBe(p);
  });
});

// ---------------------------------------------------------------- logs and audit

describe("no content in logs or audit (D-07)", () => {
  it("no canary, webhook secret, mailbox password or ERP value in the captured API log lines", () => {
    expect(s.logs.length).toBeGreaterThan(100);
    // The capture is the API's real output at debug: the scenarios' requests are in it (by id, never by content).
    for (const o of [orgs.A, orgs.B]) {
      expect(
        s.logs.some((l) => l.includes(o.scheduleAutomationId)),
        o.key,
      ).toBe(true);
    }
    const leaks: string[] = [];
    for (const line of s.logs) {
      for (const needle of [...CANARIES, ...SECRETS]) {
        if (line.includes(needle)) leaks.push(`${needle.slice(0, 18)}… in ${line.slice(0, 240)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("no canary, secret or password in any audit_events metadata of either organization", async () => {
    const rows = (
      await s.su.query(
        "select organization_id, action, metadata::text as metadata from app.audit_events where organization_id = any($1::uuid[])",
        [[orgs.A.id, orgs.B.id]],
      )
    ).rows as Json[];
    // The scenarios were audited (automation, webhook, mailbox, watched, digest actions exist in both organizations).
    for (const o of [orgs.A, orgs.B]) {
      const actions = new Set(rows.filter((r) => r.organization_id === o.id).map((r) => r.action as string));
      expect([...actions].some((a) => a.startsWith("automation."))).toBe(true);
      expect([...actions].some((a) => a.startsWith("mailbox."))).toBe(true);
      expect([...actions].some((a) => a.startsWith("watched"))).toBe(true);
    }
    const leaks: string[] = [];
    for (const r of rows) {
      for (const needle of [...CANARIES, ...SECRETS]) {
        if ((r.metadata ?? "").includes(needle)) leaks.push(`${r.action}: ${needle.slice(0, 18)}…`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
