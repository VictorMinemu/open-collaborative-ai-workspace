import { type APIRequestContext, expect } from "@playwright/test";
import { asSuperuser } from "./superuser";

/**
 * Automations through the API (07.6-15): create, run now, wait for a run, and the seeds the browser specs need. Every
 * call goes through the REST API as a signed-in person (the API decides everything); only `seedRuns` writes rows
 * directly, as the e2e superuser, to show run states no API path makes quickly (a webhook run, a daily-limit failure).
 */

export interface AutomationDto {
  id: string;
  name: string;
  status: "active" | "paused" | "needs_attention";
  version: number;
  nextRunAt: string | null;
  lastRun: { status: string; reason: string | null; at: string } | null;
  runAs: { id: string; displayName: string };
}

export interface RunDto {
  id: string;
  trigger: string;
  status: "queued" | "delivered" | "answered" | "skipped" | "failed" | "no_reply";
  reason: string | null;
  anchor: { conversationId: string; messageId: string; threadRootId: string } | null;
}

/** A weekly schedule into a channel, unless `body` says otherwise. */
export async function createAutomation(
  api: APIRequestContext,
  body: {
    name: string;
    agentId: string;
    conversationId?: string;
    target?: Record<string, unknown>;
    cron?: string;
    timeZone?: string;
    instructions?: string;
    maxRunsPerDay?: number;
  },
): Promise<AutomationDto> {
  const res = await api.post("/api/v1/automations", {
    data: {
      name: body.name,
      agentId: body.agentId,
      instructions:
        body.instructions ?? "Summarise this week's closed deals: total, top 3 accounts, anything stuck.",
      trigger: {
        kind: "schedule",
        schedule: { cron: body.cron ?? "0 17 * * 5", timeZone: body.timeZone ?? "Europe/Madrid" },
      },
      target: body.target ?? { kind: "channel", conversationId: body.conversationId },
      maxRunsPerDay: body.maxRunsPerDay ?? 24,
    },
  });
  expect(res.status(), `create automation ${body.name}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { automation: AutomationDto }).automation;
}

export async function getAutomation(api: APIRequestContext, id: string): Promise<AutomationDto> {
  const res = await api.get(`/api/v1/automations/${id}`);
  expect(res.ok(), `automation ${id}`).toBe(true);
  return (await res.json()) as AutomationDto;
}

/**
 * Deletes every automation of the organization (`manager` holds `automation.manage`): a deleted bot is only marked
 * deleted, so its automations would outlive it and leak into the next run's lists.
 */
export async function clearAutomations(manager: APIRequestContext): Promise<void> {
  const res = await manager.get("/api/v1/automations?scope=all");
  expect(res.ok(), "list everyone's automations").toBe(true);
  const { automations } = (await res.json()) as { automations: Array<{ id: string }> };
  for (const a of automations) {
    const del = await manager.delete(`/api/v1/automations/${a.id}`);
    expect(del.status(), `delete automation ${a.id}`).toBe(204);
  }
}

/** "Run now": the run's id (202). */
export async function runNow(api: APIRequestContext, id: string): Promise<string> {
  const res = await api.post(`/api/v1/automations/${id}/run`);
  expect(res.status(), `run ${id}: ${await res.text()}`).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

/** Waits until run `runId` of automation `id` matches `done` (polls the runs list) and returns it. */
export async function waitRun(
  api: APIRequestContext,
  id: string,
  runId: string,
  done: (r: RunDto) => boolean,
  timeoutMs = 30_000,
): Promise<RunDto> {
  let last: RunDto | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`/api/v1/automations/${id}/runs`);
        last = ((await res.json()) as { runs: RunDto[] }).runs.find((r) => r.id === runId);
        return !!last && done(last);
      },
      { timeout: timeoutMs, message: `run ${runId} of ${id}` },
    )
    .toBe(true);
  return last as RunDto;
}

/** Waits until the bot is offered as ready for automations (the fake cell acked it). */
export async function waitBotReady(api: APIRequestContext, agentId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/v1/automations/options");
        const bots = ((await res.json()) as { bots: Array<{ id: string; ready: boolean }> }).bots;
        return bots.find((b) => b.id === agentId)?.ready ?? false;
      },
      { timeout: 30_000, message: `bot ${agentId} ready` },
    )
    .toBe(true);
}

/** Adds a bot to a channel (admin). */
export async function addBot(api: APIRequestContext, channelId: string, agentId: string): Promise<void> {
  const res = await api.post(`/api/v1/channels/${channelId}/members`, {
    data: { kind: "agent", id: agentId },
  });
  expect(res.ok() || res.status() === 409, `add bot to ${channelId}: ${res.status()}`).toBe(true);
}

export async function removeBot(api: APIRequestContext, channelId: string, agentId: string): Promise<void> {
  const res = await api.delete(`/api/v1/channels/${channelId}/members/agent/${agentId}`);
  expect(res.ok(), `remove bot from ${channelId}: ${res.status()}`).toBe(true);
}

/**
 * Three failed runs in a row (D-07): with the bot no longer a member of the target, each "Run now" is skipped
 * `agent_not_member`, which counts as a failure, and the third pauses the automation as needs attention. `admin`
 * removes the bot; `owner` runs it.
 */
export async function makeNeedsAttention(
  admin: APIRequestContext,
  owner: APIRequestContext,
  automationId: string,
  channelId: string,
  agentId: string,
): Promise<void> {
  await removeBot(admin, channelId, agentId);
  for (let i = 0; i < 3; i += 1) {
    const runId = await runNow(owner, automationId);
    await waitRun(owner, automationId, runId, (r) => r.status === "skipped");
  }
  await expect
    .poll(async () => (await getAutomation(owner, automationId)).status, { timeout: 15_000 })
    .toBe("needs_attention");
}

/**
 * Runs in states no quick API path makes (UI-SPEC screenshot `automation-runs`): a webhook run nobody answered, a
 * scheduled run skipped because the bot left the channel, and a Run now that hit the bot's daily limit. Written as the
 * e2e superuser, older than any real run, with no anchor (nothing to open).
 */
export async function seedRuns(automationId: string): Promise<void> {
  await asSuperuser(
    `insert into app.automation_runs
       (organization_id, automation_id, trigger, scheduled_for, status, reason, tainted, created_at, updated_at)
     select a.organization_id, a.id, v.trigger, v.scheduled_for, v.status, v.reason, v.tainted, v.created_at, v.created_at
       from app.automations a,
            (values
              ('webhook', null::timestamptz, 'no_reply', 'no_reply', true, now() - interval '1 day'),
              ('schedule', date_trunc('minute', now() - interval '2 days'), 'skipped', 'agent_not_member', false,
               date_trunc('minute', now() - interval '2 days')),
              ('manual', null::timestamptz, 'failed', 'agent_daily_limit', false, now() - interval '3 days')
            ) as v(trigger, scheduled_for, status, reason, tainted, created_at)
      where a.id = $1`,
    [automationId],
  );
}

/** Makes a delivered run look 16 minutes old, so the next scheduler tick marks it No reply. */
export async function ageDeliveredRun(runId: string): Promise<void> {
  const res = await asSuperuser(
    `update app.automation_runs set delivered_at = now() - interval '16 minutes'
      where id = $1 and status = 'delivered'`,
    [runId],
  );
  expect(res.rowCount, `run ${runId} was delivered`).toBe(1);
}

/** The caller's digest, on, delivered by `agentId` (07.6-13): it shows in the list as a Digest row. */
export async function saveDigest(api: APIRequestContext, agentId: string): Promise<void> {
  const res = await api.put("/api/v1/digest", {
    data: {
      enabled: true,
      days: ["mon", "tue", "wed", "thu", "fri"],
      time: "08:00",
      timeZone: "Europe/Madrid",
      sections: ["decisions", "follows", "mentions"],
      skipEmpty: true,
      agentId,
      summary: { enabled: false, modelRef: null },
    },
  });
  expect(res.ok(), `save digest: ${res.status()} ${await res.text()}`).toBe(true);
}
