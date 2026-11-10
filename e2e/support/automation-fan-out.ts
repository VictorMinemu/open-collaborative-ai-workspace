import { type APIRequestContext, expect } from "@playwright/test";
import type { BotWorkZoneProfileInput } from "../../packages/contracts/src/bot-work-zone.ts";
import { type Actor, apiAs, ensureMember } from "./actors";
import { ensureUnit, ensureUnitRole } from "./approvals";
import { columnId, createBoardChannel } from "./board";
import { FAKE_URL } from "./bot-tools";
import { allowBot, expectProfileActive, saveBotProfile } from "./bot-work-zone";
import { ERP_TOKEN } from "./watched";
import type { FakeDeviceHandle } from "./work-zone-device";

/**
 * Setup for the automation fan-out spec (07.17-18, PD-19, PD-22) through the public API, for what the spec does not
 * exercise in the browser: the people and the Logistics team, the `#fleet` board, the bot's Work Zone profile and the
 * device's consent (the 07.16 helpers), new orders in the fake ERP (its `__add` hook) and the automation's body for the
 * phone run, which creates it through the API.
 */

/** Logistics members who read `#fleet` (a team mention reaches them) and Eva, who reads it from outside the team. */
export const CAM: Actor = { name: "Cam Ortiz", email: "cam-0717@ocw.test", password: "cam-e2e-password-123" };
export const DAN: Actor = { name: "Dan Reyes", email: "dan-0717@ocw.test", password: "dan-e2e-password-123" };
export const EVA: Actor = { name: "Eva Lund", email: "eva-0717@ocw.test", password: "eva-e2e-password-123" };
/** The department the team sits under, and the team itself (its handle comes from its name, 07.17-06). */
export const DEPARTMENT = "Supply chain";
export const TEAM = "Logistics";
export const TEAM_HANDLE = "logistics";

export interface FanOutPeople {
  cam: { id: string; api: APIRequestContext };
  dan: { id: string; api: APIRequestContext };
  eva: { id: string; api: APIRequestContext };
  logistics: { id: string; handle: string };
}

export interface FanOutBoard {
  id: string;
  name: string;
  columns: { backlog: string; started: string; done: string };
}

/**
 * Cam, Dan and Eva as members, the Logistics team (Cam and Dan) under Supply chain, and a fresh `fleet-…` board they all
 * read (default columns Backlog, In progress, Done, Cancelled). Units and people are idempotent across projects and
 * retries; the board is new on every call, so each attempt counts its own cards.
 */
export async function seedFanOutBoard(admin: APIRequestContext): Promise<{
  people: FanOutPeople;
  board: FanOutBoard;
}> {
  const camId = await ensureMember(admin, CAM, "developer");
  const danId = await ensureMember(admin, DAN, "developer");
  const evaId = await ensureMember(admin, EVA, "developer");
  const departmentId = await ensureUnit(admin, "department", DEPARTMENT, null);
  const teamId = await ensureUnit(admin, "team", TEAM, departmentId);
  await ensureUnitRole(admin, teamId, camId, "member");
  await ensureUnitRole(admin, teamId, danId, "member");
  const units = (await (await admin.get("/api/v1/units")).json()) as {
    units: Array<{ id: string; handle?: string }>;
  };
  const handle = units.units.find((u) => u.id === teamId)?.handle ?? "";
  expect(handle, "the Logistics team's handle").toBe(TEAM_HANDLE);

  const cam = await apiAs(CAM);
  const dan = await apiAs(DAN);
  const eva = await apiAs(EVA);
  const board = await createBoardChannel(admin, { prefix: "fleet", members: [cam, dan, eva] });
  return {
    people: {
      cam: { id: camId, api: cam },
      dan: { id: danId, api: dan },
      eva: { id: evaId, api: eva },
      logistics: { id: teamId, handle },
    },
    board: {
      ...board,
      columns: {
        backlog: await columnId(admin, board.id, "Backlog"),
        started: await columnId(admin, board.id, "In progress"),
        done: await columnId(admin, board.id, "Done"),
      },
    },
  };
}

/**
 * Atlas's 07.16 profile on the isolated build server, saved by `admin` (its sponsor): the device's project, Claude Code,
 * up to Full access, `actOnOutsideContent` on (an item is outside content, so without it every start would be a
 * proposal, 07.16-19), room for three sessions at once (two orders run together; `too_many_sessions` otherwise), then
 * the device's consent with its own Full access checkbox. Resolves once the profile is active.
 */
