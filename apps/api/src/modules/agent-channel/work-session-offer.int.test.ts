import { createHash, randomUUID } from "node:crypto";
import {
  type BotWorkZoneProfileInput,
  type SessionAudienceInput,
  TurnWorkZone,
  WORK_SESSION_TOOL_FLAGS,
  WORK_SESSION_TOOL_NAMES,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  grantBotConsent,
  invite,
  pairDevice,
  shareDevice,
} from "../../testing-workzone";
import { turnPolicy } from "../bot-capabilities";
import { createPermissionService } from "../organization";
import { loadBotProfile, profileStatus, workZoneOfferFor } from "../work-session";
import { consultTargets } from "./agent-message";
import { conversationAudience } from "./memory-files";
import { buildMentionEvents } from "./mentions";

/**
 * Phase 07.16-11 (D-05, D-21, PD-17; BWZ-02, BWZ-06): which turns are offered the four `ocw_work_session_*` tools and
 * the Work Zone context. Decided server-side at delivery: a bot whose profile is active, an asker who passes the Work
 * Zone module gate, a person's delivery (never an automation run or a consult hop), and room for four tools. A bot
 * without a profile gets the turn it got before the phase. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-work-session-offer-0123456789";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let orgId: string;
let ana: TestClient;
let anaId: string;
let victorId: string;
let engUnitId: string;
let atlasId: string;
let echoId: string;
let engId: string;
let server: FakeDevice;
let serverId: string;
let billingId: string;
let ledgerId: string;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** A team bot of the whole organization, ready (no OpenClaw cell runs in this suite). */
async function teamBot(name: string, username: string): Promise<string> {
  const bot = await ok(
    victor.request("POST", "/api/v1/agents", {
      name,
      username,
      instructions: `You are ${name}.`,
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  await su.query("update app.agents set status = 'ready' where id = $1", [bot.id]);
  return bot.id as string;
}

/** A public channel holding `botIds` and `userIds`. */
async function channel(name: string, botIds: string[], userIds: string[]): Promise<string> {
  const id = (await ok(victor.request("POST", "/api/v1/channels", { name, visibility: "public" })))
    .id as string;
  for (const botId of botIds) {
    await ok(victor.request("POST", `/api/v1/channels/${id}/members`, { kind: "agent", id: botId }));
  }
  for (const userId of userIds) {
    await ok(victor.request("POST", `/api/v1/channels/${id}/members`, { kind: "user", id: userId }));
  }
  return id;
}

/**
 * `as` addresses the bot by `handle` in `conversationId` (chat resolves mentions from the text); the delivered
 * `agent.mention.v1` payload for `botId`. Daily usage is cleared first (more turns than a bot's limit run here).
 */
async function mentionTurn(
  botId: string,
  p: { as?: TestClient; conversationId?: string; handle?: string } = {},
): Promise<Json> {
  await su.query("delete from app.agent_usage_daily");
  const msg = await ok(
    (p.as ?? ana).request("POST", `/api/v1/conversations/${p.conversationId ?? engId}/messages`, {
      body: `@${p.handle ?? "atlas"} please fix the invoice totals ${randomUUID().slice(0, 6)}`,
    }),
  );
  return eventually(async () => {
    const r = await su.query(
      "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1 and payload->'agent'->>'id' = $2",
      [msg.id, botId],
    );
    return r.rows[0]?.payload as Json | undefined;
  });
}

const ledgerTools = async (eventId: string) =>
  (await su.query("select tools from app.agent_turns where event_id = $1", [eventId])).rows[0]
    ?.tools as string[];

/** No work-session tool, flag or context on the turn, nor in its ledger row. */
async function expectNoOffer(ev: Json) {
  for (const name of WORK_SESSION_TOOL_NAMES) {
    expect(ev.turn.tools).not.toContain(name);
    expect(ev.turn.toolFlags).not.toHaveProperty(name);
  }
  expect(ev.turn).not.toHaveProperty("workZone");
  const tools = await ledgerTools(ev.eventId as string);
  for (const name of WORK_SESSION_TOOL_NAMES) expect(tools).not.toContain(name);
}

/** The four tools with their flags on the turn and in its ledger row; returns the parsed Work Zone context. */
async function expectOffer(ev: Json): Promise<TurnWorkZone> {
  for (const name of WORK_SESSION_TOOL_NAMES) {
    expect(ev.turn.tools).toContain(name);
    expect(ev.turn.toolFlags[name]).toEqual(WORK_SESSION_TOOL_FLAGS[name]);
  }
  expect(await ledgerTools(ev.eventId as string)).toEqual(
    expect.arrayContaining([...WORK_SESSION_TOOL_NAMES]),
  );
  return TurnWorkZone.parse(ev.turn.workZone);
}

/** Atlas's profile on the build server with both repos, Claude Code, Opus only, up to Full access. */
const profile = (over: Partial<BotWorkZoneProfileInput> = {}): BotWorkZoneProfileInput => ({
  deviceId: serverId,
  runtime: "claude-code",
  projectIds: [billingId, ledgerId],
  defaultModel: "opus",
  allowedModels: ["opus"],
  defaultEffort: null,
  allowedEfforts: [],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "fullAccess",
  worktree: true,
  maxConcurrent: 2,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
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
  orgId = setup.organization.id;
  victorId = setup.user.id;
  ({ client: ana, userId: anaId } = await invite(stack, victor, "ana@example.test", "Ana Gil", "developer"));
  const unit = async (kind: string, name: string, parentId: string | null) =>
    (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
  engUnitId = await unit("team", "Engineering", await unit("department", "Company", null));
  await ok(victor.request("POST", `/api/v1/units/${engUnitId}/members`, { userId: anaId }));
  atlasId = await teamBot("Atlas", "atlas");
  // Echo never gets a Work Zone profile: its turns must be what they were before the phase (BWZ-06).
  echoId = await teamBot("Echo", "echo");
  engId = await channel("eng", [atlasId, echoId], [anaId]);

  // Full access allowed by the organization; Víctor's build server reports both catalogs and its own opt-in.
  await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true, allowFastMode: true }));
  const paired = await pairDevice(stack, victor, "billing-server");
  serverId = paired.deviceId;
  server = await FakeDevice.connect(stack.baseUrl, paired.token);
  server.send({
    type: "projects.sync",
    projects: ["billing-api", "ledger"].map((name) => ({
      localId: `lp_${name}`,
      name,
      gitRemote: null,
      defaultBranch: "main",
    })),
  });
  await server.next((f) => f.type === "projects.ack");
  server.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog, full_access_opt_in from app.devices where id = $1", [
      serverId,
    ]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2 && r.rows[0].full_access_opt_in === true;
  });
  const list = (await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")!.id as string;
  ledgerId = list.find((p) => p.name === "ledger")!.id as string;
}, 180_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("tracer: a channel mention of a team bot with an active profile carries the four tools and its Work Zone", () => {
  it("before the device's consent the mention carries none of the four tools and no workZone", async () => {
    await createBotProfile(victor, atlasId, profile());
    await expectNoOffer(await mentionTurn(atlasId));
  });

  it("with the consent (Full access for this bot), Ana's mention in #eng is offered the tools and the Work Zone", async () => {
    await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
    const ev = await mentionTurn(atlasId);
    const wz = await expectOffer(ev);
    expect(wz).toMatchObject({
      runtime: "claude-code",
      device: { id: serverId, name: "billing-server", online: true },
      projects: [
        { id: billingId, name: "billing-api" },
        { id: ledgerId, name: "ledger" },
      ],
      projectsMore: 0,
      models: ["opus"],
      defaultModel: "opus",
      fastMode: "off",
      defaultMode: "default",
      maxMode: "fullAccess",
      outsideContent: false,
      sessions: [],
    });
    // The proposal tools keep their own rule (Ana may start sessions): both are still offered.
    expect(ev.turn.tools).toEqual(expect.arrayContaining(["ocw_work_zone_projects", "ocw_start_work_zone"]));
    // Repo-relative data only: no absolute path, no URL.
    expect(JSON.stringify(wz)).not.toMatch(/https?:\/\/|\/Users\/|\/home\//u);
  });
});

// ---------------------------------------------------------------- when the tools are not offered (PD-17)

const perms = () => createPermissionService(stack.built.core);

/** `workZoneOfferFor` for `agentId` as `userId`, in `organizationId`'s tenant transaction. */
const offerAs = (agentId: string, userId = anaId, organizationId = orgId) =>
  stack.built.core.db.withTenant({ organizationId, userId }, (tx) =>
    workZoneOfferFor(tx, perms(), { agentId, askerUserId: userId, conversationId: engId }),
  );

/** Why the bot's profile is (in)active right now, as delivery decides it. */
const reasonOf = (agentId = atlasId) =>
  stack.built.core.db.withTenant({ organizationId: orgId, userId: anaId }, async (tx) => {
    const stored = await loadBotProfile(tx, agentId);
    if (!stored) return "no_profile";
    const status = await profileStatus(tx, perms(), stored);
    return status.active ? "active" : status.reason;
  });

/**
 * An unattended delivery of Atlas (an automation run or a consult hop) on a fresh message of Ana's, through the one
 * delivery code (`buildMentionEvents`) with the trigger and chain those callers set.
 */
async function unattendedTurn(trigger: "automation" | "consult"): Promise<Json> {
  const msg = await ok(
    ana.request("POST", `/api/v1/conversations/${engId}/messages`, {
      body: `the invoice totals are off ${randomUUID().slice(0, 6)}`,
    }),
  );
  await su.query("delete from app.agent_usage_daily");
  const mention: AgentMention = {
    organizationId: orgId,
    conversationId: engId,
    threadRootId: msg.id as string,
    messageId: msg.id as string,
    agentIds: [atlasId],
    author: { kind: "user", id: anaId, displayName: "Ana Gil" },
    body: msg.body as string,
    createdAt: new Date().toISOString(),
    delivery: "thread",
    trigger,
    ...(trigger === "consult"
      ? {
          chain: {
            chainId: null,
            depth: 1 as const,
            answeringHopId: null,
            returningHopId: null,
            rootAgentId: echoId,
            usedTargetIds: [echoId],
          },
        }
      : {}),
  };
  const events = await stack.built.core.db.withTenant({ organizationId: orgId, userId: anaId }, (tx) =>
    buildMentionEvents(tx, mention, { core: stack.built.core, perms: perms() }),
  );
  expect(events).toHaveLength(1);
  return events[0] as Json;
}

describe("no offer when the asker, the profile or the delivery does not allow one (PD-17)", () => {
  it("a Work Zone module deny on Ana's unit: neither the session tools nor the proposal tools", async () => {
    const access = (enabled: boolean) =>
      ok(
        victor.request("PUT", "/api/v1/module-access", {
          module: "work_zone",
          scopeUnitId: engUnitId,
          subject: { kind: "everyone" },
          enabled,
        }),
      );
    await access(false);
    try {
      const ev = await mentionTurn(atlasId);
      await expectNoOffer(ev);
      expect(ev.turn.tools).not.toContain("ocw_start_work_zone");
    } finally {
      await access(true);
    }
    await expectOffer(await mentionTurn(atlasId));
  });

  it("no_consent: the device's consent revoked", async () => {
    await ok(victor.request("DELETE", `/api/v1/devices/${serverId}/bot-consents/${atlasId}`));
    try {
      expect(await reasonOf()).toBe("no_consent");
      await expectNoOffer(await mentionTurn(atlasId));
    } finally {
      await grantBotConsent(victor, serverId, atlasId, { allowFullAccess: true });
    }
    expect(await reasonOf()).toBe("active");
  });

  it("sponsor_inactive: the sponsor (Víctor) deactivated", async () => {
    await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [victorId]);
    try {
      expect(await reasonOf()).toBe("sponsor_inactive");
      await expectNoOffer(await mentionTurn(atlasId));
    } finally {
      await su.query("update app.org_members set deactivated_at = null where user_id = $1", [victorId]);
    }
    expect(await reasonOf()).toBe("active");
  });

  it("bot_disabled: a disabled bot gets no delivery, and the offer answers null", async () => {
    await su.query("update app.agents set status = 'disabled' where id = $1", [atlasId]);
    try {
      expect(await reasonOf()).toBe("bot_disabled");
      expect(await offerAs(atlasId)).toBeNull();
    } finally {
      await su.query("update app.agents set status = 'ready' where id = $1", [atlasId]);
    }
    expect(await offerAs(atlasId)).not.toBeNull();
  });

  it("org_disabled: the organization allows 0 bot sessions", async () => {
    await ok(victor.request("PUT", "/api/v1/work-zone-policy", { botSessionsMax: 0 }));
    try {
      expect(await reasonOf()).toBe("org_disabled");
      await expectNoOffer(await mentionTurn(atlasId));
    } finally {
      await ok(victor.request("PUT", "/api/v1/work-zone-policy", { botSessionsMax: 10 }));
    }
    expect(await reasonOf()).toBe("active");
  });

  it("an automation run's turn of the same bot: no offer (07.17 owns automations)", async () => {
    await expectNoOffer(await unattendedTurn("automation"));
  });

  it("a consult hop's turn of the same bot: no offer (hops are unattended)", async () => {
    await expectNoOffer(await unattendedTurn("consult"));
  });
});

