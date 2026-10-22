import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { BROWSER_TOOL_NAMES, SANDBOX_TOOL_NAMES } from "../../packages/contracts/src/bot-capabilities";
import { apiAs, ensureMember, SAM } from "../support/actors";
import { enableBotSandbox, enableSandboxOrg, killSwitch, organizationOf, resume } from "../support/sandbox";
import { asSuperuser } from "../support/superuser";
import { ADMIN } from "../tests/env";

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
  if (file) writeFileSync(file, JSON.stringify({ ...state, nonce: NONCE }, null, 2));
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

type Message = { id: string; seq: number; authorKind: string; authorId: string | null; body: string };

async function post(api: APIRequestContext, dm: string, text: string): Promise<Message> {
  const res = await api.post(`/api/v1/conversations/${dm}/messages`, { data: { body: text } });
  expect(res.ok(), `post in ${dm}: ${res.status()}`).toBe(true);
  return (await res.json()) as Message;
}

/** The first bot message after `asked` (the reply to it). */
async function replyTo(api: APIRequestContext, dm: string, asked: Message, timeout = REAL): Promise<string> {
  let reply = "";
  await expect
    .poll(
      async () => {
        const res = await api.get(`/api/v1/conversations/${dm}/messages?after=${asked.seq}&limit=50`);
        if (!res.ok()) return "";
        const page = (await res.json()) as { messages: Message[] };
        reply = page.messages.find((m) => m.authorKind === "agent")?.body ?? "";
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
    const reply = await replyTo(api, dm, asked);
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
