import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * Sandbox-proof CI p142/p164/p178 (step 2, Echo's `cat note.txt`): a bot's first `ocw_sandbox_exec` met a cold start of
 * its shell that a contended Docker daemon held for 15-42 s. The API waited 60 s for the start and then up to 40 s for
 * the command while the cell gave the call 35 s, so the model read "the workspace could not be reached" and the command
 * ran anyway. Every sandbox call now runs under one deadline below the cell's budget (contracts SANDBOX_TIMEOUTS_MS),
 * and the start has its own share of it: within the share the call answers the command's result; past it the call is
 * 503 `starting` at the share, the reservation stays `starting` (never "service down"), sandboxd finishes the start,
 * and the bot's next call runs. This stack shortens the start's share (a test hook, never read from the environment) and
 * slows the in-memory sandboxd's `ensure`.
 *
 * Real PostgreSQL + Redis; the in-memory sandboxd (P-13).
 */

const ENSURE_SHARE_MS = 1_500;
let s: SandboxStack;

async function control(path: string, body: Json = {}): Promise<void> {
  const res = await fetch(`${s.sandboxd.url}/__control${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

/** A bot whose shell has never started (so its first call is a cold start), with Sam's DM and a live turn. */
async function coldBot(name: string): Promise<{ id: string; dm: string; ev: Json }> {
  const bot = await s.newBot(name);
  return { ...bot, ev: await s.turnOf(s.sam, bot.dm, bot.id) };
}

const exec = (bot: { id: string }, ev: Json, argv: string[]) =>
  s.cell("/sandbox/exec", { eventId: ev.eventId, agentId: bot.id, argv });

const shellOf = async (agentId: string) =>
  (
    await s.su.query(
      "select state, stop_reason from app.bot_sandboxes where agent_id = $1 and kind = 'sbx'",
      [agentId],
    )
  ).rows as Json[];

beforeAll(async () => {
  s = await startSandboxStack({ sandboxBudgetsMs: { ensure: ENSURE_SHARE_MS } });
  await s.setPolicy({ enabled: true });
  await s.su.query("update app.sandbox_policies set max_sandboxes = 50 where organization_id = $1", [s.orgA]);
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

describe("a bot's first sandbox call on a slow Docker daemon (CI p142/p164/p178)", () => {
  it("a cold start inside the start's share: the call answers the command's result, the shell is recorded running", async () => {
    const bot = await coldBot("Ember");
    await control("/browser/delay", { op: "ensure", ms: 600 });
    const started = Date.now();
    const r = await exec(bot, bot.ev, ["sh", "-c", "echo hi"]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(r.body).toMatchObject({ status: "exited", exitCode: 0, stdout: "hi\n" });
    expect(await shellOf(bot.id)).toEqual([{ state: "running", stop_reason: null }]);
  });

  it("a start longer than its share: 503 `starting` at the share (never later), the reservation kept, the step and audit say why; the next call runs in the started shell", async () => {
    const bot = await coldBot("Flint");
    await control("/browser/delay", { op: "ensure", ms: 4_000 });
    const started = Date.now();
    const res = await exec(bot, bot.ev, ["cat", "note.txt"]);
    const took = Date.now() - started;
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(codeOf(res)).toBe("starting");
    expect(took).toBeGreaterThanOrEqual(ENSURE_SHARE_MS - 50);
    expect(took).toBeLessThan(ENSURE_SHARE_MS + 1_500);

    // The start is still running in sandboxd: the slot stays reserved, never marked "service down".
    expect((await shellOf(bot.id))[0]).toMatchObject({ state: "starting" });
    const [audit] = (
      await s.su.query(
        "select result, metadata from app.audit_events where action = 'sandbox.exec' and metadata->>'eventId' = $1",
        [bot.ev.eventId],
      )
    ).rows as Json[];
    expect(audit?.metadata).toMatchObject({ status: "error", reason: "starting" });

    // sandboxd finishes the start although the API stopped waiting; the bot's next call (the reservation is still
    // `starting`, so it ensures again and finds the shell up) runs the command and records the shell running.
    const target = { orgId: s.orgA, agentId: bot.id };
    await expect
      .poll(() => s.sandboxd.fake.stateOf(target), { timeout: 10_000, interval: 200 })
      .toBe("running");
    const next = await ok(exec(bot, await s.turnOf(s.sam, bot.dm, bot.id), ["sh", "-c", "echo again"]));
    expect(next).toMatchObject({ status: "exited", exitCode: 0, stdout: "again\n" });
    expect(await shellOf(bot.id)).toEqual([{ state: "running", stop_reason: null }]);
  });
});
