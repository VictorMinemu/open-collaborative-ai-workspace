import { type APIRequestContext, expect, test } from "@playwright/test";
import { AgentMessagingSettings, AgentMessagingView } from "../../packages/contracts/src/agent-chains.ts";
import { apiAs } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { ADMIN } from "../tests/env";

/**
 * 07.7-11 (A2A-02, D-04, D-11, D-16, principle 10): agent-to-agent consults on the release images an operator deploys,
 * behind Caddy. The one-shot migrate service applied the 07.7 migrations (the chain ledger and the Bots-off
 * `agent.message` backfill) and created the `consult.tick` queue; the API booted as `ocw_app` and registered the tick's
 * worker and schedule (it would not boot without the queue). Here the admin finds "Bots may consult each other" off,
 * turns it on through the public API (`PUT /api/v1/agent-messaging`), reads it back, and a team bot's consult rules
 * (`GET /api/v1/agents/:id/messaging`) answer with the server's "Right now": the other bot is consultable. The switch
 * goes back off at the end, and the API stays healthy throughout.
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

async function healthy(api: APIRequestContext, when: string): Promise<void> {
  const res = await api.get("/health");
  expect(res.status(), `API healthy ${when}`).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("ok");
}

async function settings(api: APIRequestContext): Promise<AgentMessagingSettings> {
  const res = await api.get("/api/v1/agent-messaging");
  expect(res.ok(), `GET /api/v1/agent-messaging: ${res.status()}`).toBe(true);
  return AgentMessagingSettings.parse(await res.json());
}

async function setSwitch(api: APIRequestContext, enabled: boolean): Promise<AgentMessagingSettings> {
  const res = await api.put("/api/v1/agent-messaging", { data: { enabled } });
  expect(res.ok(), `PUT /api/v1/agent-messaging ${enabled}: ${res.status()}`).toBe(true);
  return AgentMessagingSettings.parse(await res.json());
}

async function botView(api: APIRequestContext, botId: string): Promise<AgentMessagingView> {
  const res = await api.get(`/api/v1/agents/${botId}/messaging`);
  expect(res.ok(), `GET /api/v1/agents/:id/messaging: ${res.status()}`).toBe(true);
  return AgentMessagingView.parse(await res.json());
}

test("on the release images, an admin turns bot-to-bot consults on and a bot's consult rules reflect it", async ({
  baseURL,
}, info) => {
  test.setTimeout(120_000);
  expect(baseURL, "the gate runs the stack behind the HTTPS proxy").toMatch(/^https:\/\//);
  const project = info.project.name;
  await healthy(admin, "before the switch");

  const archie = await freshTeamBot(admin, `Archie ${project}`);
  const bea = await freshTeamBot(admin, `Bea ${project}`);

  // Closed by default (D-04): no allow rule, so no bot may consult another.
  expect(await settings(admin)).toEqual({ enabled: false, canManage: true });
  const closed = await botView(admin, archie);
  expect(closed.orgDefault).toBe(false);
  expect(closed.outbound.mode).toBe("default");
  expect(closed.effective.kind).toBe("none");

  // The admin turns the switch on; it reads back on.
  expect(await setSwitch(admin, true)).toEqual({ enabled: true, canManage: true });
  expect(await settings(admin)).toEqual({ enabled: true, canManage: true });

  // Archie's rules follow the organization default: Bea is consultable right now, decided by the API.
  const open = await botView(admin, archie);
  expect(open.agentId).toBe(archie);
  expect(open.orgDefault).toBe(true);
  expect(open.canManage).toBe(true);
  expect(open.inbound.consultable).toBe(true);
  expect(open.effective.kind).not.toBe("none");
  expect(open.effective.targets.map((t) => t.id)).toContain(bea);
  expect(open.effective.targets.map((t) => t.id)).not.toContain(archie);

  await healthy(admin, "with the switch on");

  // Back off, so the next project (and the backup stage) starts from the default.
  expect(await setSwitch(admin, false)).toEqual({ enabled: false, canManage: true });
  expect((await botView(admin, archie)).effective.kind).toBe("none");
  for (const id of [archie, bea]) {
    expect((await admin.delete(`/api/v1/agents/${id}`)).ok(), "delete the bot").toBe(true);
  }
  await healthy(admin, "after the switch");
});
