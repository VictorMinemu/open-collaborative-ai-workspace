import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * CI p64/p66 (sandbox-proof step 6): the first `ocw_browser_open` of a run met a cold browser start slower than the
 * cell's 20 s budget. The cell gave up and the model read "the workspace could not be reached", while the API kept
 * waiting (60 s for the start, then the page) and opened the page anyway; the bot's next call raced that open. Each
 * browser call now runs under one deadline the API answers within (contracts BROWSER_TIMEOUTS_MS: the open's below the
 * cell's budget for it), so the model always reads the API's own outcome. This stack shortens the deadlines (a test hook,
 * never read from the environment) and slows the in-memory sandboxd's browser start.
 *
 * Real PostgreSQL + Redis; the in-memory sandboxd (P-13).
 */

const OPEN_DEADLINE_MS = 1_500;
let s: SandboxStack;

const setBotBrowser = (agentId: string) =>
  s.su.query(
    "update app.agents set capabilities = capabilities || jsonb_build_object('browser', true) where id = $1",
    [agentId],
  );

async function control(path: string, body: Json = {}): Promise<void> {
  const res = await fetch(`${s.sandboxd.url}/__control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

/** A bot whose browser has never started (so its first open is a cold start), with Sam's DM and a live turn. */
async function coldBot(name: string): Promise<{ id: string; dm: string; ev: Json }> {
  const bot = await s.newBot(name);
  await setBotBrowser(bot.id);
  return { ...bot, ev: await s.turnOf(s.sam, bot.dm, bot.id) };
}

const open = (bot: { id: string; ev: Json }) =>
  s.cell("/browser/open", { eventId: bot.ev.eventId, agentId: bot.id, url: "https://panel.fake.test/app" });

beforeAll(async () => {
  s = await startSandboxStack({ browserBudgetsMs: { apiOpen: OPEN_DEADLINE_MS, apiCall: OPEN_DEADLINE_MS } });
  await s.setPolicy({ enabled: true });
  await s.su.query("update app.sandbox_policies set max_browsers = 50 where organization_id = $1", [s.orgA]);
});

afterAll(async () => {
  await s?.stop();
});

describe("a browser call answers within its deadline (CI p64/p66)", () => {
  it("a cold start inside the open's deadline answers the page", async () => {
    const bot = await coldBot("Ranger");
    await control("/browser/delay", { op: "browserEnsure", ms: 600 });
    const started = Date.now();
    const opened = await ok(open(bot));
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(opened).toMatchObject({ host: "panel.fake.test", signedIn: false });
  });

  it("a start longer than the deadline: 503 `timeout` at the deadline (never later), the page ended, the step says why; the next open finds the browser started", async () => {
    const bot = await coldBot("Drifter");
    await control("/browser/delay", { op: "browserEnsure", ms: 4_000 });
    const started = Date.now();
    const res = await open(bot);
    const took = Date.now() - started;
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(codeOf(res)).toBe("timeout");
    expect(took).toBeGreaterThanOrEqual(OPEN_DEADLINE_MS - 50);
    expect(took).toBeLessThan(OPEN_DEADLINE_MS + 1_500);

    // No page is left behind: the context the open created ended `crashed`, and the call is recorded as a timeout.
    const contexts = (
      await s.su.query("select state, end_reason, closed_at from app.browser_contexts where agent_id = $1", [
        bot.id,
      ])
    ).rows as Json[];
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.closed_at).not.toBeNull();
    expect(contexts[0]?.end_reason).toBe("crashed");
    const calls = (
      await s.su.query("select tool, status from app.agent_tool_calls where event_id = $1", [bot.ev.eventId])
    ).rows as Json[];
    expect(calls).toEqual([{ tool: "ocw_browser_open", status: "error" }]);
    const steps = ((
      await s.su.query("select steps from app.bot_turn_activity where event_id = $1", [bot.ev.eventId])
    ).rows[0]?.steps ?? []) as Json[];
    expect(steps.at(-1)).toMatchObject({
      tool: "ocw_browser_open",
      outcome: { kind: "error", code: "timeout" },
    });

    // sandboxd finished the start meanwhile: the bot's next open (a new turn) opens the page.
    await new Promise((r) => setTimeout(r, 4_000 - took + 300));
    const again = { id: bot.id, ev: await s.turnOf(s.sam, bot.dm, bot.id) };
    await expect(ok(open(again))).resolves.toMatchObject({ host: "panel.fake.test" });
  });
});
