import { type APIRequestContext, expect, test } from "@playwright/test";
import { apiAs } from "../support/actors";
import { addBot, createAutomation, runNow, waitRun } from "../support/automations";
import { freshTeamBot } from "../support/bot-tools";
import { freshChannel } from "../support/chat";
import { ADMIN } from "../tests/env";

/**
 * 07.6-19 (AUTO-01, Pitfall 10, principle 10): an automation runs on the release images an operator deploys, behind
 * Caddy. The one-shot migrate service installed the `pgboss` schema as `ocw_migrator`, the API booted as `ocw_app`
 * with its job workers on (`OCW_JOBS_WORKER` defaults to on outside tests), and here the admin creates a team bot and
 * a channel through the public API, schedules a weekly automation into it, presses Run now (`POST …/run`), and within
 * 60 s the channel holds the platform-owned run card and the run is `delivered`. Delivery is the run event recorded
 * for the bot's cell; no cell has to answer, so nothing here depends on a model. The API stays healthy throughout.
 *
 * Viewport-independent; it runs on both projects with names of its own, so the gate's "no skipped test" rule holds.
 */

test.describe.configure({ mode: "serial" });

let admin: APIRequestContext;

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
});

test.afterAll(async () => {
  await admin?.dispose();
});

interface MessageDto {
  id: string;
  authorKind: string;
  authorId: string | null;
  card?: { kind: string; platformOwned?: boolean };
}

async function healthy(api: APIRequestContext, when: string): Promise<void> {
  const res = await api.get("/health");
  expect(res.status(), `API healthy ${when}`).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("ok");
}

test("on the release images, Run now posts the automation's run card and the run is delivered", async ({
  baseURL,
}, info) => {
  test.setTimeout(120_000);
  expect(baseURL, "the gate runs the stack behind the HTTPS proxy").toMatch(/^https:\/\//);
  const project = info.project.name;
  await healthy(admin, "before the run");

  const botId = await freshTeamBot(admin, `Reporter ${project}`);
  const channel = await freshChannel(admin, [], `auto-${project}`);
  await addBot(admin, channel.id, botId);

  const automation = await createAutomation(admin, {
    name: `Weekly sales report (${project})`,
    agentId: botId,
    conversationId: channel.id,
    cron: "0 17 * * 5",
    timeZone: "Europe/Madrid",
  });
  expect(automation.status).toBe("active");
  expect(automation.nextRunAt, "the schedule has a next run").not.toBeNull();

  // Run now: enqueued ids-only in the request's transaction, fired by the pg-boss worker on the API image.
  const runId = await runNow(admin, automation.id);
  const run = await waitRun(admin, automation.id, runId, (r) => r.status === "delivered", 60_000);
  expect(run.trigger).toBe("manual");
  expect(run.anchor?.conversationId).toBe(channel.id);

  const res = await admin.get(`/api/v1/conversations/${channel.id}/messages?limit=50`);
  expect(res.ok(), "read the channel").toBe(true);
  const { messages } = (await res.json()) as { messages: MessageDto[] };
  const card = messages.find((m) => m.id === run.anchor?.messageId);
  expect(card, "the run card is in the channel").toBeDefined();
  expect(card?.card?.kind).toBe("automation");
  expect(card?.card?.platformOwned, "the platform owns the run card, not the bot").toBe(true);
  expect(card?.authorKind).toBe("agent");
  expect(card?.authorId).toBe(botId);

  await healthy(admin, "after the run");
});