describe("D-21: the session runs under the sponsor's rights", () => {
  it("Ana without work_session.create but with the Work Zone module still gets the four tools (not the proposal)", async () => {
    const rule = await ok(
      victor.request("POST", "/api/v1/permission-rules", {
        permission: "work_session.create",
        subjectKind: "user",
        subjectId: anaId,
        effect: "deny",
      }),
    );
    try {
      const ev = await mentionTurn(atlasId);
      const wz = await expectOffer(ev);
      expect(wz.maxMode).toBe("fullAccess");
      // The proposal tools keep their unchanged rule: the asker's own `work_session.create`.
      expect(ev.turn.tools).not.toContain("ocw_start_work_zone");
      expect(ev.turn.tools).not.toContain("ocw_work_zone_projects");
    } finally {
      await ok(victor.request("DELETE", `/api/v1/permission-rules/${rule.id as string}`));
    }
  });
});

describe("BWZ-06: a bot without a profile gets the turn it got before the phase", () => {
  it("Echo's delivered turn equals turnPolicy without the offer for the same inputs (tools, flags, every key)", async () => {
    expect(await reasonOf(echoId)).toBe("no_profile");
    const ev = await mentionTurn(echoId, { handle: "echo" });
    expect(ev.turn).not.toHaveProperty("workZone");
    const p = perms();
    const direct = await stack.built.core.db.withTenant(
      { organizationId: orgId, userId: anaId },
      async (tx) => {
        const targets = await consultTargets(tx, p, {
          sourceAgentId: echoId,
          humanUserId: anaId,
          conversationId: engId,
          chain: null,
        });
        return turnPolicy(
          tx,
          stack.built.core,
          p,
          {
            agentId: echoId,
            humanUserId: anaId,
            conversationId: engId,
            conversationKind: "channel",
            messageId: ev.message.id as string,
            eventId: randomUUID(),
            clientTimeZone: null,
            taintedAtStart: false,
            unattended: false,
            chain: null,
            consultTargets: targets,
            attachments: [],
          },
          {
            audience: null,
            memory: {
              service: stack.built.memory,
              audience: () => conversationAudience(tx, { conversationId: engId }),
            },
          },
        );
      },
    );
    if (!direct.deliver) throw new Error("the direct turn was not delivered");
    expect(ev.turn.tools).toEqual(direct.turn.tools);
    expect(ev.turn.toolFlags).toEqual(direct.turn.toolFlags);
    expect(Object.keys(ev.turn).sort()).toEqual(Object.keys(direct.turn).sort());
    // Everything but the clock (`now` is taken per call).
    const { now: _delivered, ...delivered } = ev.turn;
    const { now: _direct, ...expected } = direct.turn;
    expect(delivered).toEqual(JSON.parse(JSON.stringify(expected)));
    for (const name of WORK_SESSION_TOOL_NAMES) expect(ev.turn.tools).not.toContain(name);
  });

  it("GET /cell lists no ocw_work_session_* for any bot; Atlas keeps ocw_agent_card (turn-scoped tools stay off the cell-wide view)", async () => {
    const res = await fetch(`${stack.baseUrl}/agent-channel/v1/cell`, {
      headers: { authorization: `Bearer ${CELL_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Json;
    const byId = new Map(
      (snap.agents as Json[]).map((a) => [a.id as string, a.capabilities.tools as string[]]),
    );
    expect(byId.get(atlasId)).toContain("ocw_agent_card");
    expect(byId.get(echoId)).toEqual(byId.get(atlasId));
    for (const tools of byId.values()) {
      for (const name of WORK_SESSION_TOOL_NAMES) expect(tools).not.toContain(name);
    }
  });
});

describe("organization B never influences an organization-A turn", () => {
  let botB: string;

  beforeAll(async () => {
    // Organization B with its own admin, bot, device, repo, profile and consent (superuser seeds).
    const orgB = randomUUID();
    const { userId: eveId } = await invite(
      stack,
      victor,
      `eve-${randomUUID().slice(0, 8)}@example.test`,
      "Eve",
      "admin",
    );
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("delete from auth.member where user_id = $1", [eveId]);
    await su.query("delete from app.org_members where user_id = $1", [eveId]);
    await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
      orgB,
      eveId,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, eveId],
    );
    const devB = randomUUID();
    const projB = randomUUID();
    botB = randomUUID();
    await su.query(
      `insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status)
       values ($1, $2, $3, 'B server', 'linux', $4, true, 'online')`,
      [devB, orgB, eveId, createHash("sha256").update(randomUUID()).digest("hex")],
    );
    await su.query(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'b-secret-repo')",
      [projB, orgB, devB],
    );
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, scope, owner_user_id)
       values ($1, $2, 'Bee', 'bee', '', 'mock', 'mock', 'ready', 'personal', $3)`,
      [botB, orgB, eveId],
    );
    const profileB = (
      await su.query(
        `insert into app.bot_work_zone_profiles (organization_id, agent_id, sponsor_user_id, device_id, runtime, max_mode, updated_by)
         values ($1, $2, $3, $4, 'claude-code', 'acceptEdits', $3) returning id`,
        [orgB, botB, eveId, devB],
      )
    ).rows[0]!.id as string;
    await su.query(
      "insert into app.bot_work_zone_profile_projects (organization_id, profile_id, device_id, project_id) values ($1, $2, $3, $4)",
      [orgB, profileB, devB, projB],
    );
    await su.query(
      "insert into app.device_bot_consents (organization_id, device_id, agent_id, granted_by) values ($1, $2, $3, $4)",
      [orgB, devB, botB, eveId],
    );
  });

  it("B's bot is unreachable from an A transaction; A's offer for Atlas names only A's device and repos", async () => {
    expect(await offerAs(botB)).toBeNull();
    const ev = await mentionTurn(atlasId);
    const wz = await expectOffer(ev);
    expect(wz.device.id).toBe(serverId);
    expect(wz.projects.map((p) => p.id).sort()).toEqual([billingId, ledgerId].sort());
    expect(JSON.stringify(ev.turn)).not.toContain("b-secret-repo");
    expect(JSON.stringify(ev.turn)).not.toContain(botB);
  });
});

describe("the four tools need four free slots (MAX_TURN_TOOLS = 64)", () => {
  it("61 tools before the offer: none of the four; 60 tools: all four", async () => {
    const base = (await mentionTurn(atlasId)).turn.tools.length - WORK_SESSION_TOOL_NAMES.length;
    const serverMcp = randomUUID();
    await su.query(
      `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
       values ($1, $2, 'Bulk', 'bulk', 'streamable-http', 'https://bulk.example.test/mcp', 'ready', 'org_secret')`,
      [serverMcp, orgId],
    );
    const names = Array.from({ length: 61 - base }, (_, i) => `bulk__t${String(i).padStart(2, "0")}`);
    for (const name of names) {
      await su.query(
        "insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only) values ($1, $2, $3, $4, true)",
        [orgId, serverMcp, name.slice("bulk__".length), name],
      );
    }
    const grant = (tools: string[]) =>
      ok(
        victor.request("PATCH", `/api/v1/agents/${atlasId}/capabilities`, {
          tools: tools.map((tool) => ({ sourceKind: "mcp", sourceId: serverMcp, tool })),
        }),
      );
    try {
      await grant(names);
      const full = await mentionTurn(atlasId);
      expect(full.turn.tools).toHaveLength(61);
      await expectNoOffer(full);

      await grant(names.slice(1));
      const room = await mentionTurn(atlasId);
      await expectOffer(room);
      expect(room.turn.tools).toHaveLength(64);
    } finally {
      await grant([]);
    }
  });
});

// ---------------------------------------------------------------- the bot's sessions and projects, bounded (Task 3)

/** Atlas's live caps, as `profileStatus` hands them to a bot start (07.16-06/07). */
async function atlasLayer() {
  return stack.built.core.db.withTenant({ organizationId: orgId, userId: victorId }, async (tx) => {
    const stored = await loadBotProfile(tx, atlasId);
    const status = stored ? await profileStatus(tx, perms(), stored) : null;
    if (!status?.active) throw new Error("Atlas's profile is not active");
    return status.layer;
  });
}

/**
 * A bot session seeded without the start route (it arrives in 07.16-15): the ONE `createWorkSession` with Atlas's
 * layer, in the sponsor's name, visible to Ana; then its `bot_work_sessions` row (superuser) naming `agentId` and the
 * origin conversation.
 */
async function botSession(
  agentId: string,
  originConversationId: string,
  projectId: string,
  visibility: SessionAudienceInput = { kind: "people", userIds: [anaId] },
): Promise<string> {
  const layer = await atlasLayer();
  const res = await stack.built.core.db.withTenant({ organizationId: orgId, userId: victorId }, (tx) =>
    stack.built.workSession.start(
      tx,
      { userId: victorId, organizationId: orgId, clientKind: null },
      {
        projectId,
        deviceId: serverId,
        runtime: "claude-code",
        prompt: "fix the totals",
        worktree: true,
        visibility,
      },
      { agent: { layer } },
    ),
  );
  if (!res.ok) throw new Error(`start refused: ${JSON.stringify(res)}`);
  await su.query(
    `insert into app.bot_work_sessions (work_session_id, organization_id, agent_id, sponsor_user_id, requester_user_id,
       origin_conversation_id, origin_message_id, origin_event_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [res.session.id, orgId, agentId, victorId, anaId, originConversationId, randomUUID(), randomUUID()],
  );
  return res.session.id;
}

describe("the bot's own sessions in this conversation (D-05, PD-17)", () => {
  it("two active sessions from #eng are listed newest first with status and repo; archived, other-channel and other-bot sessions are not", async () => {
    // Ana may use the build server (so its repos, and a session shared with her, are hers to see).
    await shareDevice(victor, serverId, anaId);
    const opsId = await channel("ops", [atlasId], [anaId]);
    const first = await botSession(atlasId, engId, billingId);
    const second = await botSession(atlasId, engId, ledgerId);
    const archived = await botSession(atlasId, engId, billingId);
    await su.query("update app.work_sessions set status = 'archived' where id = $1", [archived]);
    const elsewhere = await botSession(atlasId, opsId, billingId);
    const echoSession = await botSession(echoId, engId, ledgerId);
    // A session Ana's transaction cannot see (only its creator's audience) is never listed in her turn (T-07.16-11-02).
    const hidden = await botSession(atlasId, engId, ledgerId, { kind: "owner" });

    const wz = await expectOffer(await mentionTurn(atlasId));
    expect(wz.sessions).toEqual([
      { id: second, status: expect.any(String), projectName: "ledger" },
      { id: first, status: expect.any(String), projectName: "billing-api" },
    ]);
    for (const s of wz.sessions)
      expect(["provisioning", "idle", "running", "waiting_approval", "host_offline"]).toContain(s.status);
    const listed = wz.sessions.map((s) => s.id);
    for (const id of [archived, elsewhere, echoSession, hidden]) expect(listed).not.toContain(id);

    // In #ops, Atlas sees only the session that started there.
    const inOps = await expectOffer(await mentionTurn(atlasId, { conversationId: opsId }));
    expect(inOps.sessions.map((s) => s.id)).toEqual([elsewhere]);
  });
});

describe("the profile's projects in the turn: bounded, ordered, live", () => {
  it("24 repos in the profile, one removed from the device: 20 listed by name then id, projectsMore 3", async () => {
    const repos = [
      "billing-api",
      "ledger",
      ...Array.from({ length: 22 }, (_, i) => `repo-${String(i).padStart(2, "0")}`),
    ];
    const sync = async (names: string[]) => {
      server.send({
        type: "projects.sync",
        projects: names.map((name) => ({
          localId: `lp_${name}`,
          name,
          gitRemote: null,
          defaultBranch: "main",
        })),
      });
      await server.next((f) => f.type === "projects.ack");
    };
    await sync(repos);
    const ids = new Map(
      ((await ok(victor.request("GET", "/api/v1/projects"))).projects as Json[])
        .filter((p) => p.deviceId === serverId)
        .map((p) => [p.name as string, p.id as string]),
    );
    expect(ids.size).toBe(24);
    await createBotProfile(victor, atlasId, profile({ projectIds: repos.map((r) => ids.get(r)!) }));
    try {
      // repo-21 leaves the device: the profile still names it, the turn never lists it.
      await sync(repos.filter((r) => r !== "repo-21"));
      const wz = await expectOffer(await mentionTurn(atlasId));
      expect(wz.projects).toHaveLength(20);
      expect(wz.projectsMore).toBe(3);
      expect(wz.projects.map((p) => p.name)).toEqual(repos.slice(0, 20));
      expect(wz.projects.map((p) => p.id)).toEqual(repos.slice(0, 20).map((r) => ids.get(r)));
      expect(wz.projects.map((p) => p.id)).not.toContain(ids.get("repo-21"));
    } finally {
      await sync(repos);
      await createBotProfile(victor, atlasId, profile());
    }
  });
});

describe("the device's live facts in the turn", () => {
  it("an allowed model the device stopped reporting is not in models", async () => {
    await createBotProfile(victor, atlasId, profile({ allowedModels: ["opus", "sonnet"] }));
    const report = async (catalog: typeof CLAUDE_CATALOG) => {
      server.capabilities([catalog, CODEX_CATALOG], true);
      await eventually(async () => {
        const r = await su.query("select runtime_catalog from app.devices where id = $1", [serverId]);
        const claude = (r.rows[0].runtime_catalog as Json[]).find((c) => c.runtime === "claude-code");
        return claude?.models.length === catalog.models.length;
      });
    };
    try {
      expect((await expectOffer(await mentionTurn(atlasId))).models).toEqual(["opus", "sonnet"]);
      await report({ ...CLAUDE_CATALOG, models: CLAUDE_CATALOG.models.filter((m) => m.id !== "sonnet") });
      expect((await expectOffer(await mentionTurn(atlasId))).models).toEqual(["opus"]);
    } finally {
      await report(CLAUDE_CATALOG);
      await createBotProfile(victor, atlasId, profile());
    }
  });

  it("the device offline: the offer stays with device.online false (the start route answers device_offline)", async () => {
    await server.close();
    // The hub marks a device offline after its reconnect grace (10 s).
    await eventually(async () => {
      const r = await su.query("select status from app.devices where id = $1", [serverId]);
      return r.rows[0].status !== "online";
    }, 20_000);
    const wz = await expectOffer(await mentionTurn(atlasId));
    expect(wz.device).toEqual({ id: serverId, name: "billing-server", online: false });
  }, 40_000);
});