export async function seedAtlasWorkZone(
  admin: APIRequestContext,
  device: FakeDeviceHandle,
  agentId: string,
): Promise<void> {
  const profile: BotWorkZoneProfileInput = {
    deviceId: device.deviceId,
    runtime: "claude-code",
    projectIds: [device.projectId],
    defaultModel: "opus",
    allowedModels: [],
    defaultEffort: null,
    allowedEfforts: [],
    defaultContextWindow: null,
    allowedContextWindows: [],
    fastMode: "off",
    defaultMode: "default",
    maxMode: "fullAccess",
    worktree: true,
    maxConcurrent: 3,
    promptsPerHour: 30,
    wakesPerSessionDay: 20,
    actOnOutsideContent: true,
  };
  await saveBotProfile(admin, agentId, profile);
  await allowBot(admin, device.deviceId, agentId, { allowFullAccess: true });
  await expectProfileActive(admin, agentId);
}

/** One JSON-RPC tool call to the fake ERP on loopback (its own session each time): the result as the ERP sent it. */
async function erpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> {
  expect(FAKE_URL, "OCW_E2E_FAKE_URL (the fake ERP) is set by scripts/e2e-isolated.sh").not.toBe("");
  const url = `${FAKE_URL}/erp-mcp`;
  const headers = { authorization: `Bearer ${ERP_TOKEN}`, "content-type": "application/json" };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    }),
  });
  expect(init.ok, `erp initialize: ${init.status}`).toBe(true);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": init.headers.get("mcp-session-id") ?? "" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.ok, `erp ${name}: ${res.status}`).toBe(true);
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  expect(body.result, `erp ${name} answered`).toBeTruthy();
  return body.result ?? {};
}

/**
 * New orders in the fake ERP, made "elsewhere" through its `__add` hook (status `new`, customer Fleet Co). The fake keeps
 * its records for the whole run, so an order an earlier attempt or project added is already there: that is the same
 * order, never an error (each attempt's automation is new, so it still finds it new).
 */
export async function addOrders(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const r = await erpTool("__add", { id, fields: { status: "new", customer: "Fleet Co" } });
    if (r.isError) expect(r.content?.[0]?.text ?? "", `add order ${id}`).toBe(`exists: ${id}`);
  }
}

/**
 * The automation the desktop run creates in the editor, as `POST /api/v1/automations` takes it (the phone run creates it
 * this way): every 10 minutes into the board's Backlog, one conversation per new item, Logistics to mention.
 */
export function fanOutAutomationBody(p: {
  name: string;
  agentId: string;
  board: FanOutBoard;
  logisticsId: string;
  instructions: string;
}) {
  return {
    name: p.name,
    agentId: p.agentId,
    instructions: p.instructions,
    trigger: { kind: "schedule", schedule: { cron: "*/10 * * * *", timeZone: "Europe/Madrid" } },
    target: { kind: "board", conversationId: p.board.id, columnId: p.board.columns.backlog },
    maxRunsPerDay: 144,
    fanOut: { enabled: true, perRun: 10, perDay: 100 },
    escalation: [{ kind: "unit", id: p.logisticsId }],
  };
}

/** Deletes every automation named `name` (a retry's or an earlier run's), so each attempt starts from none. */
export async function deleteAutomationsNamed(admin: APIRequestContext, name: string): Promise<void> {
  const res = await admin.get("/api/v1/automations?scope=all");
  expect(res.ok(), "list everyone's automations").toBe(true);
  const { automations } = (await res.json()) as { automations: Array<{ id: string; name: string }> };
  for (const a of automations.filter((x) => x.name === name)) {
    const del = await admin.delete(`/api/v1/automations/${a.id}`);
    expect(del.status(), `delete automation ${a.id}`).toBe(204);
  }
}

/** A run as `GET /automations/:id/runs` lists it, with what a fan-out run opened (07.17-05). */
export interface FanOutRunDto {
  id: string;
  trigger: string;
  status: string;
  opened: number | null;
  anchor: { conversationId: string; messageId: string; threadRootId: string } | null;
}

export async function runsOf(api: APIRequestContext, automationId: string): Promise<FanOutRunDto[]> {
  const res = await api.get(`/api/v1/automations/${automationId}/runs`);
  expect(res.ok(), `runs of ${automationId}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { runs: FanOutRunDto[] }).runs;
}
