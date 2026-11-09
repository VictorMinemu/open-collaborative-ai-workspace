import { randomUUID } from "node:crypto";
import {
  type BotWorkZoneProfileInput,
  TurnWorkZone,
  WORK_SESSION_TOOL_FLAGS,
  WORK_SESSION_TOOL_NAMES,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  grantBotConsent,
  invite,
  pairDevice,
} from "../../testing-workzone";

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
let atlasId: string;
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
  ({ client: ana, userId: anaId } = await invite(stack, victor, "ana@example.test", "Ana Gil", "developer"));
  atlasId = await teamBot("Atlas", "atlas");
  engId = await channel("eng", [atlasId], [anaId]);

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
